import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeHost, registrableDomain, sameSite, siteOfUrl } from '../../extension/core/domain.js';

test('registrable domain of ordinary hosts', () => {
  assert.equal(registrableDomain('example.com'), 'example.com');
  assert.equal(registrableDomain('accounts.example.com'), 'example.com');
  assert.equal(registrableDomain('a.b.c.example.com'), 'example.com');
  assert.equal(registrableDomain('EXAMPLE.COM.'), 'example.com');
});

test('Japanese second-level domains are public suffixes', () => {
  assert.equal(registrableDomain('login.bank.co.jp'), 'bank.co.jp');
  assert.equal(registrableDomain('evil.co.jp'), 'evil.co.jp');
  assert.notEqual(registrableDomain('bank.co.jp'), registrableDomain('evil.co.jp'));
  assert.equal(registrableDomain('www.example.tokyo.jp'), 'example.tokyo.jp');
  assert.equal(registrableDomain('co.jp'), '');
  assert.equal(registrableDomain('ne.jp'), '');
});

test('wildcard and exception rules', () => {
  // *.kawasaki.jp is a wildcard, !city.kawasaki.jp an exception.
  assert.equal(registrableDomain('foo.kawasaki.jp'), '');
  assert.equal(registrableDomain('bar.foo.kawasaki.jp'), 'bar.foo.kawasaki.jp');
  assert.equal(registrableDomain('city.kawasaki.jp'), 'city.kawasaki.jp');
  assert.equal(registrableDomain('www.city.kawasaki.jp'), 'city.kawasaki.jp');
});

test('private suffixes keep user sites apart', () => {
  assert.equal(registrableDomain('alice.github.io'), 'alice.github.io');
  assert.notEqual(registrableDomain('alice.github.io'), registrableDomain('mallory.github.io'));
  assert.equal(registrableDomain('github.io'), '');
});

test('IDN hosts are compared in punycode', () => {
  assert.equal(registrableDomain('ログイン.例え.jp'), registrableDomain('xn--s9jyb6b8c.xn--r8jz45g.jp'));
  assert.equal(registrableDomain('例え.jp'), 'xn--r8jz45g.jp');
});

test('IP addresses, localhost, single labels and junk are never a site', () => {
  for (const host of ['127.0.0.1', '[::1]', '::1', 'localhost', 'app.localhost', 'intranet', '', ' ', 'a..b.com',
    'exa mple.com', 'example.com/path', 'user@example.com', 'example.com:443', '-bad.com', null, undefined, 42]) {
    assert.equal(registrableDomain(host), '', String(host));
  }
  assert.equal(normalizeHost('Example.COM'), 'example.com');
});

test('siteOfUrl only accepts https', () => {
  assert.equal(siteOfUrl('https://login.bank.co.jp/otp?x=1'), 'bank.co.jp');
  assert.equal(siteOfUrl('http://login.bank.co.jp/'), '');
  assert.equal(siteOfUrl('https://127.0.0.1/'), '');
  assert.equal(siteOfUrl('chrome://settings'), '');
  assert.equal(siteOfUrl('not a url'), '');
  assert.equal(siteOfUrl('https://user:pass@bank.co.jp/'), 'bank.co.jp');
});

test('sameSite needs two equal, non-empty domains', () => {
  assert.equal(sameSite('bank.co.jp', 'bank.co.jp'), true);
  assert.equal(sameSite('bank.co.jp', 'evil.co.jp'), false);
  assert.equal(sameSite('', ''), false);
});
