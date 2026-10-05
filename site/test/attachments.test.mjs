import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { assembleChunks, decodeMimeBytes, writeAttachment, readJsonLines, MAX_DECODED_BYTES, MAX_ENCODED_BYTES } from '../scripts/assemble-attachment.mjs';
import { createMcpHandler, normalizeArgs, ownerAuthorizer, TOOLS } from '../src/mcp.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const identity = { mailbox: 'INBOX', uid: 23, uidValidity: '44', part: '2.1' };
function fixture(bytes, encoding = 'binary', cut = 131072, overrides = {}) {
  const chunks = [];
  const metadata = { ...identity, filename: 'вложение.bin', contentType: 'application/octet-stream', contentTransferEncoding: encoding, encodedSize: bytes.length, metadataFingerprint: hash('fixture descriptor'), maxDecodedBytes: MAX_DECODED_BYTES, ...overrides };
  for (let offset = 0; offset < bytes.length || !chunks.length; offset += cut) {
    const chunk = bytes.subarray(offset, offset + cut);
    const nextOffset = offset + chunk.length;
    chunks.push({ ...metadata, offset, nextOffset, done: nextOffset === bytes.length, dataBase64: chunk.toString('base64'), chunkSha256: hash(chunk) });
  }
  return chunks;
}
const wrap = chunk => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(chunk) }], isError: false } });
const rpc = (name, args = {}, headers = {}) => new Request('https://private.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
const owner = { 'oai-authenticated-user-id': 'owner-1', 'oai-authenticated-user-email': 'owner@example.invalid' };

test('five readonly tools expose folder discovery and bounded selected attachment inputs', () => {
  assert.equal(TOOLS.length, 5);
  assert.ok(TOOLS.every(tool => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
  assert.deepEqual(normalizeArgs('yandex_mail_folders', {}), {});
  assert.deepEqual(normalizeArgs('yandex_mail_search', { to: 'recipient@example.invalid' }), { to: 'recipient@example.invalid', mailbox: 'INBOX', limit: 20 });
  assert.throws(() => normalizeArgs('yandex_mail_search', { to: 'bad\r\nTO' }));
  assert.throws(() => normalizeArgs('yandex_mail_folders', { mailbox: 'Sent' }));
  assert.deepEqual(normalizeArgs('yandex_mail_attachment', identity), { ...identity, offset: 0 });
  const schema = TOOLS.find(tool => tool.name === 'yandex_mail_attachment').inputSchema;
  assert.ok(new RegExp(schema.properties.part.pattern).test('2.1'));
  for (const overrides of [{ part: '' }, { part: '0' }, { part: '01' }, { part: '1.MIME' }, { part: '2\r\nSTORE' }, { part: '../2' }, { offset: -1 }, { offset: 67108865 }, { offset: '0' }, { uidValidity: '4294967296' }, { ownerId: 'other' }, { filename: 'choose.txt' }, { downloadAll: true }]) {
    assert.throws(() => normalizeArgs('yandex_mail_attachment', { ...identity, ...overrides }));
  }
});

test('new routes require owner and preserve exact folder and selected-part identity', async () => {
  let forwarded;
  const handler = createMcpHandler({ authorizeOwner: ownerAuthorizer({ ownerUserId: 'owner-1', ownerEmail: 'owner@example.invalid' }), bridgeCall: async (...args) => { forwarded = args; return { ok: true }; } });
  for (const [name, args, route] of [['yandex_mail_folders', {}, '/v1/mailboxes/discover'], ['yandex_mail_attachment', identity, '/v1/messages/attachment']]) {
    assert.equal((await handler(rpc(name, args))).status, 401);
    assert.equal((await handler(rpc(name, args, { ...owner, 'oai-authenticated-user-id': 'intruder' }))).status, 403);
    assert.equal(forwarded, undefined);
    const result = await (await handler(rpc(name, args, owner))).json();
    assert.equal(result.result.isError, false);
    assert.equal(forwarded[0], route);
    assert.deepEqual(forwarded[1], name === 'yandex_mail_folders' ? {} : { ...identity, offset: 0 });
    forwarded = undefined;
  }
});

test('attachment transport fits wrapper cap and oversized bridge response fails closed', async () => {
  const chunk = fixture(Buffer.alloc(131072, 0xff))[0];
  assert.ok(Buffer.byteLength(JSON.stringify(chunk)) < 262144);
  const handler = createMcpHandler({ authorizeOwner: () => ({ userId: 'owner-1' }), bridgeCall: async () => chunk });
  const response = await (await handler(rpc('yandex_mail_attachment', identity))).json();
  assert.equal(response.result.isError, false);
  assert.deepEqual(assembleChunks([response]).bytes, Buffer.alloc(131072, 0xff));
  const oversize = createMcpHandler({ authorizeOwner: () => ({ userId: 'owner-1' }), bridgeCall: async () => ({ data: 'x'.repeat(262144) }) });
  assert.equal((await (await oversize(rpc('yandex_mail_attachment', identity))).json()).result.isError, true);
});

test('exact binary, UTF-8 and legacy text bytes survive wrapped base64 split inside quanta and lines', () => {
  for (const original of [Buffer.from([0, 255, 128, 13, 10, 0x80, 0x82, 0xa0]), Buffer.from('Привет\r\nformat=flowed \r\n next')]) {
    const base64 = original.toString('base64').replace(/.{8}/g, '$&\r\n');
    const result = assembleChunks(fixture(Buffer.from(base64), 'base64', 3).map(wrap));
    assert.deepEqual(result.bytes, original);
    assert.equal(result.metadata.sha256, hash(original));
    assert.equal(result.metadata.encodedSha256, hash(Buffer.from(base64)));
    assert.match(result.metadata.checksumSource, /locally calculated/);
  }
});

test('quoted-printable escape and soft-break boundaries preserve exact original bytes', () => {
  const encoded = Buffer.from('a=00=FF=\r\n=80=0D=0Aline=3D\r\n');
  const expected = Buffer.concat([Buffer.from('a'), Buffer.from([0, 255, 128, 13, 10]), Buffer.from('line=\r\n')]);
  for (const cut of [1, 2, 3, 7, 128]) assert.deepEqual(assembleChunks(fixture(encoded, 'quoted-printable', cut)).bytes, expected);
});

test('empty attachment is a valid single final chunk', () => {
  assert.deepEqual(assembleChunks(fixture(Buffer.alloc(0))).bytes, Buffer.alloc(0));
});

test('malformed encoding, unsupported encoding, and decoded size overflow fail closed', () => {
  for (const value of ['AA=A', 'AB==', 'a===', 'Zg', 'AA--', 'AA__', 'AAAA=']) assert.throws(() => decodeMimeBytes(Buffer.from(value), 'base64'));
  for (const value of ['bad=', 'bad=F', 'bad=XX', 'bad=\nline', 'bad=\rX', 'bad\xff']) assert.throws(() => decodeMimeBytes(Buffer.from(value, 'latin1'), 'quoted-printable'));
  assert.throws(() => decodeMimeBytes(Buffer.from('x'), 'uuencode'));
  assert.throws(() => decodeMimeBytes(Buffer.from([255]), '7bit'));
  assert.throws(() => decodeMimeBytes(Buffer.alloc(MAX_DECODED_BYTES + 1), 'binary'));
  assert.throws(() => decodeMimeBytes(Buffer.from(Buffer.alloc(MAX_DECODED_BYTES + 1).toString('base64')), 'base64'));
  assert.throws(() => decodeMimeBytes(Buffer.alloc(MAX_DECODED_BYTES + 1, 65), 'quoted-printable'));
  assert.equal(decodeMimeBytes(Buffer.from(Buffer.alloc(MAX_DECODED_BYTES).toString('base64')), 'base64').length, MAX_DECODED_BYTES);
});

test('checksum, metadata, duplicate, reordered, missing, terminal, and offset conflicts fail', () => {
  const original = fixture(Buffer.from('123456'), 'binary', 2);
  for (const [index, changes] of [[1, { uidValidity: '45' }], [1, { uid: 24 }], [1, { part: '2.2' }], [1, { mailbox: 'Sent' }], [1, { filename: 'other' }], [1, { metadataFingerprint: hash('changed') }], [1, { contentTransferEncoding: 'base64' }], [1, { chunkSha256: '0'.repeat(64) }], [1, { offset: 0 }], [1, { nextOffset: 5 }], [1, { done: true }], [2, { done: false }]]) {
    assert.throws(() => assembleChunks(original.map((item, i) => i === index ? { ...item, ...changes } : item)));
  }
  assert.throws(() => assembleChunks([]));
  assert.throws(() => assembleChunks(original.slice(0, -1)));
  assert.throws(() => assembleChunks([original[1], original[0], original[2]]));
  assert.throws(() => assembleChunks([...original, original[2]]));
  assert.throws(() => assembleChunks([{ ...original[0], dataBase64: 'MT==' }, ...original.slice(1)]));
  assert.throws(() => assembleChunks([{ isError: true, content: [{ type: 'text', text: JSON.stringify(original[0]) }] }]));
});

test('safe output path ignores hostile filename, no overwrite, no partial on invalid data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ymail-assembler-'));
  try {
    const chunks = fixture(Buffer.from('private bytes'), 'binary', 2, { filename: '../../escape $(whoami).txt' });
    const output = join(dir, 'chosen.bin');
    const result = await writeAttachment(chunks, output);
    assert.equal(result.filename, '../../escape $(whoami).txt');
    assert.equal(result.path, output);
    assert.equal(await readFile(output, 'utf8'), 'private bytes');
    await assert.rejects(writeAttachment(chunks, output));
    await assert.rejects(writeAttachment(chunks, '../relative-path'));
    await assert.rejects(writeAttachment(chunks.slice(1), join(dir, 'invalid.bin')));
    assert.deepEqual(await readdir(dir), ['chosen.bin']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('assembler never replaces a symlink destination or changes its target', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ymail-assembler-link-'));
  try {
    const chunks = fixture(Buffer.from('private bytes'));
    const output = join(dir, 'chosen.bin'), linked = join(dir, 'linked.bin');
    await writeAttachment(chunks, output);
    try { await symlink(output, linked, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows runner does not grant file-symlink creation'); return; }
      throw error;
    }
    await assert.rejects(writeAttachment(chunks, linked));
    assert.equal(await readFile(output, 'utf8'), 'private bytes');
    assert.deepEqual((await readdir(dir)).sort(), ['chosen.bin', 'linked.bin']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('serialized complete MCP tool results acquire private file bytes without printing payload', async () => {
  const original = Buffer.from('=A\r\n\x00\xff', 'latin1');
  const serialized = fixture(Buffer.from(original.toString('base64')), 'base64', 4).map(chunk => JSON.stringify(wrap(chunk))).join('\n');
  const results = await readJsonLines(Readable.from(serialized));
  assert.deepEqual(assembleChunks(results).bytes, original);
  await assert.rejects(readJsonLines(Readable.from('bad-json\n')));
});


test('QP removes raw trailing transport whitespace, preserves encoded whitespace and space before soft break', () => {
  for (const cut of [1, 2, 3, 4, 128]) {
    const raw = Buffer.from('a \t\r\nb=20=09\r\nc =\r\nd= \t\r\ne \t');
    assert.equal(assembleChunks(fixture(raw, 'quoted-printable', cut)).bytes.toString(), 'a\r\nb \t\r\nc de');
  }
  for (const raw of ['a\nb', 'a\rb', 'a\r', '=0D\nb']) assert.throws(() => decodeMimeBytes(Buffer.from(raw), 'quoted-printable'));
});

test('JSONL reader rejects oversized unfinished line before reading the rest', async () => {
  let yielded = 0;
  async function* pieces() { for (let i = 0; i < 1000; i++) { yielded++; yield Buffer.alloc(65536, 65); } }
  await assert.rejects(readJsonLines(Readable.from(pieces())));
  assert.ok(yielded < 10);
  await assert.rejects(readJsonLines(Readable.from([Buffer.from([255, 10])])));
});

test('decoded 20 MiB boundary is exact for identity, base64, and quoted-printable', () => {
  assert.equal(MAX_DECODED_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_ENCODED_BYTES, 64 * 1024 * 1024);
  for (const encoding of ['binary', '7bit', '8bit', 'base64', 'quoted-printable']) {
    for (const difference of [-1, 0, 1]) {
      const original = Buffer.alloc(MAX_DECODED_BYTES + difference, 65);
      const encoded = encoding === 'base64' ? Buffer.from(original.toString('base64')) : original;
      if (difference > 0) assert.throws(() => decodeMimeBytes(encoded, encoding));
      else assert.deepEqual(decodeMimeBytes(encoded, encoding), original);
    }
  }
});

test('full 20 MiB folded MIME base64 assembles in unchanged 128 KiB chunks', () => {
  const original = Buffer.alloc(MAX_DECODED_BYTES, 255);
  const encoded = Buffer.from(original.toString('base64').replace(/.{76}/g, '$&\r\n'));
  const chunks = fixture(encoded, 'base64');
  assert.equal(chunks.length, 219);
  assert.ok(chunks.every(chunk => Buffer.from(chunk.dataBase64, 'base64').length <= 131072));
  const result = assembleChunks(chunks);
  assert.equal(result.metadata.sizeBytes, MAX_DECODED_BYTES);
  assert.equal(result.metadata.sha256, hash(original));
  assert.deepEqual(result.bytes, original);
});

test('20 MiB fully escaped folded quoted-printable survives JSONL above old 50 MiB cap', async () => {
  const block = '=FF'.repeat(25) + '=\r\n'; // 25 decoded bytes, RFC-sized 76-char line.
  const lines = Math.floor(MAX_DECODED_BYTES / 25);
  const remainder = '=FF'.repeat(MAX_DECODED_BYTES % 25);
  const encoded = Buffer.alloc(lines * block.length + remainder.length);
  encoded.subarray(0, lines * block.length).fill(block);
  encoded.write(remainder, lines * block.length);
  assert.ok(encoded.length > 32 * 1024 * 1024 && encoded.length < MAX_ENCODED_BYTES);
  let serializedBytes = 0;
  async function* serializedChunks() {
    for (let offset = 0; offset < encoded.length; offset += 131072) {
      const bytes = encoded.subarray(offset, offset + 131072);
      const chunk = { ...identity, filename: 'boundary.bin', contentType: 'application/octet-stream', contentTransferEncoding: 'quoted-printable', encodedSize: encoded.length, metadataFingerprint: hash('QP boundary fixture'), maxDecodedBytes: MAX_DECODED_BYTES, offset, nextOffset: offset + bytes.length, done: offset + bytes.length === encoded.length, dataBase64: bytes.toString('base64'), chunkSha256: hash(bytes) };
      const line = JSON.stringify(wrap(chunk)) + '\n';
      serializedBytes += Buffer.byteLength(line);
      yield Buffer.from(line);
    }
  }
  const results = await readJsonLines(Readable.from(serializedChunks()));
  assert.ok(serializedBytes > 50 * 1024 * 1024 && serializedBytes < 100 * 1024 * 1024);
  assert.ok(results.length < 1024);
  const result = assembleChunks(results);
  assert.equal(result.bytes.length, MAX_DECODED_BYTES);
  assert.equal(result.metadata.sha256, hash(Buffer.alloc(MAX_DECODED_BYTES, 255)));
});

test('64 MiB encoded cap, old limit mismatch, and unchanged chunk cap fail closed', () => {
  assert.equal(decodeMimeBytes(Buffer.alloc(MAX_ENCODED_BYTES, 32), 'base64').length, 0);
  assert.throws(() => decodeMimeBytes(Buffer.alloc(MAX_ENCODED_BYTES + 1, 32), 'base64'));
  assert.throws(() => decodeMimeBytes(Buffer.alloc(MAX_ENCODED_BYTES + 1, 65), 'quoted-printable'));
  assert.throws(() => assembleChunks(fixture(Buffer.from('a'), 'binary', 131072, { encodedSize: MAX_ENCODED_BYTES + 1 })));
  assert.throws(() => assembleChunks(fixture(Buffer.from('a'), 'binary', 131072, { maxDecodedBytes: 10 * 1024 * 1024 })));
  assert.throws(() => assembleChunks(fixture(Buffer.alloc(131073), 'binary', 131073)));
});

test('JSONL aggregate 100 MiB boundary and 1024 result ceiling remain bounded', async () => {
  const piece = Buffer.alloc(65536, 32); piece[piece.length - 1] = 10;
  let yielded = 0;
  async function* pieces(extra) {
    for (let index = 0; index < 1600; index++) { yielded++; yield piece; }
    if (extra) { yielded++; yield Buffer.from(' '); }
  }
  assert.deepEqual(await readJsonLines(Readable.from(pieces(false))), []);
  await assert.rejects(readJsonLines(Readable.from(pieces(true))), /oversized serialized results/);
  assert.equal(yielded, 3201);
  assert.equal((await readJsonLines(Readable.from('{}\n'.repeat(1024)))).length, 1024);
  await assert.rejects(readJsonLines(Readable.from('{}\n'.repeat(1025))), /oversized serialized results/);
});
