import { Parser } from 'htmlparser2';
import { createHash } from 'node:crypto';
import { LIMITS } from './validation.js';

export const PART_PATTERN = /^[1-9]\d{0,4}(?:\.[1-9]\d{0,4}){0,9}$/;
const ENCODINGS = new Set(['base64', 'quoted-printable', '7bit', '8bit', 'binary']);
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

export function truncateUtf8(value, maxBytes) {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return { text: new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: bytes.length > maxBytes }), truncated: bytes.length > maxBytes };
}

/** Text extraction only: no browser, DOM execution, URL loading, or attributes in output. */
export function htmlToText(html) {
  const skip = new Set(['head', 'script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'noscript']);
  const blocks = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article', 'table', 'blockquote', 'hr', 'pre']);
  const hidden = [];
  const output = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      const invisible = skip.has(name) || Object.hasOwn(attributes, 'hidden') || attributes['aria-hidden'] === 'true' || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.style ?? '');
      hidden.push(invisible || hidden.at(-1) === true);
      if (!hidden.at(-1) && blocks.has(name)) output.push('\n');
    },
    ontext(text) { if (!hidden.at(-1)) output.push(text); },
    onclosetag(name) { const wasHidden = hidden.pop(); if (!wasHidden && blocks.has(name) && !['br', 'hr'].includes(name)) output.push('\n'); },
  }, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  const text = output.join('').replace(CONTROLS, '').replace(/[\t \u00a0]+/gu, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return truncateUtf8(text, LIMITS.textBytes);
}

export function safeFilename(value, part) {
  let name = typeof value === 'string' ? value.slice(0, 240).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/gu, '_').replace(/^[. ]+|[. ]+$/g, '') : '';
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return name || `attachment-${part}.bin`;
}

function attachmentMeta(node, part) {
  const encoding = typeof node.encoding === 'string' ? node.encoding.toLowerCase().trim() : '7bit';
  const size = Number.isSafeInteger(node.size) && node.size >= 0 ? node.size : null;
  const contentType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(node.type ?? '') ? node.type.toLowerCase() : 'application/octet-stream';
  const reason = size === null ? 'unknown_encoded_size' : !ENCODINGS.has(encoding) ? 'unsupported_transfer_encoding' : size > LIMITS.attachmentEncodedBytes || (!['base64', 'quoted-printable'].includes(encoding) && size > LIMITS.attachmentBytes) ? 'attachment_too_large' : null;
  const suppliedFilename = node.dispositionParameters?.filename ?? node.parameters?.name;
  const originalFilename = typeof suppliedFilename === 'string' ? suppliedFilename.slice(0, 512) : null;
  const metadata = { part, filename: safeFilename(suppliedFilename, part), originalFilename, filenameTruncated: typeof suppliedFilename === 'string' && suppliedFilename.length > 512, contentType, contentTransferEncoding: encoding, encodedSize: size, maxDecodedBytes: LIMITS.attachmentBytes };
  return { ...metadata, downloadable: reason === null, unavailableReason: reason, metadataFingerprint: createHash('sha256').update(JSON.stringify(metadata)).digest('hex') };
}

/** Never traverse attached containers or nested forwarded mail; bounded breadth-first tree walk. */
export function inspectMime(root) {
  const queue = root ? [root] : [];
  const attachments = [];
  let plain = null, html = null, visited = 0, attachmentsTruncated = false;
  while (queue.length && visited++ < LIMITS.mimeNodes) {
    const node = queue.shift();
    if (!node || typeof node !== 'object') continue;
    const part = node.part || (node === root ? '1' : '');
    const isAttachment = node.disposition === 'attachment' || !!node.dispositionParameters?.filename || !!node.parameters?.name || node.type === 'message/rfc822' || (node.type && !node.type.startsWith('multipart/') && !['text/plain', 'text/html'].includes(node.type));
    if (isAttachment) {
      if (!node.type?.startsWith('multipart/') && PART_PATTERN.test(part)) {
        if (attachments.length < LIMITS.attachments) attachments.push(attachmentMeta(node, part)); else attachmentsTruncated = true;
      }
      continue;
    }
    if (PART_PATTERN.test(part)) {
      if (node.type === 'text/plain' && !plain) plain = part;
      if (node.type === 'text/html' && !html) html = part;
    }
    if (node.type?.startsWith('multipart/') && Array.isArray(node.childNodes)) {
      const room = Math.max(0, LIMITS.mimeNodes - visited - queue.length);
      if (node.childNodes.length > room) attachmentsTruncated = true;
      queue.push(...node.childNodes.slice(0, room));
    }
  }
  return { plain, html, attachments, attachmentsTruncated: attachmentsTruncated || queue.length > 0 };
}
