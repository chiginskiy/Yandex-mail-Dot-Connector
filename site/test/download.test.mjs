import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile, stat, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMcpHandler, createSignedBridgeClient, safeRetryAfterSeconds } from '../src/mcp.mjs';
import { downloadAttachment, retryDelaySeconds } from '../scripts/download-attachment.mjs';
import { MAX_DECODED_BYTES, readJsonLines } from '../scripts/assemble-attachment.mjs';
import { createReadStream } from 'node:fs';

const hash = value => createHash('sha256').update(value).digest('hex');
const attachment = { mailbox: 'INBOX', uid: 23, uidValidity: '44', part: '2.1' };
function fixture(bytes = Buffer.from('123456'), cut = 2, encoding = 'binary') {
  const chunks = [];
  for (let offset = 0; offset < bytes.length || !chunks.length; offset += cut) {
    const part = bytes.subarray(offset, offset + cut), nextOffset = offset + part.length;
    chunks.push({ ...attachment, filename: '../../hostile-file.bin', contentType: 'application/octet-stream', contentTransferEncoding: encoding, encodedSize: bytes.length, metadataFingerprint: hash('descriptor'), maxDecodedBytes: MAX_DECODED_BYTES, offset, nextOffset, done: nextOffset === bytes.length, dataBase64: part.toString('base64'), chunkSha256: hash(part) });
  }
  return chunks;
}
const wrapped = chunk => ({ jsonrpc: '2.0', id: 1, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(chunk) }] } });
const limited = seconds => ({ isError: true, content: [{ type: 'text', text: 'irrelevant secret error body' }], structuredContent: { status: 'rate_limited', httpStatus: 429, retryAfterSeconds: seconds } });
function clock() {
  let now = 0;
  return { now: () => now, sleep: async (ms, { signal }) => { assert.equal(signal.aborted, false); now += ms; }, advance: ms => { now += ms; } };
}
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'ymail-download-'));
  try { await fn({ directory, outputPath: join(directory, 'output.bin'), checkpointPath: join(directory, 'chunks.jsonl') }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const rpc = () => new Request('https://private.example/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'yandex_mail_attachment', arguments: attachment } }) });
function bridge(response) {
  return createSignedBridgeClient({ origin: 'https://bridge.example', siteId: 'fixture', getSigningKey: async () => null, signRequest: async ({ url }) => new Request(url), fetchImpl: async () => response });
}

test('429 survives bridge and MCP with safe machine-readable metadata only', async () => {
  const upstream = new Response('secret-token, mailbox, https://provider.invalid/private', { status: 429, headers: { 'content-type': 'text/plain', 'retry-after': '60', 'x-private': 'secret' } });
  const handler = createMcpHandler({ authorizeOwner: () => ({ userId: 'owner' }), bridgeCall: bridge(upstream) });
  const response = await handler(rpc()), serialized = await response.text(), body = JSON.parse(serialized);
  assert.equal(response.status, 200);
  assert.equal(body.result.isError, true);
  assert.deepEqual(body.result.structuredContent, { status: 'rate_limited', httpStatus: 429, retryAfterSeconds: 60 });
  assert.doesNotMatch(serialized, /secret|provider\.invalid|x-private|mailbox/);
  assert.equal(upstream.bodyUsed, true);
});

test('malicious Retry-After values are bounded; non-429 failure details stay generic', async () => {
  const now = Date.parse('Mon, 05 Oct 2026 00:00:00 GMT');
  for (const [value, expected] of [[undefined, 60], ['', 60], ['NaN', 60], ['Infinity', 60], ['-1', 60], ['0', 1], ['9999999999', 120], ['1e9', 60], ['https://secret.invalid/', 60], ['Mon, 05 Oct 2026 00:01:30 GMT', 90], ['Mon, 05 Oct 2026 00:10:00 GMT', 120], ['Mon, 05 Oct 2026 00:00:00 GMT', 1]]) assert.equal(safeRetryAfterSeconds(value, now), expected);
  for (const seconds of [NaN, Infinity, 'secret', {}, [], undefined]) assert.equal(retryDelaySeconds(limited(seconds)), 60);
  assert.equal(retryDelaySeconds(limited(-5000)), 1);
  assert.equal(retryDelaySeconds(limited(Number.MAX_VALUE)), 120);
  assert.equal(retryDelaySeconds({ ...limited(60), structuredContent: { status: 'rate_limited', httpStatus: 500, retryAfterSeconds: 60 } }), null);
  for (const status of [401, 403, 500, 502]) {
    const handler = createMcpHandler({ authorizeOwner: () => ({ userId: 'owner' }), bridgeCall: bridge(new Response('secret-provider-body', { status, headers: { 'retry-after': '60' } })) });
    const serialized = await (await handler(rpc())).text(), body = JSON.parse(serialized);
    assert.equal(body.result.structuredContent, undefined);
    assert.doesNotMatch(serialized, /secret-provider-body|retryAfterSeconds|httpStatus/);
  }
});

test('sequential calls pace request STARTS, preserve offsets, checkpoint privately and assemble exactly', async () => temporary(async options => {
  const time = clock(), starts = [], offsets = [], chunks = fixture();
  let active = 0;
  const result = await downloadAttachment({ ...options, attachment, clock: time, callTool: async (request, { signal }) => {
    assert.equal(active++, 0); assert.equal(signal.aborted, false);
    starts.push(time.now()); offsets.push(request.arguments.offset);
    assert.equal(request.name, 'yandex_mail_attachment');
    assert.deepEqual(request.arguments, { ...attachment, offset: offsets.at(-1) });
    time.advance(300); active--; return wrapped(chunks.find(chunk => chunk.offset === request.arguments.offset));
  } });
  assert.deepEqual(starts, [0, 2100, 4200]); assert.deepEqual(offsets, [0, 2, 4]);
  assert.equal(result.sha256, hash(Buffer.from('123456')));
  assert.equal(await readFile(options.outputPath, 'utf8'), '123456');
  if (process.platform !== 'win32') {
    assert.equal((await stat(options.outputPath)).mode & 0o777, 0o600);
    assert.equal((await stat(options.checkpointPath)).mode & 0o777, 0o600);
  }
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 3);
  assert.deepEqual((await readdir(options.directory)).sort(), ['chunks.jsonl', 'output.bin']);
}));

test('429 retries same offset with bounded exponential delay and no duplicate saved chunks', async () => temporary(async options => {
  const time = clock(), starts = [], offsets = [], chunks = fixture(); let count = 0;
  const result = await downloadAttachment({ ...options, attachment, clock: time, callTool: async ({ arguments: args }) => {
    starts.push(time.now()); offsets.push(args.offset); count++;
    if (count === 1) return limited(60);
    if (count === 2) return { jsonrpc: '2.0', result: limited(1), id: 1 };
    return chunks.find(chunk => chunk.offset === args.offset);
  } });
  assert.deepEqual(offsets, [0, 0, 0, 2, 4]);
  assert.deepEqual(starts, [0, 60000, 64200, 66300, 68400]);
  assert.equal(result.sizeBytes, 6);
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 3);
}));

test('retry counts and elapsed deadline bound a permanently throttled download', async () => {
  for (const limits of [{ maxRetries: 2 }, { maxTotalRetries: 2 }, { maxElapsedMs: 5000 }]) await temporary(async options => {
    const time = clock(); let count = 0;
    await assert.rejects(downloadAttachment({ ...options, attachment, ...limits, clock: time, callTool: async () => { count++; return limited(60); } }), { code: limits.maxElapsedMs ? 'elapsed_limit' : 'retry_limit' });
    assert.equal(count, limits.maxElapsedMs ? 1 : 3);
    assert.deepEqual(await readdir(options.directory), []);
  });
});

test('network interruption preserves a verified prefix; resume starts at exactly next offset', async () => temporary(async options => {
  const chunks = fixture(), firstOffsets = [];
  await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), callTool: async ({ arguments: args }) => {
    firstOffsets.push(args.offset); if (args.offset === 2) throw new Error('provider-secret'); return wrapped(chunks[0]);
  } }), { code: 'tool_call_failed' });
  assert.deepEqual(firstOffsets, [0, 2]);
  assert.deepEqual(await readdir(options.directory), ['chunks.jsonl']);
  const offsets = [];
  const result = await downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: async ({ arguments: args }) => { offsets.push(args.offset); return wrapped(chunks.find(chunk => chunk.offset === args.offset)); } });
  assert.deepEqual(offsets, [2, 4]); assert.equal(result.sha256, hash(Buffer.from('123456')));
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 3);
}));

test('explicit abort leaves verified prefix and never appends an aborted request', async () => temporary(async options => {
  const controller = new AbortController(), chunks = fixture(); let calls = 0;
  await assert.rejects(downloadAttachment({ ...options, attachment, signal: controller.signal, clock: clock(), callTool: async ({ arguments: args }) => {
    calls++; if (args.offset === 2) controller.abort(); return chunks.find(chunk => chunk.offset === args.offset);
  } }), { code: 'aborted' });
  assert.equal(calls, 2);
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 1);
  assert.deepEqual(await readdir(options.directory), ['chunks.jsonl']);
}));

test('resume rejects wrong identity, hash, gap, duplicate, reordered and changed metadata BEFORE network/write', async () => {
  const chunks = fixture();
  const broken = [[{ ...chunks[0], uid: 99 }], [{ ...chunks[0], chunkSha256: '0'.repeat(64) }], [chunks[0], chunks[2]], [chunks[0], chunks[0]], [chunks[1], chunks[0]], [chunks[0], { ...chunks[1], metadataFingerprint: hash('other version') }]];
  for (const prefix of broken) await temporary(async options => {
    const prior = prefix.map(chunk => JSON.stringify(wrapped(chunk))).join('\n') + '\n';
    await writeFile(options.checkpointPath, prior, { mode: 0o600 }); let calls = 0;
    await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: async () => { calls++; } }));
    assert.equal(calls, 0); assert.equal(await readFile(options.checkpointPath, 'utf8'), prior);
    assert.deepEqual(await readdir(options.directory), ['chunks.jsonl']);
  });
});

test('new corrupt/version-changing response is never checkpointed or silently skipped', async () => {
  const chunks = fixture();
  for (const changes of [{ uidValidity: '45' }, { metadataFingerprint: hash('changed') }, { filename: 'other.bin' }, { encodedSize: 8 }, { dataBase64: 'AAAA' }, { offset: 4 }, { nextOffset: 5 }, { done: true }]) await temporary(async options => {
    const prior = JSON.stringify(chunks[0]) + '\n';
    await writeFile(options.checkpointPath, prior, { mode: 0o600 }); let calls = 0;
    await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: async () => { calls++; return { ...chunks[1], ...changes }; } }));
    assert.equal(calls, 1); assert.equal(await readFile(options.checkpointPath, 'utf8'), prior);
    assert.deepEqual(await readdir(options.directory), ['chunks.jsonl']);
  });
});

test('complete verified checkpoint reconstructs with no request and output remains exclusive', async () => temporary(async options => {
  const chunks = fixture();
  await writeFile(options.checkpointPath, chunks.map(chunk => JSON.stringify(wrapped(chunk))).join('\n') + '\n', { mode: 0o600 });
  const callTool = () => assert.fail('No network call for a complete checkpoint');
  await downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool });
  await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool }), { code: 'output_exists' });
  assert.equal(await readFile(options.outputPath, 'utf8'), '123456');
}));

test('in-memory prefix supports wrapped chunks and empty attachment', async () => {
  await temporary(async ({ outputPath }) => {
    const chunks = fixture(), offsets = [];
    await downloadAttachment({ outputPath, attachment, resumeChunks: chunks.slice(0, 2).map(wrapped), clock: clock(), callTool: async ({ arguments: args }) => { offsets.push(args.offset); return chunks[2]; } });
    assert.deepEqual(offsets, [4]); assert.equal(await readFile(outputPath, 'utf8'), '123456');
  });
  await temporary(async ({ outputPath }) => {
    const result = await downloadAttachment({ outputPath, attachment, clock: clock(), callTool: async () => fixture(Buffer.alloc(0))[0] });
    assert.equal(result.sizeBytes, 0); assert.equal((await readFile(outputPath)).length, 0);
  });
});

test('corrupt/truncated/missing-delimiter checkpoints fail closed', async () => {
  for (const source of ['{', JSON.stringify(fixture()[0]), JSON.stringify(fixture()[0]) + '\n{"unfinished":']) await temporary(async options => {
    await writeFile(options.checkpointPath, source, { mode: 0o600 });
    await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: () => assert.fail('No call') }));
    assert.equal(await readFile(options.checkpointPath, 'utf8'), source);
  });
});

test('POSIX group/world-readable checkpoint is rejected', { skip: process.platform === 'win32' ? 'Windows privacy is enforced by directory ACLs, not POSIX mode bits' : false }, async () => {
  await temporary(async options => {
    await writeFile(options.checkpointPath, '', { mode: 0o644 });
    await chmod(options.checkpointPath, 0o644); // Independent of the runner's umask.
    await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: () => assert.fail('No call') }), { code: 'unsafe_checkpoint' });
  });
});

test('symlink checkpoint is rejected without touching its target', async t => {
  await temporary(async options => {
    const target = join(options.directory, 'target'); await writeFile(target, '', { mode: 0o600 });
    try { await symlink(target, options.checkpointPath, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) { t.skip('Windows runner does not grant file-symlink creation'); return; }
      throw error;
    }
    await assert.rejects(downloadAttachment({ ...options, attachment, resume: true, clock: clock(), callTool: () => assert.fail('No call') }));
    assert.equal(await readFile(target, 'utf8'), '');
  });
});

test('fresh download refuses existing checkpoint/lock and relative or attachment-derived paths', async () => {
  for (const target of ['checkpoint', 'lock']) await temporary(async options => {
    const path = target === 'lock' ? `${options.checkpointPath}.lock` : options.checkpointPath;
    await writeFile(path, 'do not replace', { mode: 0o600 });
    await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), callTool: () => assert.fail('No call') }));
    assert.equal(await readFile(path, 'utf8'), 'do not replace');
  });
  for (const overrides of [{ outputPath: '../relative' }, { checkpointPath: '../relative' }, { minIntervalMs: 2099 }, { maxRetries: 11 }, { attachment: { ...attachment, offset: 2 } }]) await temporary(async options => {
    await assert.rejects(downloadAttachment({ ...options, attachment, ...overrides, clock: clock(), callTool: () => assert.fail('No call') }));
    assert.deepEqual(await readdir(options.directory), []);
  });
});

test('only safe 429 tool results retry; generic tool/RPC/provider failures do not leak', async () => {
  for (const value of [{ isError: true, content: [{ type: 'text', text: 'provider-secret' }] }, { jsonrpc: '2.0', error: { code: 429, message: 'provider-secret' } }, { ...limited(60), structuredContent: { status: 'rate_limited', httpStatus: 503 } }]) await temporary(async options => {
    let calls = 0;
    await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), callTool: async () => { calls++; return value; } }), error => !/provider-secret/.test(error.message));
    assert.equal(calls, 1); assert.deepEqual(await readdir(options.directory), []);
  });
});

test('invalid final MIME or decoded overflow creates no output', async () => temporary(async options => {
  const bad = fixture(Buffer.from('bad=XX'), 131072, 'quoted-printable');
  await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), callTool: async () => bad[0] }), { code: 'verification_failed' });
  assert.deepEqual(await readdir(options.directory), ['chunks.jsonl']);
}));

test('20 MiB folded base64 integration: 219 chunks, paced/retried/resumed, exact final SHA', async () => temporary(async options => {
  const original = Buffer.alloc(MAX_DECODED_BYTES, 255), encoded = Buffer.from(original.toString('base64').replace(/.{76}/g, '$&\r\n'));
  const chunks = fixture(encoded, 131072, 'base64'); assert.equal(chunks.length, 219);
  const firstTime = clock(); let count = 0;
  await assert.rejects(downloadAttachment({ ...options, attachment, clock: firstTime, callTool: async ({ arguments: args }) => {
    count++; if (count === 72) throw new Error('synthetic interruption'); return chunks.find(chunk => chunk.offset === args.offset);
  } }), { code: 'tool_call_failed' });
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 71);
  const time = clock(), starts = [], offsets = []; let throttled = false;
  const result = await downloadAttachment({ ...options, attachment, resume: true, clock: time, callTool: async ({ arguments: args }) => {
    starts.push(time.now()); offsets.push(args.offset);
    if (!throttled && args.offset === 100 * 131072) { throttled = true; return limited(60); }
    return wrapped(chunks.find(chunk => chunk.offset === args.offset));
  } });
  assert.equal(offsets[0], 71 * 131072);
  assert.equal(offsets.filter(offset => offset === 100 * 131072).length, 2);
  for (let index = 1; index < starts.length; index++) assert.ok(starts[index] - starts[index - 1] >= 2100);
  assert.equal(result.sizeBytes, MAX_DECODED_BYTES); assert.equal(result.sha256, hash(original));
  assert.equal(hash(await readFile(options.outputPath)), hash(original));
  assert.equal((await readJsonLines(createReadStream(options.checkpointPath))).length, 219);
}));

test('non-cooperative in-flight client is bounded and never writes its late result', async () => temporary(async options => {
  let calls = 0, seenSignal;
  await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), requestTimeoutMs: 10, callTool: async (_request, { signal }) => {
    calls++; seenSignal = signal; return new Promise(() => {});
  } }), { code: 'request_timeout' });
  assert.equal(calls, 1); assert.equal(seenSignal.aborted, true);
  assert.deepEqual(await readdir(options.directory), []);
}));

test('oversized nested MCP chunk JSON is rejected before parsing or writing', async () => temporary(async options => {
  await assert.rejects(downloadAttachment({ ...options, attachment, clock: clock(), callTool: async () => ({ content: [{ type: 'text', text: ' '.repeat(262145) }], isError: false }) }), { code: 'verification_failed' });
  assert.deepEqual(await readdir(options.directory), []);
}));
