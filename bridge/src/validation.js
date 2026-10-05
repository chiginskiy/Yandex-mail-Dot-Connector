import { fail } from './errors.js';

export const LIMITS = Object.freeze({
  requestBytes: 8192, responseBytes: 256 * 1024, messages: 50, uidWindow: 1000,
  textBytes: 32 * 1024, htmlBytes: 128 * 1024, operationMs: 15_000, bodyMs: 3000,
  mimeNodes: 100, attachments: 30, mailboxes: 100,
  attachmentBytes: 20 * 1024 * 1024, attachmentEncodedBytes: 64 * 1024 * 1024, attachmentChunkBytes: 128 * 1024,
});
const COMMON = ['mailbox', 'limit', 'beforeUid'];
const SEARCH = ['from', 'to', 'subject', 'text', 'since', 'before', 'unseen'];
const control = /[\u0000-\u001f\u007f]/u;
export function boundedString(value, max, field) {
  if (typeof value !== 'string' || !value.length || value.length > max || control.test(value)) fail(400, `invalid_${field}`);
  return value;
}
export function uint(value, field, max = 0xffffffff) {
  if (!Number.isInteger(value) || value < 1 || value > max) fail(400, `invalid_${field}`);
  return value;
}
function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(400, `invalid_${field}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail(400, `invalid_${field}`);
  return parsed;
}
export function validateInput(operation, body, allowedMailboxes) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'invalid_json_object');
  if (operation === 'discover') {
    if (Object.keys(body).length) fail(400, 'unknown_field');
    return { allowedMailboxes };
  }
  const keys = ['read', 'attachment'].includes(operation) ? ['mailbox', 'uid', 'uidValidity', ...(operation === 'attachment' ? ['part', 'offset'] : [])] : [...COMMON, ...(operation === 'search' ? SEARCH : [])];
  if (Object.keys(body).some(key => !keys.includes(key))) fail(400, 'unknown_field');
  const mailbox = boundedString(body.mailbox ?? 'INBOX', 120, 'mailbox');
  if (!allowedMailboxes.includes(mailbox)) fail(403, 'mailbox_not_allowed');
  if (operation === 'read' || operation === 'attachment') {
    const uid = uint(body.uid, 'uid');
    if (typeof body.uidValidity !== 'string' || !/^[1-9]\d{0,9}$/.test(body.uidValidity) || Number(body.uidValidity) > 0xffffffff) fail(400, 'invalid_uidValidity');
    if (operation === 'read') return { mailbox, uid, uidValidity: body.uidValidity };
    if (typeof body.part !== 'string' || !/^[1-9]\d{0,4}(?:\.[1-9]\d{0,4}){0,9}$/.test(body.part)) fail(400, 'invalid_part');
    const offset = body.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > LIMITS.attachmentEncodedBytes) fail(400, 'invalid_offset');
    return { mailbox, uid, uidValidity: body.uidValidity, part: body.part, offset };
  }
  const limit = body.limit === undefined ? 20 : uint(body.limit, 'limit', LIMITS.messages);
  const beforeUid = body.beforeUid === undefined ? undefined : uint(body.beforeUid, 'beforeUid');
  const criteria = {};
  for (const name of ['from', 'to', 'subject', 'text']) {
    if (body[name] !== undefined) criteria[name === 'text' ? 'body' : name] = boundedString(body[name], 256, name);
  }
  for (const name of ['since', 'before']) if (body[name] !== undefined) criteria[name] = date(body[name], name);
  if (criteria.since && criteria.before && criteria.since >= criteria.before) fail(400, 'invalid_date_range');
  if (body.unseen !== undefined) {
    if (typeof body.unseen !== 'boolean') fail(400, 'invalid_unseen');
    criteria.seen = !body.unseen;
  }
  if (operation === 'search' && !Object.keys(criteria).length) fail(400, 'search_filter_required');
  return { mailbox, limit, beforeUid, criteria };
}

export function readConfig(env) {
  const owner = env.YANDEX_OWNER_EMAIL;
  if (typeof owner !== 'string' || owner.length > 254 || !/^[^\s@\\/]+@[^\s@]+$/u.test(owner) || control.test(owner)) fail(503, 'not_configured');
  let mailboxes;
  try { mailboxes = JSON.parse(env.ALLOWED_MAILBOXES ?? '["INBOX"]'); } catch { fail(503, 'not_configured'); }
  if (!Array.isArray(mailboxes) || !mailboxes.length || mailboxes.length > 20 || mailboxes.some(v => typeof v !== 'string' || !v.length || v.length > 120 || control.test(v))) fail(503, 'not_configured');
  return { owner, mailboxes };
}
