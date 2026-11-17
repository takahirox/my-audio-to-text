import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { TranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { translateGemmaLanguages, TRANSLATE_GEMMA_LANGUAGES } from '../web/translategemma-languages.js';
import { TranslationSchedulerNode, TRANSLATION_OUTPUTS } from '../extension/translation-scheduler.js';
import { NODE_TYPES, graphNode, edge, assertGraph, saveGraph, readGraph, GRAPH_VERSION } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { assertSubgraph } from '../extension/subgraphs.js';
import { buildGraph } from '../extension/graph-runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ holdLoad = false, prepare } = {}) {
  let input;
  const requests = [], workers = [], outputs = [], states = [];
  const scheduler = new TranslationSchedulerNode({ TranslationNode: TranslateGemmaTranslationNode,
    modelName: 'TranslateGemma 4B', prepare, onState: state => states.push(state), workerFactory: url => {
      const worker = { url, terminated: 0, messages: [], postMessage(data) {
        this.messages.push(data);
        if (data.type === 'load' && !holdLoad) queueMicrotask(() => this.reply({ id: data.id, type: 'ready' }));
        if (data.type === 'drain') queueMicrotask(() => this.reply({ id: data.id, type: 'drained' }));
        if (data.type === 'translate') requests.push(data);
      }, reply(data) { this.onmessage?.({ data }); }, terminate() { this.terminated++; } };
      workers.push(worker); return worker;
    } });
  const ports = { context: TEXT, text: TEXT, provisional: TEXT, source_lang: TEXT, target_lang: TEXT, id: NUMBER, provisionalId: NUMBER };
  const pipeline = new Pipeline({ nodes: {
    source: { outputs: ports, start(context) { input = context; } }, scheduler,
    sink: { inputs: TRANSLATION_OUTPUTS, receiveInputs(values) { outputs.push(values); } },
  }, connections: [...Object.keys(ports).map(port => edge('source', port, 'scheduler', port)),
    ...Object.keys(TRANSLATION_OUTPUTS).map(port => edge('scheduler', port, 'sink', port))] });
  await pipeline.start();
  return { pipeline, scheduler, requests, workers, outputs, states,
    send: (port, value) => input.emit(port, value), group: values => input.emitOutputs(values),
    complete(index, text = 'translated', error) { workers[0].reply({ id: requests[index].id,
      type: error ? 'error' : 'result', texts: [text], message: error }); } };
}

test('configuration-only updates never infer; text jobs snapshot immutable FIFO config during async load', async () => {
  let loaded;
  const f = await fixture({ prepare: () => new Promise(resolve => { loaded = resolve; }) });
  f.send('text', 'default'); f.send('source_lang', 'en'); f.send('target_lang', 'ja'); f.send('text', 'first');
  f.send('source_lang', 'fr'); f.send('target_lang', 'de'); f.send('context', 'French reference'); f.send('text', 'second'); f.send('source_lang', 'ja');
  await tick(); assert.equal(f.workers.length, 0);
  loaded(); await f.scheduler.ready; await tick();
  for (const [index, config] of [{ source_lang: 'ja', target_lang: 'en' }, { source_lang: 'en', target_lang: 'ja' }, { source_lang: 'fr', target_lang: 'de' }].entries()) {
    assert.deepEqual(Object.fromEntries(['source_lang', 'target_lang'].map(port => [port, f.requests[index][port]])), config);
    if (index === 2) assert.equal(f.requests[index].context, 'French reference');
    f.complete(index); await tick();
  }
  assert.equal(f.workers.length, 1);
  assert.equal(f.workers[0].messages.filter(m => m.type === 'load').length, 1);
  await f.pipeline.stop(); assert.equal(f.requests.length, 3); assert.equal(f.outputs.length, 3);
  assert.deepEqual(f.outputs.map(o => o.source), ['default', 'first', 'second']);
  await f.pipeline.dispose(); assert.equal(f.workers[0].terminated, 1);
});

test('atomic grouped text + languages applies config first, omissions restore defaults and IDs stay paired', async () => {
  const f = await fixture();
  f.group({ text: 'one', target_lang: 'ja', source_lang: 'en', context: 'one context', id: 10 });
  f.group({ text: 'two', target_lang: 'ja', id: 11 });
  f.group({ text: 'three' });
  await tick();
  for (const [index, source, target] of [[0, 'en', 'ja'], [1, 'ja', 'ja'], [2, 'ja', 'en']]) {
    assert.equal(f.requests[index].context, index === 0 ? 'one context' : undefined);
    assert.equal(f.requests[index].source_lang, source); assert.equal(f.requests[index].target_lang, target);
    f.complete(index); await tick();
  }
  await f.pipeline.stop(); assert.deepEqual(f.outputs.map(o => o.id), [10, 11, undefined]);
  await f.pipeline.dispose();
});

test('invalid codes route per-job source/error without inference; corrected config recovers', async () => {
  const f = await fixture();
  f.send('target_lang', 'xx'); await tick(); assert.equal(f.requests.length, 0);
  f.send('text', 'bad target'); await tick();
  assert.equal(f.outputs[0].source, 'bad target'); assert.match(f.outputs[0].error, /target_lang/); assert.equal(f.outputs[0].text, undefined);
  f.send('target_lang', 'ja'); f.send('source_lang', ''); f.send('text', 'blank source'); await tick();
  assert.match(f.outputs[1].error, /source_lang/); assert.equal(f.requests.length, 0);
  f.send('source_lang', 'ja'); f.send('text', 'recovered'); await tick(); f.complete(0);
  await f.pipeline.stop(); assert.equal(f.outputs.at(-1).text, 'translated'); assert.equal(f.outputs.at(-1).error, '');
  await f.pipeline.dispose();
});

test('provisional snapshots stay separate from generated tokens, final supersedes preview and Stop drains finals', async () => {
  const f = await fixture();
  f.group({ provisional: 'old preview', source_lang: 'en', target_lang: 'ja', provisionalId: 2 }); await tick();
  f.send('target_lang', 'en');
  assert.equal(f.requests[0].target_lang, 'ja');
  f.group({ text: 'final', target_lang: 'ja', id: 3 });
  let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); f.complete(0, 'obsolete'); await tick();
  assert.equal(f.requests[1].target_lang, 'ja'); f.complete(1, 'committed'); await stopping;
  assert.equal(f.outputs.some(o => o.provisionalText === 'obsolete'), false);
  assert.equal(f.outputs.at(-1).text, 'committed'); assert.equal(f.outputs.at(-1).id, 3);
  await f.pipeline.dispose();
});

for (const phase of ['load', 'inference']) test(`Cancel during ${phase} owns Worker and ignores late output; fresh Node retries`, async () => {
  const f = await fixture({ holdLoad: phase === 'load' });
  f.send('text', 'cancel'); await tick();
  const callback = f.workers[0].onmessage;
  await f.pipeline.dispose(); callback({ data: { type: 'result', id: 2, texts: ['late'] } });
  assert.equal(f.workers[0].terminated, 1); assert.deepEqual(f.outputs, []);
  const next = await fixture(); next.send('text', 'retry'); await tick(); next.complete(0, 'fresh');
  await next.pipeline.stop(); assert.equal(next.outputs[0].text, 'fresh'); await next.pipeline.dispose();
});

test('language defaults and exact template vocabulary reject unsupported/blank codes and normalize regional tags', () => {
  assert.deepEqual(translateGemmaLanguages(), { source_lang: 'ja', target_lang: 'en' });
  assert.equal(Object.keys(TRANSLATE_GEMMA_LANGUAGES).length, 581);
  for (const [source, target] of [['ja', 'en'], ['en', 'ja'], ['fr', 'de'], ['es', 'ko'], ['en_GB', 'zh_Hant']]) {
    const result = translateGemmaLanguages({ source_lang: source, target_lang: target });
    assert.equal(result.source_lang, source.replaceAll('_', '-'));
    assert.equal(result.target_lang, target.replaceAll('_', '-'));
    assert.ok(Object.isFrozen(result));
  }
  for (const value of ['', ' ', 'auto', 'EN', 'xx', 'eng', 'zh-CN', '__proto__', 'toString', null, undefined, 42])
    for (const port of ['source_lang', 'target_lang']) assert.throws(() => translateGemmaLanguages({ [port]: value }), new RegExp(port));
});

test('one concrete Translation type saves and reloads languages, context, IDs, wires and subgraph ports', async () => {
  assert.deepEqual(Object.keys(NODE_TYPES).filter(type => /TranslateGemma/.test(type)), ['TranslateGemma4B']);
  assert.equal(NODE_TYPES.TranslateGemma4B.label, 'Translation');
  assert.equal(NODE_TYPES.TranslateGemma4B.ai.model, 'TranslateGemma 4B');
  assert.deepEqual(graphNode('TranslateGemma4B', 'gemma').settings, {});
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'input'), graphNode('Text', 'context'),
    graphNode('TranslateGemma4B', 'gemma'), graphNode('Text', 'source'), graphNode('Text', 'target'),
    graphNode('Number', 'requestId'), graphNode('Display', 'out')], edges: [
      edge('input', 'value', 'gemma', 'text'), edge('context', 'value', 'gemma', 'context'),
      edge('source', 'value', 'gemma', 'source_lang'), edge('target', 'value', 'gemma', 'target_lang'),
      edge('requestId', 'value', 'gemma', 'id'), edge('gemma', 'text', 'out', 'input1'),
  ] };
  for (const [id, value] of [['input', 'Hello'], ['context', 'Reference'], ['source', 'en'], ['target', 'ja']])
    graph.nodes.find(node => node.id === id).settings.value = value;
  assert.deepEqual(assertGraph(graph), graph);
  const storage = new Map(); storage.getItem = key => storage.get(key) ?? null; storage.setItem = (key,value) => storage.set(key,value);
  saveGraph(storage, graph);
  const reloaded = readGraph(storage);
  assert.deepEqual(reloaded, graph);
  assert.deepEqual(graphModelRequirements(reloaded).map(model => model.key), ['translategemma']);
  const requests = [], outputs = [];
  const built = buildGraph(reloaded, { prepareTranslateGemma: async () => {}, translationWorkerFactory: () => ({
    postMessage(data) {
      if (data.type === 'translate') requests.push(data);
      queueMicrotask(() => this.onmessage?.({ data: { id: data.id, type: data.type === 'load' ? 'ready' : data.type === 'drain' ? 'drained' : 'result', texts: ['translated'] } }));
    }, terminate() {},
  }) });
  built.pipeline.entries.get('out').node.render = value => outputs.push(value);
  await built.pipeline.start(); await built.pipeline.stop(); await built.pipeline.dispose();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source_lang, 'en'); assert.equal(requests[0].target_lang, 'ja');
  assert.equal(requests[0].context, 'Reference');
  assert.ok(outputs.length > 0);
  const subgraph = { version: GRAPH_VERSION, nodes: [graph.nodes[2]], edges: [], interface: {
    inputs: ['text', 'context', 'source_lang', 'target_lang', 'id'].map(port => ({ id: port, name: port, node: 'gemma', port })),
    outputs: [{ id: 'text', name: 'Translation', node: 'gemma', port: 'text' }],
  } };
  assert.deepEqual(assertSubgraph(JSON.parse(JSON.stringify(subgraph))), subgraph);
});
