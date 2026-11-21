/**
 * Who really sent an email, and whether its code may go into a given site.
 *
 * The From header alone is easy to forge, so Q-Fill trusts the sender's
 * domain only when Gmail's own authentication checks vouch for it: the
 * topmost Authentication-Results header, written by Gmail's receiving server,
 * must show DMARC passing, or DKIM or SPF passing for the same registrable
 * domain as From (DMARC's "relaxed alignment").
 *
 * Pure functions with no browser APIs, so they run in the service worker and
 * in Node tests alike.
 */

import { normalizeHost, registrableDomain, sameSite } from './domain.js';

/** The authserv-id Gmail writes on mail it receives. */
export const GMAIL_AUTHSERV_ID = 'mx.google.com';

/** A plain addr-spec. Quoted local parts and comments are refused. */
const ADDR_SPEC = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@([^\s@<>()[\],;:\\"]+)$/;

/**
 * Reads the one sender address from a From header value, as Gmail returns it
 * (encoded words already decoded). Only the address inside the angle brackets
 * counts, never the display name, so `"x@bank.co.jp" <a@evil.example>` is
 * from evil.example. Headers with more than one address are refused.
 * @param {string} from
 * @returns {{ address: string, host: string } | null}
 */
export function parseFrom(from) {
  if (typeof from !== 'string') return null;
  const value = from.trim();
  if (!value || value.length > 998) return null;

  let address;
  const angle = /^([^<>]*)<([^<>]+)>\s*$/.exec(value);
  if (angle) {
    // A display name with an unquoted comma or another @ address hints at a list.
    const display = angle[1].replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (/[,;]/.test(display)) return null;
    address = angle[2].trim();
  } else if (!/[<>]/.test(value)) {
    address = value;
  } else {
    return null;
  }

  const match = ADDR_SPEC.exec(address);
  if (!match) return null;
  const host = normalizeHost(match[1]);
  if (!host) return null;
  return { address: address.toLowerCase(), host };
}

/** Removes RFC 5322 comments "( ... )", including nested ones. */
function stripComments(text) {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (!depth) out += c + text[i + 1];
      i++;
      continue;
    }
    if (c === '"' && !depth) quoted = !quoted;
    if (!quoted && c === '(') {
      depth++;
      continue;
    }
    if (!quoted && c === ')' && depth) {
      depth--;
      out += ' ';
      continue;
    }
    if (!depth) out += c;
  }
  return out;
}

/**
 * @typedef {object} AuthResult
 * @property {string} method - dkim, spf, dmarc, ...
 * @property {string} result - pass, fail, none, ...
 * @property {Record<string, string>} props - e.g. { 'header.i': '@example.com' }
 */

/**
 * Parses one Authentication-Results header value (RFC 8601).
 * @param {string} value
 * @returns {{ authservId: string, results: AuthResult[] } | null}
 */
export function parseAuthenticationResults(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parts = stripComments(value.replace(/\r?\n[ \t]+/g, ' ')).split(';').map(p => p.trim());
  const authservId = (parts.shift() || '').split(/\s+/)[0].toLowerCase();
  if (!authservId) return null;

  const results = [];
  for (const part of parts) {
    if (!part) continue;
    const tokens = part.split(/\s+/);
    const head = /^([a-z0-9-]+)\s*=\s*([a-z]+)$/i.exec(tokens.shift() || '');
    if (!head) continue;
    const props = {};
    for (const token of tokens) {
      const prop = /^([a-z0-9-]+\.[a-z0-9_-]+)=(.+)$/i.exec(token);
      if (prop) props[prop[1].toLowerCase()] = prop[2].replace(/^"|"$/g, '');
    }
    results.push({ method: head[1].toLowerCase(), result: head[2].toLowerCase(), props });
  }
  return { authservId, results };
}

/** Domain part of "user@host", "@host" or "host". */
function hostOf(value) {
  if (!value) return '';
  const at = value.lastIndexOf('@');
  return normalizeHost(at === -1 ? value : value.slice(at + 1));
}

/**
 * @typedef {object} SenderCheck
 * @property {string} domain - Registrable domain of the From address, '' when unreadable.
 * @property {boolean} verified - True when Gmail's checks vouch for that domain.
 * @property {string} method - 'dmarc', 'dkim' or 'spf' when verified, else why not.
 */

/**
 * Decides whether the From domain of a message is authentic.
 * @param {{ from: string, authResults: string[] }} message
 *   authResults: every Authentication-Results header value, top first.
 * @returns {SenderCheck}
 */
export function checkSender({ from, authResults }) {
  const parsed = parseFrom(from);
  const domain = parsed ? registrableDomain(parsed.host) : '';
  if (!domain) return { domain: '', verified: false, method: 'bad-from' };

  // Only the topmost header is Gmail's own. Anything below it came with the
  // message and may be forged by the sender.
  const top = parseAuthenticationResults(authResults?.[0] ?? '');
  if (!top || top.authservId !== GMAIL_AUTHSERV_ID) return { domain, verified: false, method: 'no-auth' };

  const aligned = host => sameSite(registrableDomain(host), domain);
  const dmarc = top.results.filter(r => r.method === 'dmarc');
  if (dmarc.some(r => r.result !== 'pass' && r.result !== 'none' && r.result !== 'bestguesspass')) {
    return { domain, verified: false, method: 'dmarc-fail' };
  }
  if (dmarc.some(r => r.result === 'pass' && aligned(hostOf(r.props['header.from'])))) {
    return { domain, verified: true, method: 'dmarc' };
  }
  if (top.results.some(r => r.method === 'dkim' && r.result === 'pass' &&
      (aligned(hostOf(r.props['header.d'])) || aligned(hostOf(r.props['header.i']))))) {
    return { domain, verified: true, method: 'dkim' };
  }
  if (top.results.some(r => r.method === 'spf' && r.result === 'pass' && aligned(hostOf(r.props['smtp.mailfrom'])))) {
    return { domain, verified: true, method: 'spf' };
  }
  return { domain, verified: false, method: 'not-aligned' };
}

/**
 * How a code relates to the site it would be filled into.
 *
 *   match       verified sender, same registrable domain as the site
 *   trusted     verified sender, a pair you approved before
 *   mismatch    verified sender, a different site
 *   unverified  Gmail's checks do not vouch for the sender
 *   spam        the message is in Spam
 *   no-site     the page is not an https page with a real domain
 *
 * Only 'match' and 'trusted' are filled without asking.
 *
 * @param {{ sender: SenderCheck, spam?: boolean }} hit
 * @param {string} site - Registrable domain of the page, '' when not eligible.
 * @param {Iterable<string>} [trustedPairs] - Entries made by pairKey().
 * @returns {'match'|'trusted'|'mismatch'|'unverified'|'spam'|'no-site'}
 */
export function verdict(hit, site, trustedPairs = []) {
  if (!site) return 'no-site';
  if (hit.spam) return 'spam';
  if (!hit.sender?.verified || !hit.sender.domain) return 'unverified';
  if (sameSite(hit.sender.domain, site)) return 'match';
  const key = pairKey(hit.sender.domain, site);
  for (const pair of trustedPairs) if (pair === key) return 'trusted';
  return 'mismatch';
}

/**
 * The best verdict for a page with several candidate sites, such as a shop
 * page with a sign-in frame from the bank. Returns the site that verdict is
 * for, which is where the code may go.
 * @param {{ sender: SenderCheck, spam?: boolean }} hit
 * @param {string[]} sites - Registrable domains, most important first.
 * @param {Iterable<string>} [trustedPairs]
 * @returns {{ verdict: ReturnType<typeof verdict>, site: string }}
 */
export function bestVerdict(hit, sites, trustedPairs = []) {
  const pairs = [...trustedPairs];
  const rank = ['match', 'trusted', 'mismatch', 'unverified', 'spam', 'no-site'];
  let best = { verdict: /** @type {ReturnType<typeof verdict>} */ ('no-site'), site: '' };
  for (const site of sites.filter(Boolean)) {
    const v = verdict(hit, site, pairs);
    if (best.site === '' || rank.indexOf(v) < rank.indexOf(best.verdict)) best = { verdict: v, site };
  }
  return best;
}

/** Verdicts that may be filled with no further question. */
export const AUTO_FILL = new Set(['match', 'trusted']);

/**
 * Key of a remembered sender-to-site pair.
 * @param {string} senderDomain
 * @param {string} site
 */
export function pairKey(senderDomain, site) {
  return `${senderDomain} -> ${site}`;
}
