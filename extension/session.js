import { LocalAsrCore } from '../web/local-asr-core.js';
import { ExtensionTab } from './tab-source.js';

// Owns the window's capture lifetime. The shared core owns recognition policy.
export class TabSession {
  constructor(render, {
    coreFactory = callback => new LocalAsrCore(callback, {
      workerFactory: path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    }),
    sourceFactory = (...args) => new ExtensionTab(...args),
  } = {}) {
    this.render = render; this.coreFactory = coreFactory; this.sourceFactory = sourceFactory;
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', partial: '', final: '', signal: '' };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId) {
    if (this.session) return; // A second invocation never retargets live capture.
    const session = { tabId }; this.session = session;
    this.update({ state: 'loading', tabId, status: 'Loading ReazonSpeech ja-en + Silero…', error: '', partial: '', final: '', signal: '' });
    try {
      const ready = new Promise(resolve => { session.ready = resolve; });
      session.core = this.coreFactory(event => {
        if (this.session !== session) return;
        if (event.type === 'ready') session.ready(true);
        else if (event.type === 'progress' && this.view.state === 'loading') this.update({ status: event.message });
        else if (event.type === 'partial' && this.view.state !== 'stopping') this.update({ partial: event.text });
        else if (event.type === 'final') this.update({ partial: '', final: this.view.final + (event.text.trim() ? `${event.text}\n` : '') });
        else if (event.type === 'error') this.fail(event.message);
        else if (event.type === 'stopped') {
          session.core.release(); this.session = null;
          this.update({ state: 'idle', status: 'Stopped. Final transcript is ready.', partial: '' });
        }
      });
      session.core.load();
      if (!await ready || this.session !== session) return;
      this.update({ state: 'starting', status: 'Starting current-tab capture…' });
      session.source = this.sourceFactory(tabId, pcm => {
        if (this.session !== session) return;
        if (!session.signal && pcm.some(sample => Math.abs(sample) > 0.00001)) {
          session.signal = true; this.update({ signal: 'Tab audio signal detected.' });
        }
        session.core.push(pcm);
      }, () => { if (this.session === session) void this.stop(); });
      session.core.start();
      if (this.session !== session) return;
      await session.source.start();
      if (this.session !== session || this.view.state !== 'starting') return;
      this.update({ state: 'running', status: 'Transcription active',
        signal: session.signal ? 'Tab audio signal detected.' : 'No audio signal yet. Play audio or check whether the tab is muted.' });
    } catch (error) {
      if (this.session === session && this.view.state !== 'stopping') this.fail(error.message || String(error));
    }
  }
  async stop() {
    const session = this.session;
    if (!session || this.view.state === 'stopping') return;
    if (this.view.state === 'loading') {
      this.cancel(); this.update({ status: 'Stopped before capture started.' }); return;
    }
    this.update({ state: 'stopping', status: 'Finalizing transcript…', partial: '' });
    try {
      await session.source?.stop();
      if (this.session === session) session.core.stop();
    } catch (error) { if (this.session === session) this.fail(error.message || String(error)); }
  }
  cancel() {
    const session = this.session; this.session = null;
    session?.ready(false); session?.core?.release();
    void session?.source?.stop(false).catch(() => {});
    this.update({ state: 'idle', partial: '', signal: '' });
  }
  fail(message) {
    this.cancel();
    this.update({ status: 'Transcription failed. Invoke the toolbar action or retry.', error: message });
  }
  tabEnded(tabId) { if (this.session?.tabId === tabId) void this.stop(); }
}
