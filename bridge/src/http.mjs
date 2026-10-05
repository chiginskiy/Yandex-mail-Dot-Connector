export async function limitedText(stream, max) {
  if (!stream) return '';
  const reader = stream.getReader();
  const parts = [];
  let length = 0;
  const until = Date.now() + 3000;
  try {
    while (true) {
      let timer;
      let chunk;
      try {
        chunk = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error('Body timeout')); }, Math.max(1, until - Date.now())); })
        ]);
      } finally { clearTimeout(timer); }
      const { value, done } = chunk;
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error('Body too large'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(out);
}
