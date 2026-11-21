/**
 * Registrable domains ("eTLD+1") from the bundled Public Suffix List.
 *
 * Q-Fill only fills a code into a page whose registrable domain is the same
 * as the sender's: mail from accounts.example.co.jp may fill example.co.jp
 * and login.example.co.jp, never evil.co.jp.
 *
 * Pure functions with no browser APIs, so they run in the service worker,
 * in the popup and in Node tests alike.
 */

import { PSL_RULES } from './psl-data.js';

/** @type {Set<string>|null} */
let rules = null;

function ruleSet() {
  rules ??= new Set(PSL_RULES.split('\n'));
  return rules;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Normalises a host name to lower-case ASCII (punycode), without a trailing
 * dot. Returns '' for anything that is not a plain DNS host name: IP
 * addresses, localhost, single labels, ports, paths and garbage.
 * @param {string} host
 * @returns {string}
 */
export function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  const raw = host.trim().replace(/\.$/, '');
  if (!raw || raw.length > 253 || /[\s/\\?#@:[\]%]/.test(raw)) return '';
  let ascii;
  try {
    ascii = new URL(`https://${raw}/`).hostname;
  } catch {
    return '';
  }
  ascii = ascii.replace(/\.$/, '');
  if (!ascii || IPV4.test(ascii) || ascii.startsWith('[')) return '';
  const labels = ascii.split('.');
  if (labels.length < 2 || labels.some(l => !l || l.length > 63)) return '';
  if (!labels.every(l => /^[a-z0-9-]+$/.test(l) && !l.startsWith('-') && !l.endsWith('-'))) return '';
  if (labels[labels.length - 1] === 'localhost') return '';
  return ascii;
}

/**
 * The registrable domain of a host, such as "example.co.jp" for
 * "login.example.co.jp". Returns '' when the host is itself a public suffix
 * (co.jp, github.io) or is not a plain host name.
 * @param {string} host
 * @returns {string}
 */
export function registrableDomain(host) {
  const ascii = normalizeHost(host);
  if (!ascii) return '';
  const labels = ascii.split('.');
  const set = ruleSet();

  // Find the longest matching rule. Exception rules win over wildcards.
  let suffixLength = 1; // The default rule "*".
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    const length = labels.length - i;
    if (set.has(`!${candidate}`)) {
      suffixLength = length - 1;
      break;
    }
    const wildcard = ['*', ...labels.slice(i + 1)].join('.');
    if (set.has(candidate) || set.has(wildcard)) {
      suffixLength = Math.max(suffixLength, length);
      break;
    }
  }

  if (labels.length <= suffixLength) return '';
  return labels.slice(labels.length - suffixLength - 1).join('.');
}

/**
 * The registrable domain of a page URL. Only https pages count.
 * @param {string} url
 * @returns {string}
 */
export function siteOfUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'https:') return '';
  return registrableDomain(parsed.hostname);
}

/**
 * True when two registrable domains are the same and both are real.
 * @param {string} a
 * @param {string} b
 */
export function sameSite(a, b) {
  return Boolean(a) && Boolean(b) && a === b;
}
