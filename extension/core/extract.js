/**
 * Finds the verification code in one email.
 *
 * Everything here is a pure function with no browser APIs, so the same file
 * runs in the extension's service worker and in the Node test suite.
 *
 * How it works: every code-shaped token in the subject and body gets a score
 * from the words around it. "Your code is 482913" scores high, a number next
 * to "order" or "%" scores low, and the best token above a threshold wins.
 */

/** Characters that mail clients and senders slip between digits. */
const INVISIBLE =
  /(?:[\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]|\u034F|\u17B4|\u17B5)/g;

const NAMED_ENTITIES = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
  zwnj: '', zwj: '', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ',
  ndash: '-', mdash: '-', hellip: '...', copy: '\u00A9', reg: '\u00AE'
};

/**
 * A letter that is not Chinese, Japanese or Korean. Those scripts write words
 * without spaces, so "認証コードは123456です" has letters glued to both sides
 * of the code. Only Latin-like letters count as "part of the same word".
 */
const WORD_LETTER = String.raw`(?:(?![\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}])\p{L})`;

/**
 * Words that label a code. Matched case-insensitively.
 * The bare words (code, pin, token) only count when they are not part of a
 * phrase such as "promo code" or "zip code", see NOT_A_CODE_LABEL.
 */
const LATIN_LABEL_SOURCE = [
  String.raw`(?:one[- ]?time|temporary|single[- ]use)\s+(?:pass(?:word|code)|code|pin)`,
  String.raw`(?:verification|verify|security|confirmation|confirm|login|log-?in|sign-?in|sign in|authentication|authenticate|auth|access|2fa|mfa|two[- ]factor|sms|email|device|activation|approval|identity)\s+(?:code|pin|token|passcode)`,
  String.raw`passcode`, String.raw`otp`, String.raw`code`, String.raw`pin`, String.raw`token`,
  String.raw`c[oó]digo`, String.raw`codice`, String.raw`k[oó]d(?:u|em)?`, String.raw`kode`,
  String.raw`koodi`, String.raw`код(?:а|ом)?`, String.raw`κωδικός`, String.raw`mã`,
  String.raw`[a-zäöü]*(?:code|kode)`
].join('|');

/**
 * Chinese, Japanese and Korean labels. Longer phrases first, so that
 * "ワンタイムパスワード" is one label and not just "パスワード".
 * Text is NFKC-normalised first, so half-width katakana and full-width
 * letters ("ＰＩＮ") arrive in their usual form.
 */
const CJK_LABEL_SOURCE = [
  String.raw`ワンタイム\s?(?:パスワード|パスコード|コード|キー|PIN|認証コード|暗証番号)`,
  String.raw`(?:本人|ログイン|サインイン|ご本人様)?確認(?:用)?(?:コード|番号|キー|PIN)`,
  String.raw`(?:ログイン|サインイン|メール|SMS|二段階|2段階|多要素)?認証(?:用)?(?:コード|番号|キー|PIN|パスワード)`,
  String.raw`(?:ログイン|サインイン)(?:用)?(?:コード|PIN)`,
  String.raw`(?:承認|検証|照合|セキュリティ|アクティベーション)コード`,
  String.raw`パスコード`, String.raw`PIN\s?(?:コード|番号)`, String.raw`コード`,
  String.raw`验证码`, String.raw`驗證碼`, String.raw`校验码`, String.raw`动态码`,
  String.raw`인증\s?번호`, String.raw`인증\s?코드`
].join('|');

/**
 * A Latin label word must not be glued to other Latin letters or digits on
 * either side. CJK labels need no such boundary.
 */
const LABEL = new RegExp(
  `(?<!${WORD_LETTER}|\\p{N})(?:${LATIN_LABEL_SOURCE})(?!${WORD_LETTER}|\\p{N})|(?:${CJK_LABEL_SOURCE})`,
  'giu'
);

/** Japanese words that, right before "コード", make it some other code. */
const NOT_A_CODE_LABEL_JA =
  /(?:クーポン|プロモーション|プロモ|招待|紹介|割引き?|値引き?|バー|QR|二次元|ギフト|商品|注文|予約|追跡|郵便|ソース|エラー|ステータス|国|地域|識別|会員|お客様|顧客|管理|ポイント|キャンペーン|特典|引換|引き換え|交換|ダウンロード|シリアル|プロダクト|ドレス|カラー|文字|色|JAN|銀行|支店|店舗|ショップ|ライセンス|プレゼント|入場|チケット|優待|友達|フレンド|ストア|決済)\s*$/i;

/** Japanese words right after "コード" that make it some other thing. */
const NOT_A_CODE_AFTER_JA = /^(?:決済|レス|ネーム|表|進行|譜|化|を読み取|をスキャン|をかざ)/;

/** "code" preceded by one of these is not a verification code. */
const NOT_A_CODE_LABEL =
  /(?:promo|promotional|coupon|discount|voucher|gift|gift card|referral|invite|invitation|zip|postal|post|area|country|tracking|product|reference|order|booking|confirmation number|bar|qr|source|dress|error|status|swift|sort|tax|iso|hs|offer|sale|redemption|redeem|reward|access-control)\s*$/i;

/** Words that, right before a token, mean it is some other kind of number. */
const OTHER_NUMBER =
  /(?:order|invoice|receipt|ref|reference|account|acct|ticket|case|tracking|booking|reservation|itinerary|flight|zip|postal|suite|apt|unit|room|phone|tel|telephone|fax|call|ext|extension|sku|model|serial|item|member|customer|policy|loan|card|ending in|last four|no\.?|number|nr\.?|id|注文番号|注文ID|会員番号|会員ID|お客様番号|顧客番号|問い?合わ?せ番号|受付番号|予約番号|伝票番号|追跡番号|配送番号|口座番号|電話番号|電話|携帯|郵便番号|請求番号|請求書番号|管理番号|契約番号|証券番号|整理番号|申込番号|申し?込み番号|取引番号|決済番号|承認番号|暗証番号|品番|型番|商品番号|部屋番号|座席番号|便名|口座|カード番号|末尾|下4桁|ポイント番号|会員証番号|住所|番地|〒)\s*[:#.]?\s*$/i;

/** Marketing context that makes a token a promo code, never an OTP. */
const PROMO = /(?:promo|coupon|discount|voucher|referral|gift card|\d+\s?%|\boff\b|save|sale|deal|at checkout|redeem|クーポン|割引|値引|セール|特典|キャンペーン|プレゼント|円引|オフ|お得)/i;

/** Meeting invites carry passcodes and PINs that are not for signing in. */
const MEETING = /(?:meeting|zoom|webex|teams|webinar|conference|dial[- ]?in|join by phone|call-in|bridge|ミーティング|会議|ウェビナー|セミナー|ダイヤルイン)/i;

/** PINs that belong to something other than a sign-in. */
const OTHER_PIN = /(?:support|account|card|atm|sim|voicemail|door|gate|customer|phone|parking)\s+pin\s*[:#]?\s*$/i;

/** Wording right after a token that says it is no longer the code to use. */
const EXPIRED_AFTER = /^\W{0,3}(?:has|had|have|is|was)?\s*(?:expired|no longer valid|been used|already used|invalid|cancell?ed|replaced)/i;
const EXPIRED_AFTER_JA = /^[\s」』】)\]]{0,3}(?:は|が)?(?:既に|すでに)?(?:無効|使用済み?|失効|期限切れ|利用できません|使用できません|使えません)/;

/** An email that reads like marketing. Codes in it need verification wording to count. */
const PROMO_EMAIL = /(?:promo code|coupon|discount|voucher|\d+\s?% off|use code|redeem|gift card|referral|クーポン|割引|セール|キャンペーン|%OFF|円OFF|% ?オフ|プレゼント)/i;

/** Compound words that end in "code" but are not verification codes. */
const NOT_A_CODE_WORD = /^(?:bar|zip|post|promo|source|qr|area|dress|error|status|swift|sort|tax|country)code$/i;

/** Words that join a label to its token: "code is 123", "código es 123". */
const IS_WORD = String.raw`(?:(?<!\p{L})(?:is|es|est|ist|lautet|è|é|är|er|jest|je|wynosi|to)|为|為|是|は|が)`;

/** Opening quotes and brackets that may wrap a code: "482913", 「482913」, 【482913】. */
const OPEN_QUOTE = String.raw`["'“«(\[「『【〈《〔]`;

/** Closing brackets that may follow a code. */
const CLOSE_QUOTE = String.raw`["'”»)\]」』】〉》〕]`;

/** Units and counters after a number that make it a quantity, date or price. */
const UNIT_AFTER =
  /^\s*(?:usd|eur|gbp|cad|aud|jpy|dollars?|euros?|points|miles|pts|reviews?|items?|people|users|followers|views|steps|calories|kb|mb|gb|km|mi|ms|px)\b|^ ?(?:円|件|名|人|点|個|枚|本|日|年|月|時|分|秒|回|歳|才|ポイント|万|億|千|株|口|位|号|番地|番|階|丁目|部|室|台|冊|杯|泊|kg|cm|mm)/i;

/** Any of these anywhere in the email shows it is about verification. */
const STRONG_INTENT =
  /(verif|one[- ]?time|otp|2fa|mfa|two[- ]factor|2-step|two-step|passcode|security code|login code|sign[- ]?in code|authenticat|confirmation code|access code|c[oó]digo|codice|bestätigung|sicherheitscode|anmeldecode|vérification|kod|код|подтвержд|認証|確認コード|確認番号|ワンタイム|本人確認|パスコード|二段階|2段階|多要素|セキュリティコード|ログインコード|验证码|驗證碼|인증)/iu;

/** Weaker hints that also appear in marketing footers ("Log in to your account"). */
const WEAK_INTENT = /(sign[- ]?in|log[- ]?in|confirm your|connexion|anmeld|ログイン|サインイン)/iu;

const THRESHOLD = 60;
const BEFORE_WINDOW = 160;
const AFTER_WINDOW = 90;

/**
 * Code-shaped tokens. Spaced and dashed forms come first so "123 456" is read
 * as one code. Lookarounds keep out prices, decimals, dates, times, emails,
 * hashtags and parts of longer numbers.
 */
const TOKEN = new RegExp(
  String.raw`(?<!${WORD_LETTER})(?<![\p{N}$€£¥₹#@+&_/\\©〒])(?<!\p{N}[.,:/-])` +
  String.raw`(\d(?: \d){3,7}|\d{3}[ -]\d{3}|\d{4}[ -]\d{4}|\d{2} \d{2} \d{2}|[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|\d{4,8}|[A-Z0-9]{4,8})` +
  String.raw`(?!${WORD_LETTER})(?![\p{N}%_/\\@])(?![.,:/-]\p{N})`,
  'gu'
);

/** Upper-case words that look like codes but never are. */
const NOT_CODES = new Set([
  'HTTP', 'HTTPS', 'HTML', 'EMAIL', 'GMAIL', 'INBOX', 'LOGIN', 'SIGNIN', 'VERIFY',
  'CODE', 'CODES', 'TOKEN', 'CLICK', 'BELOW', 'ABOVE', 'HELLO', 'THANKS', 'TEAM',
  'NOTE', 'NOTICE', 'ALERT', 'URGENT', 'ACTION', 'REQUIRED', 'ACCOUNT', 'SECURITY',
  'PASSWORD', 'RESET', 'CONFIRM', 'SUPPORT', 'HELP', 'FAQ', 'TERMS', 'PRIVACY',
  'POLICY', 'APP', 'IOS', 'ANDROID', 'WINDOWS', 'MACOS', 'LINUX', 'CHROME', 'SAFARI',
  'FIREFOX', 'EDGE', 'UTC', 'GMT', 'EST', 'PST', 'CEST', 'USA', 'USD', 'EUR', 'GBP',
  'CAD', 'AUD', 'INR', 'JPY', 'NULL', 'NONE', 'TRUE', 'FALSE', 'OTP', 'PIN', 'SMS',
  'MFA', 'TFA', 'IMPORTANT', 'WARNING', 'EXPIRES', 'MINUTES', 'VALID', 'IGNORE',
  'DEAR', 'USER', 'CUSTOMER', 'WELCOME', 'NEW', 'DEVICE', 'BROWSER', 'LOCATION'
]);

/**
 * Converts an HTML email body to plain text, keeping block boundaries as
 * line breaks so that a code in its own table cell stays on its own line.
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  if (!html) return '';
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(p|div|tr|td|th|li|ul|ol|table|tbody|thead|h[1-6]|section|article|header|footer|blockquote|center|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*|#39);/gi, (whole, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith('#x')) return safeFromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#') && lower !== '#39') return safeFromCodePoint(parseInt(lower.slice(1), 10));
    return Object.hasOwn(NAMED_ENTITIES, lower) ? NAMED_ENTITIES[lower] : whole;
  });
}

function safeFromCodePoint(n) {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/**
 * Removes invisible characters, links and addresses, and tidies whitespace
 * while keeping line breaks.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  if (!text) return '';
  return text
    .replace(INVISIBLE, '')
    // CJK sentence commas and stops stay CJK: NFKC would turn "663201，5分"
    // into "663201,5分", which reads like a decimal number.
    .replace(/[，､]/g, '、')
    .replace(/[．｡]/g, '。')
    // Full-width digits, letters and colons become ASCII, and half-width
    // katakana becomes full-width.
    .normalize('NFKC')
    .replace(/[\u00A0\u2007\u202F\u3000]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Finds every label word ("code", "OTP", "código") that really labels a
 * verification code.
 * @param {string} text
 * @returns {Array<{ start: number, end: number }>}
 */
function findLabels(text) {
  const labels = [];
  for (const match of text.matchAll(LABEL)) {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (NOT_A_CODE_LABEL.test(before)) continue;
    if (NOT_A_CODE_LABEL_JA.test(before)) continue;
    if (NOT_A_CODE_AFTER_JA.test(text.slice(match.index + match[0].length, match.index + match[0].length + 8))) continue;
    if (NOT_A_CODE_WORD.test(match[0])) continue;
    // "code of conduct", "code of practice"
    if (/^\s+of\s/i.test(text.slice(match.index + match[0].length, match.index + match[0].length + 5))) continue;
    if (/^(?:code|pin|token)$/i.test(match[0]) && /(?:promo|coupon|discount|zip|postal|area|tracking|referral|invite)\s*$/i.test(before)) continue;
    labels.push({ start: match.index, end: match.index + match[0].length });
  }
  return labels;
}

/**
 * @param {string} token
 * @returns {{ code: string, kind: 'numeric'|'spaced'|'spread'|'mixed'|'letters' } | null}
 */
function classifyToken(token) {
  const code = token.replace(/[ -]/g, '');
  if (code.length < 4 || code.length > 8) return null;
  if (/^\d+$/.test(code)) {
    if (/^\d(?: \d)+$/.test(token)) return { code, kind: 'spread' };
    return { code, kind: token.length === code.length ? 'numeric' : 'spaced' };
  }
  if (NOT_CODES.has(code)) return null;
  if (/^[A-Z]+$/.test(code)) return { code, kind: 'letters' };
  return { code, kind: 'mixed' };
}

/**
 * @param {string} full - Subject, a blank line, then the body.
 * @param {number} subjectLength
 * @param {string} html
 * @returns {Array<{ code: string, score: number, index: number, reason: string }>}
 */
function scoreTokens(full, subjectLength, html) {
  const labels = findLabels(full);
  const strongIntent = STRONG_INTENT.test(full);
  const intent = strongIntent || WEAK_INTENT.test(full);
  const promoEmail = !strongIntent && PROMO_EMAIL.test(full);
  const candidates = [];

  for (const match of full.matchAll(TOKEN)) {
    const token = match[1];
    const start = match.index;
    const end = start + token.length;
    const info = classifyToken(token);
    if (!info) continue;

    // Spaced codes must not be one group of a longer number such as a phone number.
    if (info.kind === 'spaced' || info.kind === 'spread') {
      if (/\d[ -]$/.test(full.slice(Math.max(0, start - 2), start))) continue;
      if (/^[ -]\d/.test(full.slice(end, end + 2))) continue;
    }

    const before = full.slice(Math.max(0, start - BEFORE_WINDOW), start);
    const after = full.slice(end, end + AFTER_WINDOW);
    const near = before.slice(-40);
    const labelBefore = nearestLabelBefore(labels, start);
    const labelAfter = labels.find(l => l.start >= end && l.start - end <= AFTER_WINDOW);

    let score = 0;
    let reason = '';

    // "Your verification code is: 482913" or "Code\n482913"
    if (labelBefore !== null) {
      const between = full.slice(labelBefore.end, start);
      if (new RegExp(`^[^\\n\\d]{0,40}?(?:${IS_WORD}\\s*[:：]?|[:：=])\\s*${OPEN_QUOTE}?\\s*$`, 'iu').test(between) ||
          new RegExp(`^\\s*${OPEN_QUOTE}?\\s*$`, 'u').test(between) ||
          /^[ \t]*[:：]?[ \t]*\n\s*$/.test(between)) {
        score = 100;
        reason = 'label';
      } else if (between.length <= 120 && !/[.!?]\s+\p{Lu}[^.!?]{40,}/u.test(between) && !/。[^。\n]{40,}/u.test(between)) {
        score = Math.max(score, 85 - Math.round(between.length / 6));
        reason = 'near-label';
      }
    }

    // "482913 is your Acme code"
    if (labelAfter) {
      const between = full.slice(end, labelAfter.start);
      if (new RegExp(`^\\s*(?:${IS_WORD})\\s[^\\n\\d]{0,40}$`, 'iu').test(between) ||
          new RegExp(`^\\s*${CLOSE_QUOTE}?\\s*(?:が|は|:)[^\\n\\d。]{0,30}$`, 'u').test(between)) {
        if (score < 100) reason = 'label-after';
        score = Math.max(score, 100);
      } else if (between.length <= 60 && score < 70) {
        score = Math.max(score, 70 - Math.round(between.length / 4));
        reason = reason || 'near-label-after';
      }
    }

    // "Use 482913 to sign in", "Enter 482913 to continue"
    if (score < 90 && intent &&
        /(?:^|[^\p{L}])(?:use|enter|type|input|paste|introduce|ingresa|introduzca|saisissez|eingeben)\s*$/iu.test(near) &&
        /^\s*(?:to|as|for|para|pour|um|per)\s/i.test(after)) {
      score = 90;
      reason = 'action';
    }

    // "123456 を入力してください"
    if (score < 90 && intent && new RegExp(`^\\s*${CLOSE_QUOTE}?\\s*を\\s*(?:ご)?(?:入力|入れ|お使い|使用|使っ)`, 'u').test(after)) {
      score = 90;
      reason = 'action';
    }

    // With no label at all, only an email that is clearly about verification counts.
    if (score === 0 && !strongIntent) continue;
    if (score === 0) {
      score = 30;
      reason = 'intent';
    }

    const inSubject = start < subjectLength;
    if (inSubject && strongIntent) {
      score += 20;
      reason += '+subject';
    }

    // A code alone on its own line is how most senders show it.
    const lineStart = full.lastIndexOf('\n', start - 1) + 1;
    const lineEndRaw = full.indexOf('\n', end);
    const line = full.slice(lineStart, lineEndRaw === -1 ? full.length : lineEndRaw).trim();
    if (line === token && strongIntent) {
      score += 25;
      reason += '+own-line';
    }

    if (html && strongIntent) {
      const emphasis = htmlEmphasis(html, token);
      if (emphasis) {
        score += emphasis;
        reason += '+emphasis';
      }
    }

    // Penalties.
    const strongLabel = reason.startsWith('label');
    if (info.kind === 'letters') {
      if (!strongLabel) continue;
      score -= 25;
    }
    if (info.kind === 'mixed' && !strongLabel) score -= 25;
    if (info.kind === 'spread' && !strongLabel) continue;
    if (info.kind === 'spaced' && !strongLabel && !reason.startsWith('near-label')) score -= 15;
    if (OTHER_NUMBER.test(near)) score -= 70;
    if (PROMO.test(near) || PROMO.test(after.slice(0, 30))) score -= 80;
    if (MEETING.test(before)) score -= 80;
    if (OTHER_PIN.test(near)) score -= 70;
    if (EXPIRED_AFTER.test(after) || EXPIRED_AFTER_JA.test(after)) score -= 60;
    if (UNIT_AFTER.test(after)) score -= 70;
    if (info.kind === 'numeric' && info.code.length === 4 && /^(?:19|20)\d\d$/.test(info.code) && !strongLabel) score -= 45;
    if (/^(\d)\1+$/.test(info.code)) score -= 30;
    if (promoEmail) score -= 50;
    if (/\b(?:expires?|valid|within|in|for|after)\s*$/i.test(near)) score -= 30;

    candidates.push({ code: info.code, score, index: start, reason });
  }

  return candidates;
}

/**
 * @param {Array<{ start: number, end: number }>} labels
 * @param {number} index
 * @returns {{ start: number, end: number } | null}
 */
function nearestLabelBefore(labels, index) {
  let best = null;
  for (const label of labels) {
    if (label.end > index) break;
    if (index - label.end <= BEFORE_WINDOW) best = label;
  }
  return best;
}

/**
 * Extra points when the HTML shows the token on its own in a large, bold or
 * spaced-out element, which is how most senders style a code.
 * @param {string} html
 * @param {string} token
 * @returns {number}
 */
function htmlEmphasis(html, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]/g, '[\\s\\-]*');
  const re = new RegExp(`<([a-z0-9]+)([^>]*)>\\s*${escaped}\\s*<`, 'i');
  const match = html.match(re);
  if (!match) return 0;
  const [, tag, attrs] = match;
  const styled = /font-size\s*:\s*(?:1[6-9]|[2-9]\d)px|letter-spacing|font-weight\s*:\s*(?:bold|[6-9]00)|monospace/i.test(attrs);
  return /^(?:b|strong|h[1-4]|code|pre|kbd)$/i.test(tag) || styled ? 20 : 10;
}

/**
 * Finds the verification code in one email.
 *
 * @param {{ subject?: string, text?: string, html?: string }} email
 *   The subject line, the plain-text body and the HTML body. Either body may
 *   be empty.
 * @returns {{ code: string, score: number, reason: string } | null}
 *   The best code, or null when nothing scores above the threshold.
 */
export function extractCode({ subject = '', text = '', html = '' } = {}) {
  const cleanSubject = normalizeText(subject).replace(/\n/g, ' ');
  const body = normalizeText(text || htmlToText(html));
  if (!cleanSubject && !body) return null;

  const full = `${cleanSubject}\n\n${body}`;
  const candidates = scoreTokens(full, cleanSubject.length, html ? html.normalize('NFKC') : '');

  // Merge repeats of the same code, keeping the best score plus a small bonus.
  const byCode = new Map();
  for (const c of candidates) {
    const seen = byCode.get(c.code);
    if (!seen) {
      byCode.set(c.code, { ...c, count: 1 });
    } else {
      seen.count += 1;
      if (c.score > seen.score) Object.assign(seen, { score: c.score, reason: c.reason, index: Math.min(seen.index, c.index) });
    }
  }

  let ranked = [...byCode.values()].map(c => ({ ...c, score: c.score + Math.min(c.count - 1, 2) * 5 }));
  ranked = ranked.filter(c => c.score >= THRESHOLD);
  if (!ranked.length) return null;

  ranked.sort((a, b) =>
    b.score - a.score ||
    Number(/^\d+$/.test(b.code)) - Number(/^\d+$/.test(a.code)) ||
    Number(b.code.length === 6) - Number(a.code.length === 6) ||
    a.index - b.index
  );

  const best = ranked[0];
  return { code: best.code, score: best.score, reason: best.reason };
}

export const EXTRACT_THRESHOLD = THRESHOLD;
