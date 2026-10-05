/** Offline-only attachment assembler. No network, credentials, execution, or uploads.
 * Usage: node scripts/assemble-attachment.mjs /explicit/output/path < chunks.jsonl
 * JSONL accepts direct chunks or complete MCP tools/call results, one per line.
 * Do not put attachment bytes in model-visible text. Serialize tool results in code.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_DECODED_BYTES = 20 * 1024 * 1024;
export const MAX_ENCODED_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 128 * 1024;
const RESULT_BYTES = 256 * 1024;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const shaPattern = /^[a-f0-9]{64}$/;
const encodings = new Set(['base64', 'quoted-printable', '7bit', '8bit', 'binary']);
const stableFields = ['mailbox', 'uid', 'uidValidity', 'part', 'filename', 'originalFilename', 'filenameTruncated', 'contentType', 'contentTransferEncoding', 'encodedSize', 'metadataFingerprint'];
const fail = reason => { throw new Error(`Attachment verification failed: ${reason}`); };
const boundedText = (text, max) => typeof text === 'string' && text.length <= max && !/[\x00-\x1f\x7f]/.test(text);
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function canonicalBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) fail('invalid base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) fail('noncanonical base64');
  return bytes;
}

/** Decode MIME transfer encoding only. Never decode a text charset or flowed text. */
export function decodeMimeBytes(encoded, encoding) {
  if (!Buffer.isBuffer(encoded) || encoded.length > MAX_ENCODED_BYTES || !encodings.has(encoding)) fail('unsupported or oversized MIME data');
  if (encoding === 'base64') {
    // RFC 2045 permits folded ASCII whitespace; reject all other non-alphabet bytes.
    // Convert as latin1 so high bytes cannot silently become replacement characters.
    const value = encoded.toString('latin1').replace(/[\t\r\n ]/g, '');
    return canonicalBase64(value, MAX_DECODED_BYTES);
  }
  if (encoding === 'quoted-printable') {
    // RFC 2045 section 6.7: discard raw transport-added trailing SPACE/TAB,
    // preserve encoded =20/=09, and distinguish WSP before a soft-break '='.
    const out = Buffer.allocUnsafe(Math.min(encoded.length, MAX_DECODED_BYTES));
    let size = 0, start = 0;
    const append = byte => {
      if (size === MAX_DECODED_BYTES) fail('decoded file exceeds 20 MiB');
      out[size++] = byte;
    };
    while (start < encoded.length) {
      const newline = encoded.indexOf(0x0a, start);
      if (newline !== -1 && (newline === start || encoded[newline - 1] !== 0x0d)) fail('bare quoted-printable line break');
      let end = newline === -1 ? encoded.length : newline - 1;
      while (end > start && (encoded[end - 1] === 0x20 || encoded[end - 1] === 0x09)) end--;
      const soft = newline !== -1 && end > start && encoded[end - 1] === 0x3d;
      if (soft) end--;
      for (let index = start; index < end; index++) {
        let byte = encoded[index];
        if (byte === 0x3d) {
          if (index + 2 >= end) fail('malformed quoted-printable escape');
          const digits = encoded.subarray(index + 1, index + 3).toString('latin1');
          if (!/^[0-9A-Fa-f]{2}$/.test(digits)) fail('malformed quoted-printable escape');
          byte = Number.parseInt(digits, 16);
          index += 2;
        } else if (byte !== 0x09 && byte !== 0x20 && (byte < 0x21 || byte > 0x7e)) {
          fail('invalid quoted-printable byte or line break');
        }
        append(byte);
      }
      if (newline !== -1 && !soft) { append(0x0d); append(0x0a); }
      start = newline === -1 ? encoded.length : newline + 1;
    }
    return out.subarray(0, size);
  }
  if (encoded.length > MAX_DECODED_BYTES) fail('decoded file exceeds 20 MiB');
  if (encoding === '7bit' && encoded.some(byte => byte > 127)) fail('non-ASCII data labeled 7bit');
  return encoded;
}

export function unwrapChunk(result) {
  // Direct bridge JSON, tools/call result, or complete JSON-RPC response.
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('invalid result');
  if (result.jsonrpc !== undefined) {
    if (result.error || result.jsonrpc !== '2.0') fail('RPC error');
    result = result.result;
  }
  if (result?.isError) fail('tool error');
  if (result?.content !== undefined) {
    if (!Array.isArray(result.content) || result.content.length > 16) fail('ambiguous tool content');
    const text = result.content.filter(item => item?.type === 'text');
    if (!text || text.length !== 1 || typeof text[0].text !== 'string') fail('ambiguous tool content');
    if (Buffer.byteLength(text[0].text) > RESULT_BYTES) fail('oversized chunk JSON');
    try { result = JSON.parse(text[0].text); } catch { fail('invalid chunk JSON'); }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) fail('invalid chunk');
  return result;
}

function validateMetadata(chunk) {
  if (!boundedText(chunk.mailbox, 120) || !chunk.mailbox || !integer(chunk.uid, 1, 0xffffffff) || typeof chunk.uidValidity !== 'string' || !/^[1-9][0-9]{0,9}$/.test(chunk.uidValidity) || !integer(Number(chunk.uidValidity), 1, 0xffffffff)) fail('invalid message identity');
  if (!boundedText(chunk.part, 59) || !/^[1-9][0-9]{0,4}(\.[1-9][0-9]{0,4}){0,9}$/.test(chunk.part)) fail('invalid part');
  if (!boundedText(chunk.filename, 512) || !boundedText(chunk.contentType, 256) || !chunk.contentType || !encodings.has(chunk.contentTransferEncoding)) fail('invalid metadata');
  if (chunk.originalFilename !== undefined && chunk.originalFilename !== null && (typeof chunk.originalFilename !== 'string' || chunk.originalFilename.length > 512)) fail('invalid original filename');
  if (chunk.filenameTruncated !== undefined && typeof chunk.filenameTruncated !== 'boolean') fail('invalid filename truncation');
  if (!integer(chunk.encodedSize, 0, MAX_ENCODED_BYTES) || typeof chunk.metadataFingerprint !== 'string' || !shaPattern.test(chunk.metadataFingerprint)) fail('invalid size or fingerprint');
  if (chunk.maxDecodedBytes !== undefined && chunk.maxDecodedBytes !== MAX_DECODED_BYTES) fail('decoded size limit mismatch');
}

/** Incrementally verify a complete or resumable prefix without retaining bytes. */
export function createChunkVerifier() {
  let first, offset = 0, ended = false;
  return {
    get state() { return { first, offset, done: ended }; },
    push(result) {
      if (ended) fail('data after final chunk');
      const chunk = unwrapChunk(result);
      validateMetadata(chunk);
      if (first && stableFields.some(field => chunk[field] !== first[field])) fail('identity or metadata changed');
      if (chunk.offset !== offset || !integer(chunk.nextOffset, offset, chunk.encodedSize) || typeof chunk.done !== 'boolean') fail('noncontiguous or invalid offsets');
      const bytes = canonicalBase64(chunk.dataBase64, CHUNK_BYTES);
      if (typeof chunk.chunkSha256 !== 'string' || !shaPattern.test(chunk.chunkSha256) || sha256(bytes) !== chunk.chunkSha256) fail('chunk checksum mismatch');
      if (chunk.nextOffset !== offset + bytes.length || chunk.done !== (chunk.nextOffset === chunk.encodedSize) || (!chunk.done && bytes.length === 0)) fail('size or completion mismatch');
      first ??= Object.fromEntries(stableFields.map(field => [field, chunk[field]]));
      offset = chunk.nextOffset;
      ended = chunk.done;
      return { chunk, bytes };
    }
  };
}

/** Verify complete ordered chunks then reconstruct the original attachment bytes. */
export function assembleChunks(results) {
  const verifier = createChunkVerifier(), chunks = [];
  for (const result of results) chunks.push(verifier.push(result).bytes);
  const { first, offset, done: ended } = verifier.state;
  if (!first || !ended || offset !== first.encodedSize) fail('missing or incomplete chunks');
  const encoded = Buffer.concat(chunks, offset);
  const bytes = decodeMimeBytes(encoded, first.contentTransferEncoding);
  return { bytes, metadata: {
    mailbox: first.mailbox, uid: first.uid, uidValidity: first.uidValidity, part: first.part,
    filename: first.filename, originalFilename: first.originalFilename ?? null, filenameTruncated: first.filenameTruncated ?? false, contentType: first.contentType,
    contentTransferEncoding: first.contentTransferEncoding, encodedSize: offset,
    sizeBytes: bytes.length, sha256: sha256(bytes), encodedSha256: sha256(encoded),
    checksumSource: 'locally calculated after verifying every server chunk',
    metadataFingerprint: first.metadataFingerprint
  } };
}

/** Explicit destination only. Never interpret an attachment's filename as a path. */
export async function writeAttachment(results, outputPath) {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) fail('an explicit absolute output path is required');
  const { bytes, metadata } = assembleChunks(results);
  const destination = resolve(outputPath);
  const temporary = join(dirname(destination), `.ymail-${randomUUID()}.part`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    // link is atomic and fails if destination exists, including a symlink.
    await link(temporary, destination);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return { ...metadata, path: destination };
}

export async function readJsonLines(stream) {
  const results = [];
  const maxLine = RESULT_BYTES + 8192;
  let total = 0, pending = Buffer.alloc(0);
  const parse = bytes => {
    if (bytes.length > maxLine || results.length >= 1024) fail('oversized serialized results');
    let line;
    try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('invalid JSONL encoding'); }
    if (!line.trim()) return;
    try { results.push(JSON.parse(line)); } catch { fail('invalid JSONL'); }
  };
  // Bound each incoming piece and each incomplete line before buffering. A bad
  // no-newline input must not make readline accumulate an unbounded string.
  for await (const value of stream) {
    const piece = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += piece.length;
    if (total > 100 * 1024 * 1024) fail('oversized serialized results');
    let start = 0;
    for (let end; (end = piece.indexOf(0x0a, start)) !== -1; start = end + 1) {
      if (pending.length + end - start > maxLine) fail('oversized serialized results');
      parse(Buffer.concat([pending, piece.subarray(start, end)]));
      pending = Buffer.alloc(0);
    }
    if (pending.length + piece.length - start > maxLine) fail('oversized serialized results');
    pending = Buffer.concat([pending, piece.subarray(start)]);
  }
  if (pending.length) parse(pending);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node assemble-attachment.mjs /absolute/output/path < chunks.jsonl');
    const metadata = await writeAttachment(await readJsonLines(process.stdin), process.argv[2]);
    process.stdout.write(JSON.stringify(metadata) + '\n');
  } catch (error) {
    // Do not reflect untrusted filename, content, URLs, or credentials into logs.
    process.stderr.write((error.message?.startsWith('Attachment verification failed:') ? error.message : 'Attachment could not be written; check the input and output path') + '\n');
    process.exitCode = 1;
  }
}
