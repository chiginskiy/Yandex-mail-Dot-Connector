import { ImapFlow } from 'imapflow';
import { LIMITS } from './validation.js';
import { fail } from './errors.js';
import { createHash } from 'node:crypto';
import { inspectMime, htmlToText, truncateUtf8 } from './mime.js';

export const YANDEX_HOST = 'imap.yandex.com';
const VERIFIED_OAUTH = Symbol('verified-yandex-xoauth2');

/**
 * Yandex supports XOAUTH2 without advertising it in CAPABILITY.
 * ImapFlow 2.2.1 has no public force-XOAUTH2 option. This isolated, version-pinned
 * shim runs just before authentication, after the server's CAPABILITY response.
 * Wire tests cover this internal hook. Re-audit it before upgrading ImapFlow.
 */
export function forceYandexXOAuth2(client) {
  const original = client.authenticate;
  if (typeof original !== 'function') fail(503, 'unsupported_imap_library');
  client.authenticate = async function () {
    // PREAUTH would skip our explicit owner/token authentication entirely.
    if (this.state !== this.states.NOT_AUTHENTICATED) fail(502, 'unexpected_preauth');
    this.capabilities.delete('AUTH=OAUTHBEARER');
    this.capabilities.delete('AUTH=XOAUTH');
    this.capabilities.set('AUTH=XOAUTH2', true);
    const result = await original.call(this);
    this[VERIFIED_OAUTH] = result === true && this.authenticated === true;
    return result;
  };
  return client;
}

export function imapOptions(owner, accessToken) {
  return {
    host: YANDEX_HOST, port: 993, secure: true,
    auth: { user: owner, accessToken },
    logger: false, emitLogs: false, logRaw: false,
    disableAutoIdle: true, disableCompression: true, disableBinary: true,
    disableAutoEnable: true, disableIMAP4rev2: true,
    connectionTimeout: 7000, greetingTimeout: 5000, socketTimeout: 8000,
    maxLineLength: 128 * 1024, maxLiteralSize: 128 * 1024, maxResponseSize: 256 * 1024,
  };
}
export function createYandexClient(owner, accessToken) {
  const client = forceYandexXOAuth2(new ImapFlow(imapOptions(owner, accessToken)));
  client.on('error', () => {}); // Never log exceptions that may contain mailbox or auth data.
  return client;
}

/** Verify OAuth mailbox ownership by authentication only; never select or read mail. */
export async function verifyYandexToken(owner, accessToken, {createClient = createYandexClient} = {}) {
  const client = createClient(owner, accessToken);
  let timer;
  try {
    return await Promise.race([
      client.connect().then(() => client.authenticated === true && client[VERIFIED_OAUTH] === true),
      new Promise(resolve => {timer = setTimeout(() => { client.close(); resolve(false); }, 10_000);}),
    ]);
  } catch { return false; }
  finally { clearTimeout(timer); client.close(); }
}

const clip = (value, length) => typeof value === 'string' ? value.slice(0, length).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '') : '';
function addresses(value) {
  return Array.isArray(value) ? value.slice(0, 10).map(v => ({name: clip(v.name, 120), address: clip(v.address, 254)})) : [];
}
function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function messageSummary(message) {
  return {
    uid: message.uid, date: iso(message.envelope?.date ?? message.internalDate),
    subject: clip(message.envelope?.subject, 1000),
    from: addresses(message.envelope?.from), to: addresses(message.envelope?.to),
    size: Number.isSafeInteger(message.size) ? message.size : null,
    flags: [...(message.flags ?? [])].slice(0, 20).map(v => clip(v, 80)),
  };
}
const SUMMARY_QUERY = Object.freeze({ uid: true, envelope: true, flags: true, size: true, internalDate: true });

async function discoverMailboxes(client, allowedMailboxes) {
  // LIST/LSUB metadata only: no SELECT, STATUS, subscription changes, or mail.
  // ImapFlow 2.2.1 listOnly returns before assigning specialUseSource, so use
  // normal list() without statusQuery or user hints and inspect its provenance.
  const entries = await client.list();
  if (!Array.isArray(entries)) fail(502, 'invalid_folder_list');
  const folders = entries.slice(0, LIMITS.mailboxes).map(entry => {
    const path = entry.path;
    if (typeof path !== 'string' || !path.length || path.length > 120 || /[\u0000-\u001f\u007f]/u.test(path)) return null;
    const flags = entry.flags instanceof Set ? entry.flags : new Set();
    const selectable = !flags.has('\\Noselect') && !flags.has('\\NonExistent');
    const specialUseSource = ['extension', 'name', 'user'].includes(entry.specialUseSource) ? entry.specialUseSource : null;
    const specialUse = typeof entry.specialUse === 'string' ? clip(entry.specialUse, 40) : null;
    return { path, selectable, allowed: allowedMailboxes.includes(path), specialUse, specialUseSource, serverSentFlag: flags.has('\\Sent') };
  }).filter(Boolean);
  // ImapFlow assigns at most one specialUse per type. Count raw flags too, so its
  // tie-breaker cannot hide multiple server-declared Sent folders from the user.
  const sent = folders.filter(folder => folder.selectable && folder.specialUse === '\\Sent' && folder.specialUseSource === 'extension');
  const rawSent = folders.filter(folder => folder.selectable && folder.serverSentFlag);
  const truncated = entries.length > LIMITS.mailboxes;
  const ambiguous = sent.length > 1 || rawSent.length > 1 || truncated;
  return { folders, truncated, sentMailbox: !ambiguous && sent.length === 1 ? sent[0].path : null, sentStatus: ambiguous ? 'ambiguous' : sent.length === 1 ? 'server_identified' : 'not_server_identified', requiresExplicitConfiguration: true };
}

async function attachmentChunk(client, input, message, metadata) {
  if (!metadata) fail(404, 'attachment_not_found');
  if (!metadata.downloadable) fail(metadata.unavailableReason === 'attachment_too_large' ? 413 : 422, metadata.unavailableReason);
  if (input.offset > metadata.encodedSize || (input.offset === metadata.encodedSize && metadata.encodedSize > 0)) fail(400, 'invalid_offset');
  const expectedBytes = Math.min(LIMITS.attachmentChunkBytes, metadata.encodedSize - input.offset);
  let buffer = Buffer.alloc(0);
  if (expectedBytes > 0) {
    // Do not use download(): it may convert text charsets/format=flowed. Return
    // exact transfer-encoded BODY.PEEK bytes; the verified consumer decodes once.
    const key = input.part === '1' && !message.bodyStructure.childNodes ? 'text' : input.part;
    const result = await client.fetchOne(input.uid, { uid: true, bodyParts: [{ key, start: input.offset, maxLength: expectedBytes }] }, { uid: true });
    if (!result || result.uid !== input.uid) fail(404, 'message_not_found');
    if (result.binaryParts?.has(key)) fail(502, 'unexpected_binary_decoding');
    const bytes = result.bodyParts?.get(key);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail(502, 'invalid_attachment_chunk');
    buffer = Buffer.from(bytes);
    if (buffer.length !== expectedBytes) fail(502, 'attachment_size_changed');
  }
  const nextOffset = input.offset + buffer.length;
  return { mailbox: input.mailbox, uid: input.uid, uidValidity: input.uidValidity, ...metadata,
    offset: input.offset, nextOffset, done: nextOffset === metadata.encodedSize,
    dataBase64: buffer.toString('base64'), chunkSha256: createHash('sha256').update(buffer).digest('hex'),
    transport: 'mime-transfer-encoded', decodedSize: null,
  };
}

export async function performOperation(client, operation, input) {
  if (operation === 'discover') return discoverMailboxes(client, input.allowedMailboxes);
  const lock = await client.getMailboxLock(input.mailbox, { readOnly: true });
  try {
    const mailbox = client.mailbox;
    if (!mailbox || mailbox.readOnly !== true || !mailbox.uidValidity) fail(502, 'readonly_mailbox_required');
    const uidValidity = String(mailbox.uidValidity);
    if (operation === 'read' || operation === 'attachment') {
      if (input.uidValidity !== uidValidity) fail(409, 'uid_validity_changed');
      const message = await client.fetchOne(input.uid, { ...(operation === 'read' ? SUMMARY_QUERY : { uid: true }), bodyStructure: true }, { uid: true });
      if (!message || message.uid !== input.uid) fail(404, 'message_not_found');
      const mime = inspectMime(message.bodyStructure);
      if (operation === 'attachment') return await attachmentChunk(client, input, message, mime.attachments.find(attachment => attachment.part === input.part));
      const result = { mailbox: input.mailbox, uidValidity, ...messageSummary(message), text: null, truncated: false, bodyStatus: 'no_supported_text', textSource: null, attachmentsIncluded: false, attachments: mime.attachments, attachmentsTruncated: mime.attachmentsTruncated };
      const part = mime.plain ?? mime.html;
      if (!part) return result;
      const isHtml = !mime.plain;
      const maxBytes = (isHtml ? LIMITS.htmlBytes : LIMITS.textBytes) + 1;
      const download = await client.download(input.uid, part, { uid: true, maxBytes, chunkSize: 8192 });
      if (!download.content) fail(404, 'message_not_found');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of download.content) {
        const buffer = Buffer.from(chunk);
        if (bytes + buffer.length > maxBytes) fail(502, 'body_limit_exceeded');
        chunks.push(buffer); bytes += buffer.length;
      }
      const buffer = Buffer.concat(chunks);
      const bounded = truncateUtf8(buffer, maxBytes - 1);
      const converted = isHtml ? htmlToText(bounded.text) : bounded;
      result.truncated = bounded.truncated || converted.truncated;
      result.text = converted.text;
      result.textSource = isHtml ? 'html_to_text' : 'plain';
      if (isHtml) result.htmlConversion = { sourceByteLimit: LIMITS.htmlBytes, textByteLimit: LIMITS.textBytes, sourceTruncated: bounded.truncated, textTruncated: converted.truncated, remoteContentLoaded: false };
      result.bodyStatus = result.truncated ? 'truncated' : 'ok';
      return result;
    }

    if (!Number.isInteger(mailbox.uidNext) || mailbox.uidNext < 1 || mailbox.uidNext > 0xffffffff) fail(502, 'invalid_mailbox_state');
    const high = Math.min(mailbox.uidNext - 1, input.beforeUid === undefined ? 0xffffffff : input.beforeUid - 1);
    if (mailbox.exists === 0 || high < 1) return { mailbox: input.mailbox, uidValidity, messages: [], nextBeforeUid: null, scannedUidRange: null };
    const low = Math.max(1, high - LIMITS.uidWindow + 1);
    const found = await client.search({ ...input.criteria, uid: `${low}:${high}` }, { uid: true });
    if (!Array.isArray(found) || found.length > LIMITS.uidWindow || found.some(uid => !Number.isInteger(uid) || uid < low || uid > high)) fail(502, 'invalid_search_result');
    const sorted = [...new Set(found)].sort((a, b) => b - a);
    const selected = sorted.slice(0, input.limit);
    const messages = selected.length ? await client.fetchAll(selected, SUMMARY_QUERY, { uid: true }) : [];
    if (messages.length > input.limit || messages.some(message => !selected.includes(message.uid))) fail(502, 'invalid_fetch_result');
    const next = sorted.length > input.limit ? selected.at(-1) : low;
    return {
      mailbox: input.mailbox, uidValidity,
      messages: messages.sort((a, b) => b.uid - a.uid).map(messageSummary),
      nextBeforeUid: next > 1 ? next : null,
      scannedUidRange: { fromUid: low, toUid: high },
    };
  } finally { lock.release(); }
}
