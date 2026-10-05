/** Bounded, sequential attachment download orchestration. No HTTP/auth client.
 *
 * const metadata = await downloadAttachment({
 *   callTool: (request, { signal }) => connectedMcpClient.callTool(request, { signal }),
 *   attachment: { mailbox: 'INBOX', uid: 23, uidValidity: '44', part: '2.1' },
 *   outputPath: '/private/explicit/chosen.bin',
 *   checkpointPath: '/private/explicit/chunks.jsonl', resume: false
 * });
 *
 * Adapt callTool to the already-authorized client's API. Return its complete MCP
 * result without printing payloads. After interruption, use the same identity,
 * paths and resume:true. Never use an attachment filename to choose either path.
 * JSONL is private mail data, not a log. It remains after success for explicit
 * caller cleanup. Only one process may use a checkpoint: a sidecar .lock enforces
 * this. A hard-killed process can leave that lock; verify no writer remains before
 * manually removing the lock. Corrupt/truncated checkpoints are never repaired
 * or silently skipped. A fresh explicit checkpoint path starts a new download.
 *
 * In-memory resumeChunks may instead provide an iterable of complete results.
 * Do not combine resumeChunks with checkpointPath. All prefixes are reverified.
 * Limits: 1024 chunks, 100 MiB serialized checkpoint, 64 MiB MIME, 20 MiB decoded.
 * Memory is bounded by those caps; final MIME decoding uses the offline assembler.
 * No automatic opening, attachment execution, upload, or Library integration.
 */
import { constants } from 'node:fs';
import { open, lstat, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createChunkVerifier, readJsonLines, writeAttachment } from './assemble-attachment.mjs';
import { normalizeArgs, safeRetryAfterSeconds } from '../src/mcp.mjs';

export const MIN_REQUEST_INTERVAL_MS = 2100;
const MAX_RESULTS = 1024, MAX_SERIALIZED_BYTES = 100 * 1024 * 1024;
const MAX_RESULT_BYTES = 256 * 1024 + 8192;
const fields = ['mailbox', 'uid', 'uidValidity', 'part', 'filename', 'originalFilename', 'filenameTruncated', 'contentType', 'contentTransferEncoding', 'encodedSize', 'metadataFingerprint', 'maxDecodedBytes', 'offset', 'nextOffset', 'done', 'dataBase64', 'chunkSha256'];
const identities = ['mailbox', 'uid', 'uidValidity', 'part'];
const defaultClock = { now: () => performance.now(), sleep: (ms, { signal }) => sleep(ms, undefined, { signal }) };
export class AttachmentDownloadError extends Error {
  constructor(code) { super(`Attachment download stopped: ${code}`); this.name = 'AttachmentDownloadError'; this.code = code; }
}
const fail = code => { throw new AttachmentDownloadError(code); };
const boundedInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Only the adapter's explicit safe metadata is retryable. Do not parse error text,
// provider bodies, URLs, HTTP headers, or arbitrary client exception messages.
export function retryDelaySeconds(result) {
  if (result?.jsonrpc !== undefined) {
    if (result.jsonrpc !== '2.0' || result.error) return null;
    result = result.result;
  }
  const metadata = result?.structuredContent;
  if (result?.isError !== true || metadata?.status !== 'rate_limited' || metadata.httpStatus !== 429) return null;
  return safeRetryAfterSeconds(typeof metadata.retryAfterSeconds === 'number' ? metadata.retryAfterSeconds : undefined);
}

/** callTool({ name, arguments }, { signal }) returns a tool result or JSON-RPC wrapper.
 * Successful direct bridge chunk objects are also accepted for offline tests.
 * Retries apply only to safe MCP 429 results, always at the SAME offset.
 * clock={now,sleep} is injectable for deterministic tests; it must be monotonic.
 */
export async function downloadAttachment({
  callTool, attachment, outputPath, checkpointPath, resume = false, resumeChunks,
  signal, minIntervalMs = MIN_REQUEST_INTERVAL_MS, maxRetries = 5,
  maxTotalRetries = 20, maxElapsedMs = 3600000, requestTimeoutMs = 30000,
  clock = defaultClock
} = {}) {
  if (typeof callTool !== 'function' || typeof clock?.now !== 'function' || typeof clock.sleep !== 'function') fail('invalid_options');
  if (!boundedInteger(minIntervalMs, MIN_REQUEST_INTERVAL_MS, 60000) || !boundedInteger(maxRetries, 0, 10) || !boundedInteger(maxTotalRetries, 0, 50) || !boundedInteger(maxElapsedMs, 1, 3600000) || !boundedInteger(requestTimeoutMs, 1, 120000) || typeof resume !== 'boolean') fail('invalid_options');
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath) || (checkpointPath !== undefined && (typeof checkpointPath !== 'string' || !isAbsolute(checkpointPath)))) fail('explicit_absolute_paths_required');
  if (resume && !checkpointPath || resumeChunks !== undefined && (checkpointPath !== undefined || resume || !resumeChunks?.[Symbol.iterator])) fail('invalid_resume_options');
  let selected;
  try {
    if (!attachment || Object.keys(attachment).some(key => !identities.includes(key))) fail('invalid_identity');
    selected = normalizeArgs('yandex_mail_attachment', attachment);
  } catch { fail('invalid_identity'); }
  const destination = resolve(outputPath), checkpoint = checkpointPath === undefined ? undefined : resolve(checkpointPath);
  if (checkpoint === destination || checkpoint && `${checkpoint}.lock` === destination) fail('conflicting_paths');
  const started = clock.now();
  if (!Number.isFinite(started)) fail('invalid_clock');
  let lastClock = started, lastStart = -Infinity, totalRetries = 0;
  const activeSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(maxElapsedMs)]);
  const check = () => {
    if (signal?.aborted) fail('aborted');
    if (activeSignal.aborted) fail('elapsed_limit');
    const now = clock.now();
    if (!Number.isFinite(now) || now < lastClock) fail('invalid_clock');
    lastClock = now;
    if (now - started >= maxElapsedMs) fail('elapsed_limit');
    return now;
  };
  const wait = async delay => {
    if (delay <= 0) return;
    const until = check() + delay;
    if (until - started >= maxElapsedMs) fail('elapsed_limit');
    // Timers can wake a fraction early: don't let that defeat request-start pacing.
    while (check() < until) {
      try { await clock.sleep(until - lastClock, { signal: activeSignal }); } catch { check(); fail('wait_failed'); }
    }
  };
  const verifier = createChunkVerifier(), chunks = [];
  let serializedBytes = 0, checkpointBytes = 0, checkpointHandle, lockHandle;
  const accept = result => {
    if (chunks.length >= MAX_RESULTS) fail('chunk_limit');
    const { chunk } = verifier.push(result);
    if (identities.some(key => chunk[key] !== selected[key])) fail('identity_mismatch');
    const clean = Object.fromEntries(fields.filter(key => chunk[key] !== undefined).map(key => [key, chunk[key]]));
    const line = JSON.stringify(clean) + '\n', length = Buffer.byteLength(line);
    if (length > MAX_RESULT_BYTES || serializedBytes + length > MAX_SERIALIZED_BYTES) fail('checkpoint_limit');
    serializedBytes += length;
    chunks.push(clean);
    return line;
  };
  const append = async line => {
    if (!checkpoint) return;
    const bytes = Buffer.from(line), before = checkpointBytes;
    if (before + bytes.length > MAX_SERIALIZED_BYTES) fail('checkpoint_limit');
    checkpointHandle ??= await open(checkpoint, 'wx', 0o600);
    try {
      for (let written = 0; written < bytes.length;) {
        const result = await checkpointHandle.write(bytes, written, bytes.length - written, before + written);
        if (!result.bytesWritten) fail('checkpoint_write_failed');
        written += result.bytesWritten;
      }
      await checkpointHandle.sync();
      checkpointBytes += bytes.length;
    } catch {
      // A failed append must never be treated as a committed chunk on restart.
      await checkpointHandle.truncate(before).catch(() => {});
      await checkpointHandle.sync().catch(() => {});
      fail('checkpoint_write_failed');
    }
  };
  try {
    check();
    try { await lstat(destination); fail('output_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (checkpoint) {
      lockHandle = await open(`${checkpoint}.lock`, 'wx', 0o600);
      if (resume) {
        const entry = await lstat(checkpoint);
        if (!entry.isFile()) fail('unsafe_checkpoint');
        checkpointHandle = await open(checkpoint, constants.O_RDWR | constants.O_NOFOLLOW);
        const info = await checkpointHandle.stat();
        // Windows uses ACLs rather than POSIX permission bits. The caller must
        // select a private directory there; stat's synthetic 0666 is not an ACL.
        if (!info.isFile() || info.ino !== entry.ino || info.dev !== entry.dev || (process.platform !== 'win32' && (info.mode & 0o077)) || info.nlink !== 1 || info.size > MAX_SERIALIZED_BYTES) fail('unsafe_checkpoint');
        const results = await readJsonLines(checkpointHandle.createReadStream({ autoClose: false }));
        for (const result of results) accept(result);
        checkpointBytes = info.size;
        if (checkpointBytes) {
          const end = Buffer.alloc(1);
          await checkpointHandle.read(end, 0, 1, checkpointBytes - 1);
          // Appending without a record delimiter would corrupt an otherwise valid prefix.
          if (end[0] !== 10) fail('checkpoint_missing_newline');
        }
      } else {
        try { await lstat(checkpoint); fail('checkpoint_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    if (resumeChunks !== undefined) for (const result of resumeChunks) accept(result);
    while (!verifier.state.done) {
      let retries = 0;
      for (;;) {
        await wait(Math.max(0, lastStart + minIntervalMs - check()));
        lastStart = check();
        // A referenced timer also bounds a client that returns a never-settling
        // promise without opening a socket (AbortSignal.timeout alone is unref'd).
        const requestController = new AbortController();
        const timer = setTimeout(() => requestController.abort(), Math.min(requestTimeoutMs, maxElapsedMs - (lastStart - started)));
        const requestSignal = AbortSignal.any([activeSignal, requestController.signal]);
        let onAbort;
        const interrupted = new Promise((_, reject) => {
          onAbort = () => reject(new AttachmentDownloadError(signal?.aborted ? 'aborted' : activeSignal.aborted ? 'elapsed_limit' : 'request_timeout'));
          requestSignal.addEventListener('abort', onAbort, { once: true });
          if (requestSignal.aborted) onAbort();
        });
        let result;
        try {
          result = await Promise.race([Promise.resolve().then(() => callTool({ name: 'yandex_mail_attachment', arguments: { ...selected, offset: verifier.state.offset } }, { signal: requestSignal })), interrupted]);
        } catch (error) { if (error instanceof AttachmentDownloadError) throw error; fail('tool_call_failed'); }
        finally { clearTimeout(timer); requestSignal.removeEventListener('abort', onAbort); }
        check();
        const retryAfter = retryDelaySeconds(result);
        if (retryAfter !== null) {
          if (retries >= maxRetries || totalRetries >= maxTotalRetries) fail('retry_limit');
          retries++; totalRetries++;
          await wait(Math.max(retryAfter * 1000, Math.min(120000, minIntervalMs * 2 ** (retries - 1))));
          continue;
        }
        const line = accept(result); // Validate BEFORE any checkpoint or output write.
        await append(line);
        break;
      }
    }
    check();
    // The existing assembler independently re-verifies every chunk and MIME cap,
    // computes final SHA-256, then atomically creates an exclusive mode-0600 file.
    return await writeAttachment(chunks, destination);
  } catch (error) {
    if (error instanceof AttachmentDownloadError) throw error;
    if (error?.message?.startsWith('Attachment verification failed:')) fail('verification_failed');
    fail('io_or_verification_failed');
  } finally {
    await checkpointHandle?.close().catch(() => {});
    if (lockHandle) {
      await lockHandle.close().catch(() => {});
      await unlink(`${checkpoint}.lock`).catch(() => {});
    }
  }
}
