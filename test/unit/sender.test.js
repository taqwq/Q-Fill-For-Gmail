import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSender, pairKey, parseAuthenticationResults, parseFrom, verdict } from '../../extension/core/sender.js';

const GOOD_AR = [
  'mx.google.com;',
  '       dkim=pass header.i=@mail.bank.co.jp header.s=s1 header.b=AbCdEf12;',
  '       spf=pass (google.com: domain of bounce@em.bank.co.jp designates 192.0.2.1 as permitted sender) smtp.mailfrom=bounce@em.bank.co.jp;',
  '       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=bank.co.jp'
].join('\r\n');

test('parseFrom reads only the address in angle brackets', () => {
  assert.deepEqual(parseFrom('Bank <no-reply@login.bank.co.jp>'), { address: 'no-reply@login.bank.co.jp', host: 'login.bank.co.jp' });
  assert.deepEqual(parseFrom('no-reply@bank.co.jp'), { address: 'no-reply@bank.co.jp', host: 'bank.co.jp' });
  assert.equal(parseFrom('"x@bank.co.jp" <a@evil.example>').host, 'evil.example');
  assert.equal(parseFrom('"銀行 <no-reply@bank.co.jp>" <a@evil.example>'), null);
  assert.equal(parseFrom('"Doe, Jane" <jane@example.com>').host, 'example.com');
});

test('parseFrom refuses lists, junk and IP literals', () => {
  for (const from of ['a@bank.co.jp, b@evil.example', 'Bank <a@bank.co.jp>, Evil <b@evil.example>', 'Bank <a@bank.co.jp> <b@evil.example>',
    '<a@bank.co.jp> extra', 'not an address', 'a@[192.0.2.1]', 'a@localhost', '"quoted local"@bank.co.jp', '', null]) {
    assert.equal(parseFrom(from), null, String(from));
  }
});

test('parses Gmail Authentication-Results with comments and folded lines', () => {
  const parsed = parseAuthenticationResults(GOOD_AR);
  assert.equal(parsed.authservId, 'mx.google.com');
  assert.deepEqual(parsed.results.map(r => `${r.method}=${r.result}`), ['dkim=pass', 'spf=pass', 'dmarc=pass']);
  assert.equal(parsed.results[0].props['header.i'], '@mail.bank.co.jp');
  assert.equal(parsed.results[2].props['header.from'], 'bank.co.jp');
});

test('DMARC pass from Gmail verifies the sender', () => {
  const check = checkSender({ from: 'Bank <no-reply@bank.co.jp>', authResults: [GOOD_AR] });
  assert.deepEqual(check, { domain: 'bank.co.jp', verified: true, method: 'dmarc' });
});

test('aligned DKIM or SPF verifies a sender without DMARC', () => {
  const dkim = 'mx.google.com; dkim=pass header.i=@notify.shop.example.jp header.s=k1; spf=softfail smtp.mailfrom=x@other.example';
  assert.equal(checkSender({ from: 'Shop <no-reply@shop.example.jp>', authResults: [dkim] }).method, 'dkim');
  const spf = 'mx.google.com; spf=pass (google.com: ...) smtp.mailfrom=bounce@mail.shop.example.jp; dkim=none';
  assert.equal(checkSender({ from: 'no-reply@shop.example.jp', authResults: [spf] }).method, 'spf');
});

test('DKIM or SPF for another domain does not verify the From domain', () => {
  const ar = 'mx.google.com; dkim=pass header.i=@sendgrid.example; spf=pass smtp.mailfrom=bounce@sendgrid.example';
  assert.deepEqual(checkSender({ from: 'Bank <no-reply@bank.co.jp>', authResults: [ar] }),
    { domain: 'bank.co.jp', verified: false, method: 'not-aligned' });
});

test('a forged Authentication-Results below Gmail\'s own is ignored', () => {
  const gmail = 'mx.google.com; dkim=none; spf=fail smtp.mailfrom=a@evil.example; dmarc=fail header.from=bank.co.jp';
  const forged = 'mx.google.com; dkim=pass header.i=@bank.co.jp; dmarc=pass header.from=bank.co.jp';
  const check = checkSender({ from: 'Bank <no-reply@bank.co.jp>', authResults: [gmail, forged] });
  assert.equal(check.verified, false);
  assert.equal(check.method, 'dmarc-fail');
});

test('a top header from another server is not trusted', () => {
  const other = 'mx.evil.example; dmarc=pass header.from=bank.co.jp';
  assert.equal(checkSender({ from: 'no-reply@bank.co.jp', authResults: [other] }).method, 'no-auth');
  assert.equal(checkSender({ from: 'no-reply@bank.co.jp', authResults: [] }).method, 'no-auth');
  // A look-alike authserv-id.
  const lookalike = 'mx.google.com.evil.example; dmarc=pass header.from=bank.co.jp';
  assert.equal(checkSender({ from: 'no-reply@bank.co.jp', authResults: [lookalike] }).verified, false);
});

test('DMARC fail or temperror wins over an aligned DKIM pass', () => {
  for (const result of ['fail', 'temperror', 'permerror', 'quarantine']) {
    const ar = `mx.google.com; dkim=pass header.i=@bank.co.jp; dmarc=${result} header.from=bank.co.jp`;
    assert.equal(checkSender({ from: 'no-reply@bank.co.jp', authResults: [ar] }).verified, false, result);
  }
});

test('DMARC pass for a different header.from does not count', () => {
  const ar = 'mx.google.com; dmarc=pass header.from=evil.co.jp';
  assert.equal(checkSender({ from: 'no-reply@bank.co.jp', authResults: [ar] }).verified, false);
});

test('a display-name spoof is judged by the real address', () => {
  const ar = 'mx.google.com; dmarc=pass header.from=evil.example';
  const check = checkSender({ from: '"no-reply@bank.co.jp" <a@evil.example>', authResults: [ar] });
  assert.equal(check.domain, 'evil.example');
});

test('verdict', () => {
  const verified = { sender: { domain: 'bank.co.jp', verified: true, method: 'dmarc' }, spam: false };
  assert.equal(verdict(verified, 'bank.co.jp'), 'match');
  assert.equal(verdict(verified, 'evil.co.jp'), 'mismatch');
  assert.equal(verdict(verified, 'bankpay.jp', [pairKey('bank.co.jp', 'bankpay.jp')]), 'trusted');
  assert.equal(verdict(verified, 'bankpay.jp', [pairKey('bankpay.jp', 'bank.co.jp')]), 'mismatch');
  assert.equal(verdict(verified, ''), 'no-site');
  assert.equal(verdict({ ...verified, spam: true }, 'bank.co.jp'), 'spam');
  assert.equal(verdict({ sender: { domain: 'bank.co.jp', verified: false, method: 'no-auth' } }, 'bank.co.jp'), 'unverified');
});
