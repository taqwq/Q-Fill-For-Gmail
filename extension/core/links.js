/**
 * Finds the link in an email that finishes a sign-up or confirms an address,
 * such as "本登録を完了する" or "Verify your email".
 *
 * Only https links whose own words, the words just before them or their path
 * say so are picked. Links to unsubscribe, help, privacy pages or "this
 * wasn't me" are never picked.
 */

import { decodeEntities, htmlToText } from './extract.js';

/**
 * Words that say the link finishes a sign-up or confirms an email address,
 * in the link text or the sentence just before it. A bare "confirm" is not
 * enough: it also confirms payments, orders and deletions.
 */
const POSITIVE = [
  '本登録', '仮登録', '登録を完了', '登録完了', '登録手続き', '会員登録', 'メールアドレス',
  'アカウントを有効', 'アカウントの有効化',
  'verify your email', 'verify email', 'verify your account', 'verify my email', 'verify my account',
  'confirm your email', 'confirm email', 'confirm your account', 'confirm my account', 'confirm my email',
  'confirm your registration', 'confirm your sign', 'activate your account', 'activate account',
  'complete registration', 'complete your registration', 'complete sign up', 'complete signup',
  'complete your sign', 'finish signing up', 'finish setting up', 'email verification', 'email confirmation'
];

/** A short button text such as "Verify", which counts only with a matching path. */
const SHORT_LABELS = new Set(['verify', 'confirm', 'activate', '確認', '認証', '確認する', '認証する', '登録する']);

/** Words in the path or query of a confirmation link. */
const PATH_POSITIVE = [
  'verify', 'verification', 'confirm', 'activate', 'activation', 'validate',
  'register', 'registration', 'signup', 'sign-up', 'sign_up', 'token=', 'key=', 'code='
];

/**
 * Never pick a link with these words in its text, its path or the sentence
 * before it: opening it could cancel, delete, pay or change something.
 */
const NEGATIVE = [
  'unsubscribe', 'opt-out', 'optout', 'preferences', 'privacy', 'terms', 'help', 'support', 'faq',
  'contact', 'report', 'not you', "wasn't you", 'was not you', "didn't request", 'did not request',
  'delete', 'deletion', 'remove', 'cancel', 'deactivate', 'close your account', 'close account',
  'order', 'payment', 'purchase', 'invoice', 'billing', 'transfer', 'change', 'reset', 'password',
  '配信停止', '配信解除', '配信を停止', '登録解除', '退会', '解約', '解除', 'プライバシー', '利用規約',
  'ヘルプ', 'サポート', 'よくある質問', 'お問い合わせ', '問い合わせ', '心当たり', '身に覚え',
  'キャンセル', '設定変更', '配信設定', '削除', '取り消', '取消', '停止', '注文', '支払', '決済',
  '購入', '送金', '振込', '振り込', '変更', '再設定', 'パスワード'
];

const THRESHOLD = 3;
const MAX_URL_LENGTH = 2048;
const CONTEXT_CHARS = 100;

/**
 * @typedef {object} LinkMatch
 * @property {string} url
 * @property {number} score
 */

/**
 * @param {{ subject?: string, text?: string, html?: string }} message
 * @returns {LinkMatch|null}
 */
export function extractVerifyLink({ text = '', html = '' } = {}) {
  /** @type {Map<string, number>} */
  const best = new Map();
  const add = (href, label, before) => {
    const url = cleanUrl(href);
    if (!url) return;
    const score = scoreLink(url, label, before);
    if (score === null) return;
    if (!best.has(url) || best.get(url) < score) best.set(url, score);
  };

  if (html) {
    // The link text is capped so that a body full of unclosed <a> stays fast.
    const anchor = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]{0,2000}?)<\/a\s*>/gi;
    for (const m of html.matchAll(anchor)) {
      const href = decodeEntities(m[1] ?? m[2] ?? m[3] ?? '');
      const label = flat(htmlToText(m[4]));
      const before = flat(htmlToText(html.slice(Math.max(0, m.index - 1500), m.index))).slice(-CONTEXT_CHARS);
      add(href, label, before);
    }
  }

  const plain = text || (html ? htmlToText(html) : '');
  for (const m of plain.matchAll(/https:\/\/[^\s<>"'()（）「」【】]+/gi)) {
    const before = flat(plain.slice(Math.max(0, m.index - 400), m.index)).slice(-CONTEXT_CHARS);
    add(m[0], '', before);
  }

  let found = null;
  for (const [url, score] of best) {
    if (score >= THRESHOLD && (!found || score > found.score)) found = { url, score };
  }
  return found;
}

/**
 * @param {string} url
 * @param {string} label - The link's own text.
 * @param {string} before - Text just before the link.
 * @returns {number|null} null when the link must never be picked.
 */
function scoreLink(url, label, before) {
  const parsed = new URL(url);
  const path = safeDecode(parsed.pathname + parsed.search).toLowerCase();
  const words = label.toLowerCase();
  // The sentences just before the link. Only the last one can veto the link
  // ("if this wasn't you, click here"); a positive word may be one sentence up,
  // as in "Finish signing up. Link:".
  const sentences = before.toLowerCase().replace(/[。.!?！？:：\s]+$/, '').split(/[。!?！？]|\.\s/);
  const last = sentences.at(-1) || '';
  const near = sentences.slice(-2).join(' ');

  if (NEGATIVE.some(w => words.includes(w) || path.includes(w) || last.includes(w))) return null;
  // A bare home page is never the confirmation link.
  if ((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search) return null;

  let score = 0;
  if (POSITIVE.some(w => words.includes(w))) score += 3;
  else if (SHORT_LABELS.has(words.trim())) score += 1;
  if (POSITIVE.some(w => near.includes(w))) score += 2;
  if (PATH_POSITIVE.some(w => path.includes(w))) score += 2;
  return score;
}

/**
 * Only plain https links, without a user name or password in them.
 * @param {string} href
 */
function cleanUrl(href) {
  const value = href.trim();
  if (!/^https:\/\//i.test(value) || value.length > MAX_URL_LENGTH) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return '';
    return url.href;
  } catch {
    return '';
  }
}

function flat(text) {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
