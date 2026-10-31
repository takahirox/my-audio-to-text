import { CosyVoice3Runtime } from './cosyvoice3-runtime.js';
import { cosyVoice3Assets } from '../extension/cosyvoice3-cache.js';

let runtime, active, acknowledgment;
const now = () => performance.timeOrigin + performance.now();
self.onmessage = async ({ data }) => {
  if (data.type === 'ack') {
    if (active?.id === data.id && acknowledgment?.sequence === data.sequence) {
      acknowledgment.resolve(); acknowledgment = null;
    }
    return;
  }
  try {
    if (data.type === 'load') {
      if (runtime || active) throw Error('CosyVoice3 Worker already loaded.');
      runtime = await CosyVoice3Runtime.create(await cosyVoice3Assets(), message => postMessage({ type: 'progress', message }));
      postMessage({ type: 'ready' });
    } else if (data.type === 'generate') {
      if (!runtime || active) throw Error('CosyVoice3 Worker is not ready.');
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 300
          || !['japanese', 'english'].includes(data.language) || data.voice !== 'libritts-r-4446') throw Error('Invalid committed CosyVoice3 input or settings.');
      active = { id: data.id, sequence: 0 };
      postMessage({ type: 'start', id: data.id, sampleRate: 24000, channels: 1, at: now() });
      await runtime.generate(data.text, data, (samples, diagnostics) => new Promise(resolve => {
        const sequence = active.sequence++;
        acknowledgment = { sequence, resolve };
        postMessage({ ...diagnostics, type: 'chunk', id: data.id, sequence, samples, at: now() }, [samples.buffer]);
      }));
      postMessage({ type: 'end', id: data.id, sequence: active.sequence, at: now() });
      active = null;
    } else throw Error('Unknown CosyVoice3 Worker request.');
  } catch (error) {
    postMessage({ type: 'error', id: active?.id, sequence: active?.sequence, message: error.message || String(error), at: now() });
    // The owner terminates the Worker on failure, releasing every model/cache.
  }
};
