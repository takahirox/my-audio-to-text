import { SpeechToTextNode } from './transcription-nodes.js';

// Optional heavy recognizers fail on their own path. Peer ASRs and text paths
// keep running. A fresh graph/Start creates a fresh Worker after preparation or
// GPU recovery; no automatic downloads, retries or model substitutions.
export class OptionalAsrNode extends SpeechToTextNode {
  receiveEvent(event) {
    if (this.disposed || this.unavailable) return;
    if (event.type !== 'error') { super.receiveEvent(event); return; }
    this.unavailable = true; this.core?.release();
    if (this.outputs.provisional) this.context?.emit('provisional', '');
    this.loading?.reject(new Error(event.message)); this.draining?.resolve();
    this.onEvent({ ...event, branchUnavailable: true });
  }
  async load() {
    try { await super.load(); }
    catch (error) { if (this.disposed || error.name === 'AbortError') throw error; this.unavailable = true; }
  }
  async start(context) {
    this.context = context;
    await this.load(); context.signal.throwIfAborted();
    if (!this.unavailable) try { this.core.start(); } catch (error) { this.receiveEvent({ type: 'error', message: error.message }); }
  }
  stop() { return this.unavailable ? Promise.resolve() : super.stop(); }
}
