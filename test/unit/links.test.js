import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractVerifyLink } from '../../extension/core/links.js';

const pick = message => extractVerifyLink(message)?.url ?? null;

test('picks the Japanese sign-up link in a plain text email', () => {
  const text = [
    'この度はご登録ありがとうございます。',
    '現在は仮登録の状態です。以下のURLをクリックして本登録を完了してください。',
    'https://www.shop.co.jp/member/regist/complete?key=a1b2c3',
    '',
    '配信停止はこちら https://www.shop.co.jp/mail/stop?u=1',
    'https://www.shop.co.jp/'
  ].join('\n');
  assert.equal(pick({ text }), 'https://www.shop.co.jp/member/regist/complete?key=a1b2c3');
});

test('picks the button in an HTML email by its words', () => {
  const html = `
    <p>Thanks for signing up.</p>
    <a href="https://acme.test/">Acme</a>
    <a href="https://acme.test/e/9f8e7d">Verify your email</a>
    <a href="https://acme.test/help">Help center</a>
    <a href="https://acme.test/settings/unsubscribe">Unsubscribe</a>`;
  assert.equal(pick({ html }), 'https://acme.test/e/9f8e7d');
});

test('decodes &amp; in href', () => {
  const html = '<a href="https://acme.test/confirm?u=1&amp;t=xyz">メールアドレスを確認する</a>';
  assert.equal(pick({ html }), 'https://acme.test/confirm?u=1&t=xyz');
});

test('never picks a link after "if this was not you"', () => {
  const text = [
    '新しい端末からログインがありました。',
    '心当たりがない場合は、以下のURLからパスワードを変更してください。',
    'https://acme.test/account/verify-device?id=1'
  ].join('\n');
  assert.equal(pick({ text }), null);
});

test('ignores http links and links with credentials', () => {
  assert.equal(pick({ text: '本登録はこちら http://acme.test/confirm?key=1' }), null);
  assert.equal(pick({ text: '本登録はこちら https://user:pw@acme.test/confirm?key=1' }), null);
});

test('ignores emails with only ordinary links', () => {
  const html = '<p>今週のおすすめ</p><a href="https://shop.test/items/123">商品を見る</a><a href="https://shop.test/">トップ</a>';
  assert.equal(pick({ html }), null);
});
