/**
 * Suggestion by the field, the desktop version of the "From Messages" code
 * above a phone keyboard. Runs only when you turned suggestions on.
 *
 * When you focus a field that clearly wants a one-time code, this script
 * tells the service worker, which looks in Gmail for a code from the same
 * site. If one is found, a small bar appears under the field with the
 * sender's domain. The code itself stays in the service worker until you
 * click the bar, so the page cannot read it before you decide.
 *
 * Classic script in the extension's isolated world. Depends on autofill.js,
 * which is injected right before it.
 */
(() => {
  'use strict';

  if (globalThis.__qfillSuggest) return;
  globalThis.__qfillSuggest = true;
  if (location.protocol !== 'https:') return;

  const FIELD = 'qfill:field';
  const OFFER = 'qfill:offer';
  const WITHDRAW = 'qfill:withdraw';
  const ACCEPT = 'qfill:accept';
  const DISMISS = 'qfill:dismiss';

  /** A click before this delay is ignored, so a page cannot swap the bar in under your pointer. */
  const ARM_MS = 400;

  const msg = (key, subs) => {
    try {
      return chrome.i18n.getMessage(key, subs) || key;
    } catch {
      return key;
    }
  };

  let anchor = null;
  let offer = null;
  let host = null;
  let shadow = null;
  let shownAt = 0;
  let askedAt = 0;
  let busy = false;

  function send(message) {
    try {
      return chrome.runtime.sendMessage(message);
    } catch {
      // The extension was updated or turned off; this page keeps an orphan script.
      return Promise.resolve(null);
    }
  }

  document.addEventListener('focusin', event => {
    const el = event.composedPath?.()[0] || event.target;
    if (!(el instanceof Element) || !globalThis.__qfill?.isCodeField?.(el)) return;
    anchor = el;
    if (offer) {
      show();
      return;
    }
    // The service worker de-duplicates too; this only saves messages.
    if (Date.now() - askedAt < 2000) return;
    askedAt = Date.now();
    send({ type: FIELD })?.catch?.(() => {});
  }, true);

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab) return;
    if (message?.type === OFFER && typeof message.offerId === 'string') {
      offer = { id: message.offerId, domain: String(message.senderDomain || '') };
      if (anchor?.isConnected) show();
    } else if (message?.type === WITHDRAW) {
      offer = null;
      hide();
    }
  });

  function hide() {
    host?.remove();
    host = null;
    shadow = null;
    removeEventListener('scroll', place, true);
    removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
  }

  function place() {
    if (!host || !anchor?.isConnected) return hide();
    const rect = anchor.getBoundingClientRect();
    const width = host.offsetWidth || 280;
    const left = Math.max(8, Math.min(rect.left, innerWidth - width - 8));
    const below = rect.bottom + 6;
    const top = below + 48 > innerHeight ? Math.max(8, rect.top - 6 - (host.offsetHeight || 40)) : below;
    host.style.left = `${Math.round(left)}px`;
    host.style.top = `${Math.round(top)}px`;
  }

  function onKey(event) {
    if (event.key === 'Escape' && host) {
      event.stopPropagation();
      dismiss();
    }
  }

  function dismiss() {
    if (offer) send({ type: DISMISS, offerId: offer.id })?.catch?.(() => {});
    offer = null;
    hide();
  }

  function show() {
    if (!offer || !anchor) return;
    hide();

    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;left:0;top:0';
    shadow = host.attachShadow({ mode: 'closed' });

    // Use the page's own typeface, so the bar reads as part of the form.
    let font = 'system-ui, sans-serif';
    try {
      font = getComputedStyle(anchor).fontFamily || font;
    } catch {
      /* keep the default */
    }

    const style = document.createElement('style');
    style.textContent = `
      .bar{display:flex;align-items:baseline;gap:16px;max-width:min(420px,calc(100vw - 16px));
        padding:10px 12px;background:#fff;color:#262626;border:1px solid #262626;border-radius:0;
        font-size:13px;line-height:1.4;font-weight:400;box-sizing:border-box}
      .text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}
      button{all:unset;cursor:pointer;color:#000;text-decoration:underline;text-underline-offset:3px;white-space:nowrap}
      button:active{opacity:.55}
      button:focus-visible{outline:1px solid #000;outline-offset:2px}
      .fill{font-size:15px;font-weight:700}
      .note{color:#262626}
    `;
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-label', 'Q-Fill');
    bar.style.fontFamily = font;

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = msg('suggestFrom', [offer.domain]);

    const fill = document.createElement('button');
    fill.className = 'fill';
    fill.type = 'button';
    fill.textContent = msg('suggestFill');

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = msg('suggestClose');

    // Keep focus in the field: the bar must not steal it on mousedown.
    for (const button of [fill, close]) button.addEventListener('mousedown', event => event.preventDefault());

    fill.addEventListener('click', async event => {
      if (!event.isTrusted || busy || !offer || Date.now() - shownAt < ARM_MS) return;
      busy = true;
      const current = offer;
      let result = null;
      try {
        result = await send({ type: ACCEPT, offerId: current.id });
      } catch {
        result = null;
      }
      busy = false;
      offer = null;
      if (result?.ok) {
        hide();
        return;
      }
      text.textContent = msg(result?.reason === 'no-field' ? 'suggestNoField' : 'suggestFailed');
      text.className = 'text note';
      fill.remove();
    });
    close.addEventListener('click', event => {
      if (!event.isTrusted) return;
      dismiss();
    });

    bar.append(text, fill, close);
    shadow.append(style, bar);
    document.documentElement.appendChild(host);
    shownAt = Date.now();
    place();
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    document.addEventListener('keydown', onKey, true);
  }
})();
