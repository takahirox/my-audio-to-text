import { graphModelRequirements } from './graph-model-preparation.js';
import { SELECTED_MEDIA_UNAVAILABLE } from './media-source.js';
import { authorizePage } from './page-target.js';
import { buttonLabel } from '../web/button-node.js';
import { verifiedOpusCache } from './opus-mt-cache.js';
import { verifiedEnglishToJapaneseOpusCache } from './opus-mt-en-ja-cache.js';
import { assertGraph, executableGraph, defaultGraph, graphPreferences, INPUT_TYPES, FIELD_TYPES, ASR_TYPES, NODE_TYPES } from './graph.js';
import { buildGraph } from './graph-runtime.js';
import { SpeakerOutputNode, StreamingSpeakerOutputNode } from '../web/speaker-output.js';

// Owns tab targeting and the window's UI. Nodes own capture and recognition.
export class TabSession {
  constructor(render, {
    workerFactory = path => new Worker(new URL(path, new URL('../web/', import.meta.url))),
    sourceFactory, pageConnectionFactory, whisperWorkerFactory, zipformerWorkerFactory, parakeetWorkerFactory, moonshineWorkerFactory,
    translationWorkerFactory = url => new Worker(url, { type: 'module' }),
    graph = defaultGraph({ enabled: false }),
    textSummaryWorkerFactory, ifConditionWorkerFactory, ttsWorkerFactory, prepareTts, prepareTranslateGemma, onSynthesizedAudio = () => {}, speakerContextFactory,
    prepareTranslation = (signal, direction) => direction === 'en-ja'
      ? verifiedEnglishToJapaneseOpusCache(signal) : verifiedOpusCache(signal),
  } = {}) {
    this.textSummaryWorkerFactory = textSummaryWorkerFactory;
    this.ifConditionWorkerFactory = ifConditionWorkerFactory;
    this.parakeetWorkerFactory = parakeetWorkerFactory; this.moonshineWorkerFactory = moonshineWorkerFactory;
    this.whisperWorkerFactory = whisperWorkerFactory; this.zipformerWorkerFactory = zipformerWorkerFactory;
    this.render = render; this.workerFactory = workerFactory; this.sourceFactory = sourceFactory;
    this.pageConnectionFactory = pageConnectionFactory; this.outputTarget = null;
    this.nodeErrors = new Map();
    this.translationWorkerFactory = translationWorkerFactory; this.prepareTranslation = prepareTranslation; this.prepareTranslateGemma = prepareTranslateGemma;
    this.graph = assertGraph(graph); this.ttsWorkerFactory = ttsWorkerFactory; this.prepareTts = prepareTts; this.onSynthesizedAudio = onSynthesizedAudio;
    this.speakerContextFactory = speakerContextFactory;
    const preferences = graphPreferences(this.graph);
    this.view = { state: 'idle', status: 'Invoke the toolbar action on a tab to begin.', prompt: '', error: '', signal: '', translationEnabled: preferences.enabled, translationDirection: preferences.direction, activeGraph: null, savedGraph: this.graph, displays: {}, ttsStatus: '', speakerStatus: '', speakerNeedsActivation: false, holdStatus: '', summaryStatus: '', conditionStatus: '', outputStatus: '', modelRecovery: false, preparingOutput: false, translationStatus: 'Translation off' };
    this.update();
  }
  update(values = {}) {
    Object.assign(this.view, values);
    this.view.graphActions = this.graphActions();
    this.render({ ...this.view });
  }
  nodeEvent(event, id) {
    // Unknown event types are diagnostics by default, including future Nodes.
    // Never infer severity from message text.
    if (event.type !== 'error' && event.severity !== 'error') return;
    this.nodeErrors.set(id, event.message || 'Operation failed. Start a new session to retry.');
    this.update({ error: [...this.nodeErrors].map(([id, message]) => `${id}: ${message}`).join('\n'),
      modelRecovery: [...this.nodeErrors.keys()].some(id => {
        const node = (this.view.activeGraph || this.graph).nodes.find(node => node.id === id);
        return node && graphModelRequirements({ nodes: [node] }).length > 0;
      }) });
  }
  async prepareFocusedOutput(tabId) {
    this.outputTarget = null;
    if (!executableGraph(this.graph).nodes.some(node => FIELD_TYPES.includes(node.type))) return;
    this.update({ preparingOutput: true });
    try {
      const target = await authorizePage(tabId);
      if (!this.session) this.outputTarget = target;
    } catch {
      // The focused output Node reports its actionable failure on Start.
      // Other branches still start, even on pages which cannot be authorized.
    } finally { this.update({ preparingOutput: false }); }
  }
  graphActions() {
    const owner = this.session || null;
    const graph = owner?.description || (this.view.state === 'idle' ? executableGraph(this.graph) : this.view.activeGraph);
    return (graph?.nodes || []).filter(node => node.type === 'Button').sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(spec => {
      const entry = owner?.pipeline?.entries.get(spec.id);
      const reachable = entry?.reachable || new Set();
      const busy = [...(owner?.actions?.values() || [])].some(action => [...reachable].some(target => action.has(target)));
      const failed = [...reachable].some(target => target.failed);
      const reason = this.view.state !== 'running' || owner?.pipeline?.state !== 'running' ? 'Start a session to use graph actions.'
        : failed ? 'Action path unavailable; start a fresh session.' : busy ? 'Action busy; waiting for downstream work.' : '';
      // Capture the exact session in each callback. Old DOM handlers cannot
      // acquire the context of a replacement session that reused this Node ID.
      return { id: spec.id, label: buttonLabel(spec.settings.label), disabled: !!reason, reason,
        invoke: () => this.pressButton(spec.id, owner) };
    });
  }
  async pressButton(id, owner = this.session) {
    if (!owner || this.session !== owner || this.view.state !== 'running' || owner.pipeline?.state !== 'running') return false;
    const entry = owner.pipeline.entries.get(id);
    if (owner.description.nodes.find(node => node.id === id)?.type !== 'Button' || !entry?.active || entry.closed || entry.failed) return false;
    owner.actions ||= new Map();
    if ([...entry.reachable].some(target => target.failed) || [...owner.actions.values()].some(action => [...entry.reachable].some(target => action.has(target)))) return false;
    owner.actions.set(id, entry.reachable);
    this.update();
    try {
      entry.node.press(); // one ordinary context.emit('trigger', 1)
      // Observe the existing queues and owned async work until this path settles.
      // UI admission is bounded to one action per overlapping downstream path.
      let previous;
      while (this.session === owner && owner.pipeline.state !== 'disposed') {
        const queues = [...entry.reachable].flatMap(target => [target.queue, ...[...target.work].map(work => work.done)]);
        if (previous && queues.length === previous.length && queues.every((queue, i) => queue === previous[i])) break;
        previous = queues;
        await Promise.allSettled(queues);
      }
      return true;
    } finally {
      owner.actions.delete(id);
      if (this.session === owner) this.update();
    }
  }
  async start(tabId, { microphoneGesture = false, speakerGesture = false } = {}) {
    if (this.session) return; // A second invocation never retargets live capture.
    this.nodeErrors.clear();
    this.update({ error: '', modelRecovery: false, prompt: '' });
    let graph, snapshot;
    try {
      snapshot = assertGraph(this.graph); graph = executableGraph(snapshot);
      if (!graph.nodes.length) throw Error('No executable path. Connect a source through complete processors to an output destination in Graph Editor.');
    } catch (error) { this.update({ error: error.message }); return; }
    const preferences = graphPreferences(graph);
    const hasDisplay = graph.nodes.some(node => node.type === 'Display');
    const hasAudioOutput = graph.nodes.some(node => ['AudioOutput', 'SpeakerOutput', 'StreamingSpeakerOutput'].includes(node.type));
    const speakers = graph.nodes.filter(node => ['SpeakerOutput', 'StreamingSpeakerOutput'].includes(node.type));
    const sources = graph.nodes.filter(n => INPUT_TYPES.includes(n.type));
    const microphones = sources.filter(n => n.type === 'MicrophoneAudio');
    if (sources.some(node => node.type === 'ChromeTabAudio') && !Number.isInteger(tabId)) {
      this.update({ error: 'Invoke the toolbar action on the target tab before starting tab capture.' }); return;
    }
    if (microphones.length && !microphoneGesture) { this.update({ tabId, status: 'Microphone selected. Press Start to request browser permission.', prompt: 'Press Start to request microphone permission.' }); return; }
    if (speakers.length && !speakerGesture) { this.update({ tabId, status: 'Speaker selected. Press Start to enable audio. Keep this Live window open.', prompt: 'Press Start to enable speaker audio.' }); return; }
    const session = { speakers: new Map(), speakerStates: Object.create(null), microphoneStreams: new Map(), endedSources: new Set(), sourceStates: Object.create(null), tabId, outputTarget: this.outputTarget && structuredClone(this.outputTarget), targetStates: {}, activeFieldOutputs: new Set(), direction: preferences.direction, translationEnabled: preferences.enabled };
    session.started = new Promise(resolve => { session.markStarted = resolve; });
    this.session = session;
    this.update({ state: 'loading', tabId, activeGraph: graph, activeSavedGraph: snapshot, displays: {}, ttsStatus: '', speakerStatus: '', speakerNeedsActivation: false, holdStatus: '', summaryStatus: '', conditionStatus: '', outputStatus: '', modelRecovery: false, preparingOutput: false, translationStatus: session.translationEnabled ? 'Preparing local translation…' : 'Translation off', status: graph.nodes.filter(node => ASR_TYPES.includes(node.type)).map(node => `${node.id}: Loading ${NODE_TYPES[node.type].label}…`).join('\n') || `Preparing ${graph.nodes.length} active Nodes…`, error: '', signal: '' });
    // Explain this source limitation even if a dependent processor fails before
    // Pipeline reaches the source's start hook. The source itself still fails
    // through Pipeline, preserving ordinary branch isolation and topology.
    for (const node of sources.filter(node => node.type === 'SelectedPageMediaAudio')) {
      this.nodeEvent({ type: 'error', message: SELECTED_MEDIA_UNAVAILABLE }, node.id);
    }
    try {
      for (const spec of speakers) {
        const Speaker = spec.type === 'StreamingSpeakerOutput' ? StreamingSpeakerOutputNode : SpeakerOutputNode;
        const node = new Speaker({ contextFactory: this.speakerContextFactory, onState: state => {
          if (this.session !== session) return;
          session.speakerStates[spec.id] = state;
          this.nodeEvent(state, spec.id);
          this.update({ speakerStatus: Object.entries(session.speakerStates).map(([id, value]) => `${id}: ${value.message}`).join('\n'),
            speakerNeedsActivation: Object.values(session.speakerStates).some(value => value.needsActivation) });
        } });
        session.speakers.set(spec.id, node);
        node.enable();
      }
      if (microphones.length) {
        // Request directly from the explicit Start action, before loading models.
        let stream;
        try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false }); }
        catch (error) { throw Error(`${microphones.map(node => node.id).join(', ')}: Microphone capture unavailable: ${error.message || error}`); }
        if (this.session !== session) { stream.getTracks().forEach(track => track.stop()); return; }
        session.microphoneStreams.set(microphones[0].id, stream);
        for (const node of microphones.slice(1)) session.microphoneStreams.set(node.id, stream.clone());
      }
      Object.assign(session, buildGraph(snapshot, {
        speakers: session.speakers,
        tabId, outputTarget: session.outputTarget, microphoneStreams: session.microphoneStreams, pageConnectionFactory: this.pageConnectionFactory,
        onTargetState: (id, state, active, severity) => {
          if (this.session === session && state) {
            session.targetStates[id] = state;
            if (active === true) session.activeFieldOutputs.add(id);
            else if (active === false) session.activeFieldOutputs.delete(id);
            const statuses = Object.entries(session.targetStates).map(([id, status]) => `${id}: ${status}`);
            if (!hasDisplay && !hasAudioOutput && !session.activeFieldOutputs.size) statuses.push('No text destination is active. Focus a supported field in the toolbar tab or invoke its toolbar action for the next session, or add a Live view in Graph Editor.');
            this.update({ outputStatus: statuses.join('\n') });
            this.nodeEvent({ severity, message: state }, id);
          }
        },
        workerFactory: this.workerFactory, whisperWorkerFactory: this.whisperWorkerFactory, zipformerWorkerFactory: this.zipformerWorkerFactory, parakeetWorkerFactory: this.parakeetWorkerFactory, moonshineWorkerFactory: this.moonshineWorkerFactory, sourceFactory: this.sourceFactory,
        translationWorkerFactory: this.translationWorkerFactory, prepareTranslation: this.prepareTranslation,
        onHoldState: (state, id) => {
          if (this.session !== session) return;
          session.holdStates ||= {}; session.holdStates[id] = state;
          this.update({ holdStatus: Object.entries(session.holdStates).map(([id, state]) => `${id}: ${state}`).join('\n') });
        },
        textSummaryWorkerFactory: this.textSummaryWorkerFactory,
        onTextSummaryEvent: (event, id) => {
          if (this.session !== session) return;
          this.nodeEvent(event, id);
          session.summaryStates ||= {}; session.summaryStates[id] = event.message || event.type;
          this.update({ summaryStatus: Object.entries(session.summaryStates).map(([id, state]) => `${id}: ${state}`).join('\n') });
        },
        ifConditionWorkerFactory: this.ifConditionWorkerFactory,
        onIfConditionEvent: (event, id) => {
          if (this.session !== session) return;
          this.nodeEvent(event, id);
          session.conditionStates ||= {}; session.conditionStates[id] = event.message || event.type;
          this.update({ conditionStatus: Object.entries(session.conditionStates).map(([id, state]) => `${id}: ${state}`).join('\n') });
        },
        prepareTranslateGemma: this.prepareTranslateGemma,
        ttsWorkerFactory: this.ttsWorkerFactory, prepareTts: this.prepareTts,
        onTtsState: (ttsStatus, id, event) => {
          if (this.session !== session) return;
          this.update({ ttsStatus }); this.nodeEvent(event || {}, id);
        },
        onSynthesizedAudio: (audio, signal) => {
          if (this.session === session && !signal.aborted) return this.onSynthesizedAudio(audio, signal);
        },
        onSpeechEvent: (event, id) => {
          if (this.session !== session) return;
          this.nodeEvent(event, id);
          if (event.type === 'progress' && this.view.state === 'loading') this.update({ status: `${id}: ${event.message}` });
          else if (['progress', 'ready'].includes(event.type) && this.view.state === 'running') this.update({ signal: this.sourceStatus(session) });
        },
        onDisplay: (id, state, port) => {
          if (this.session === session || (!this.session && this.canceling === session)) this.update({ displays: { ...this.view.displays, [id]: { ...this.view.displays[id], [port]: state } } });
        },
        onCapturedAudio: (pcm, id) => {
          if (this.session !== session) return;
          if (!session.sourceStates[id] && pcm.some(sample => Math.abs(sample) > 0.00001)) {
            session.sourceStates[id] = 'Audio signal detected.';
            this.update({ signal: this.sourceStatus(session) });
          }
        },
        onEnded: id => { if (this.session === session) void this.sourceEnded(session, id); },
        onTranslationState: (state, id, severity) => {
          if (this.session !== session) return;
          this.nodeEvent({ severity, message: state }, id);
          session.translationStates ||= {};
          session.translationStates[id] = state;
          const statuses = Object.entries(session.translationStates);
          this.update({ translationStatus: statuses.length === 1 ? state : statuses.map(([id, state]) => `${id}: ${state}`).join('\n') });
        },
        onError: (error, id) => {
          if (this.session !== session) return;
          // Structured Node events may already contain more useful recovery
          // instructions for this failure. Keep one notice per Node.
          if (!this.nodeErrors.has(id)) this.nodeEvent({ type: 'error', message: error.cause?.message || error.message }, id);
        },
      }));
      await Promise.allSettled([...session.speechNodes].map(async ([id, node]) => {
        await node.load({ connectedInputs: graph.edges.filter(route => route.to[0] === id).map(route => route.to[1]) });
      }));
      if (this.session !== session) return;
      this.update({ state: 'starting', status: sources.length ? `Starting ${sources.length} audio source(s)…` : 'Starting processing paths…' });
      await session.pipeline.start();
      session.markStarted();
      if (this.session !== session || this.view.state !== 'starting') return;
      this.update({ state: 'running', status: sources.length ? 'Transcription active' : 'Processing active',
        signal: this.sourceStatus(session) });
    } catch (error) {
      if (this.session === session) this.fail(error.message || String(error), { reported: session.pipeline?.errors.includes(error) });
    }
  }
  releaseMicrophones(session) {
    for (const stream of session?.microphoneStreams?.values() || []) stream.getTracks().forEach(track => track.stop());
    session?.microphoneStreams?.clear();
  }
  sourceStatus(session) {
    const sources = session.description.nodes.filter(node => INPUT_TYPES.includes(node.type)).map(node =>
      `${node.id}: ${session.sourceStates[node.id] || (node.type === 'MicrophoneAudio'
        ? 'No audio signal yet. Check microphone permission, input volume and device selection.'
        : node.type === 'ChromeTabAudio' ? 'No audio signal yet. Play audio or check whether the tab is muted.' : 'No audio signal yet. Play the selected media.')}`);
    const waiting = [...session.speechNodes].filter(([, node]) => node.waitingConfiguration && !node.disposed)
      .map(([id, node]) => `${id}: Waiting for startup ${node.configurationPort}; model has not started.`);
    return [...sources, ...waiting].join('\n');
  }
  sourceEnded(session, id) {
    if (session.endedSources.has(id) || session.stopping) return;
    session.endedSources.add(id);
    session.sourceStates[id] = 'Capture ended; finalizing this path.';
    this.update({ signal: this.sourceStatus(session) });
    // When all live capture ends, retain the existing full-session Stop policy.
    if ([...session.audioSources.keys()].every(source => session.endedSources.has(source) || session.pipeline.entries.get(source).failed)) return this.stop();
    // Drain only Nodes with no remaining live source ancestor. A formatter with
    // another live input stays open; one-source fan-out drains all its branches.
    const live = new Set([...session.audioSources.keys()].filter(source => !session.endedSources.has(source) && !session.pipeline.entries.get(source).failed));
    // Buttons remain live event producers. Startup-only Text/Number constants
    // must not keep an ended audio branch open through configuration edges.
    for (const node of session.description.nodes) if (node.type === 'Button') live.add(node.id);
    for (const entry of session.pipeline.order) {
      if (session.description.edges.some(route => route.to[0] === entry.id && live.has(route.from[0]))) live.add(entry.id);
    }
    const finished = session.pipeline.order.filter(entry => !live.has(entry.id)).map(entry => entry.id);
    return session.branchDrain = (session.branchDrain || Promise.resolve()).then(async () => {
      await session.started;
      if (this.session !== session) return;
      await session.pipeline.drain(finished);
      // A drained state input can still be sampled by a live consumer. Keep
      // that readable state until full-session cleanup; its producers can be
      // released now without clearing the consumer's last completed value.
      const retained = new Set(session.pipeline.order.filter(entry => live.has(entry.id))
        .flatMap(entry => entry.samples.map(sample => sample.entry)));
      for (const nodeId of finished) {
        const entry = session.pipeline.entries.get(nodeId);
        if (retained.has(entry)) continue;
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
        try { await session.pipeline.stop(); }
        catch (error) {
          // stop() drains every surviving path before reporting recorded Node
          // failures. They were already shown in Live; finish ordinary Stop
          // cleanup instead of canceling committed output as a new failure.
          if (session.pipeline.state !== 'stopped' || !(error instanceof AggregateError) ||
            !error.errors.every(cause => session.pipeline.errors.includes(cause))) throw error;
        }
        if (this.session !== session) return;
        await session.pipeline.dispose();
        if (this.session !== session) return;
        this.session = null;
        this.releaseMicrophones(session);
        this.update({ state: 'idle', speakerNeedsActivation: false, status: 'Stopped. Outputs are ready.' });
      } catch (error) { if (this.session === session) this.fail(error.message || String(error)); }
    });
  }
  cancel() {
    const session = this.session;
    if (!session) return this.canceling?.canceled;
    session.markStarted?.();
    this.session = null;
    this.canceling = session;
    this.releaseMicrophones(session);
    // These may already be unlocked while microphone permission/model loading
    // is pending and before a Pipeline exists. Disposal halts output immediately.
    for (const speaker of session.speakers.values()) void speaker.dispose();
    const canceled = session?.pipeline?.cancel().catch(() => {}).finally(() => {
      if (this.canceling === session) this.canceling = null;
    });
    session.canceled = canceled;
    if (!canceled) this.canceling = null;
    this.update({ state: 'idle', signal: '', speakerStatus: '', speakerNeedsActivation: false, translationStatus: session.translations?.length ? 'Translation canceled' : this.view.translationStatus });
    return canceled;
  }
  enableSpeakers() {
    for (const speaker of this.session?.speakers.values() || []) speaker.enable();
  }
  fail(message, { reported = false } = {}) {
    this.cancel();
    this.update({ status: 'Transcription failed. Invoke the toolbar action or retry.', error: reported ? this.view.error : [...new Set([this.view.error, message].filter(Boolean))].join('\n') });
  }
  setGraph(graph) {
    this.graph = assertGraph(graph);
    const preferences = graphPreferences(this.graph);
    this.update({ savedGraph: this.graph, translationEnabled: preferences.enabled, translationDirection: preferences.direction,
      ...(this.session ? {} : { translationStatus: preferences.enabled ? 'Translation enabled for the next session' : 'Translation off' }) });
  }
  tabEnded(tabId) {
    if (this.outputTarget?.tabId === tabId) this.outputTarget = null;
    if (this.session?.outputTarget?.tabId === tabId) {
      for (const spec of this.session.description?.nodes || []) if (FIELD_TYPES.includes(spec.type)) {
        this.session.pipeline.entries.get(spec.id).node.failure('Toolbar document navigated or closed.');
      }
    }
    if (this.session?.tabId === tabId) for (const [id, node] of this.session.audioSources || []) {
      if (this.session.description.nodes.find(spec => spec.id === id).type !== 'MicrophoneAudio') {
        node.end(); void this.sourceEnded(this.session, id);
      }
    }
    // Each output port reports its own detachment; preserve peer/skip statuses.
    this.update();
  }
}
