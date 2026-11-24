import { Microphone } from '../web/audio.js';
import { BrowserTabAudioNode } from '../web/transcription-nodes.js';
import { Pipeline } from '../web/pipeline.js';
import { SpeechToTextMoonshineSmallJaNode } from '../web/moonshine-small-ja-node.js';
import { TextFormatterNode } from '../web/text-nodes.js';
import { TextNode } from '../web/text-constant-node.js';
import { displayInputs } from '../web/display-node.js';
import { snapshotItem } from '../web/paired-text.js';
import { ModelAssetCache } from '../extension/model-asset-cache.js';
import { moonshineJapaneseManifest } from '../extension/optional-asr-cache.js';
import { FOCUSED_OUTPUT, JAPANESE_ASR, MICROPHONE } from './graph.js';
import { FocusedApplicationTextOutputNode } from './focused-output.js';

const host = window.runtimeHost;
let current, cachePromise, download;

function modelCache() {
  return cachePromise ??= moonshineJapaneseManifest().then(manifest => new ModelAssetCache(manifest, {
    // Downloads are explicit. The desktop's durable Chromium profile owns them.
    beforeDownload: () => {},
  })).catch(error => { cachePromise = null; throw error; });
}

class DesktopMicrophoneNode extends BrowserTabAudioNode {
  constructor(fail, onStopped) {
    super({
      onEnded: () => fail('The system microphone disconnected. Check the default input and start again.'),
      sourceFactory: (onAudio, ended) => new Microphone(onAudio, ended),
    });
    this.onStopped = onStopped;
  }

  async start(context) {
    try { await super.start(context); }
    catch (error) {
      throw Error(`Microphone unavailable: ${error.message}. Check the system microphone permission and default input, then retry.`);
    }
  }

  async stop() {
    await super.stop();
    this.onStopped();
  }
}

// The shared Display contracts and snapshot semantics are used in the hidden
// runtime. The Live window owns the view and never gains capture permissions.
class DesktopDisplayNode {
  outputs = {};
  constructor(settings, show) { this.inputs = displayInputs(settings.inputCount); this.show = show; }
  start(context) { this.signal = context.signal; }
  receiveInputs(values, context) {
    if (context.signal !== this.signal || context.signal.aborted) return;
    for (const [port, item] of Object.entries(values)) this.show(port, snapshotItem(item));
  }
}

async function start(id, graph) {
  if (current) throw Error('A desktop graph is already running.');
  const session = { id, active: true };
  current = session;
  const fail = message => {
    if (session.active) host.failure(id, message);
  };
  const recognizers = [];
  const create = ({ type, id: node, settings }) => {
    switch (type) {
      case MICROPHONE:
        return new DesktopMicrophoneNode(fail, () => host.captureEnded(id));
      case JAPANESE_ASR: {
        const recognizer = new SpeechToTextMoonshineSmallJaNode({
          workerFactory: () => new Worker(new URL('./moonshine-worker.js', import.meta.url), { type: 'module' }),
          onEvent: event => { if (event.type === 'error') fail(event.message); },
        });
        recognizers.push(recognizer);
        return recognizer;
      }
      case 'Text': return new TextNode(settings);
      case 'TextFormatter': return new TextFormatterNode(settings, { separatePreviews: true });
      case 'Display': return new DesktopDisplayNode(settings, (port, item) => {
        if (session.active) host.display(id, node, port, item);
      });
      case FOCUSED_OUTPUT: return new FocusedApplicationTextOutputNode(text => host.insert(id, text));
      default: throw Error(`Unsupported desktop Node: ${type}.`);
    }
  };
  try {
    session.pipeline = new Pipeline({ nodes: Object.fromEntries(graph.nodes.map(node => [node.id, create(node)])),
      connections: graph.edges, onError: error => fail(error.message) });
    // Verify weights and load every recognizer before requesting microphone
    // access or allowing another complete path to emit at startup.
    await Promise.all(recognizers.map(recognizer => recognizer.load()));
    if (!session.active) return;
    if (recognizers.some(recognizer => recognizer.unavailable)) throw Error('Model unavailable. Prepare it in Models and retry.');
    await session.pipeline.start();
  } catch (error) {
    await close(session);
    throw error;
  }
}

async function close(session) {
  session.active = false;
  // Dispose the full graph, including workers that started loading before
  // their Pipeline start hooks ran.
  try { await session.pipeline?.dispose(); }
  finally { if (current === session) current = null; }
}

const commands = {
  start,
  async stop(id) {
    const session = current;
    if (session?.id !== id) return;
    try { await session.pipeline.stop(); }
    finally { await close(session); }
  },
  async cancel(id) {
    const session = current;
    if (session?.id !== id) return;
    session.active = false;
    try { await session.pipeline?.cancel(); }
    finally { await close(session); }
  },
  async modelStatus() { return (await modelCache()).inspect(); },
  async modelPrepare() {
    if (download) throw Error('Model preparation is already running.');
    const controller = new AbortController();
    download = controller;
    const status = view => controller.signal.aborted && view.state !== 'Ready'
      ? { ...view, state: 'Canceled', error: 'Model preparation canceled. Retry to finish downloading.' } : view;
    try {
      const result = await (await modelCache()).prepare({ signal: controller.signal, onChange: view => host.modelProgress(status(view)) });
      return status(result);
    } finally { download = null; }
  },
  modelCancel() { download?.abort(); },
  async modelDelete() {
    if (current || download) throw Error('Stop the running session or download before deleting the model.');
    return (await modelCache()).remove();
  },
};

host.onCommand(async ({ request, action, args }) => {
  try { host.respond({ request, value: await commands[action](...args) }); }
  catch (error) { host.respond({ request, error: error.message }); }
});
host.ready();
