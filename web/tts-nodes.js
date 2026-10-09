import { TEXT } from './translation-nodes.js';
import { SYNTHESIZED_AUDIO, validateSynthesizedAudio } from './synthesized-audio.js';

// Private RPC plumbing; each production instance owns one dedicated Worker.
class WorkerTextToSpeechNode {
  inputs = { text: TEXT };
  outputs = { audio: SYNTHESIZED_AUDIO };
  constructor(url, settings, { workerFactory = url => new Worker(url, { type: 'module' }), onEvent = () => {}, loadOptions = {} } = {}) {
    this.url = url; this.settings = { ...settings, ...loadOptions }; this.workerFactory = workerFactory;
    this.onEvent = onEvent; this.pending = new Map(); this.sequence = 0;
  }
  event(value) { try { this.onEvent(value); } catch { /* observer only */ } }
  async start(context) {
    if (this.started || this.disposed) throw new Error('TTS nodes require a fresh instance.');
    this.started = true; this.context = context;
    context.signal.throwIfAborted();
    this.worker = this.workerFactory(this.url);
    this.worker.onmessage = ({ data }) => {
      if (this.disposed || context.signal.aborted) return;
      if (data.type === 'progress') { this.event(data); return; }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.type === 'error') pending.reject(new Error(data.message));
      else if (data.type === pending.type) pending.resolve(data);
      else pending.reject(new Error(`Unexpected TTS Worker reply: ${data.type}`));
    };
    const failed = event => {
      const error = new Error(event.message || 'TTS Worker communication failed.');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear(); context.fail(error);
    };
    this.worker.onerror = failed; this.worker.onmessageerror = failed;
    this.abort = () => this.dispose();
    context.signal.addEventListener('abort', this.abort, { once: true });
    await this.request('load', 'ready', this.settings);
    context.signal.throwIfAborted(); this.event({ type: 'ready' });
  }
  request(type, reply, payload = {}) {
    if (this.disposed || this.context?.signal.aborted) return Promise.reject(new DOMException('TTS canceled.', 'AbortError'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type: reply });
      try { this.worker.postMessage({ type, id, ...payload }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }
  async receive(port, text, context) {
    if (port !== 'text' || typeof text !== 'string') throw new TypeError('TTS input must be a plain text string.');
    if (text.length > 300) throw new RangeError('Use a short snippet of at most 300 characters.');
    if (!text.trim()) return;
    const result = await this.request('generate', 'result', { text });
    context.signal.throwIfAborted();
    context.emit('audio', validateSynthesizedAudio(result.audio));
  }
  async stop() { await this.request('drain', 'drained'); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    const error = new DOMException('TTS canceled.', 'AbortError');
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.context = null;
  }
}

export class Supertonic3TextToSpeechNode extends WorkerTextToSpeechNode {
  constructor({ language = 'ja', voice = 'F1', ...options } = {}) {
    if (!['ja', 'en'].includes(language)) throw new Error('Supertonic 3 supports Japanese (ja) and English (en) here.');
    if (!['F1', 'M1'].includes(voice)) throw new Error('Choose Supertonic 3 voice F1 or M1.');
    super(new URL('./supertonic3-worker.js', import.meta.url), { language, voice }, options);
  }
}
export class KokoroTextToSpeechNode extends WorkerTextToSpeechNode {
  // Voice determines the frontend/language; there is no redundant language selector.
  constructor({ voice = 'jf_alpha', ...options } = {}) {
    if (!['jf_alpha', 'af_heart'].includes(voice)) throw new Error('Choose Japanese jf_alpha or English af_heart.');
    super(new URL('./kokoro-worker.js', import.meta.url), { voice }, options);
  }
}
