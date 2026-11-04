import { Pipeline } from '../../web/pipeline.js';
import { HoldNode } from '../../web/hold-node.js';
import { TextFormatterNode } from '../../web/text-nodes.js';
import { TextWindowNode } from '../../web/text-window-node.js';
import { TextSummaryNode } from '../../web/text-summary-node.js';
import { TEXT } from '../../web/port-contracts.js';
import { EnglishToJapaneseTranslateGemmaTranslationNode } from '../../web/translation-nodes.js';
import { TranslationSchedulerNode, TRANSLATION_OUTPUTS } from '../../extension/translation-scheduler.js';

// Deterministic summary replies, explicitly controlled translation completion.
// Runs unchanged in Node and the source-only MV3 fixture package.
export async function translationFeedback({ TranslationNode = EnglishToJapaneseTranslateGemmaTranslationNode,
  workerFactory, failLoad = false, failTranslate = false, reverse = false, preview = false,
  translatedFeedback = false, summaryResult = count => 'S' + count } = {}) {
  const workers = [], requests = [], summaries = [], outputs = [], accepted = [], states = [];
  const factory = url => {
    const worker = workerFactory ? workerFactory(url) : {
      postMessage(data) {
        if (data.type === 'load') queueMicrotask(() => this.reply({ id: data.id,
          type: failLoad && !url.pathname.endsWith('text-summary-worker.js') ? 'error' : 'ready', message: 'model failed' }));
        if (data.type === 'summarize') queueMicrotask(() => this.reply({ id: data.id, type: 'result', summary: summaryResult(summaries.length) }));
        if (data.type === 'drain') queueMicrotask(() => this.reply({ id: data.id, type: 'drained' }));
      }, reply(data) { this.onmessage?.({ data }); }, terminate() { this.released = true; },
    };
    const post = worker.postMessage.bind(worker);
    worker.postMessage = data => {
      if (data.type === 'summarize') summaries.push(data.text);
      if (data.type === 'translate') requests.push({ worker, ...data });
      post(data);
    };
    workers.push(worker); return worker;
  };
  const hold = new HoldNode(), window = new TextWindowNode();
  const scheduler = new TranslationSchedulerNode({ TranslationNode, workerFactory: factory, onState: state => states.push(state) });
  const receive = scheduler.receiveInputs.bind(scheduler);
  scheduler.receiveInputs = (values, context) => {
    accepted.push(values.text ?? values.provisional);
    return receive(values, context);
  };
  let source;
  const nodes = {
    source: { outputs: { text: TEXT, final: TEXT }, start(c) { source = c; } }, window, hold,
    formatter: new TextFormatterNode({ inputCount: 2, template: '{1}/{2}' }),
    summary: new TextSummaryNode({ type: 'TextSummaryLfm2', workerFactory: factory }),
    translator: scheduler,
    sink: { inputs: TRANSLATION_OUTPUTS, receiveInputs(values, context) { outputs.push({ values, provisional: context.provisional }); } },
  };
  const edge = (a, b, c, d) => ({ from: [a, b], to: [c, d] });
  const connections = [edge('source', 'text', 'window', 'text'), edge('window', 'text', 'formatter', 'input2'),
    edge('hold', 'value', 'formatter', 'input1'), edge('formatter', 'text', 'summary', 'text'),
    edge(translatedFeedback ? 'translator' : 'summary', translatedFeedback ? 'text' : 'summary', 'hold', 'input'),
    edge('summary', 'summary', 'translator', preview ? 'provisional' : 'text'),
    ...(preview ? [edge('source', 'final', 'translator', 'text')] : []),
    ...Object.keys(TRANSLATION_OUTPUTS).map(port => edge('translator', port, 'sink', port))];
  if (reverse) connections.reverse();
  const pipeline = new Pipeline({ nodes, connections });
  await pipeline.start();
  return { pipeline, hold, window, scheduler, summaries, requests, outputs, accepted, states, workers,
    async send(text) { source.emit('text', text); await pipeline.entries.get('window').queue; window.flush(); },
    commit(text) { source.emit('final', text); },
    complete(index, text = 'T' + (index + 1)) {
      const request = requests[index];
      const data = { id: request.id, type: failTranslate ? 'error' : 'result', message: 'inference failed', texts: [text] };
      if (workerFactory) request.worker.postMessage({ type: 'complete', result: data });
      else request.worker.reply(data);
    },
  };
}
