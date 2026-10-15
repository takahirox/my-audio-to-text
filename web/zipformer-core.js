import { ZIPFORMER as C } from './zipformer-config.js';

export class ZipformerCore {
  constructor(onEvent, { workerFactory = path => new Worker(new URL(path, import.meta.url)) } = {}) {
    this.onEvent = onEvent; this.workerFactory = workerFactory; this.state = 'idle'; this.session = 0;
    this.queue = []; this.pendingSamples = 0; this.sequence = 0;
  }
  load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    try {
      this.worker = this.workerFactory('./zipformer-worker.js');
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = event => { event.preventDefault?.(); this.fail(event.message || 'Zipformer Worker crashed'); };
      this.worker.onmessageerror = () => this.fail('Zipformer Worker message could not be decoded');
      this.worker.postMessage({ type: 'load' });
    } catch (error) { this.fail(error.message); }
  }
  start() {
    if (this.state !== 'ready') throw Error('Zipformer is not ready');
    this.session++; this.state = 'running';
    this.worker.postMessage({ type: 'start', session: this.session });
  }
  push(audio) {
    if (this.state !== 'running') return;
    if (!(audio instanceof Float32Array)) throw TypeError('Zipformer.audio requires Float32Array PCM');
    if (audio.length + this.pendingSamples > C.backlogSamples) { this.fail('English Zipformer is over 30 seconds behind; recording stopped without silently dropping audio.'); return; }
    // Copy before returning: fan-out producers retain their buffers. Transfer only
    // these owned bounded chunks, and send one at a time to bound the Worker inbox.
    for (let offset = 0; offset < audio.length; offset += C.chunkSamples) {
      const owned = audio.slice(offset, offset + C.chunkSamples);
      this.queue.push(owned); this.pendingSamples += owned.length;
    }
    this.pump();
  }
  pump() {
    if (this.inflight || !['running', 'stopping'].includes(this.state)) return;
    try {
      if (this.queue.length) {
        const audio = this.queue.shift();
        this.inflight = { sequence: ++this.sequence, samples: audio.length };
        this.worker.postMessage({ type: 'audio', session: this.session, sequence: this.sequence, audio }, [audio.buffer]);
      } else if (this.state === 'stopping' && !this.sentStop) {
        this.sentStop = true; this.worker.postMessage({ type: 'stop', session: this.session });
      }
    } catch (error) { this.fail(error.message); }
  }
  receive(event) {
    if (this.state === 'released') return;
    if (event.type === 'error') { this.fail(event.message); return; }
    if (event.type === 'ready' && this.state === 'loading') { this.state = 'ready'; this.onEvent(event); return; }
    if (event.type === 'configuration' || event.type === 'progress') { this.onEvent(event); return; }
    if (event.session !== this.session) return;
    if (event.type === 'consumed' && event.sequence === this.inflight?.sequence) {
      this.pendingSamples -= this.inflight.samples; this.inflight = null; this.pump();
    } else if (event.type === 'stopped' && this.state === 'stopping' && this.sentStop) {
      this.state = 'ready'; this.sentStop = false; this.onEvent(event);
    } else if (['partial', 'final'].includes(event.type) && ['running', 'stopping'].includes(this.state)) this.onEvent(event);
  }
  stop() { if (this.state === 'running') { this.state = 'stopping'; this.pump(); } }
  fail(message) { if (this.state === 'released') return; this.release(); this.onEvent({ type: 'error', message }); }
  release() {
    this.state = 'released'; this.queue = []; this.pendingSamples = 0; this.inflight = null;
    if (this.worker) { this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null; this.worker.terminate(); this.worker = null; }
  }
}
