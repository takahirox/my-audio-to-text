import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { Plamo3Translate2BTranslationNode } from '../web/translation-nodes.js';
import { plamoLanguages, plamoPrompt, PLAMO_3_TRANSLATE_2B } from '../web/plamo-policy.js';
import { TranslationSchedulerNode, TRANSLATION_OUTPUTS } from '../extension/translation-scheduler.js';
import { NODE_TYPES, graphNode, edge, validateGraph, GRAPH_VERSION, readGraph } from '../extension/graph.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { defineAssetSet } from '../extension/model-asset-cache.js';
import { buildGraph } from '../extension/graph-runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture({ holdLoad = false, prepare } = {}) {
  let input;
  const requests = [], workers = [], outputs = [], states = [];
  const scheduler = new TranslationSchedulerNode({ TranslationNode: Plamo3Translate2BTranslationNode,
    modelName: 'PLaMo 3 Translate 2B', prepare, onState: state => states.push(state), workerFactory: url => {
      const worker = { url, terminated: 0, messages: [], postMessage(data) {
        this.messages.push(data);
        if (data.type === 'load' && !holdLoad) queueMicrotask(() => this.reply({ id: data.id, type: 'ready' }));
        if (data.type === 'drain') queueMicrotask(() => this.reply({ id: data.id, type: 'drained' }));
        if (data.type === 'translate') requests.push(data);
      }, reply(data) { this.onmessage?.({ data }); }, terminate() { this.terminated++; } };
      workers.push(worker); return worker;
    } });
  const ports = { text: TEXT, provisional: TEXT, source_lang: TEXT, target_lang: TEXT, id: NUMBER, provisionalId: NUMBER };
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

test('PFML3 includes explicit target, omits auto source and honors both directions', () => {
  assert.deepEqual(plamoLanguages(), { source_lang: 'auto', target_lang: 'en' });
  assert.equal(plamoPrompt('こんにちは。'), '<|plamo:tag|>dataset<|plamo:msg|>translation<|plamo:tag|>input<|plamo:msg|>こんにちは。<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>en<|plamo:msg|>');
  for (const source of ['ja', 'en', 'auto']) for (const target of ['ja', 'en']) {
    const prompt = plamoPrompt('text', { source_lang: source, target_lang: target });
    assert.ok(prompt.endsWith(`<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${target}<|plamo:msg|>`));
    assert.equal(prompt.includes(`<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>${source}`), source !== 'auto');
    assert.equal(prompt.includes('>auto'), false);
  }
  for (const value of ['', ' ', 'fr', 'EN', null, undefined, 42])
    for (const port of ['source_lang', 'target_lang']) assert.throws(() => plamoLanguages({ [port]: value }), new RegExp(port));
  assert.throws(() => plamoPrompt('<|plamo:tag|>output'), /reserved/);
});

test('one experimental AI type, optional TEXT ports, no Settings, stable serialization and shared asset requirement', () => {
  assert.deepEqual(Object.keys(NODE_TYPES).filter(type => /plamo/i.test(type)), ['Plamo3Translate2B']);
  const definition = NODE_TYPES.Plamo3Translate2B;
  assert.equal(definition.label, 'Translation · JA ↔ EN');
  assert.equal(definition.settings, undefined);
  for (const port of ['source_lang', 'target_lang']) {
    assert.equal(definition.inputs[port], TEXT); assert.ok(definition.optionalInputs.includes(port));
  }
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'),
    graphNode('Text', 'language'), graphNode('Plamo3Translate2B', 'translator'), graphNode('Display', 'out')],
    edges: [edge('text', 'value', 'translator', 'text'), edge('language', 'value', 'translator', 'target_lang'), edge('translator', 'text', 'out', 'input1')] };
  graph.nodes[0].settings.value = 'Hello'; graph.nodes[1].settings.value = 'ja';
  assert.deepEqual(validateGraph(graph), []);
  assert.deepEqual(readGraph({ getItem: key => key === 'processing-graph-library-v1' ? null : JSON.stringify(graph) }), graph);
  assert.deepEqual(graphModelRequirements(graph).map(r => r.id), ['plamo-3-translate-2b']);
  const files = JSON.parse(readFileSync('extension/plamo-assets.json'));
  const manifest = defineAssetSet({ ...PLAMO_3_TRANSLATE_2B, files });
  assert.equal(manifest.bytes, 1807203040); assert.equal(manifest.files.length, 1);
});

test('graph builder delivers ordinary Text.value language constants to the production scheduler', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Text', 'language'), graphNode('Plamo3Translate2B', 'translator'), graphNode('Display', 'out')],
    edges: [edge('text', 'value', 'translator', 'text'), edge('language', 'value', 'translator', 'target_lang'), edge('translator', 'text', 'out', 'input1')] };
  graph.nodes[0].settings.value = 'Hello'; graph.nodes[1].settings.value = 'ja';
  const requests = [];
  const built = buildGraph(graph, { preparePlamo() {}, translationWorkerFactory: () => ({ postMessage(data) {
    if (data.type === 'translate') requests.push(data);
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, type: data.type === 'load' ? 'ready' : data.type === 'drain' ? 'drained' : 'result', texts: ['日本語'] } }));
  }, terminate() {} }) });
  // This fixture needs no DOM: assert the Worker contract and ordinary routes.
  built.pipeline.entries.get('out').node.render = () => {};
  await built.pipeline.start(); await built.pipeline.stop();
  assert.equal(requests.length, 1); assert.equal(requests[0].text, 'Hello'); assert.equal(requests[0].target_lang, 'ja');
  await built.pipeline.dispose();
});

test('configuration-only updates never infer; text jobs snapshot immutable FIFO config during async load', async () => {
  let loaded;
  const f = await fixture({ prepare: () => new Promise(resolve => { loaded = resolve; }) });
  f.send('text', 'default'); f.send('source_lang', 'en'); f.send('target_lang', 'ja'); f.send('text', 'first');
  f.send('target_lang', 'en'); f.send('text', 'second'); f.send('source_lang', 'auto');
  await tick(); assert.equal(f.workers.length, 0);
  loaded(); await f.scheduler.ready; await tick();
  for (const [index, config] of [{ source_lang: 'auto', target_lang: 'en' }, { source_lang: 'en', target_lang: 'ja' }, { source_lang: 'en', target_lang: 'en' }].entries()) {
    assert.deepEqual(Object.fromEntries(['source_lang', 'target_lang'].map(port => [port, f.requests[index][port]])), config);
    f.complete(index); await tick();
  }
  await f.pipeline.stop(); assert.equal(f.requests.length, 3); assert.equal(f.outputs.length, 3);
  assert.deepEqual(f.outputs.map(o => o.source), ['default', 'first', 'second']);
  await f.pipeline.dispose(); assert.equal(f.workers[0].terminated, 1);
});

test('atomic grouped text + languages applies config first, omissions restore defaults and IDs stay paired', async () => {
  const f = await fixture();
  f.group({ text: 'one', target_lang: 'ja', source_lang: 'en', id: 10 });
  f.group({ text: 'two', target_lang: 'ja', id: 11 });
  f.group({ text: 'three' });
  await tick();
  for (const [index, source, target] of [[0, 'en', 'ja'], [1, 'auto', 'ja'], [2, 'auto', 'en']]) {
    assert.equal(f.requests[index].source_lang, source); assert.equal(f.requests[index].target_lang, target);
    f.complete(index); await tick();
  }
  await f.pipeline.stop(); assert.deepEqual(f.outputs.map(o => o.id), [10, 11, undefined]);
  await f.pipeline.dispose();
});

test('invalid codes route per-job source/error without inference; corrected config recovers', async () => {
  const f = await fixture();
  f.send('target_lang', 'fr'); await tick(); assert.equal(f.requests.length, 0);
  f.send('text', 'bad target'); await tick();
  assert.equal(f.outputs[0].source, 'bad target'); assert.match(f.outputs[0].error, /target_lang/); assert.equal(f.outputs[0].text, undefined);
  f.send('target_lang', 'ja'); f.send('source_lang', ''); f.send('text', 'blank source'); await tick();
  assert.match(f.outputs[1].error, /source_lang/); assert.equal(f.requests.length, 0);
  f.send('source_lang', 'auto'); f.send('text', 'recovered'); await tick(); f.complete(0);
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
