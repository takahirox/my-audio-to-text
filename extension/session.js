import { verifiedOpusCache } from './opus-mt-cache.js';
import { verifiedEnglishToJapaneseOpusCache } from './opus-mt-en-ja-cache.js';
import { translationDirection } from './translation-preferences.js';
import { assertGraph, defaultGraph, graphPreferences, withTranslation, INPUT_TYPES, FIELD_TYPES, ASR_TYPES, NODE_TYPES } from './graph.js';
import { buildGraph } from './graph-runtime.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory, pageConnectionFactory, whisperWorkerFactory, zipformerWorkerFactory,
    translationWorkerFactory = url => new Worker(url, { type: 'module' }),
    graph = defaultGraph({ enabled: false }),
    ttsWorkerFactory, prepareTts, onSynthesizedAudio = () => {},
    prepareTranslation = (signal, direction) => direction === 'en-ja'
      ? verifiedEnglishToJapaneseOpusCache(signal) : verifiedOpusCache(signal),
  } = {}) {
    this.whisperWorkerFactory = whisperWorkerFactory; this.zipformerWorkerFactory = zipformerWorkerFactory;
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.pageConnectionFactory = pageConnectionFactory; this.targets = {}; this.outputTarget = null;
    this.translationWorkerFactory = translationWorkerFactory; this.prepareTranslation = prepareTranslation;
    this.graph = assertGraph(graph); this.ttsWorkerFactory = ttsWorkerFactory; this.prepareTts = prepareTts; this.onSynthesizedAudio = onSynthesizedAudio;
    const preferences = graphPreferences(this.graph);
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', signal: '', translationEnabled: preferences.enabled, translationDirection: preferences.direction, activeGraph: null, savedGraph: this.graph, displays: {}, ttsStatus: '', targetStatus: '', translationStatus: 'Translation off' };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId, { microphoneGesture = false } = {}) {
    if (this.session) return; // A second invocation never retargets live capture.
    let graph;
    try { graph = assertGraph(this.graph); } catch (error) { this.update({ error: error.message }); return; }
    const preferences = graphPreferences(graph);
    const hasDisplay = graph.nodes.some(node => node.type === 'LiveTextDisplay');
    const hasAudioOutput = graph.nodes.some(node => node.type === 'AudioOutput');
    const sourceType = graph.nodes.find(n => INPUT_TYPES.includes(n.type)).type;
    if (sourceType === 'MicrophoneAudio' && !microphoneGesture) { this.update({ tabId, status: 'Microphone selected. Press Start to request browser permission.' }); return; }
    for (const node of graph.nodes.filter(n => n.type === 'SelectedPageMediaAudio')) {
      const target = this.targets[node.id];
      if (!target || !target.mediaId || target.tabId !== tabId) {
        this.update({ tabId, error: `Select and authorize the target for ${node.id} in Live before Start.` }); return;
      }
    }
    const session = { tabId, outputTarget: this.outputTarget && structuredClone(this.outputTarget), targets: structuredClone(this.targets), targetStates: {}, activeFieldOutputs: new Set(), sourceType, direction: preferences.direction, translationEnabled: preferences.enabled }; this.session = session;
    this.update({ state: 'loading', tabId, activeGraph: graph, displays: {}, ttsStatus: '', targetStatus: '', translationStatus: session.translationEnabled ? 'Loading local OPUS-MT…' : 'Translation off', status: `Loading ${NODE_TYPES[graph.nodes.find(n => ASR_TYPES.includes(n.type)).type].label}${graph.nodes.some(n => n.type === 'SpeechToTextZipformerEn') ? '' : ' + Silero'}…`, error: '', signal: '' });
    try {
      if (sourceType === 'MicrophoneAudio') {
        // Request directly from the explicit Start action, before loading models.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
        if (this.session !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.microphoneStream = stream;
      }
      Object.assign(session, buildGraph(graph, {
        tabId, outputTarget: session.outputTarget, targets: session.targets, microphoneStream: session.microphoneStream, pageConnectionFactory: this.pageConnectionFactory,
        onTargetState: (id, state, active) => {
          if (this.session === session && state) {
            session.targetStates[id] = state;
            if (active === true) session.activeFieldOutputs.add(id);
            else if (active === false) session.activeFieldOutputs.delete(id);
            const statuses = Object.entries(session.targetStates).map(([id, status]) => `${id}: ${status}`);
            if (!hasDisplay && !hasAudioOutput && !session.activeFieldOutputs.size) statuses.push('No text destination is active. Focus a supported field in the toolbar tab or invoke its toolbar action for the next session, or add a Live view in Graph Editor.');
            this.update({ targetStatus: statuses.join('\n') });
          }
        },
        workerFactory: this.workerFactory, whisperWorkerFactory: this.whisperWorkerFactory, zipformerWorkerFactory: this.zipformerWorkerFactory, sourceFactory: this.sourceFactory,
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
        onDisplay: (id, state) => {
          if (this.session === session) this.update({ displays: { ...this.view.displays, [id]: state } });
        },
        onCapturedAudio: pcm => {
          if (this.session !== session) return;
          if (!session.signal && pcm.some(sample => Math.abs(sample) > 0.00001)) {
            session.signal = true; this.update({ signal: sourceType === 'ChromeTabAudio' ? 'Tab audio signal detected.' : 'Audio input signal detected.' });
          }
        },
        onEnded: () => { if (this.session === session) void this.stop(); },
        onTranslationState: (state, id) => {
          if (this.session !== session) return;
          session.translationStates ||= {};
          session.translationStates[id] = state;
          const statuses = Object.entries(session.translationStates);
          this.update({ translationStatus: statuses.length === 1 ? state : statuses.map(([id, state]) => `${id}: ${state}`).join('\n') });
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
    for (const translation of session.translations || []) translation.discardProvisional();
    this.update({ state: 'stopping', status: 'Finalizing graph outputs…' });
    // Schedule before ending the source: onEnded can reenter stop().
    return session.stopping = Promise.resolve().then(async () => {
      try {
        if (starting) session.audio.end();
        await session.pipeline.stop();
        if (this.session !== session) return;
        this.clearDisplayPreviews(session);
        await session.pipeline.dispose();
        if (this.session !== session) return;
        this.session = null;
        session.microphoneStream?.getTracks().forEach(track => track.stop());
        this.update({ state: 'idle', status: 'Stopped. Outputs are ready.' });
      } catch (error) { if (this.session === session) this.fail(error.message || String(error)); }
    });
  }
  cancel() {
    const session = this.session;
    // The compatibility formatter retains completed source-bearing history and
    // marks pending rows canceled before Pipeline invalidates all emissions.
    for (const entry of session?.pipeline?.entries.values() || []) {
      if (typeof entry.node.cancel !== 'function') continue;
      const text = entry.node.cancel();
      for (const route of entry.routes.get('text') || []) if (route.port === 'replace' && typeof route.entry.node.publish === 'function') {
        route.entry.node.receive('replace', text, route.entry.context);
      }
    }
    this.clearDisplayPreviews(session);
    this.session = null;
    session?.microphoneStream?.getTracks().forEach(track => track.stop());
    void session?.pipeline?.dispose().catch(() => {});
    this.update({ state: 'idle', signal: '', translationStatus: session?.translation ? 'Translation canceled' : this.view.translationStatus });
  }
  clearDisplayPreviews(session) {
    for (const spec of session?.description?.nodes || []) if (spec.type === 'LiveTextDisplay') session.pipeline.entries.get(spec.id).node.finish();
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
    if (this.outputTarget?.tabId === tabId) this.outputTarget = null;
    if (this.session?.outputTarget?.tabId === tabId) {
      for (const spec of this.session.description?.nodes || []) if (FIELD_TYPES.includes(spec.type)) {
        this.session.pipeline.entries.get(spec.id).node.failure('Toolbar document navigated or closed.');
      }
    }
    for (const [id, target] of Object.entries(this.targets)) if (target.tabId === tabId) delete this.targets[id];
    if (this.session?.tabId === tabId && this.session.sourceType !== 'MicrophoneAudio') void this.stop();
    // Each output port reports its own detachment; preserve peer/skip statuses.
    this.update();
  }
}
