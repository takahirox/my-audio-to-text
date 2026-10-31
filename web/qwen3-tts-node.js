import { StreamingTtsNode } from './streaming-tts-node.js';
export { STREAMING_TTS_LIMITS as QWEN3_TTS_LIMITS } from './streaming-tts-node.js';

export class Qwen3TtsNode extends StreamingTtsNode {
  constructor({ language = 'japanese', voice = 'ono_anna', ...options } = {}) {
    if (!['japanese', 'english'].includes(language) || !['ono_anna', 'ryan'].includes(voice)) throw Error('Choose Japanese/English and Qwen3-TTS voice ono_anna/ryan explicitly.');
    super({ ...options, language, voice, label: 'Qwen3-TTS', workerURL: new URL('./qwen3-tts-worker.js', import.meta.url) });
  }
}
