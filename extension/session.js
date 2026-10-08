import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode, TranscriptOutputNode } from '../web/transcription-nodes.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory,
  } = {}) {
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', partial: '', final: '', signal: '' };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId) {
    if (this.session) return; // A second invocation never retargets live capture.
    const session = { tabId }; this.session = session;
    this.update({ state: 'loading', tabId, status: 'Loading ReazonSpeech ja-en + Silero…', error: '', partial: '', final: '', signal: '' });
    try {
      session.speech = new SpeechToTextNode({ workerFactory: this.workerFactory, onEvent: event => {
        if (this.session !== session) return;
        if (event.type === 'progress' && this.view.state === 'loading') this.update({ status: event.message });
        // Preloading has no active pipeline context to report errors yet.
        else if (event.type === 'error' && session.pipeline.state === 'idle') this.fail(event.message);
      } });
      const transcript = new TranscriptOutputNode((port, { text }, signal) => {
        if (this.session !== session || signal.aborted) return;
        if (port === 'provisional' && this.view.state !== 'stopping') this.update({ partial: text });
        else if (port === 'final') this.update({ partial: '', final: this.view.final + (text.trim() ? `${text}\n` : '') });
      });
      session.audio = new ExtensionTabAudioNode(tabId, {
        sourceFactory: this.sourceFactory,
        onAudio: pcm => {
          if (this.session !== session) return;
          if (!session.signal && pcm.some(sample => Math.abs(sample) > 0.00001)) {
            session.signal = true; this.update({ signal: 'Tab audio signal detected.' });
          }
        },
        onEnded: () => { if (this.session === session) void this.stop(); },
      });
      session.pipeline = new Pipeline({ nodes: { audio: session.audio, speech: session.speech, transcript }, connections: [
        { from: ['audio', 'audio'], to: ['speech', 'audio'] },
        { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
        { from: ['speech', 'final'], to: ['transcript', 'final'] },
      ], onError: error => { if (this.session === session) this.fail(error.cause?.message || error.message); } });
      await session.speech.load();
      if (this.session !== session) return;
      this.update({ state: 'starting', status: 'Starting current-tab capture…' });
      await session.pipeline.start();
      if (this.session !== session || this.view.state !== 'starting') return;
      this.update({ state: 'running', status: 'Transcription active',
        signal: session.signal ? 'Tab audio signal detected.' : 'No audio signal yet. Play audio or check whether the tab is muted.' });
    } catch (error) {
      if (this.session === session) this.fail(error.message || String(error));
    }
  }
  stop() {
    const session = this.session;
    if (!session) return Promise.resolve();
    if (session.stopping) return session.stopping;
    if (this.view.state === 'loading') {
      this.cancel(); this.update({ status: 'Stopped before capture started.' }); return Promise.resolve();
    }
    const starting = this.view.state === 'starting';
    this.update({ state: 'stopping', status: 'Finalizing transcript…', partial: '' });
    // Schedule before ending the source: onEnded can reenter stop().
    return session.stopping = Promise.resolve().then(async () => {
      try {
        if (starting) session.audio.end();
        await session.pipeline.stop();
        if (this.session !== session) return;
        await session.pipeline.dispose();
        if (this.session !== session) return;
        this.session = null;
        this.update({ state: 'idle', status: 'Stopped. Final transcript is ready.', partial: '' });
      } catch (error) { if (this.session === session) this.fail(error.message || String(error)); }
    });
  }
  cancel() {
    const session = this.session; this.session = null;
    void session?.pipeline?.dispose().catch(() => {});
    this.update({ state: 'idle', partial: '', signal: '' });
  }
  fail(message) {
    this.cancel();
    this.update({ status: 'Transcription failed. Invoke the toolbar action or retry.', error: message });
  }
  tabEnded(tabId) { if (this.session?.tabId === tabId) void this.stop(); }
}
