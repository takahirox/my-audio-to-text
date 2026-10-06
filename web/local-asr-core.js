import { ReazonSimulation, BUFFER_LIMIT } from './reazon-simulation.js';

const backlogError = () => new Error('Backend is over 30 seconds behind. Capture stopped; retry with shorter utterances.');

// Normalized 16 kHz mono Float32Array input -> recognition events. No capture or DOM.
// workerFactory is the deterministic-test seam; production owns two isolated workers.
export class LocalAsrCore {
  constructor(onEvent, { workerFactory = path => new Worker(path) } = {}) {
    this.onEvent = onEvent;
    this.workerFactory = workerFactory;
    this.state = 'released'; this.session = 0;
    this.latestPartials = new Map();
  }
  emit(type, values = {}) { this.onEvent({ type, ...values }); }
  diagnostics() {
    this.emit('diagnostics', { pendingSamples: this.vadQueued + (this.simulation?.waiting || 0) });
  }
  load() {
    if (this.state !== 'released') throw new Error('Release the ASR core before loading again.');
    this.state = 'loading'; this.asrReady = this.vadReady = false;
    try {
      this.worker = this.createWorker('./sherpa-worker.js', false);
      this.vadWorker = this.createWorker('./silero-worker.js', true);
      this.vadWorker.postMessage({ type: 'load' });
      this.worker.postMessage({ type: 'load' });
    } catch (error) { this.fail(error); }
  }
  createWorker(path, vad) {
    const worker = this.workerFactory(path);
    // Worker identity rejects queued callbacks even after release/reload.
    worker.onmessage = ({ data }) => {
      if (this[vad ? 'vadWorker' : 'worker'] !== worker) return;
      try { this.receive(data, vad); } catch (error) { this.fail(error); }
    };
    worker.onerror = event => {
      event.preventDefault();
      if (this[vad ? 'vadWorker' : 'worker'] === worker) this.fail(new Error(event.message));
    };
    return worker;
  }
  start() {
    if (this.state !== 'ready') throw new Error('ASR core must be ready before starting.');
    const session = ++this.session;
    this.state = 'running'; this.vadQueued = 0;
    this.latestPartials.clear();
    this.simulation = new ReazonSimulation(
      message => this.worker.postMessage({ ...message, session }, [message.audio.buffer]),
      () => { this.latestPartials.clear(); this.state = 'ready'; this.diagnostics(); this.emit('stopped'); },
      (event, id) => this.emit('speech', { event, id }),
    );
    try { this.vadWorker.postMessage({ type: 'vad-start', session }); }
    catch (error) { this.fail(error); }
  }
  push(audio) {
    if (this.state !== 'running') return;
    try {
      if (!(audio instanceof Float32Array)) throw new TypeError('ASR input must be mono 16 kHz Float32Array PCM.');
      if (!audio.length) return;
      if (this.vadQueued + this.simulation.waiting + audio.length > BUFFER_LIMIT) throw backlogError();
      // Copy so callers retain ownership, including views into a larger buffer.
      const block = audio.slice();
      this.vadQueued += block.length;
      this.vadWorker.postMessage({ type: 'vad-audio', audio: block, session: this.session }, [block.buffer]);
      this.diagnostics();
    } catch (error) { this.fail(error); }
  }
  stop() {
    if (this.state !== 'running') return;
    this.state = 'stopping';
    try { this.vadWorker.postMessage({ type: 'vad-stop', session: this.session }); }
    catch (error) { this.fail(error); }
  }
  receive(data, vad) {
    if (data.session !== undefined && data.session !== this.session) return;
    if (data.type === 'error') { this.fail(new Error(data.message)); return; }
    if (data.type === 'configuration') {
      this.emit('configuration', { model: data.model, modelName: data.modelName, numThreads: data.numThreads });
      return;
    }
    if (data.type === 'progress') { this.emit('progress', { message: data.message }); return; }
    if (data.type === 'ready' && this.state === 'loading') {
      if (vad) this.vadReady = true; else this.asrReady = true;
      if (this.asrReady && this.vadReady) { this.state = 'ready'; this.emit('ready'); }
      return;
    }
    if (!['running', 'stopping'].includes(this.state) || data.session !== this.session) return;
    if (vad && data.type === 'vad') {
      for (const frame of data.frames) {
        this.vadQueued -= frame.audio.length;
        this.simulation.push(frame.audio, frame.speaking);
        if (this.vadQueued + this.simulation.waiting > BUFFER_LIMIT) throw backlogError();
      }
      this.diagnostics();
    } else if (vad && data.type === 'vad-stopped' && this.state === 'stopping') {
      this.simulation.stop();
    } else if (!vad && data.type === 'decoded' && this.simulation.inFlight) {
      this.simulation.decoded(); this.diagnostics();
    } else if (!vad && ['partial', 'final'].includes(data.type)) {
      const request = this.simulation.inFlight;
      if (!request || request.id !== data.id || request.final !== (data.type === 'final')) return;
      if (data.type === 'partial' && (this.state === 'stopping' || !this.simulation.acceptsPartial(data.id))) return;
      let text = data.text;
      if (data.type === 'partial') {
        if (text.trim()) this.latestPartials.set(data.id, text);
      } else {
        // Keep the fresh final authoritative unless it contains no usable text.
        if (!text.trim()) text = this.latestPartials.get(data.id) ?? text;
        this.latestPartials.delete(data.id);
      }
      this.emit(data.type, { text, id: data.id });
    }
  }
  release() {
    ++this.session; this.state = 'released';
    this.latestPartials.clear();
    this.worker?.terminate(); this.worker = null;
    this.vadWorker?.terminate(); this.vadWorker = null;
    this.simulation = null; this.vadQueued = 0;
    this.asrReady = this.vadReady = false;
  }
  fail(error) {
    this.release();
    this.emit('error', { message: error.message || String(error) });
  }
}
