/**
 * The search loop: look through recent mail, newest first, for a message with
 * a verification code. If there is none yet, keep checking until one arrives
 * or time runs out.
 *
 * Gmail access and the clock are passed in, so the loop runs in Node tests
 * with fakes and in the service worker with the real API.
 */

import { extractCode } from './extract.js';
import { parseMessage } from './mime.js';
import { AUTO_FILL, checkSender } from './sender.js';

/**
 * @typedef {object} Hit
 * @property {string} id - Gmail message ID.
 * @property {string} code
 * @property {number} score
 * @property {string} reason
 * @property {number} receivedAt
 * @property {string} from
 * @property {string} subject
 * @property {import('./sender.js').SenderCheck} sender - Authenticated sender domain.
 * @property {boolean} spam
 * @property {string} verdict - From options.classify: 'match', 'trusted', 'mismatch', ...
 */

/**
 * @typedef {object} FinderDeps
 * @property {() => Promise<string>} getToken
 * @property {(token: string, options: { afterMs: number, max: number, signal?: AbortSignal }) => Promise<string[]>} listIds
 * @property {(token: string, id: string, signal?: AbortSignal) => Promise<object>} getMessage
 * @property {() => Promise<void>} [dropToken] - Called when Gmail rejects the token.
 * @property {() => number} [now]
 * @property {(ms: number, signal?: AbortSignal) => Promise<void>} [sleep]
 */

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  return new DOMException('The search was cancelled', 'AbortError');
}

/**
 * @param {FinderDeps} deps
 * @param {object} options
 * @param {number} options.lookbackMs - Only messages received this recently count.
 * @param {number} options.waitMs - How long to keep checking for a new message.
 * @param {number} options.pollMs - Time between checks.
 * @param {number} options.maxPerCheck - Messages to list per check.
 * @param {(hit: Hit) => string} options.classify - Returns the verdict for a hit
 *   (see sender.js verdict()). Only 'match' and 'trusted' are returned without
 *   waiting; anything else is a blocked code.
 * @param {boolean} [options.stopOnBlocked] - Return a blocked code as soon as a
 *   complete check finds one and nothing better, instead of waiting for a code
 *   that may be filled. The popup uses this to explain the problem at once.
 * @param {Set<string>} [options.skipIds] - Messages whose code was already used.
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { phase: 'checking'|'waiting', deadline: number, blocked: Hit|null }) => void} [options.onProgress]
 * @param {(blocked: Hit|null) => void} [options.onBlocked] - Called when the newest
 *   blocked code changes, so the popup can offer it while the wait goes on.
 * @returns {Promise<Hit|null>} The newest message whose code may be filled.
 *   When there is none, the newest blocked one (check hit.verdict), or null.
 */
export async function findNewestCode(deps, options) {
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const { lookbackMs, waitMs, pollMs, maxPerCheck, skipIds = new Set(), signal, onProgress, onBlocked, classify, stopOnBlocked = false } = options;
  if (typeof classify !== 'function') throw new TypeError('findNewestCode needs options.classify');

  const startedAt = now();
  const since = startedAt - lookbackMs;
  const deadline = startedAt + waitMs;
  /** @type {Map<string, Hit|null>} */
  const seen = new Map();
  let retriedAuth = false;
  let first = true;
  let lastError = null;
  /** @type {Hit|null} */
  let blocked = null;

  for (;;) {
    if (signal?.aborted) throw abortError();
    onProgress?.({ phase: first ? 'checking' : 'waiting', deadline, blocked });
    first = false;

    // True when this check could not see everything, so a newer code may exist.
    let incomplete = false;

    try {
      const token = await deps.getToken();
      // Gmail's after: filter works in whole seconds, so ask for a minute more
      // and apply the exact cutoff using each message's received time.
      const ids = await deps.listIds(token, { afterMs: since - 60_000, max: maxPerCheck, signal });
      const fresh = ids.filter(id => !seen.has(id));

      const parsed = await Promise.all(fresh.map(async id => {
        try {
          return parseMessage(await deps.getMessage(token, id, signal));
        } catch (error) {
          if (error?.name === 'AbortError' || error?.status === 401) throw error;
          if (!isRetryable(error)) return null;
          lastError = error;
          return undefined;
        }
      }));

      fresh.forEach((id, i) => {
        const message = parsed[i];
        // Not cached, so the next check tries this message again.
        if (message === undefined) {
          incomplete = true;
          return;
        }
        if (!message || message.receivedAt < since) {
          seen.set(id, null);
          return;
        }
        const match = extractCode(message);
        if (!match) {
          seen.set(id, null);
          return;
        }
        /** @type {Hit} */
        const hit = {
          id,
          code: match.code,
          score: match.score,
          reason: match.reason,
          receivedAt: message.receivedAt,
          from: message.from,
          subject: message.subject,
          sender: checkSender(message),
          spam: message.spam,
          verdict: ''
        };
        seen.set(id, hit);
      });
      retriedAuth = false;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      if (error?.status === 401 && !retriedAuth && deps.dropToken) {
        retriedAuth = true;
        await deps.dropToken();
        continue;
      }
      if (!isRetryable(error)) throw error;
      // A dropped connection or a busy Gmail: keep trying until the deadline.
      lastError = error;
      incomplete = true;
    }

    // Classify on every check: the verdict depends on the page, which the
    // caller re-reads, and on pairs you may have approved meanwhile.
    const usable = [...seen.values()]
      .filter(hit => hit && !skipIds.has(hit.id))
      .map(hit => Object.assign(hit, { verdict: String(classify(hit)) }))
      .sort((a, b) => b.receivedAt - a.receivedAt);
    const newest = usable.find(hit => AUTO_FILL.has(hit.verdict));
    const previousBlocked = blocked;
    blocked = usable.find(hit => !AUTO_FILL.has(hit.verdict)) ?? null;
    if (blocked?.id !== previousBlocked?.id || blocked?.verdict !== previousBlocked?.verdict) onBlocked?.(blocked);
    const timeLeft = now() + pollMs <= deadline;

    if (newest && (!incomplete || !timeLeft)) return newest;
    if (blocked && stopOnBlocked && !incomplete) return blocked;
    if (!timeLeft) {
      if (blocked) return blocked;
      if (incomplete && lastError) throw lastError;
      return null;
    }
    await wait(pollMs, signal);
  }
}

/**
 * Network failures, rate limits and server errors are worth another try.
 * @param {any} error
 */
function isRetryable(error) {
  const status = error?.status;
  return status === 0 || status === 429 || (typeof status === 'number' && status >= 500);
}
