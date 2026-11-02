// Installed in a real page. Manual Worker replies make translation delay exact.
export async function installKeyedDOMBrowser() {
  const { Pipeline } = await import('/pipeline.js'), { SpeechToTextNode } = await import('/transcription-nodes.js');
  const { OpusMtTranslationNode } = await import('/translation-nodes.js');
  const { PairedTextToDOMNode, KeyedDOMAccumulatorNode } = await import('/dom-nodes.js');
  const { LiveTextDisplayNode } = await import('/text-nodes.js');
  const root = document.createElement('div'); root.id = 'keyed-live'; document.body.append(root);
  const speech = new SpeechToTextNode();
  speech.load = async () => {};
  speech.core = { start() {}, stop() { speech.receiveEvent({ type: 'stopped' }); }, release() {} };
  const requests = []; let worker;
  const complete = () => {
    const job = requests.shift();
    worker.onmessage?.({ data: { type: job.text === 'fail' ? 'error' : 'result', id: job.id, message: 'controlled failure', texts: [`translated:${job.text}`] } });
  };
  const translation = new OpusMtTranslationNode({ workerFactory() {
    worker = { postMessage(job) {
      if (job.type === 'translate') { requests.push(job); if (window.keyedFast) queueMicrotask(complete); }
      else queueMicrotask(() => worker.onmessage?.({ data: { type: job.type === 'load' ? 'ready' : 'drained', id: job.id } }));
    }, terminate() {} }; return worker;
  } });
  window.keyedSnapshots = [];
  const edge = (a, p, b, q) => ({ from: [a, p], to: [b, q] });
  window.keyedPipeline = new Pipeline({ nodes: { speech, translation, preview: new PairedTextToDOMNode(), final: new PairedTextToDOMNode(), translated: new PairedTextToDOMNode(), history: new KeyedDOMAccumulatorNode(),
    display: new LiveTextDisplayNode(dom => { root.replaceChildren(dom); window.keyedSnapshots.push([...root.querySelectorAll('tr')].map(row => [...row.children].map(cell => cell.textContent))); }) },
  connections: [edge('speech', 'provisional', 'preview', 'input1'), edge('speech', 'provisionalId', 'preview', 'id'),
    edge('speech', 'final', 'final', 'input1'), edge('speech', 'finalId', 'final', 'id'),
    edge('speech', 'final', 'translation', 'text'), edge('speech', 'finalId', 'translation', 'id'),
    edge('translation', 'source', 'translated', 'input1'), edge('translation', 'text', 'translated', 'input2'), edge('translation', 'id', 'translated', 'id'),
    ...['preview', 'final', 'translated'].flatMap((name, i) => [edge(name, 'id', 'history', `id${i+1}`), edge(name, 'dom', 'history', `dom${i+1}`)]), edge('history', 'dom', 'display', 'dom')] });
  window.keyedSend = (type, id, text) => speech.receiveEvent({ type, id, text });
  window.keyedComplete = complete;
  await window.keyedPipeline.start();
}

// Exercise actual primitive ports with independently controlled Number/TEXT
// sources, plus a real module Worker boundary for asynchronous job snapshots.
export async function installIndependentIDBrowser() {
  const { Pipeline } = await import('/pipeline.js');
  const { NumberNode } = await import('/number-node.js');
  const { TEXT, DOM } = await import('/port-contracts.js');
  const { PairedTextToDOMNode, KeyedDOMAccumulatorNode, TextToDOMNode } = await import('/dom-nodes.js');
  const { OpusMtTranslationNode } = await import('/translation-nodes.js');
  const root = document.createElement('div'); root.id = 'independent-live'; document.body.append(root);
  const number = new NumberNode({ value: -1.5 });
  let numberContext, textContext;
  number.start = context => { numberContext = context; };
  const edge = (a, p, b, q) => ({ from: [a, p], to: [b, q] });
  window.independentResults = [];
  const translator = new OpusMtTranslationNode({ workerFactory: () => new Worker('/independent-id-fixture-worker.js', { type: 'module' }) });
  const history = new KeyedDOMAccumulatorNode();
  window.independentPipeline = new Pipeline({ nodes: {
    number, text: { outputs: { value: TEXT }, start(context) { textContext = context; } },
    pair: new PairedTextToDOMNode(), plain: new TextToDOMNode(), history, translator,
    result: { inputs: translator.outputs, receiveInputs(values) { independentResults.push(values); } },
    display: { inputs: { dom: DOM }, receive(_, value) { root.replaceChildren(value); } },
  }, connections: [edge('number', 'value', 'pair', 'id'), edge('text', 'value', 'pair', 'input1'),
    edge('number', 'value', 'translator', 'id'), edge('text', 'value', 'translator', 'text'),
    edge('text', 'value', 'plain', 'text'),
    ...[1, 2, 3].flatMap(slot => [edge('number', 'value', 'history', `id${slot}`), edge(slot === 3 ? 'pair' : 'plain', 'dom', 'history', `dom${slot}`)]),
    ...Object.keys(translator.outputs).map(port => edge('translator', port, 'result', port)), edge('history', 'dom', 'display', 'dom')] });
  window.independentID = value => numberContext.emit('value', value);
  window.independentText = value => textContext.emit('value', value);
  window.independentKeys = () => [...history.rows.keys()];
  await independentPipeline.start();
}
