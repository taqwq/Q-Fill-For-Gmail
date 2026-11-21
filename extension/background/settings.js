/**
 * Settings kept in chrome.storage.local (they survive a browser restart) and
 * per-session data kept in chrome.storage.session (memory only, cleared when
 * the browser closes).
 */

import { DEFAULT_CLIENT_ID } from '../config.js';
import { DEFAULT_LOOKBACK_MINUTES, LOOKBACK_CHOICES } from '../shared/constants.js';

/**
 * @typedef {object} Settings
 * @property {string} clientId - Your Google OAuth client ID.
 * @property {string} email - The Gmail address you connected, or '' when not connected.
 * @property {number} lookbackMinutes - How far back to look for a code.
 * @property {string[]} trustedPairs - Sender-to-site pairs you approved, see sender.js pairKey().
 * @property {boolean} suggestEnabled - Offer a code by the field on its own.
 * @property {boolean} autoStart - Start looking as soon as the popup opens.
 */

/** "bank.co.jp -> bankpay.jp" with two plain ASCII domains. */
const PAIR = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])? -> [a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const stored = await chrome.storage.local.get(['clientId', 'email', 'lookbackMinutes', 'trustedPairs', 'suggestEnabled', 'autoStart']);
  const lookback = Number(stored.lookbackMinutes);
  return {
    clientId: stored.clientId || DEFAULT_CLIENT_ID || '',
    email: stored.email || '',
    lookbackMinutes: LOOKBACK_CHOICES.includes(lookback) ? lookback : DEFAULT_LOOKBACK_MINUTES,
    trustedPairs: Array.isArray(stored.trustedPairs) ? stored.trustedPairs.filter(p => typeof p === 'string' && PAIR.test(p)) : [],
    suggestEnabled: stored.suggestEnabled === true,
    autoStart: stored.autoStart !== false
  };
}

/** @param {string} key - From pairKey(). */
export async function addTrustedPair(key) {
  if (!PAIR.test(key)) return;
  const { trustedPairs } = await getSettings();
  if (!trustedPairs.includes(key)) await saveSettings({ trustedPairs: [...trustedPairs, key].slice(-200) });
}

/** @param {string} key */
export async function removeTrustedPair(key) {
  const { trustedPairs } = await getSettings();
  await saveSettings({ trustedPairs: trustedPairs.filter(p => p !== key) });
}

/** @param {Partial<Settings>} patch */
export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

const USED_KEY = 'usedMessageIds';
const USED_LIMIT = 50;

/**
 * Message IDs whose code was already filled, so the same email is never
 * filled twice. Memory only.
 * @returns {Promise<Set<string>>}
 */
export async function getUsedMessageIds() {
  const { [USED_KEY]: ids = [] } = await chrome.storage.session.get(USED_KEY);
  return new Set(ids);
}

/** @param {string} id */
export async function markMessageUsed(id) {
  const { [USED_KEY]: ids = [] } = await chrome.storage.session.get(USED_KEY);
  const next = [id, ...ids.filter(x => x !== id)].slice(0, USED_LIMIT);
  await chrome.storage.session.set({ [USED_KEY]: next });
}

const LAST_KEY = 'lastResult';

/**
 * The outcome of the last run, shown when you reopen the popup. Memory only.
 * @returns {Promise<object|null>}
 */
export async function getLastResult() {
  const { [LAST_KEY]: last = null } = await chrome.storage.session.get(LAST_KEY);
  return last;
}

/** @param {object|null} result */
export async function setLastResult(result) {
  if (result) await chrome.storage.session.set({ [LAST_KEY]: result });
  else await chrome.storage.session.remove(LAST_KEY);
}

/** Forgets everything tied to the connected account. */
export async function clearSession() {
  await chrome.storage.session.clear();
}
