/**
 * Suggestions by the field: focus a code field, see the sender's domain under
 * it, click to fill. Runs with access to every https site, as after you turn
 * suggestions on and Chrome grants the permission.
 */
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE, addEmail, installFakeGmail, launch, popupSend } from './harness.js';

let env;

before(async () => {
  env = await launch({ grantAll: true });
  await installFakeGmail(env.worker);
  await popupSend(env, { type: 'setSuggest', enabled: true });
  const scripts = await env.worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.equal(scripts.length, 1, 'the suggestion script is registered');
});

after(async () => {
  await env?.close();
});

beforeEach(async () => {
  await env.worker.evaluate(() => { globalThis.__inbox.length = 0; });
});

/**
 * The bar lives in a closed shadow root, which neither the page nor
 * Playwright's locators can enter. DevTools can: find the button through the
 * DOM domain with pierce, and return its centre for a real mouse click.
 * @param {import('playwright').Page} page
 * @param {RegExp} label
 */
async function closedButton(page, label, timeout = 15_000) {
  const cdp = await page.context().newCDPSession(page);
  const deadline = Date.now() + timeout;
  try {
    for (;;) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (node.nodeName === 'BUTTON' && label.test((node.children || []).map(c => c.nodeValue || '').join(''))) {
          const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
          const [x1, y1, , , x3, y3] = model.content;
          return { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
        }
        stack.push(...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : []));
      }
      if (Date.now() > deadline) return null;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  } finally {
    await cdp.detach();
  }
}

/** The bar lives in a closed shadow root; the page can only see its host. */
async function barHost(page) {
  return page.evaluate(() => [...document.documentElement.children].some(el =>
    el.tagName === 'DIV' && el.style.position === 'fixed' && el.shadowRoot === null && el.style.zIndex === '2147483647'));
}

test('focusing a code field offers the matching code, and a click fills it', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 482913.');
  const page = await env.context.newPage();
  await page.goto(`${BASE}/single.html`);
  await page.click('#otp');

  const fill = await closedButton(page, /^(Fill|入力)$/);
  assert.ok(fill, 'the bar shows a Fill button');
  assert.equal(await barHost(page), true);
  // The page cannot read the code before the click.
  assert.ok(!(await page.content()).includes('482913'));
  assert.equal(await page.inputValue('#otp'), '');

  await page.waitForTimeout(500);
  await page.mouse.click(fill.x, fill.y);
  await page.waitForFunction(() => document.querySelector('#otp').value === '482913', null, { timeout: 5000 });
  await page.close();
});

test('no offer for a code from another site', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 573920.', 0, { from: 'Shop <no-reply@shop.other.test>' });
  const page = await env.context.newPage();
  await page.goto(`${BASE}/single.html`);
  await page.click('#otp');
  assert.equal(await closedButton(page, /^(Fill|入力)$/, 4000), null);
  assert.equal(await page.inputValue('#otp'), '');
  await page.close();
});

test('a synthetic click from the page does not fill', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 135790.');
  const page = await env.context.newPage();
  await page.goto(`${BASE}/single.html`);
  await page.click('#otp');
  assert.ok(await closedButton(page, /^(Fill|入力)$/));
  await page.waitForTimeout(500);
  // The page's own script clicks everything it can reach, as a hostile page
  // would; its clicks are untrusted and must not fill.
  await page.evaluate(() => {
    const host = [...document.documentElement.children].find(el => el.style.position === 'fixed');
    host.click();
    host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  });
  await page.waitForTimeout(800);
  assert.equal(await page.inputValue('#otp'), '');
  await page.close();
});

test('the search box on a page does not trigger a look at your mail', async () => {
  const page = await env.context.newPage();
  await page.goto(`${BASE}/iframe.html`);
  const before = await env.worker.evaluate(() => globalThis.__gmailCalls.length);
  await page.click('#search');
  await page.waitForTimeout(1500);
  const afterCalls = await env.worker.evaluate(() => globalThis.__gmailCalls.length);
  assert.equal(afterCalls, before);
  await page.close();
});
