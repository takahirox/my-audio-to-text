import { validateSynthesizedAudio } from './synthesized-audio.js';

export function requireWasm() {
  if (typeof WebAssembly !== 'object') throw new Error('Local TTS requires WebAssembly with SIMD. Use a current browser.');
  // A minimal valid module containing i8x16.splat; no network/runtime imports.
  if (!WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,10,9,1,7,0,65,0,253,15,26,11]))) {
    throw new Error('Local TTS requires WebAssembly SIMD. Use a current browser.');
  }
}

// Per-worker serial queue. Termination cancels downloads, initialization and
// synchronous WASM work immediately; no stale result can reach a disposed graph.
export function serveTts({ load, generate }) {
  let queue = Promise.resolve(), ready = false;
  self.onmessage = ({ data }) => {
    queue = queue.then(async () => {
      try {
        if (data.type === 'load') {
          if (ready) throw new Error('TTS Worker already loaded.');
          requireWasm(); await load(data); ready = true;
          self.postMessage({ type: 'ready', id: data.id });
        } else if (data.type === 'generate') {
          if (!ready) throw new Error('TTS model is not ready.');
          if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 300) throw new Error('Use 1–300 characters of plain text.');
          const audio = validateSynthesizedAudio(await generate(data.text));
          self.postMessage({ type: 'result', id: data.id, audio }, [audio.samples.buffer]);
        } else if (data.type === 'drain') {
          self.postMessage({ type: 'drained', id: data.id });
        } else throw new Error('Unknown TTS request.');
      } catch (error) {
        self.postMessage({ type: 'error', id: data.id, message: error.message || String(error) });
      }
    });
  };
}

export function progress(message) { self.postMessage({ type: 'progress', message }); }

// Asset-only GET cache, keyed by the complete immutable URL. Storage eviction
// and unavailable/quota-limited Cache Storage fall back to network transparently.
export async function ttsAsset(url) {
  let cache;
  try { cache = await caches.open('tts-assets-v1'); } catch { /* optional */ }
  const hit = await cache?.match(url).catch(() => undefined);
  if (hit) return hit;
  progress(`Downloading ${new URL(url).pathname.split('/').at(-1)}…`);
  let response;
  try { response = await fetch(url); }
  catch { throw new Error('TTS asset download failed (network/CORS or offline cache miss). Reconnect and retry.'); }
  if (!response.ok) throw new Error(`TTS asset download failed: HTTP ${response.status} (${new URL(url).pathname.split('/').at(-1)}).`);
  try { await cache?.put(url, response.clone()); }
  catch { progress('Browser storage unavailable or full; using downloaded assets without persistent caching.'); }
  return response;
}
