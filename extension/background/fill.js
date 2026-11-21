/**
 * Puts a code into the page through content/autofill.js.
 *
 * Q-Fill has no access to any site until you click its icon or press its
 * shortcut. That gesture grants temporary access to the current tab
 * (activeTab), which is all this needs. If you turned on suggestions, Q-Fill
 * also has access to https pages so it can offer a code by the field.
 *
 * A code only ever goes into a frame whose registrable domain is the one the
 * code was checked against. The check happens twice: here, against the
 * origin each frame reports, and again inside the frame at the moment of
 * typing, so a frame that navigated in between is refused.
 */

import { registrableDomain } from '../core/domain.js';

const SCRIPT = 'content/autofill.js';

/**
 * @typedef {object} FillResult
 * @property {boolean} ok
 * @property {'blocked'|'no-field'|'rejected'|'bad-code'|'gone'|'origin'} [reason]
 */

/**
 * The registrable domain of an https origin such as "https://login.bank.co.jp".
 * @param {string} origin
 */
export function siteOfOrigin(origin) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) return '';
  try {
    const url = new URL(origin);
    if (url.origin !== origin) return '';
    return registrableDomain(url.hostname);
  } catch {
    return '';
  }
}

/**
 * Asks every frame Q-Fill may access for its best code field.
 * @param {number} tabId
 * @param {number} codeLength
 * @returns {Promise<{ ok: true, probes: Array<{ frameId: number, documentId?: string, score: number, origin: string, site: string }> } | { ok: false, reason: 'blocked'|'gone' }>}
 */
export async function probeTab(tabId, codeLength = 6) {
  try {
    await inject({ tabId, allFrames: true });
  } catch (error) {
    if (/No tab with id/i.test(String(error?.message))) return { ok: false, reason: 'gone' };
    return { ok: false, reason: 'blocked' };
  }

  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: length => globalThis.__qfill?.probe(length) ?? null,
      args: [codeLength]
    });
  } catch {
    return { ok: false, reason: 'blocked' };
  }

  const probes = results
    .filter(r => r?.result && typeof r.result.score === 'number')
    .map(r => ({
      frameId: r.frameId,
      documentId: r.documentId,
      score: r.result.score,
      origin: String(r.result.origin || ''),
      site: siteOfOrigin(String(r.result.origin || ''))
    }));
  return { ok: true, probes };
}

/**
 * Sites (registrable domains) of every frame that has a code field.
 * @param {number} tabId
 * @returns {Promise<string[]>}
 */
export async function fieldSites(tabId) {
  const probe = await probeTab(tabId);
  if (!probe.ok) return [];
  return [...new Set(probe.probes.map(p => p.site).filter(Boolean))];
}

/**
 * Fills the best field among the frames that belong to `site`.
 * @param {number} tabId
 * @param {string} code
 * @param {string} site - Registrable domain the code was checked against.
 * @param {{ frameId?: number, documentId?: string }} [only] - Limit to one frame.
 * @returns {Promise<FillResult>}
 */
export async function fillCodeInTab(tabId, code, site, only = {}) {
  if (!site) return { ok: false, reason: 'origin' };
  const probe = await probeTab(tabId, code.length);
  if (!probe.ok) return { ok: false, reason: probe.reason };

  const eligible = probe.probes.filter(p =>
    p.site === site &&
    (only.frameId === undefined || p.frameId === only.frameId) &&
    (only.documentId === undefined || p.documentId === only.documentId));
  const best = eligible.sort((a, b) => b.score - a.score || (a.frameId === 0 ? -1 : 1))[0];
  if (!best) {
    // A field exists, but only in frames of another site.
    return { ok: false, reason: probe.probes.length ? 'origin' : 'no-field' };
  }

  // Target the exact document that was checked, so a navigation in between
  // makes this call fail instead of typing into the new page.
  const target = best.documentId ? { tabId, documentIds: [best.documentId] } : { tabId, frameIds: [best.frameId] };
  try {
    const [run] = await chrome.scripting.executeScript({
      target,
      func: (value, origin) => globalThis.__qfill.fill(value, origin),
      args: [code, best.origin]
    });
    return run?.result ?? { ok: false, reason: 'rejected' };
  } catch {
    return { ok: false, reason: 'origin' };
  }
}

/**
 * Shows a short message at the bottom of the page. Fails quietly on pages the
 * extension cannot touch, such as the browser's own settings pages.
 *
 * The page can read what is shown, so callers never pass a code here unless
 * it was just typed into that same page.
 * @param {number} tabId
 * @param {string} text
 * @param {'success'|'error'|'info'} tone
 * @param {number} [durationMs]
 */
export async function showToast(tabId, text, tone, durationMs) {
  try {
    await inject({ tabId, frameIds: [0] });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (message, kind, ms) => globalThis.__qfill?.toast(message, kind, ms),
      args: [text, tone, durationMs ?? 3200]
    });
  } catch {
    // Nothing to show on a page we cannot reach.
  }
}

/** @param {chrome.scripting.InjectionTarget} target */
function inject(target) {
  return chrome.scripting.executeScript({ target, files: [SCRIPT] });
}
