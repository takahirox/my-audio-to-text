// Private bounded transport for the two optional production Workers. One in
// flight block bounds the Worker inbox; capture/fan-out buffers stay owned by
// their producer. Errors fail visibly instead of dropping audio.
export class OptionalAsrCore {
  constructor(onEvent, { workerPath, label, workerFactory = path => new Worker(new URL(path, import.meta.url), { type: 'module' }) }) {
    Object.assign(this, { onEvent, workerPath, label, workerFactory });
    this.state = 'idle'; this.session = 0; this.sequence = 0; this.queue = []; this.pendingSamples = 0;
  }
  load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    try {
      this.worker = this.workerFactory(this.workerPath);
      this.worker.onmessage = ({ data }) => this.receive(data);
      this.worker.onerror = event => { event.preventDefault?.(); this.fail(event.message || 'Worker crashed'); };
      this.worker.onmessageerror = () => this.fail('Worker message could not be decoded');
      this.worker.postMessage({ type: 'load' });
    } catch (error) { this.fail(error.message); }
  }
  start() {
    if (this.state !== 'ready') throw Error(`${this.label} is not ready`);
    this.session++; this.state = 'running'; this.sentStop = false;
    this.worker.postMessage({ type: 'start', session: this.session });
  }
  push(audio) {
    if (this.state !== 'running') return;
    if (!(audio instanceof Float32Array) || audio.some(value => !Number.isFinite(value))) throw TypeError(`${this.label}.audio requires finite Float32Array PCM`);
    if (audio.length + this.pendingSamples > 16000 * 30) { this.fail('over 30 seconds behind; stopped without silently dropping audio'); return; }
    for (let offset = 0; offset < audio.length; offset += 1600) {
      const owned = audio.slice(offset, offset + 1600); this.queue.push(owned); this.pendingSamples += owned.length;
    }
    this.pump();
  }
  pump() {
    if (this.inflight || !['running', 'stopping'].includes(this.state)) return;
    try {
      if (this.queue.length) {
        const audio = this.queue.shift(); this.inflight = { sequence: ++this.sequence, samples: audio.length };
        this.worker.postMessage({ type: 'audio', session: this.session, sequence: this.sequence, audio }, [audio.buffer]);
      } else if (this.state === 'stopping' && !this.sentStop) {
        this.sentStop = true; this.worker.postMessage({ type: 'stop', session: this.session });
      }
    } catch (error) { this.fail(error.message); }
  }
  receive(event) {
    if (this.state === 'released') return;
    // Session-bearing failures and all text must belong to the current session.
    if (event.session !== undefined && event.session !== this.session) return;
    if (event.type === 'error') { this.fail(event.message); return; }
    if (event.type === 'ready' && this.state === 'loading') { this.state = 'ready'; this.onEvent(event); return; }
    if (['configuration', 'progress'].includes(event.type)) { this.onEvent(event); return; }
    if (event.session !== this.session) return;
    if (event.type === 'consumed' && event.sequence === this.inflight?.sequence) {
      this.pendingSamples -= this.inflight.samples; this.inflight = null; this.pump();
    } else if (event.type === 'stopped' && this.state === 'stopping' && this.sentStop) {
      this.state = 'ready'; this.sentStop = false; this.onEvent(event);
    } else if (['partial', 'final'].includes(event.type) && ['running', 'stopping'].includes(this.state)) this.onEvent(event);
  }
  stop() { if (this.state === 'running') { this.state = 'stopping'; this.pump(); } }
  fail(message) { if (this.state !== 'released') { this.release(); this.onEvent({ type: 'error', message: `${this.label}: ${message}` }); } }
  release() {
    this.state = 'released'; this.queue = []; this.pendingSamples = 0; this.inflight = null;
    if (this.worker) { this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null; this.worker.terminate(); this.worker = null; }
  }
}
