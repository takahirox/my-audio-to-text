import { verifiedOpusCache } from './opus-mt-cache.js';
import { verifiedEnglishToJapaneseOpusCache } from './opus-mt-en-ja-cache.js';
import { translationDirection } from './translation-preferences.js';
import { assertGraph, defaultGraph, graphPreferences, withTranslation, FIELD_TYPES, INPUT_TYPES } from './graph.js';
import { buildGraph } from './graph-runtime.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory, pageConnectionFactory,
    translationWorkerFactory = url => new Worker(url, { type: 'module' }),
    graph = defaultGraph({ enabled: false }),
    ttsWorkerFactory, prepareTts, onSynthesizedAudio = () => {},
    prepareTranslation = (signal, direction) => direction === 'en-ja'
      ? verifiedEnglishToJapaneseOpusCache(signal) : verifiedOpusCache(signal),
  } = {}) {
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.pageConnectionFactory = pageConnectionFactory; this.targets = {};
    this.translationWorkerFactory = translationWorkerFactory; this.prepareTranslation = prepareTranslation;
    this.graph = assertGraph(graph); this.ttsWorkerFactory = ttsWorkerFactory; this.prepareTts = prepareTts; this.onSynthesizedAudio = onSynthesizedAudio;
    const preferences = graphPreferences(this.graph);
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', partial: '', final: '', signal: '', translationEnabled: preferences.enabled, translationDirection: preferences.direction, activeGraph: null, savedGraph: this.graph, ttsStatus: '', targetStatus: '', displayDirection: 'ja-en', displayTranslationEnabled: false, translationStatus: 'Translation off', interimTranslation: null, utterances: [] };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId, { microphoneGesture = false } = {}) {
    if (this.session) return; // A second invocation never retargets live capture.
    let graph;
    try { graph = assertGraph(this.graph); } catch (error) { this.update({ error: error.message }); return; }
    const preferences = graphPreferences(graph);
    const sourceType = graph.nodes.find(n => INPUT_TYPES.includes(n.type)).type;
    if (sourceType === 'MicrophoneAudio' && !microphoneGesture) { this.update({ tabId, status: 'Microphone selected. Press Start to request browser permission.' }); return; }
    for (const node of graph.nodes.filter(n => FIELD_TYPES.includes(n.type) || n.type === 'SelectedPageMediaAudio')) {
      const target = this.targets[node.id];
      if (!target || (node.type === 'SelectedFormFieldTextOutputNode' && !target.fieldId) || (node.type === 'SelectedPageMediaAudio' && (!target.mediaId || target.tabId !== tabId))) {
        this.update({ tabId, error: `Select and authorize the target for ${node.id} in Live before Start.` }); return;
      }
    }
    const session = { tabId, targets: structuredClone(this.targets), targetStates: {}, sourceType, direction: preferences.direction, translationEnabled: preferences.enabled }; this.session = session;
    this.update({ state: 'loading', tabId, activeGraph: graph, ttsStatus: '', targetStatus: '', displayDirection: session.direction, displayTranslationEnabled: session.translationEnabled,
      translationStatus: session.translationEnabled ? 'Loading local OPUS-MT…' : 'Translation off', status: 'Loading ReazonSpeech ja-en + Silero…', error: '', partial: '', final: '', signal: '', interimTranslation: null, utterances: [] });
    try {
      if (sourceType === 'MicrophoneAudio') {
        // Request directly from the explicit Start action, before loading models.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        if (this.session !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.microphoneStream = stream;
      }
      Object.assign(session, buildGraph(graph, {
        tabId, targets: session.targets, microphoneStream: session.microphoneStream, pageConnectionFactory: this.pageConnectionFactory,
        onTargetState: (id, state) => {
          if (this.session === session && state) { session.targetStates[id] = state; this.update({ targetStatus: Object.entries(session.targetStates).map(([id, status]) => `${id}: ${status}`).join('\n') }); }
        },
        workerFactory: this.workerFactory, sourceFactory: this.sourceFactory,
        translationWorkerFactory: this.translationWorkerFactory, prepareTranslation: this.prepareTranslation,
        ttsWorkerFactory: this.ttsWorkerFactory, prepareTts: this.prepareTts,
        onTtsState: ttsStatus => { if (this.session === session) this.update({ ttsStatus }); },
        onSynthesizedAudio: (audio, signal) => {
          if (this.session === session && !signal.aborted) return this.onSynthesizedAudio(audio, signal);
        },
        onSpeechEvent: event => {
          if (this.session !== session) return;
          if (event.type === 'progress' && this.view.state === 'loading') this.update({ status: event.message });
          else if (event.type === 'error' && session.pipeline?.state === 'idle') this.fail(event.message);
        },
        onTranscript: (port, { text }, signal) => {
          if (this.session !== session || signal.aborted) return;
          if (port === 'provisional' && this.view.state !== 'stopping') this.update({ partial: text });
          else if (port === 'final') this.update({ partial: '', interimTranslation: null,
            final: this.view.final + (text.trim() ? `${text}\n` : ''),
            utterances: text.trim() ? [...this.view.utterances, { source: text, direction: session.direction, status: session.translation ? 'pending' : 'off', text: '' }] : this.view.utterances });
        },
        onCapturedAudio: pcm => {
          if (this.session !== session) return;
          if (!session.signal && pcm.some(sample => Math.abs(sample) > 0.00001)) {
            session.signal = true; this.update({ signal: sourceType === 'ChromeTabAudio' ? 'Tab audio signal detected.' : 'Audio input signal detected.' });
          }
        },
        onEnded: () => { if (this.session === session) void this.stop(); },
        onTranslationState: translationStatus => { if (this.session === session) this.update({ translationStatus }); },
        onTranslation: (port, value, context) => {
          if (this.session !== session || context.signal.aborted) return;
          if (port === 'provisional') {
            if (this.view.state !== 'stopping' && value.source.text === this.view.partial) this.update({ interimTranslation: value.status === 'pending' && this.view.interimTranslation
              ? { ...value, previous: this.view.interimTranslation.status === 'complete' ? this.view.interimTranslation : this.view.interimTranslation.previous } : value });
          } else {
            const utterances = this.view.utterances.map((row, index) => index === value.index ? { ...row, ...value, source: row.source } : row);
            this.update({ utterances });
          }
        },
        onError: error => { if (this.session === session) this.fail(error.cause?.message || error.message); },
      }));
      await session.speech.load();
      if (this.session !== session) return;
      this.update({ state: 'starting', status: `Starting ${sourceType === 'MicrophoneAudio' ? 'microphone' : sourceType === 'SelectedPageMediaAudio' ? 'selected media' : 'current-tab'} capture…` });
      await session.pipeline.start();
      if (this.session !== session || this.view.state !== 'starting') return;
      this.update({ state: 'running', status: 'Transcription active',
        signal: session.signal ? (sourceType === 'ChromeTabAudio' ? 'Tab audio signal detected.' : 'Audio input signal detected.') : sourceType === 'MicrophoneAudio' ? 'No audio signal yet. Check microphone permission, input volume and device selection.' : 'No audio signal yet. Play audio or check whether the tab is muted.' });
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
        session.microphoneStream?.getTracks().forEach(track => track.stop());
        this.update({ state: 'idle', status: 'Stopped. Final transcript is ready.', partial: '' });
      } catch (error) { if (this.session === session) this.fail(error.message || String(error)); }
    });
  }
  cancel() {
    const session = this.session; this.session = null;
    session?.microphoneStream?.getTracks().forEach(track => track.stop());
    void session?.pipeline?.dispose().catch(() => {});
    this.update({ state: 'idle', partial: '', signal: '', interimTranslation: null,
      translationStatus: session?.translation ? 'Translation canceled' : this.view.translationStatus,
      utterances: this.view.utterances.map(row => row.status === 'pending' ? { ...row, status: 'canceled' } : row) });
  }
  fail(message) {
    this.cancel();
    this.update({ status: 'Transcription failed. Invoke the toolbar action or retry.', error: message });
  }
  setGraph(graph) {
    this.graph = assertGraph(graph);
    const preferences = graphPreferences(this.graph);
    this.update({ savedGraph: this.graph, translationEnabled: preferences.enabled, translationDirection: preferences.direction,
      ...(this.session ? {} : { translationStatus: preferences.enabled ? 'Translation enabled for the next session' : 'Translation off' }) });
  }
  setTranslation(enabled) {
    if (this.session) return;
    this.setGraph(withTranslation(this.graph, { ...graphPreferences(this.graph), enabled: !!enabled }));
  }
  setTranslationDirection(direction) {
    this.setGraph(withTranslation(this.graph, { ...graphPreferences(this.graph), direction: translationDirection(direction) }));
  }
  setTarget(id, target) {
    if (this.session) throw Error('Stop before selecting or clearing targets.');
    if (target) this.targets[id] = structuredClone(target); else delete this.targets[id];
    this.update();
  }
  tabEnded(tabId) {
    for (const [id, target] of Object.entries(this.targets)) if (target.tabId === tabId) delete this.targets[id];
    if (this.session?.tabId === tabId && this.session.sourceType !== 'MicrophoneAudio') void this.stop();
    else if (this.session && Object.values(this.session.targets).some(target => target.tabId === tabId)) this.update({ targetStatus: 'Output page navigated or closed. Insertion detached; Stop and reselect.' });
    this.update();
  }
}
