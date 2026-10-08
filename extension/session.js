import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextNode, TranscriptOutputNode } from '../web/transcription-nodes.js';
import { ExtensionTabAudioNode } from './tab-audio-node.js';
import { TranslationSchedulerNode, TRANSLATION } from './translation-scheduler.js';
import { verifiedOpusCache } from './opus-mt-cache.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory,
    translationWorkerFactory = url => new Worker(url, { type: 'module' }),
    prepareTranslation = verifiedOpusCache,
  } = {}) {
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.translationWorkerFactory = translationWorkerFactory; this.prepareTranslation = prepareTranslation;
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', partial: '', final: '', signal: '', translationEnabled: false, translationStatus: 'Translation off', interimTranslation: null, utterances: [] };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId) {
    if (this.session) return; // A second invocation never retargets live capture.
    const session = { tabId }; this.session = session;
    this.update({ state: 'loading', tabId, status: 'Loading ReazonSpeech ja-en + Silero…', error: '', partial: '', final: '', signal: '', interimTranslation: null, utterances: [] });
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
        else if (port === 'final') this.update({ partial: '', interimTranslation: null,
          final: this.view.final + (text.trim() ? `${text}\n` : ''),
          utterances: text.trim() ? [...this.view.utterances, { source: text, status: session.translation ? 'pending' : 'off', text: '' }] : this.view.utterances });
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
      const nodes = { audio: session.audio, speech: session.speech, transcript };
      const connections = [
        { from: ['audio', 'audio'], to: ['speech', 'audio'] },
        { from: ['speech', 'provisional'], to: ['transcript', 'provisional'] },
        { from: ['speech', 'final'], to: ['transcript', 'final'] },
      ];
      if (this.view.translationEnabled) {
        session.translation = new TranslationSchedulerNode({ prepare: this.prepareTranslation,
          workerFactory: this.translationWorkerFactory, onState: status => {
            if (this.session === session) this.update({ translationStatus: status });
          } });
        nodes.translation = session.translation;
        nodes.english = { inputs: { provisional: TRANSLATION, final: TRANSLATION }, outputs: {},
          receive: (port, value, context) => {
            if (this.session !== session || context.signal.aborted) return;
            if (port === 'provisional') {
              if (this.view.state !== 'stopping' && value.source.text === this.view.partial) this.update({ interimTranslation: value.status === 'pending' && this.view.interimTranslation
                ? { ...value, previous: this.view.interimTranslation.status === 'complete' ? this.view.interimTranslation : this.view.interimTranslation.previous } : value });
            } else {
              const utterances = this.view.utterances.map((row, index) => index === value.index ? { ...row, ...value, source: row.source } : row);
              this.update({ utterances });
            }
          } };
        for (const port of ['provisional', 'final']) {
          connections.push({ from: ['speech', port], to: ['translation', port] },
            { from: ['translation', port], to: ['english', port] });
        }
      }
      session.pipeline = new Pipeline({ nodes, connections, onError: error => { if (this.session === session) this.fail(error.cause?.message || error.message); } });
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
    session.translation?.discardProvisional();
    this.update({ state: 'stopping', status: session.translation ? 'Finalizing transcript and translations…' : 'Finalizing transcript…', partial: '', interimTranslation: null });
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
    this.update({ state: 'idle', partial: '', signal: '', interimTranslation: null,
      translationStatus: session?.translation ? 'Translation canceled' : this.view.translationStatus,
      utterances: this.view.utterances.map(row => row.status === 'pending' ? { ...row, status: 'canceled' } : row) });
  }
  fail(message) {
    this.cancel();
    this.update({ status: 'Transcription failed. Invoke the toolbar action or retry.', error: message });
  }
  setTranslation(enabled) {
    if (this.session) return; // Apply to the next session; live graphs are immutable.
    this.update({ translationEnabled: !!enabled, translationStatus: enabled ? 'Translation enabled for the next session' : 'Translation off' });
  }
  tabEnded(tabId) { if (this.session?.tabId === tabId) void this.stop(); }
}
