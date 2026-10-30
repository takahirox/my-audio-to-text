import { Qwen3TtsRuntime } from './qwen3-tts-runtime.js';
import { qwen3TtsAssets } from '../extension/qwen3-tts-cache.js';

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
      if (runtime || active) throw Error('Qwen3-TTS Worker already loaded.');
      runtime = await Qwen3TtsRuntime.create(await qwen3TtsAssets(), message => postMessage({ type: 'progress', message }));
      postMessage({ type: 'ready' });
    } else if (data.type === 'generate') {
      if (!runtime || active) throw Error('Qwen3-TTS Worker is not ready.');
      if (typeof data.text !== 'string' || !data.text.trim() || data.text.length > 300
          || !['japanese', 'english'].includes(data.language) || !['ono_anna', 'ryan'].includes(data.voice)) throw Error('Invalid committed Qwen3-TTS input or settings.');
      active = { id: data.id, sequence: 0 };
      postMessage({ type: 'start', id: data.id, sampleRate: 24000, channels: 1, at: now() });
      await runtime.generate(data.text, data, samples => new Promise(resolve => {
        const sequence = active.sequence++;
        acknowledgment = { sequence, resolve };
        postMessage({ type: 'chunk', id: data.id, sequence, samples, at: now() }, [samples.buffer]);
      }));
      postMessage({ type: 'end', id: data.id, sequence: active.sequence, at: now() });
      active = null;
    } else throw Error('Unknown Qwen3-TTS Worker request.');
  } catch (error) {
    postMessage({ type: 'error', id: active?.id, sequence: active?.sequence, message: error.message || String(error), at: now() });
    // The owner terminates the Worker on failure, releasing every model/cache.
  }
};
