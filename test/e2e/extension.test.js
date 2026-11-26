import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { BASE, addEmail, findUntilBlocked, installFakeGmail, lastResult, launch, popupSend, runFind, waitForResult } from './harness.js';

let env;
const base = BASE;

before(async () => {
  env = await launch();
  await installFakeGmail(env.worker);
});

after(async () => {
  await env?.close();
});

// Each test starts with an empty inbox, so a code left over from an earlier
// test cannot be filled by mistake.
beforeEach(async () => {
  await env.worker.evaluate(() => { globalThis.__inbox.length = 0; });
});

/** Waits for a tab showing (or loading) `url`, as Chrome reports it. */
async function waitForTab(url, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const tab = await env.worker.evaluate(async target => {
      const tabs = await chrome.tabs.query({});
      return tabs.find(t => t.url === target || t.pendingUrl === target) ?? null;
    }, url);
    if (tab) return tab;
    if (Date.now() > deadline) throw new Error(`No tab for ${url}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

function closeTab(id) {
  return env.worker.evaluate(tabId => chrome.tabs.remove(tabId), id);
}

async function open(path) {
  const page = await env.context.newPage();
  await page.goto(`${base}/${path}`);
  return page;
}

test('the service worker starts and the manifest asks for no site access', async () => {
  const manifest = await env.worker.evaluate(() => chrome.runtime.getManifest());
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['activeTab', 'identity', 'scripting', 'storage']);
  assert.equal(manifest.content_scripts, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
});

test('fills a single one-time-code field', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 482913.', 30_000);
  const page = await open('single.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(result.code, '482913');
  assert.equal(await page.inputValue('#otp'), '482913');
  assert.equal(await page.textContent('#received'), 'Received: 482913');
  await page.close();
});

test('never fills the same email twice and waits for a new one', async () => {
  await addEmail(env.worker, 'Your login code', 'Login code: 864200');
  const page = await open('single.html');
  const first = await runFind(env, page);
  assert.equal(first.code, '864200');

  await page.fill('#otp', '');
  setTimeout(() => {
    addEmail(env.worker, 'Sign in', 'Use 135790 to sign in.').catch(() => {});
  }, 4000);
  const started = Date.now();
  const second = await runFind(env, page, { timeout: 30_000 });
  assert.equal(second.status, 'filled');
  assert.equal(second.code, '135790');
  assert.ok(Date.now() - started >= 3500, 'should have waited for the new email');
  assert.equal(await page.inputValue('#otp'), '135790');
  await page.close();
});

test('fills six separate boxes', async () => {
  await addEmail(env.worker, '204816 is your Acme code', 'Use 204816 to sign in.');
  const page = await open('boxes.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  const values = await page.$$eval('#boxes input', inputs => inputs.map(i => i.value).join(''));
  assert.equal(values, '204816');
  await page.close();
});

test('fills a transparent input laid over six boxes', async () => {
  await addEmail(env.worker, 'Two-step verification', 'Your code: 771204');
  const page = await open('hidden-input.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(await page.inputValue('#otp input'), '771204');
  await page.close();
});

test('fills a framework-controlled input so the framework sees the value', async () => {
  await addEmail(env.worker, 'Security code', 'Your security code is 660021');
  const page = await open('react.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  await page.waitForTimeout(400);
  assert.equal(await page.textContent('#received'), 'State: 660021');
  assert.equal(await page.inputValue('#code'), '660021');
  await page.close();
});

test('on a login form, fills only the code field', async () => {
  await addEmail(env.worker, 'Your login code', 'Login code: 909182');
  const page = await open('login.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(await page.inputValue('#mfa'), '909182');
  assert.equal(await page.inputValue('#email'), 'sam@example.com');
  assert.equal(await page.inputValue('#password'), 'hunter22');
  assert.equal(await page.inputValue('#promo'), '');
  await page.close();
});

test('fills a field inside a shadow root', async () => {
  await addEmail(env.worker, 'Verify your device', 'Your device code is 314159');
  const page = await open('shadow.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  const value = await page.evaluate(() => document.querySelector('code-field').shadowRoot.querySelector('input').value);
  assert.equal(value, '314159');
  await page.close();
});

test('fills a field inside a same-origin iframe and leaves the search box alone', async () => {
  await addEmail(env.worker, 'Payment check', 'Your one-time code is 552901');
  const page = await open('iframe.html');
  await page.frameLocator('#frame').locator('#code').waitFor();
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(await page.frameLocator('#frame').locator('#code').inputValue(), '552901');
  assert.equal(await page.inputValue('#search'), '');
  await page.close();
});

test('skips a cross-origin frame it may not access, without failing', async () => {
  await addEmail(env.worker, 'Payment check', 'Your one-time code is 118822');
  const page = await open('iframe.html?cross=blocked');
  await page.frameLocator('#frame').locator('#code').waitFor();
  const result = await runFind(env, page);
  assert.equal(result.status, 'found');
  assert.equal(result.reason, 'no-field');
  assert.equal(result.code, '118822');
  assert.equal(await page.inputValue('#search'), '');
  await page.close();
});

test('on a page with no code field, finds the code but changes nothing', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 700111');
  const page = await open('no-field.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'found');
  assert.equal(result.reason, 'no-field');
  assert.equal(await page.inputValue('#name'), '');
  assert.equal(await page.inputValue('#email'), '');
  const toast = await page.evaluate(() => Boolean(document.getElementById('qfill-toast-host')));
  assert.ok(toast, 'a toast explains what happened');
  await page.close();
});

test('a confirmation link to the same site opens in a new tab next to the page', async () => {
  const link = `${base}/single.html?verify=abc123`;
  await addEmail(env.worker, '仮登録のお知らせ', `以下のURLをクリックして本登録を完了してください。
${link}`);
  const page = await open('no-field.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'opened');
  assert.equal(result.action, 'link');
  const tab = await waitForTab(link);
  const pageTab = await waitForTab(page.url());
  assert.equal(tab.index, pageTab.index + 1);
  assert.equal(tab.openerTabId, pageTab.id);
  await closeTab(tab.id);
  await page.close();
});

test('a confirmation link to another site is not opened until you confirm', async () => {
  const link = 'https://click.mailer.test/l/abc?verify=1';
  await addEmail(env.worker, 'Confirm your email', `Please confirm your email address:
${link}`);
  const page = await open('no-field.html');
  await findUntilBlocked(env, page);
  const popup = await env.context.newPage();
  await popup.goto(`chrome-extension://${env.extensionId}/popup/popup.html?view=page`);
  await popup.locator('#confirm').waitFor();
  assert.equal(await popup.textContent('#confirmLink'), 'click.mailer.test');
  assert.equal(await popup.isVisible('#rememberRow'), false);
  assert.equal(await waitForTab(link, 1000).catch(() => null), null, 'not opened before you confirm');
  await popup.click('#fillAnyway');
  const result = await waitForResult(env.worker);
  assert.equal(result.status, 'opened');
  const tab = await waitForTab(link);
  await closeTab(tab.id);
  await popup.close();
  await page.close();
});

test('the popup shows the result with the code', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 246810');
  const page = await open('single.html');
  await runFind(env, page);
  const popup = await env.context.newPage();
  await popup.goto(`chrome-extension://${env.extensionId}/popup/popup.html`);
  await popup.locator('#resultCode').waitFor();
  assert.equal(await popup.textContent('#resultCode'), '246810');
  assert.equal(await popup.isVisible('#viewMain'), true);
  assert.equal(await popup.textContent('#account'), 'sam@example.com');
  await popup.close();
  await page.close();
});

// ---------------------------------------------------------------------------
// Sender and site must match

test('a code from another site is not filled, and the page never sees it', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 573920.', 0, { from: 'Shop <no-reply@shop.other.test>' });
  const page = await open('single.html');
  const blocked = await findUntilBlocked(env, page);
  assert.equal(blocked.verdict, 'mismatch');
  assert.equal(blocked.senderDomain, 'other.test');
  assert.equal(blocked.site, 'acme.test');
  assert.equal(blocked.code, '573920');
  await page.waitForTimeout(500);
  assert.equal(await page.inputValue('#otp'), '');
  assert.ok(!(await page.content()).includes('573920'));
  await popupSend(env, { type: 'cancel' });
  assert.equal((await waitForResult(env.worker)).status, 'cancelled');
  await page.close();
});

test('a newer code from another site does not hide the matching one', async () => {
  await addEmail(env.worker, 'Your Acme code', 'Your verification code is 610042.', 20_000);
  await addEmail(env.worker, 'Your code', 'Your verification code is 999111.', 0, { from: 'Shop <no-reply@shop.other.test>' });
  const page = await open('single.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(result.code, '610042');
  assert.equal(await page.inputValue('#otp'), '610042');
  await page.close();
});

test('a forged From without Gmail authentication is not filled', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 424242.', 0, { auth: null });
  const page = await open('single.html');
  const blocked = await findUntilBlocked(env, page);
  assert.equal(blocked.verdict, 'unverified');
  assert.equal(await page.inputValue('#otp'), '');
  await popupSend(env, { type: 'cancel' });
  await waitForResult(env.worker);
  await page.close();
});

test('a code in Spam is not filled without asking', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 515151.', 0, { spam: true });
  const page = await open('single.html');
  const blocked = await findUntilBlocked(env, page);
  assert.equal(blocked.verdict, 'spam');
  assert.equal(await page.inputValue('#otp'), '');
  await popupSend(env, { type: 'cancel' });
  await waitForResult(env.worker);
  await page.close();
});

test('confirming a forged sender fills once but never remembers it', async () => {
  await addEmail(env.worker, 'Your verification code', 'Your verification code is 737373.', 0, { from: 'no-reply@other.test', auth: null });
  const page = await open('single.html');
  const blocked = await findUntilBlocked(env, page);
  assert.equal(blocked.verdict, 'unverified');
  await popupSend(env, { type: 'fillBlocked', remember: true });
  const filled = await waitForResult(env.worker);
  assert.equal(filled.status, 'filled');
  assert.equal(await page.inputValue('#otp'), '737373');
  const { trustedPairs = [] } = await env.worker.evaluate(() => chrome.storage.local.get('trustedPairs'));
  assert.deepEqual(trustedPairs, []);
  await page.close();
});

test('a confirmed, authenticated pair is remembered and then filled without asking', async () => {
  await addEmail(env.worker, 'Your code', 'Your verification code is 828282.', 0, { from: 'Acme Pay <no-reply@acmepay.test>' });
  const page = await open('single.html');
  const blocked = await findUntilBlocked(env, page);
  assert.equal(blocked.verdict, 'mismatch');
  await popupSend(env, { type: 'fillBlocked', remember: true });
  const filled = await waitForResult(env.worker);
  assert.equal(filled.status, 'filled');
  const { trustedPairs } = await env.worker.evaluate(() => chrome.storage.local.get('trustedPairs'));
  assert.deepEqual(trustedPairs, ['acmepay.test -> acme.test']);

  await page.fill('#otp', '');
  await addEmail(env.worker, 'Your code', 'Your verification code is 939393.', 0, { from: 'Acme Pay <no-reply@acmepay.test>' });
  const again = await runFind(env, page);
  assert.equal(again.status, 'filled');
  assert.equal(again.verdict, 'trusted');
  assert.equal(await page.inputValue('#otp'), '939393');

  await popupSend(env, { type: 'removePair', pair: 'acmepay.test -> acme.test' });
  await page.close();
});

test('never fills a frame of another site, even one it may access', async () => {
  await addEmail(env.worker, 'Payment check', 'Your one-time code is 404404');
  const page = await open('iframe.html?cross=evil');
  await page.frameLocator('#frame').locator('#code').waitFor();
  const result = await runFind(env, page);
  assert.equal(result.status, 'found');
  assert.equal(result.reason, 'origin');
  assert.equal(await page.frameLocator('#frame').locator('#code').inputValue(), '');
  await page.close();
});

test('a code from the frame\'s own site goes into that frame', async () => {
  await addEmail(env.worker, 'Payment check', 'Your one-time code is 707070', 0, { from: 'Pay <no-reply@evil.test>' });
  const page = await open('iframe.html?cross=evil');
  await page.frameLocator('#frame').locator('#code').waitFor();
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(result.site, 'evil.test');
  assert.equal(await page.frameLocator('#frame').locator('#code').inputValue(), '707070');
  assert.equal(await page.inputValue('#search'), '');
  await page.close();
});

test('a Japanese email is found and filled', async () => {
  await addEmail(env.worker, '【Acme】認証コードのお知らせ', 'あなたの認証コードは１２３４５６です。\n有効期限は10分です。');
  const page = await open('single.html');
  const result = await runFind(env, page);
  assert.equal(result.status, 'filled');
  assert.equal(await page.inputValue('#otp'), '123456');
  await page.close();
});

test('the popup explains a blocked code and offers to fill it', async () => {
  await addEmail(env.worker, 'Your code', 'Your verification code is 252525.', 0, { from: 'Shop <no-reply@shop.other.test>' });
  const page = await open('single.html');
  await findUntilBlocked(env, page);
  const popup = await env.context.newPage();
  await popup.goto(`chrome-extension://${env.extensionId}/popup/popup.html?view=page`);
  await popup.locator('#confirm').waitFor();
  // Still waiting for a matching code, and offering the blocked one meanwhile.
  assert.equal(await popup.isVisible('#progress'), true);
  assert.equal(await popup.textContent('#confirmSender'), 'other.test');
  assert.equal(await popup.textContent('#confirmSite'), 'acme.test');
  assert.equal(await popup.isVisible('#fillAnyway'), true);
  assert.equal(await popup.isVisible('#rememberRow'), true);
  assert.equal(await popup.textContent('#resultCode'), '252525');
  await popup.close();
  await popupSend(env, { type: 'cancel' });
  await waitForResult(env.worker);
  await page.close();
});

test('an older code from another site does not end the wait for the right one', async () => {
  await addEmail(env.worker, 'Your code', 'Your verification code is 313131.', 30_000, { from: 'Shop <no-reply@shop.other.test>' });
  const page = await open('single.html');
  setTimeout(() => {
    addEmail(env.worker, 'Your Acme code', 'Your verification code is 464646.').catch(() => {});
  }, 4000);
  const result = await runFind(env, page, { timeout: 30_000 });
  assert.equal(result.status, 'filled');
  assert.equal(result.code, '464646');
  assert.equal(await page.inputValue('#otp'), '464646');
  assert.equal(await lastResult(env.worker).then(r => r.senderDomain), 'acme.test');
  await page.close();
});

// Last: this test disconnects the account.
test('the popup asks for a client ID when none is set', async () => {
  await env.worker.evaluate(() => chrome.storage.local.set({ clientId: '' }));
  const popup = await env.context.newPage();
  await popup.goto(`chrome-extension://${env.extensionId}/popup/popup.html`);
  await popup.locator('#viewSetup').waitFor();
  const redirect = await popup.textContent('#setupRedirect');
  assert.equal(redirect, `https://${env.extensionId}.chromiumapp.org/`);
  await popup.fill('#clientIdInput', 'not a client id');
  await popup.click('#clientForm button');
  assert.equal(await popup.isVisible('#clientIdError'), true);
  await popup.fill('#clientIdInput', '123456789012-abcdefghijklmnop.apps.googleusercontent.com');
  await popup.click('#clientForm button');
  await popup.locator('#viewConnect').waitFor();
  await popup.close();
});
