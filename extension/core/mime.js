/**
 * Turns a Gmail API message resource (format=full) into subject, sender,
 * plain text and HTML.
 *
 * Pure functions with no browser APIs, so they run in the service worker and
 * in Node tests alike.
 */

/**
 * @param {Array<{ name: string, value: string }>} [headers]
 * @param {string} name
 * @returns {string}
 */
export function getHeader(headers, name) {
  const lower = name.toLowerCase();
  return headers?.find(h => h?.name?.toLowerCase() === lower)?.value ?? '';
}

/**
 * Every value of a header that may appear more than once, in message order
 * (the topmost header first).
 * @param {Array<{ name: string, value: string }>} [headers]
 * @param {string} name
 * @returns {string[]}
 */
export function getHeaders(headers, name) {
  const lower = name.toLowerCase();
  return (headers || []).filter(h => h?.name?.toLowerCase() === lower).map(h => String(h.value ?? ''));
}

/**
 * @param {string} contentType - e.g. 'text/html; charset="ISO-8859-1"'
 * @returns {string}
 */
export function charsetOf(contentType) {
  const match = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType || '');
  if (!match) return 'utf-8';
  const name = match[1].toLowerCase();
  return CHARSET_ALIASES[name] || name;
}

/**
 * Names Japanese senders use that TextDecoder does not know. Shift_JIS mail is
 * nearly always Microsoft's superset, which TextDecoder decodes as shift_jis.
 */
const CHARSET_ALIASES = {
  cp932: 'shift_jis',
  'ms932': 'shift_jis',
  'x-ms932': 'shift_jis',
  'ms_kanji': 'shift_jis',
  'x-sjis-cp932': 'shift_jis',
  'iso-2022-jp-ms': 'iso-2022-jp',
  'iso-2022-jp-1': 'iso-2022-jp',
  'iso-2022-jp-2': 'iso-2022-jp',
  'iso-2022-jp-3': 'iso-2022-jp',
  'cp50220': 'iso-2022-jp',
  'cp50221': 'iso-2022-jp',
  'eucjp-ms': 'euc-jp',
  'cp51932': 'euc-jp'
};

/**
 * Decodes Gmail's base64url body data using the part's character set.
 * @param {string} data
 * @param {string} [charset]
 * @returns {string}
 */
export function decodeBody(data, charset = 'utf-8') {
  if (!data) return '';
  let bytes;
  try {
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch {
    return '';
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

/**
 * Collects every text/plain and text/html part, skipping attachments.
 * @param {object} part
 * @param {{ text: string[], html: string[] }} out
 */
function walk(part, out) {
  if (!part) return;
  if (Array.isArray(part.parts) && part.parts.length) {
    for (const child of part.parts) walk(child, out);
    return;
  }

  const mime = (part.mimeType || '').toLowerCase();
  const disposition = getHeader(part.headers, 'content-disposition').toLowerCase();
  if (part.filename || disposition.startsWith('attachment')) return;
  if (!part.body?.data) return;

  const charset = charsetOf(getHeader(part.headers, 'content-type'));
  if (mime === 'text/plain') out.text.push(decodeBody(part.body.data, charset));
  else if (mime === 'text/html') out.html.push(decodeBody(part.body.data, charset));
}

/**
 * @typedef {object} ParsedMessage
 * @property {string} id
 * @property {number} receivedAt - Milliseconds since the epoch, from Gmail's internalDate.
 * @property {string} subject
 * @property {string} from
 * @property {string[]} authResults - Authentication-Results header values, top first.
 * @property {boolean} spam - True when Gmail filed the message in Spam.
 * @property {string} text - Plain-text body, may be empty.
 * @property {string} html - HTML body, may be empty.
 */

/**
 * @param {object} message - Gmail API message resource fetched with format=full.
 * @returns {ParsedMessage}
 */
export function parseMessage(message) {
  const payload = message?.payload ?? {};
  const out = { text: [], html: [] };
  walk(payload, out);

  return {
    id: message?.id ?? '',
    receivedAt: Number(message?.internalDate) || 0,
    subject: getHeader(payload.headers, 'subject'),
    from: getHeader(payload.headers, 'from'),
    authResults: getHeaders(payload.headers, 'authentication-results'),
    spam: Array.isArray(message?.labelIds) && message.labelIds.includes('SPAM'),
    text: out.text.join('\n').trim(),
    html: out.html.join('\n').trim()
  };
}

/**
 * "Acme Security <no-reply@acme.com>" becomes "Acme Security".
 * @param {string} from
 * @returns {string}
 */
export function senderName(from) {
  if (!from) return '';
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  if (named) return named[1].trim();
  return from.replace(/[<>]/g, '').trim();
}
