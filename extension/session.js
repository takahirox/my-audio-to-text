import { verifiedOpusCache } from './opus-mt-cache.js';
import { verifiedEnglishToJapaneseOpusCache } from './opus-mt-en-ja-cache.js';
import { translationDirection } from './translation-preferences.js';
import { assertGraph, executableGraph, defaultGraph, graphPreferences, withTranslation, INPUT_TYPES, FIELD_TYPES, ASR_TYPES, NODE_TYPES } from './graph.js';
import { buildGraph } from './graph-runtime.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory, pageConnectionFactory, whisperWorkerFactory, zipformerWorkerFactory, parakeetWorkerFactory, moonshineWorkerFactory,
    translationWorkerFactory = url => new Worker(url, { type: 'module' }),
    graph = defaultGraph({ enabled: false }),
    ttsWorkerFactory, prepareTts, prepareTranslateGemma, onSynthesizedAudio = () => {},
    prepareTranslation = (signal, direction) => direction === 'en-ja'
      ? verifiedEnglishToJapaneseOpusCache(signal) : verifiedOpusCache(signal),
  } = {}) {
    this.parakeetWorkerFactory = parakeetWorkerFactory; this.moonshineWorkerFactory = moonshineWorkerFactory;
    this.whisperWorkerFactory = whisperWorkerFactory; this.zipformerWorkerFactory = zipformerWorkerFactory;
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.pageConnectionFactory = pageConnectionFactory; this.targets = {}; this.outputTarget = null;
    this.translationWorkerFactory = translationWorkerFactory; this.prepareTranslation = prepareTranslation; this.prepareTranslateGemma = prepareTranslateGemma;
    this.graph = assertGraph(graph); this.ttsWorkerFactory = ttsWorkerFactory; this.prepareTts = prepareTts; this.onSynthesizedAudio = onSynthesizedAudio;
    const preferences = graphPreferences(this.graph);
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', error: '', signal: '', translationEnabled: preferences.enabled, translationDirection: preferences.direction, activeGraph: null, savedGraph: this.graph, displays: {}, ttsStatus: '', targetStatus: '', translationStatus: 'Translation off' };
    this.update();
  }
  update(values = {}) { Object.assign(this.view, values); this.render({ ...this.view }); }
  async start(tabId, { microphoneGesture = false } = {}) {
    if (this.session) return; // A second invocation never retargets live capture.
    let graph, snapshot;
    try {
      snapshot = assertGraph(this.graph); graph = executableGraph(snapshot);
      if (!graph.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination in Graph Editor.');
    } catch (error) { this.update({ error: error.message }); return; }
    const preferences = graphPreferences(graph);
    const hasDisplay = graph.nodes.some(node => node.type === 'LiveTextDisplay');
    const hasAudioOutput = graph.nodes.some(node => node.type === 'AudioOutput');
    const sources = graph.nodes.filter(n => INPUT_TYPES.includes(n.type));
    const microphones = sources.filter(n => n.type === 'MicrophoneAudio');
    if (sources.some(node => node.type !== 'MicrophoneAudio') && !Number.isInteger(tabId)) {
      this.update({ error: 'Invoke the toolbar action on the target tab before starting tab or selected-media capture.' }); return;
    }
    if (microphones.length && !microphoneGesture) { this.update({ tabId, status: 'Microphone selected. Press Start to request browser permission.' }); return; }
    for (const node of graph.nodes.filter(n => n.type === 'SelectedPageMediaAudio')) {
      const target = this.targets[node.id];
      if (!target || !target.mediaId || target.tabId !== tabId) {
        this.update({ tabId, error: `Select and authorize the target for ${node.id} in Live before Start.` }); return;
      }
    }
    const session = { microphoneStreams: new Map(), endedSources: new Set(), sourceStates: Object.create(null), tabId, outputTarget: this.outputTarget && structuredClone(this.outputTarget), targets: structuredClone(this.targets), targetStates: {}, activeFieldOutputs: new Set(), direction: preferences.direction, translationEnabled: preferences.enabled };
    session.started = new Promise(resolve => { session.markStarted = resolve; });
    this.session = session;
    this.update({ state: 'loading', tabId, activeGraph: graph, activeSavedGraph: snapshot, displays: {}, ttsStatus: '', targetStatus: '', translationStatus: session.translationEnabled ? 'Preparing local translation…' : 'Translation off', status: graph.nodes.filter(node => ASR_TYPES.includes(node.type)).map(node => `${node.id}: Loading ${NODE_TYPES[node.type].label}…`).join('\n') || `Preparing ${graph.nodes.length} active Nodes…`, error: '', signal: '' });
    try {
      if (microphones.length) {
        // Request directly from the explicit Start action, before loading models.
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }); }
        catch (error) { throw Error(`${microphones.map(node => node.id).join(', ')}: Microphone capture unavailable: ${error.message || error}`); }
        if (this.session !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.microphoneStreams.set(microphones[0].id, stream);
        for (const node of microphones.slice(1)) session.microphoneStreams.set(node.id, stream.clone());
      }
      Object.assign(session, buildGraph(graph, {
        tabId, outputTarget: session.outputTarget, targets: session.targets, microphoneStreams: session.microphoneStreams, pageConnectionFactory: this.pageConnectionFactory,
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
        workerFactory: this.workerFactory, whisperWorkerFactory: this.whisperWorkerFactory, zipformerWorkerFactory: this.zipformerWorkerFactory, parakeetWorkerFactory: this.parakeetWorkerFactory, moonshineWorkerFactory: this.moonshineWorkerFactory, sourceFactory: this.sourceFactory,
        translationWorkerFactory: this.translationWorkerFactory, prepareTranslation: this.prepareTranslation,
        prepareTranslateGemma: this.prepareTranslateGemma,
        ttsWorkerFactory: this.ttsWorkerFactory, prepareTts: this.prepareTts,
        onTtsState: ttsStatus => { if (this.session === session) this.update({ ttsStatus }); },
        onSynthesizedAudio: (audio, signal) => {
          if (this.session === session && !signal.aborted) return this.onSynthesizedAudio(audio, signal);
        },
        onSpeechEvent: (event, id) => {
          if (this.session !== session) return;
          if (event.type === 'error' && event.branchUnavailable) {
            session.asrErrors ||= {}; session.asrErrors[id] = event.message;
            this.update({ error: Object.entries(session.asrErrors).map(([id, message]) => `${id}: ${message}`).join('\n') });
          } else if (event.type === 'progress' && this.view.state === 'loading') this.update({ status: `${id}: ${event.message}` });
          else if (event.type === 'error' && session.pipeline?.state === 'idle') this.fail(`${id}: ${event.message}`);
        },
        onDisplay: (id, state) => {
          if (this.session === session) this.update({ displays: { ...this.view.displays, [id]: state } });
        },
        onCapturedAudio: (pcm, id) => {
          if (this.session !== session) return;
          if (!session.sourceStates[id] && pcm.some(sample => Math.abs(sample) > 0.00001)) {
            session.sourceStates[id] = 'Audio signal detected.';
            this.update({ signal: this.sourceStatus(session) });
          }
        },
        onEnded: id => { if (this.session === session) void this.sourceEnded(session, id); },
        onTranslationState: (state, id) => {
          if (this.session !== session) return;
          session.translationStates ||= {};
          session.translationStates[id] = state;
          const statuses = Object.entries(session.translationStates);
          this.update({ translationStatus: statuses.length === 1 ? state : statuses.map(([id, state]) => `${id}: ${state}`).join('\n') });
        },
        onError: error => { if (this.session === session) this.fail(error.message); },
      }));
      await Promise.all([...session.speechNodes].map(async ([id, node]) => {
        try { await node.load(); } catch (error) { throw Error(`${id}: ${error.message || error}`); }
      }));
      if (this.session !== session) return;
      this.update({ state: 'starting', status: sources.length ? `Starting ${sources.length} audio source(s)…` : 'Starting processing paths…' });
      await session.pipeline.start();
      session.markStarted();
      if (this.session !== session || this.view.state !== 'starting') return;
      this.update({ state: 'running', status: sources.length ? 'Transcription active' : 'Processing active',
        signal: this.sourceStatus(session) });
    } catch (error) {
      if (this.session === session) this.fail(error.message || String(error));
    }
  }
  releaseMicrophones(session) {
    for (const stream of session?.microphoneStreams?.values() || []) stream.getTracks().forEach(track => track.stop());
    session?.microphoneStreams?.clear();
  }
  sourceStatus(session) {
    return session.description.nodes.filter(node => INPUT_TYPES.includes(node.type)).map(node =>
      `${node.id}: ${session.sourceStates[node.id] || (node.type === 'MicrophoneAudio'
        ? 'No audio signal yet. Check microphone permission, input volume and device selection.'
        : node.type === 'ChromeTabAudio' ? 'No audio signal yet. Play audio or check whether the tab is muted.' : 'No audio signal yet. Play the selected media.')}`).join('\n');
  }
  sourceEnded(session, id) {
    if (session.endedSources.has(id) || session.stopping) return;
    session.endedSources.add(id);
    session.sourceStates[id] = 'Capture ended; finalizing this path.';
    this.update({ signal: this.sourceStatus(session) });
    // When all live capture ends, retain the existing full-session Stop policy.
    if (session.endedSources.size === session.audioSources.size) return this.stop();
    // Drain only Nodes with no remaining live source ancestor. A formatter with
    // another live input stays open; one-source fan-out drains all its branches.
    const live = new Set([...session.audioSources.keys()].filter(source => !session.endedSources.has(source)));
    for (const entry of session.pipeline.order) {
      if (session.description.edges.some(route => route.to[0] === entry.id && live.has(route.from[0]))) live.add(entry.id);
    }
    const finished = session.pipeline.order.filter(entry => !live.has(entry.id)).map(entry => entry.id);
    return session.branchDrain = (session.branchDrain || Promise.resolve()).then(async () => {
      await session.started;
      if (this.session !== session) return;
      await session.pipeline.drain(finished);
      for (const nodeId of finished) {
        const entry = session.pipeline.entries.get(nodeId);
        if (entry.node.finish) entry.node.finish();
        await entry.node.dispose?.();
      }
    }).catch(error => { if (this.session === session) this.fail(error.message || String(error)); });
  }
  stop() {
    const session = this.session;
    if (!session) return Promise.resolve();
    if (session.stopping) return session.stopping;
    if (this.view.state === 'loading') {
      this.cancel(); this.update({ status: 'Stopped before capture started.' }); return Promise.resolve();
    }
    const starting = this.view.state === 'starting';
    this.update({ state: 'stopping', status: 'Finalizing graph outputs…' });
    // Schedule before ending the source: onEnded can reenter stop().
    return session.stopping = Promise.resolve().then(async () => {
      try {
        if (starting) for (const node of session.audioSources.values()) node.end();
        await session.branchDrain;
        await session.pipeline.stop();
        if (this.session !== session) return;
        this.clearDisplayPreviews(session);
        await session.pipeline.dispose();
        if (this.session !== session) return;
        this.session = null;
        this.releaseMicrophones(session);
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
    session?.markStarted?.();
    this.session = null;
    this.releaseMicrophones(session);
    void session?.pipeline?.dispose().catch(() => {});
    this.update({ state: 'idle', signal: '', translationStatus: session?.translations?.length ? 'Translation canceled' : this.view.translationStatus });
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
    if (this.session?.tabId === tabId) for (const [id, node] of this.session.audioSources || []) {
      if (this.session.description.nodes.find(spec => spec.id === id).type !== 'MicrophoneAudio') {
        node.end(); void this.sourceEnded(this.session, id);
      }
    }
    // Each output port reports its own detachment; preserve peer/skip statuses.
    this.update();
  }
}
