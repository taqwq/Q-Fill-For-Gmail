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

test('never picks a link that deletes, cancels, pays or changes something', () => {
  for (const text of [
    'Click to confirm account deletion https://acme.test/delete/confirm?t=1',
    'アカウント削除の確認: 以下のURLを開くと削除が完了します https://acme.test/account/confirm?token=1',
    'ご注文内容を確認する https://acme.test/order/123?key=9',
    'Confirm your payment https://acme.test/pay/confirm?id=1',
    'メールアドレス変更を確認するには https://acme.test/email/change/confirm?token=1',
    'Confirm cancellation of your subscription https://acme.test/sub/confirm?token=1',
    'パスワード再設定はこちら https://acme.test/password/reset?token=1'
  ]) assert.equal(pick({ text }), null, text);
});

test('a short button text counts only with a confirmation path', () => {
  assert.equal(pick({ html: '<a href="https://acme.test/verify?t=1">Verify</a>' }), 'https://acme.test/verify?t=1');
  assert.equal(pick({ html: '<a href="https://acme.test/items/1">確認する</a>' }), null);
});

test('a sign-up sentence one line above the link still counts', () => {
  const text = '以下のURLから本登録を完了してください。\nURL: https://acme.test/r/abc?key=1';
  assert.equal(pick({ text }), 'https://acme.test/r/abc?key=1');
});

test('stays fast on a large body full of unclosed links', () => {
  const html = '<a href="https://acme.test/a?token=1">本登録 '.repeat(5000);
  const start = Date.now();
  extractVerifyLink({ html });
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});
