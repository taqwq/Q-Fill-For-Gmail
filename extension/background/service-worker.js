/**
 * Q-Fill service worker.
 *
 * Runs a find when you press Fill in the popup or use the keyboard shortcut,
 * offers a code by the field when suggestions are on, and keeps the popup up
 * to date over a long-lived port.
 *
 * The rule that everything here follows: a code goes into a page only when
 * the email's sender is authenticated by Gmail and its registrable domain is
 * the page's (or a pair you approved). Anything else needs your explicit
 * confirmation in the popup, and is never shown to the page.
 */

import {
  CLIENT_ID_PATTERN,
  LOOKBACK_CHOICES,
  MAX_MESSAGES_PER_CHECK,
  OFFER_TTL_MS,
  PAGE,
  PHASE,
  POLL_INTERVAL_MS,
  PORT_NAME,
  REQUEST,
  STATE,
  SUGGEST_COOLDOWN_MS,
  SUGGEST_ORIGINS,
  SUGGEST_SCRIPT_ID,
  WAIT_FOR_EMAIL_MS
} from '../shared/constants.js';
import { t } from '../shared/i18n.js';
import { findNewestCode } from '../core/finder.js';
import { siteOfUrl } from '../core/domain.js';
import { AUTO_FILL, bestVerdict, pairKey, verdict } from '../core/sender.js';
import { AuthError, dropToken, getAccessToken, redirectUri, signIn, signOut } from './auth.js';
import { GmailError, getEmailAddress, getMessage, listRecentMessageIds } from './gmail.js';
import { fieldSites, fillCodeInTab, showToast, siteOfOrigin } from './fill.js';
import {
  addTrustedPair,
  clearSession,
  getLastResult,
  getSettings,
  getUsedMessageIds,
  markMessageUsed,
  removeTrustedPair,
  saveSettings,
  setLastResult
} from './settings.js';

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();

/** The run in progress, if any. */
let job = null;

/** True while the Google sign-in window is open. */
let connecting = false;

/** The last sign-in error, shown in the popup until the next attempt. */
let authError = '';

// ---------------------------------------------------------------------------
// State sent to the popup

async function snapshot() {
  const [settings, last, commands, suggestGranted] = await Promise.all([
    getSettings(),
    getLastResult(),
    chrome.commands.getAll().catch(() => []),
    hasSuggestPermission()
  ]);
  return {
    type: STATE,
    extensionId: chrome.runtime.id,
    redirectUri: redirectUri(),
    clientId: settings.clientId,
    email: settings.email,
    lookbackMinutes: settings.lookbackMinutes,
    trustedPairs: settings.trustedPairs,
    suggestEnabled: settings.suggestEnabled && suggestGranted,
    autoStart: settings.autoStart,
    shortcut: commands.find(c => c.name === 'fill-code')?.shortcut || '',
    connecting,
    authError,
    job: job ? { phase: job.phase, deadline: job.deadline, tabId: job.tabId, blocked: job.blocked } : null,
    last
  };
}

async function broadcast() {
  if (!ports.size) return;
  const state = await snapshot();
  for (const port of ports) {
    try {
      port.postMessage(state);
    } catch {
      ports.delete(port);
    }
  }
}

// ---------------------------------------------------------------------------
// Errors in plain language

/** @param {unknown} error */
function describe(error) {
  if (error instanceof AuthError) {
    const key = {
      no_client_id: 'errorNoClientId',
      cancelled: 'errorSignInCancelled',
      access_denied: 'errorAccessDenied',
      scope_denied: 'errorScopeDenied',
      interaction_required: 'errorSignInAgain'
    }[error.code];
    return key ? t(key) : t('errorSignInFailed', error.message);
  }
  if (error instanceof GmailError) {
    if (error.status === 0) return t('errorOffline');
    if (error.status === 401) return t('errorSignInAgain');
    if (error.status === 403) return t('errorGmailForbidden');
    if (error.status === 429) return t('errorRateLimited');
    return t('errorGmail', error.message);
  }
  return t('errorUnexpected', String(error?.message || error));
}

// ---------------------------------------------------------------------------
// Which sites a tab may receive a code for

/**
 * Registrable domains a code could go to in this tab: every frame with a
 * code field, then the page itself. Only https pages count.
 * @param {number} tabId
 * @returns {Promise<string[]>}
 */
async function tabSites(tabId) {
  return (await tabInfo(tabId)).sites;
}

/**
 * The sites a code could go to, the page's own site, and whether any frame
 * has a code field.
 * @param {number} tabId
 */
async function tabInfo(tabId) {
  const top = await pageSite(tabId);
  const fields = await fieldSites(tabId);
  return { sites: [...new Set([...fields, top].filter(Boolean))], top, hasField: fields.length > 0 };
}

/**
 * Registrable domain of the page in the tab, '' when not an https page.
 * @param {number} tabId
 */
async function pageSite(tabId) {
  try {
    return siteOfUrl((await chrome.tabs.get(tabId)).url || '');
  } catch {
    return '';
  }
}

/**
 * Sets hit.action, hit.site and hit.linkSite and returns the verdict.
 *
 * A message with a code is filled when the page has a code field. A message
 * with a confirmation link and no field to fill opens the link, and only when
 * the link goes to the page's own site: the sender check alone would let a
 * real sender's email send you anywhere.
 * @param {any} hit
 * @param {{ sites: string[], top: string, hasField: boolean }} info
 * @param {string[]} trustedPairs
 */
function classifyHit(hit, info, trustedPairs) {
  hit.action = hit.link && (!hit.code || !info.hasField) ? 'link' : 'code';
  if (hit.action === 'code') {
    const best = bestVerdict(hit, info.sites, trustedPairs);
    hit.site = best.site;
    return best.verdict;
  }
  hit.site = info.top;
  hit.linkSite = siteOfUrl(hit.link);
  const result = verdict(hit, info.top, trustedPairs);
  if (AUTO_FILL.has(result) && hit.linkSite !== info.top) return 'link-host';
  return result;
}

/** What the popup shows about a hit. Never sent to a page. */
function describeHit(hit) {
  return {
    code: hit.code,
    link: hit.action === 'link' ? hit.link : '',
    linkSite: hit.action === 'link' ? hit.linkSite || '' : '',
    action: hit.action || 'code',
    messageId: hit.id,
    senderDomain: hit.sender?.domain || '',
    verified: Boolean(hit.sender?.verified),
    spam: Boolean(hit.spam),
    verdict: hit.verdict,
    site: hit.site || '',
    subject: hit.subject,
    receivedAt: hit.receivedAt
  };
}

// ---------------------------------------------------------------------------
// Find and fill, started by you

/**
 * @param {number} tabId
 * @param {'popup'|'shortcut'} source
 */
async function startFind(tabId, source) {
  if (job) {
    if (job.tabId === tabId) return;
    job.controller.abort();
  }
  stopWatch(tabId);

  // Claim the slot before any await, so a second press cannot start a second run.
  const controller = new AbortController();
  const current = { tabId, phase: PHASE.CHECKING, deadline: 0, controller, waitingToastShown: false, blocked: null, confirmed: false };
  job = current;

  const settings = await getSettings();
  if (!settings.clientId || !settings.email) {
    if (job === current) job = null;
    if (source === 'shortcut') await showToast(tabId, t('toastConnectFirst'), 'info', 4000);
    return broadcast();
  }

  await chrome.action.setBadgeText({ text: '…' });
  await broadcast();

  let result;
  try {
    const info = await tabInfo(tabId);
    const hit = await findNewestCode(
      {
        getToken: () => getAccessToken({ interactive: true }),
        listIds: listRecentMessageIds,
        getMessage,
        dropToken
      },
      {
        lookbackMs: settings.lookbackMinutes * 60_000,
        waitMs: WAIT_FOR_EMAIL_MS,
        pollMs: POLL_INTERVAL_MS,
        maxPerCheck: MAX_MESSAGES_PER_CHECK,
        skipIds: await getUsedMessageIds(),
        links: true,
        signal: controller.signal,
        // A blocked code does not end the wait: the right one may still be on
        // its way, and anyone can mail you a code-shaped message. The popup
        // shows the blocked one meanwhile and lets you fill it if you choose.
        onBlocked: found => {
          current.blocked = found ? { tabId, ...describeHit(found) } : null;
          if (found && !current.blockedToastShown) {
            current.blockedToastShown = true;
            showToast(tabId, t(found.action === 'link' ? 'toastBlockedWaitingLink' : 'toastBlockedWaiting'), 'info', 0);
          }
          broadcast();
        },
        classify: found => classifyHit(found, info, settings.trustedPairs),
        onProgress: progress => {
          current.phase = progress.phase;
          current.deadline = progress.deadline;
          if (progress.phase === PHASE.WAITING && !current.waitingToastShown) {
            current.waitingToastShown = true;
            showToast(tabId, t('toastWaiting'), 'info', 0);
          }
          broadcast();
        }
      }
    );

    if (!hit) {
      result = { status: 'none', lookbackMinutes: settings.lookbackMinutes };
      await showToast(tabId, t('toastNoCode'), 'error', 4500);
    } else if (!AUTO_FILL.has(hit.verdict)) {
      // The code stays in the popup. The page only learns that Q-Fill stopped.
      result = { status: 'blocked', tabId, ...describeHit(hit) };
      await showToast(tabId, t(hit.action === 'link' ? 'toastBlockedLink' : 'toastBlocked'), 'error', 6000);
    } else if (hit.action === 'link') {
      current.phase = PHASE.FILLING;
      await broadcast();
      result = await openHit(tabId, hit);
    } else {
      current.phase = PHASE.FILLING;
      await broadcast();
      result = await fillHit(tabId, hit);
    }
  } catch (error) {
    if (error?.name === 'AbortError') {
      // Stopped because you chose to fill the blocked code: that writes its own result.
      result = job === current && !current.confirmed ? { status: 'cancelled' } : null;
      if (!current.confirmed) await showToast(tabId, '', 'info');
    } else {
      console.warn('[Q-Fill]', error);
      result = { status: 'error', message: describe(error) };
      await showToast(tabId, result.message, 'error', 6000);
      if (error instanceof AuthError && error.code === 'no_client_id') await saveSettings({ email: '' });
    }
  } finally {
    if (job === current) {
      job = null;
      await chrome.action.setBadgeText({ text: '' });
    }
  }

  if (result) await setLastResult({ ...result, at: Date.now() });
  await broadcast();
}

/**
 * Fills a hit into the frames of hit.site and reports the outcome.
 * @param {number} tabId
 * @param {any} hit
 */
async function fillHit(tabId, hit) {
  const fill = await fillCodeInTab(tabId, hit.code, hit.site);
  if (fill.ok) await markMessageUsed(hit.id);
  const domain = hit.sender?.domain || '';
  if (fill.ok) {
    await showToast(tabId, t('toastFilled', [domain]), 'success', 3200);
  } else {
    const key = fill.reason === 'no-field' ? 'toastNoField' : fill.reason === 'origin' ? 'toastOriginChanged' : 'toastRejected';
    await showToast(tabId, t(key), 'error', 6000);
  }
  return {
    status: fill.ok ? 'filled' : 'found',
    reason: fill.reason || '',
    tabId,
    ...describeHit(hit)
  };
}

/**
 * Opens a confirmation link in a new tab next to the page, after checking
 * that the page still shows the site the link was checked against.
 * @param {number} tabId
 * @param {any} hit
 */
async function openHit(tabId, hit) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    tab = null;
  }
  if (!tab || !hit.site || siteOfUrl(tab.url || '') !== hit.site || !hit.link) {
    if (tab) await showToast(tabId, t('toastOriginChanged'), 'error', 6000);
    return { status: 'found', reason: tab ? 'origin' : 'gone', tabId, ...describeHit(hit) };
  }
  // Clear a waiting message first: the page stays open behind the new tab.
  await showToast(tabId, '', 'info');
  await chrome.tabs.create({ url: hit.link, index: tab.index + 1, openerTabId: tabId, windowId: tab.windowId, active: true });
  await markMessageUsed(hit.id);
  return { status: 'opened', reason: '', tabId, ...describeHit(hit) };
}

/**
 * Fills the code the popup is showing as blocked, after you confirmed it.
 * Re-checks that the tab still shows the same site.
 * @param {boolean} remember - Also trust this sender for this site from now on.
 */
async function fillBlocked(remember) {
  let last = await getLastResult();
  if (job?.blocked) {
    // Still waiting: stop the wait and use the code the popup is showing.
    last = { status: 'blocked', ...job.blocked };
    job.confirmed = true;
    job.controller.abort();
  }
  if (!last || last.status !== 'blocked' || !last.site || !Number.isInteger(last.tabId)) return;
  const isLink = last.action === 'link';
  if (!['mismatch', 'unverified', 'spam', ...(isLink ? ['link-host'] : [])].includes(last.verdict)) return;

  const sites = isLink ? [await pageSite(last.tabId)] : await tabSites(last.tabId);
  if (!sites.includes(last.site)) {
    await setLastResult({ ...last, status: 'found', reason: 'origin', at: Date.now() });
    return broadcast();
  }

  // Only an authenticated sender can be remembered: a forged From must never
  // become trusted for good.
  if (remember && last.verdict === 'mismatch' && last.verified && last.senderDomain) {
    await addTrustedPair(pairKey(last.senderDomain, last.site));
  }

  const hit = {
    id: last.messageId,
    code: last.code,
    link: last.link,
    linkSite: last.linkSite,
    action: last.action,
    site: last.site,
    subject: last.subject,
    receivedAt: last.receivedAt,
    spam: last.spam,
    sender: { domain: last.senderDomain, verified: last.verified },
    verdict: last.verdict
  };
  const result = isLink ? await openHit(last.tabId, hit) : await fillHit(last.tabId, hit);
  await setLastResult({ ...result, confirmed: true, at: Date.now() });
  await broadcast();
}

// ---------------------------------------------------------------------------
// Suggestions by the field (opt-in)

/**
 * Searches running because a page focused a code field, one per tab.
 * @type {Map<number, { documentId: string, controller: AbortController }>}
 */
const watches = new Map();

/** documentId -> time the last suggestion search for it ended without a code. */
const cooldowns = new Map();

/**
 * Codes offered to a page and waiting for your click. The code itself never
 * leaves the service worker until then.
 * @type {Map<string, { tabId: number, frameId: number, documentId: string, origin: string, site: string, hit: any, at: number }>}
 */
const offers = new Map();

async function hasSuggestPermission() {
  try {
    return await chrome.permissions.contains({ origins: [...SUGGEST_ORIGINS] });
  } catch {
    return false;
  }
}

/** Registers or removes the suggestion script to match the setting and the permission. */
async function syncSuggestScript() {
  const { suggestEnabled } = await getSettings();
  const wanted = suggestEnabled && (await hasSuggestPermission());
  let registered = [];
  try {
    registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SUGGEST_SCRIPT_ID] });
  } catch {
    registered = [];
  }
  if (wanted && !registered.length) {
    await chrome.scripting.registerContentScripts([{
      id: SUGGEST_SCRIPT_ID,
      matches: [...SUGGEST_ORIGINS],
      js: ['content/autofill.js', 'content/suggest.js'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true
    }]);
  } else if (!wanted && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [SUGGEST_SCRIPT_ID] });
  }
  if (!wanted) {
    for (const tabId of [...watches.keys()]) stopWatch(tabId);
    offers.clear();
  }
}

/** @param {number} tabId */
function stopWatch(tabId) {
  watches.get(tabId)?.controller.abort();
  watches.delete(tabId);
}

/**
 * A page in a tab you are looking at focused a code field. Look for a code
 * from the same site, without ever opening a sign-in window.
 * @param {chrome.runtime.MessageSender} sender
 */
async function onCodeField(sender) {
  const tabId = sender.tab?.id;
  const { frameId, documentId, origin } = sender;
  if (!Number.isInteger(tabId) || !Number.isInteger(frameId) || !documentId || !sender.tab.active) return;
  const site = siteOfOrigin(origin || '');
  if (!site) return;
  if (job?.tabId === tabId) return;

  const settings = await getSettings();
  if (!settings.suggestEnabled || !settings.clientId || !settings.email) return;

  // An offer for this document is already waiting: show it again.
  for (const [offerId, offer] of offers) {
    if (offer.documentId === documentId && Date.now() - offer.at < OFFER_TTL_MS) {
      return sendOffer(offerId, offer);
    }
  }
  if (watches.get(tabId)?.documentId === documentId) return;
  if (Date.now() - (cooldowns.get(documentId) || 0) < SUGGEST_COOLDOWN_MS) return;

  stopWatch(tabId);
  const controller = new AbortController();
  watches.set(tabId, { documentId, controller });

  try {
    const hit = await findNewestCode(
      {
        getToken: () => getAccessToken({ interactive: false }),
        listIds: listRecentMessageIds,
        getMessage,
        dropToken
      },
      {
        lookbackMs: settings.lookbackMinutes * 60_000,
        waitMs: WAIT_FOR_EMAIL_MS,
        pollMs: POLL_INTERVAL_MS,
        maxPerCheck: MAX_MESSAGES_PER_CHECK,
        skipIds: await getUsedMessageIds(),
        signal: controller.signal,
        classify: found => {
          found.site = site;
          return verdict(found, site, settings.trustedPairs);
        }
      }
    );
    if (hit && AUTO_FILL.has(hit.verdict)) {
      const offerId = crypto.randomUUID();
      const offer = { tabId, frameId, documentId, origin, site, hit, at: Date.now() };
      offers.set(offerId, offer);
      await sendOffer(offerId, offer);
    } else {
      // Blocked codes are not offered by the field; the popup explains them.
      cooldowns.set(documentId, Date.now());
    }
  } catch (error) {
    if (error?.name !== 'AbortError') cooldowns.set(documentId, Date.now());
  } finally {
    if (watches.get(tabId)?.controller === controller) watches.delete(tabId);
  }
}

/** Tells the page that a code is ready, with the sender's domain only. */
async function sendOffer(offerId, offer) {
  try {
    await chrome.tabs.sendMessage(offer.tabId, {
      type: PAGE.OFFER,
      offerId,
      senderDomain: offer.hit.sender.domain
    }, { documentId: offer.documentId });
  } catch {
    offers.delete(offerId);
  }
}

/**
 * You clicked the suggestion. Fill only if the click came from the very
 * document the offer was made to, and that document is still on the same site.
 * @param {string} offerId
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function acceptOffer(offerId, sender) {
  const offer = offers.get(offerId);
  offers.delete(offerId);
  if (!offer) return { ok: false, reason: 'expired' };
  if (Date.now() - offer.at > OFFER_TTL_MS) return { ok: false, reason: 'expired' };
  if (sender.tab?.id !== offer.tabId || sender.documentId !== offer.documentId ||
      sender.origin !== offer.origin || siteOfOrigin(sender.origin || '') !== offer.site) {
    return { ok: false, reason: 'origin' };
  }
  const used = await getUsedMessageIds();
  if (used.has(offer.hit.id)) return { ok: false, reason: 'expired' };

  const fill = await fillCodeInTab(offer.tabId, offer.hit.code, offer.site, { documentId: offer.documentId });
  if (fill.ok) {
    await markMessageUsed(offer.hit.id);
    await setLastResult({ status: 'filled', reason: '', tabId: offer.tabId, via: 'suggest', ...describeHit(offer.hit), at: Date.now() });
    await broadcast();
  }
  return { ok: fill.ok, reason: fill.reason };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only this extension's own content scripts, never other extensions or pages.
  if (sender.id !== chrome.runtime.id || !sender.tab || sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  switch (message?.type) {
    case PAGE.FIELD:
      onCodeField(sender).catch(error => console.warn('[Q-Fill]', error));
      return false;
    case PAGE.ACCEPT:
      if (typeof message.offerId !== 'string') return false;
      acceptOffer(message.offerId, sender)
        .then(sendResponse, () => sendResponse({ ok: false, reason: 'rejected' }));
      return true;
    case PAGE.DISMISS: {
      const offer = offers.get(message.offerId);
      if (offer && offer.documentId === sender.documentId) offers.delete(message.offerId);
      if (sender.tab?.id !== undefined && watches.get(sender.tab.id)?.documentId === sender.documentId) {
        stopWatch(sender.tab.id);
        if (sender.documentId) cooldowns.set(sender.documentId, Date.now());
      }
      return false;
    }
    default:
      return false;
  }
});

function forgetTab(tabId) {
  stopWatch(tabId);
  for (const [offerId, offer] of offers) if (offer.tabId === tabId) offers.delete(offerId);
}

chrome.tabs.onRemoved.addListener(forgetTab);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') forgetTab(tabId);
});

// The permission prompt can close the popup before it hears the answer, so
// the setting is saved first and the script is registered when Chrome grants.
chrome.permissions.onAdded.addListener(() => {
  syncSuggestScript().then(broadcast).catch(error => console.warn('[Q-Fill]', error));
});

chrome.permissions.onRemoved.addListener(() => {
  syncSuggestScript().then(broadcast).catch(error => console.warn('[Q-Fill]', error));
});

// ---------------------------------------------------------------------------
// Account

async function connect() {
  if (connecting) return;
  connecting = true;
  authError = '';
  await broadcast();
  try {
    const token = await signIn();
    const email = await getEmailAddress(token);
    await saveSettings({ email });
    await setLastResult(null);
    chrome.action.openPopup?.()?.catch(() => {});
  } catch (error) {
    authError = describe(error);
  } finally {
    connecting = false;
    await broadcast();
  }
}

async function disconnect() {
  job?.controller.abort();
  for (const tabId of [...watches.keys()]) stopWatch(tabId);
  offers.clear();
  await signOut();
  await saveSettings({ email: '' });
  await clearSession();
  authError = '';
  await broadcast();
}

// ---------------------------------------------------------------------------
// Messages from the popup

/** @param {any} message */
async function handle(message) {
  switch (message?.type) {
    case REQUEST.SAVE_CLIENT_ID: {
      const clientId = String(message.clientId || '').trim();
      if (clientId && !CLIENT_ID_PATTERN.test(clientId)) return;
      const { clientId: previous } = await getSettings();
      if (clientId !== previous) {
        await signOut();
        await saveSettings({ clientId, email: '' });
        await clearSession();
      }
      authError = '';
      return broadcast();
    }
    case REQUEST.CONNECT:
      return connect();
    case REQUEST.DISCONNECT:
      return disconnect();
    case REQUEST.FIND:
      if (Number.isInteger(message.tabId)) return startFind(message.tabId, 'popup');
      return;
    case REQUEST.CANCEL:
      job?.controller.abort();
      return;
    case REQUEST.FILL_BLOCKED:
      return fillBlocked(message.remember === true);
    case REQUEST.SET_LOOKBACK:
      if (LOOKBACK_CHOICES.includes(Number(message.minutes))) {
        await saveSettings({ lookbackMinutes: Number(message.minutes) });
        return broadcast();
      }
      return;
    case REQUEST.SET_SUGGEST:
      // The popup saves the choice first, then asks Chrome for the permission;
      // permissions.onAdded registers the script once it is granted.
      await saveSettings({ suggestEnabled: message.enabled === true });
      if (message.enabled !== true) await chrome.permissions.remove({ origins: [...SUGGEST_ORIGINS] }).catch(() => false);
      await syncSuggestScript();
      return broadcast();
    case REQUEST.SET_AUTO_START:
      await saveSettings({ autoStart: message.enabled === true });
      return broadcast();
    case REQUEST.REMOVE_PAIR:
      if (typeof message.pair === 'string') await removeTrustedPair(message.pair);
      return broadcast();
    case REQUEST.OPEN_SHORTCUTS:
      return chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    default:
      return;
  }
}

chrome.runtime.onConnect.addListener(port => {
  // Only the popup (or the setup page, which is the popup in a tab). Content
  // scripts run inside web pages and must never drive the popup's commands.
  if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id ||
      !port.sender?.url?.startsWith(chrome.runtime.getURL('popup/'))) {
    port.disconnect();
    return;
  }
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(message => {
    handle(message).catch(error => console.warn('[Q-Fill]', error));
  });
  snapshot().then(state => port.postMessage(state)).catch(() => {});
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'fill-code' && tab?.id !== undefined) {
    startFind(tab.id, 'shortcut').catch(error => console.warn('[Q-Fill]', error));
  }
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.action.setBadgeBackgroundColor({ color: '#1d3a2a' });
  await syncSuggestScript().catch(error => console.warn('[Q-Fill]', error));
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    const { clientId } = await getSettings();
    if (!clientId) chrome.tabs.create({ url: 'popup/popup.html?view=page' });
  }
});

chrome.runtime.onStartup.addListener(() => {
  syncSuggestScript().catch(error => console.warn('[Q-Fill]', error));
});
