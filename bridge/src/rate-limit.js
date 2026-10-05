import { BridgeError } from './errors.js';

// Required Cloudflare bindings, intentionally no production bypass or memory fallback.
export async function requireRateLimit(binding, key) {
  if (typeof binding?.limit !== 'function') throw new BridgeError(503, 'rate_limit_unavailable');
  let timer;
  try {
    const result = await Promise.race([
      binding.limit({key}),
      new Promise((_, reject) => {timer=setTimeout(()=>reject(new BridgeError(503,'rate_limit_unavailable')),2000);}),
    ]);
    if (result?.success === false) throw new BridgeError(429, 'rate_limited');
    if (result?.success !== true) throw new BridgeError(503, 'rate_limit_unavailable');
  } catch(error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(503, 'rate_limit_unavailable');
  } finally {clearTimeout(timer);}
}
