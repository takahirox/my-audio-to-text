import { StreamingTtsNode } from './streaming-tts-node.js';
export { STREAMING_TTS_LIMITS as COSYVOICE3_LIMITS } from './streaming-tts-node.js';

export class CosyVoice3Node extends StreamingTtsNode {
  constructor({ language = 'english', voice = 'libritts-r-4446', ...options } = {}) {
    if (!['japanese', 'english'].includes(language) || voice !== 'libritts-r-4446') throw Error('Choose CosyVoice3 Japanese/English with the reviewed LibriTTS-R voice.');
    super({ ...options, language, voice, label: 'CosyVoice3', workerURL: new URL('./cosyvoice3-worker.js', import.meta.url) });
  }
}
