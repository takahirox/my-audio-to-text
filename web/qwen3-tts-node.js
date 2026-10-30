import { TEXT } from './translation-nodes.js';
import { AUDIO_STREAM, validateAudioStream } from './audio-stream.js';

export const QWEN3_TTS_LIMITS = Object.freeze({ utterances: 16, characters: 4800, text: 300 });

export class Qwen3TtsNode {
  inputs = { text: TEXT };
  outputs = { stream: AUDIO_STREAM };
  constructor({ language = 'japanese', voice = 'ono_anna', workerFactory = url => new Worker(url, { type: 'module' }), onEvent = () => {} } = {}) {
    if (!['japanese', 'english'].includes(language) || !['ono_anna', 'ryan'].includes(voice)) throw Error('Choose Japanese/English and Qwen3-TTS voice ono_anna/ryan explicitly.');
    Object.assign(this, { language, voice, workerFactory, onEvent });
    this.queue = []; this.characters = 0; this.nextId = 0; this.waiters = [];
  }
  event(event) {
    const value = this.rejected && event.type !== 'overflow'
      ? { ...event, message: `${event.message || event.type} Text queue full; new utterances rejected. Stop to drain accepted speech, then Start again.` } : event;
    try { this.onEvent(value); } catch { /* observer only */ }
  }
  start(context) {
    if (this.started || this.disposed) throw Error('Qwen3-TTS requires a fresh Node per session.');
    this.started = true; this.context = context; context.signal.throwIfAborted();
    this.abort = () => this.dispose(); context.signal.addEventListener('abort', this.abort, { once: true });
    return new Promise((resolve, reject) => {
      this.loading = { resolve, reject };
      try {
        this.worker = this.workerFactory(new URL('./qwen3-tts-worker.js', import.meta.url));
        this.worker.onmessage = ({ data }) => this.message(data);
        this.worker.onerror = event => this.fail(Error(event.message || 'Qwen3-TTS Worker failed. Check GPU memory, then Start again.'));
        this.worker.onmessageerror = () => this.fail(Error('Qwen3-TTS Worker communication failed.'));
        this.worker.postMessage({ type: 'load' });
      } catch (error) { this.fail(error); }
    });
  }
  message(data) {
    if (this.disposed || this.context.signal.aborted) return;
    try {
      if (data.type === 'progress') { this.event(data); return; }
      if (data.type === 'ready' && this.loading) {
        this.loading.resolve(); this.loading = null; this.event({ type: 'ready', message: 'Qwen3-TTS ready (local WebGPU).' }); return;
      }
      if (data.type === 'error') {
        if (this.loading || (this.current && data.id === this.current.id)) this.fail(Error(data.message));
        return;
      }
      if (!this.current || data.id !== this.current.id) return; // retired/late replies cannot replay audio
      if (!['start', 'chunk', 'end'].includes(data.type)) throw Error('Unexpected Qwen3-TTS Worker reply.');
      validateAudioStream(data);
      if (data.type === 'start') {
        if (this.current.begun) throw Error('Duplicate Qwen3-TTS stream start.');
        this.current.begun = true;
      } else {
        if (!this.current.begun || data.sequence !== this.current.sequence) throw Error('Out-of-order Qwen3-TTS PCM.');
        if (data.type === 'chunk') this.current.sequence++;
      }
      this.current.context.emit('stream', data);
      this.event({ type: data.type, id: data.id, sequence: data.sequence, at: data.at,
        message: data.type === 'end' ? 'Qwen3-TTS utterance synthesized.' : 'Generating local Qwen3-TTS speech…' });
      if (data.type === 'chunk') {
        // Pipeline delivery runs in a microtask before this next Worker task.
        this.worker.postMessage({ type: 'ack', id: data.id, sequence: data.sequence });
      } else if (data.type === 'end') {
        this.characters -= this.current.text.length; this.current = null; this.pump();
      }
    } catch (error) { this.fail(error); }
  }
  receive(port, text, context) {
    if (this.disposed || this.stopping || context.signal.aborted) return;
    const invalid = error => { this.fail(error); throw error; };
    if (port !== 'text' || typeof text !== 'string') return invalid(TypeError('Qwen3-TTS needs committed plain TEXT.'));
    if (context.provisional) return invalid(Error('Qwen3-TTS requires committed TEXT; route revisions to a preview display.'));
    if (text.length > QWEN3_TTS_LIMITS.text) return invalid(RangeError('Qwen3-TTS accepts 300 characters per committed utterance. Split longer text before this Node.'));
    if (!text.trim()) return;
    if (this.rejected || this.queue.length + !!this.current >= QWEN3_TTS_LIMITS.utterances
        || this.characters + text.length > QWEN3_TTS_LIMITS.characters) {
      this.rejected = true;
      this.event({ type: 'overflow', message: 'Qwen3-TTS text queue full. New utterances rejected; Stop drains accepted speech, then Start again.' }); return;
    }
    this.queue.push({ text, context }); this.characters += text.length; this.pump();
  }
  pump() {
    if (this.disposed || this.current) return;
    const next = this.queue.shift();
    if (!next) { this.waiters.splice(0).forEach(resolve => resolve()); return; }
    this.current = { ...next, id: ++this.nextId, sequence: 0, begun: false };
    try { this.worker.postMessage({ type: 'generate', id: this.current.id, text: next.text, language: this.language, voice: this.voice }); }
    catch (error) { this.fail(error); }
  }
  stop() {
    this.stopping = true;
    if (this.disposed || (!this.current && !this.queue.length)) return;
    return new Promise(resolve => this.waiters.push(resolve));
  }
  fail(error) {
    if (this.disposed) return;
    if (this.current?.begun) this.current.context.emit('stream', {
      type: 'abort', id: this.current.id, sequence: this.current.sequence, message: error.message,
    });
    this.event({ type: 'error', message: error.message });
    this.loading?.reject(error); this.loading = null;
    this.context?.fail(error); this.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.context?.signal.removeEventListener('abort', this.abort);
    if (this.worker) {
      this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
      this.worker.terminate(); this.worker = null;
    }
    this.loading?.reject(new DOMException('Qwen3-TTS canceled.', 'AbortError')); this.loading = null;
    this.queue.length = 0; this.current = null; this.characters = 0;
    this.waiters.splice(0).forEach(resolve => resolve());
  }
}
