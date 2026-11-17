import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pipeline } from '../web/pipeline.js';
import { TEXT, NUMBER } from '../web/port-contracts.js';
import { Plamo3Translate2BTranslationNode } from '../web/translation-nodes.js';
import { plamoLanguages, plamoPrompt, plamoCompletion, validatePlamoContext, MAX_PLAMO_PROMPT_TOKENS, PLAMO_3_TRANSLATE_2B, PLAMO_LANGUAGE_CODES, DEFAULT_PLAMO_LANGUAGES } from '../web/plamo-policy.js';
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

test('PFML3 matches the pinned official Jinja template for auto switching and all 53 languages', () => {
  const oracle = JSON.parse(readFileSync('tests/fixtures/plamo-template.json'));
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  assert.equal(sha256(readFileSync('web/plamo-chat-template.jinja')), oracle.templateSha256);
  assert.deepEqual(PLAMO_LANGUAGE_CODES, oracle.languageCodes);
  assert.equal(new Set(PLAMO_LANGUAGE_CODES).size, 53);
  assert.deepEqual(plamoLanguages(), { source_lang: 'auto', target_lang: 'auto' });
  assert.deepEqual(plamoLanguages(), DEFAULT_PLAMO_LANGUAGES);
  assert.ok(Object.isFrozen(plamoLanguages()));
  for (const { text, languages, prompt } of oracle.cases) assert.equal(plamoPrompt(text, languages), prompt);
  const allPrompts = PLAMO_LANGUAGE_CODES.flatMap(code => [
    plamoPrompt('text', { source_lang: code, target_lang: 'ja' }),
    plamoPrompt('text', { target_lang: code }),
  ]);
  assert.equal(sha256(allPrompts.join('\n')), oracle.allLanguagePromptsSha256);
  for (const source of ['auto', ...PLAMO_LANGUAGE_CODES]) for (const target of PLAMO_LANGUAGE_CODES) {
    const prompt = plamoPrompt('text', { source_lang: source, target_lang: target });
    assert.ok(prompt.endsWith(`<|plamo:tag|>output<|plamo:key|>lang<|plamo:val|>${target}<|plamo:msg|>`));
    assert.equal(prompt.includes(`<|plamo:tag|>input<|plamo:key|>lang<|plamo:val|>${source}`), source !== 'auto');
    assert.equal(prompt.includes('>auto'), false);
  }
});

test('blank, malformed, unsupported codes and concrete source + default/auto target are configuration errors', () => {
  for (const value of ['', ' ', ' en', 'en ', 'EN', 'ZH-HANS', 'zh', 'zh-CN', 'zh-Hans', 'en-US', 'xx', 'ja/en', 'ja-easy', 'ja(easy)', null, undefined, 42])
    for (const port of ['source_lang', 'target_lang'])
      assert.throws(() => plamoLanguages({ target_lang: 'ja', [port]: value }), new RegExp(port));
  for (const source_lang of PLAMO_LANGUAGE_CODES) for (const target of [{}, { target_lang: 'auto' }])
    assert.throws(() => plamoLanguages({ source_lang, ...target }), /source_lang requires a concrete target_lang/);
  assert.throws(() => plamoPrompt('<|plamo:tag|>output'), /reserved/);
  assert.throws(() => plamoPrompt('x'.repeat(1001)), /1,000/);
});

test('one experimental AI type, optional TEXT ports, no Settings, stable serialization and shared asset requirement', () => {
  assert.deepEqual(Object.keys(NODE_TYPES).filter(type => /plamo/i.test(type)), ['Plamo3Translate2B']);
  const definition = NODE_TYPES.Plamo3Translate2B;
  assert.equal(definition.label, 'Translation');
  assert.equal(definition.settings, undefined);
  for (const port of ['context', 'source_lang', 'target_lang']) {
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

test('graph builder delivers ordinary Text.value context and language constants to the production scheduler', async () => {
  const graph = { version: GRAPH_VERSION, nodes: [graphNode('Text', 'text'), graphNode('Text', 'language'), graphNode('Text', 'reference'), graphNode('Plamo3Translate2B', 'translator'), graphNode('Display', 'out')],
    edges: [edge('text', 'value', 'translator', 'text'), edge('reference', 'value', 'translator', 'context'), edge('language', 'value', 'translator', 'target_lang'), edge('translator', 'text', 'out', 'input1')] };
  graph.nodes[0].settings.value = 'Hello'; graph.nodes[1].settings.value = 'ja'; graph.nodes[2].settings.value = '折り紙を作っています。';
  const requests = [];
  const built = buildGraph(graph, { preparePlamo() {}, translationWorkerFactory: () => ({ postMessage(data) {
    if (data.type === 'translate') requests.push(data);
    queueMicrotask(() => this.onmessage?.({ data: { id: data.id, type: data.type === 'load' ? 'ready' : data.type === 'drain' ? 'drained' : 'result', texts: ['日本語'] } }));
  }, terminate() {} }) });
  // This fixture needs no DOM: assert the Worker contract and ordinary routes.
  built.pipeline.entries.get('out').node.render = () => {};
  await built.pipeline.start(); await built.pipeline.stop();
  assert.equal(requests[0].context, '折り紙を作っています。'); assert.equal(requests.length, 1); assert.equal(requests[0].text, 'Hello'); assert.equal(requests[0].target_lang, 'ja');
  await built.pipeline.dispose();
});

test('configuration-only updates never infer; text jobs snapshot immutable FIFO config during async load', async () => {
  let loaded;
  const f = await fixture({ prepare: () => new Promise(resolve => { loaded = resolve; }) });
  f.send('text', 'default'); f.send('context', 'first reference'); f.send('source_lang', 'fr'); f.send('target_lang', 'ja'); f.send('text', 'first');
  f.send('context', 'second reference'); f.send('source_lang', 'ko'); f.send('target_lang', 'en'); f.send('text', 'second'); f.send('context', 'later'); f.send('source_lang', 'auto');
  await tick(); assert.equal(f.workers.length, 0);
  loaded(); await f.scheduler.ready; await tick();
  for (const [index, config] of [{ source_lang: 'auto', target_lang: 'auto' }, { source_lang: 'fr', target_lang: 'ja' }, { source_lang: 'ko', target_lang: 'en' }].entries()) {
    assert.deepEqual(Object.fromEntries(['source_lang', 'target_lang'].map(port => [port, f.requests[index][port]])), config);
    assert.equal(f.requests[index].context, [undefined, 'first reference', 'second reference'][index]);
    f.complete(index); await tick();
  }
  await f.pipeline.stop(); assert.equal(f.requests.length, 3); assert.equal(f.outputs.length, 3);
  assert.deepEqual(f.outputs.map(o => o.source), ['default', 'first', 'second']);
  await f.pipeline.dispose(); assert.equal(f.workers[0].terminated, 1);
});

test('atomic grouped text + languages applies config first, omissions restore defaults and IDs stay paired', async () => {
  const f = await fixture();
  f.group({ text: 'one', context: 'first', target_lang: 'ja', source_lang: 'en', id: 10 });
  f.group({ text: 'two', context: '', target_lang: 'ja', id: 11 });
  f.group({ text: 'three' });
  await tick();
  for (const [index, source, target] of [[0, 'en', 'ja'], [1, 'auto', 'ja'], [2, 'auto', 'auto']]) {
    assert.equal(f.requests[index].context, index === 0 ? 'first' : undefined);
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
  f.group({ text: 'concrete source without target', source_lang: 'fr', id: 12 }); await tick();
  assert.match(f.outputs[2].error, /source_lang requires a concrete target_lang/); assert.equal(f.outputs[2].id, 12);
  f.group({ provisional: 'concrete source with auto target', source_lang: 'ko', target_lang: 'auto', provisionalId: 13 }); await tick();
  assert.match(f.outputs[3].provisionalError, /source_lang requires a concrete target_lang/); assert.equal(f.outputs[3].provisionalId, 13);
  assert.equal(f.requests.length, 0);
  f.send('source_lang', 'auto'); f.send('text', 'recovered'); await tick(); f.complete(0);
  await f.pipeline.stop(); assert.equal(f.outputs.at(-1).text, 'translated'); assert.equal(f.outputs.at(-1).error, '');
  await f.pipeline.dispose();
});

test('provisional snapshots stay separate from generated tokens, final supersedes preview and Stop drains finals', async () => {
  const f = await fixture();
  f.group({ provisional: 'old preview', source_lang: 'zh-hans', target_lang: 'ja', context: 'preview context', provisionalId: 2 }); await tick();
  f.send('target_lang', 'en'); f.send('context', 'updated');
  assert.equal(f.requests[0].context, 'preview context');
  assert.equal(f.requests[0].target_lang, 'ja');
  assert.equal(f.requests[0].source_lang, 'zh-hans');
  f.group({ text: 'final', target_lang: 'ja', id: 3 });
  let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false); f.complete(0, 'obsolete'); await tick();
  assert.equal(f.requests[1].context, undefined); assert.equal(f.requests[1].target_lang, 'ja'); f.complete(1, 'committed'); await stopping;
  assert.equal(f.outputs.some(o => o.provisionalText === 'obsolete'), false);
  assert.equal(f.outputs.at(-1).text, 'committed'); assert.equal(f.outputs.at(-1).id, 3);
  await f.pipeline.dispose();
});

for (const phase of ['load', 'inference']) test(`Cancel during ${phase} owns Worker and ignores late output; fresh Node retries`, async () => {
  const f = await fixture({ holdLoad: phase === 'load' });
  f.send('context', 'cancel context'); f.send('text', 'cancel'); f.send('text', 'queued'); await tick();
  const callback = f.workers[0].onmessage;
  await f.pipeline.dispose(); callback({ data: { type: 'result', id: 2, texts: ['late'] } });
  assert.equal(f.workers[0].terminated, 1); assert.equal(f.scheduler.translationContext, ''); assert.deepEqual(f.outputs, []);
  const next = await fixture(); next.send('text', 'retry'); await tick(); assert.equal(next.requests[0].context, undefined); next.complete(0, 'fresh');
  await next.pipeline.stop(); assert.equal(next.outputs[0].text, 'fresh'); await next.pipeline.dispose();
});

test('native context preserves boundaries and characters, rejects controls, and omits only empty context', () => {
  const text = 'かみを切りました。', context = '折り紙を作っています。\n<xml> & "quotes"\t日本語';
  const section = '<|plamo:tag|>context<|plamo:msg|>' + context;
  const plain = plamoPrompt(text);
  const prompt = plamoPrompt(text, { context });
  assert.equal(prompt.replace(section, ''), plain);
  assert.equal(prompt.indexOf(section), '<|plamo:tag|>dataset<|plamo:msg|>translation'.length);
  assert.equal(plamoPrompt(text, { context: '' }), plain);
  assert.ok(plamoPrompt(text, { context: ' ' }).includes('>context<|plamo:msg|> '));
  for (const context of ['<|plamo:tag|>output', '<|plamo:key|>lang', '<|plamo:msg|>', '<|plamo:unknown', '<|endoftext|>'])
    assert.throws(() => plamoPrompt(text, { context }), /context.*reserved/);
  for (const context of [null, undefined, 1, {}]) assert.throws(() => validatePlamoContext(context), /context must be TEXT/);
  assert.throws(() => plamoPrompt(text, { context: 'x'.repeat(8001) }), /8,000/);
});

test('runtime preflight counts the full prompt including BOS and reserves output space without truncation', async () => {
  const calls = [];
  let tokens = MAX_PLAMO_PROMPT_TOKENS, finish = 'stop', output = ' translated ';
  const model = { async createCompletion(options) {
    calls.push(options);
    return { usage: { prompt_tokens: tokens }, choices: [{ text: options.max_tokens ? output : '', finish_reason: finish }] };
  } };
  assert.deepEqual(await plamoCompletion(model, 'source', { context: 'reference' }), ['translated']);
  assert.deepEqual(calls.map(c => c.max_tokens), [0, 256]);
  assert.equal(calls[0].prompt, plamoPrompt('source', { context: 'reference' }));
  assert.equal(calls[0].prompt, calls[1].prompt);
  assert.equal(calls.every(c => c.cache_prompt && c.stream === false && c.seed === 0 && c.temperature === 0), true);
  for (tokens of [1793, 2049, undefined, NaN, 0, -1, 1.5]) {
    calls.length = 0;
    await assert.rejects(plamoCompletion(model, 'source', { context: '😀'.repeat(500) }), /budget/);
    assert.equal(calls.length, 1, 'no generation after budget failure');
  }
  tokens = 100;
  finish = 'length'; await assert.rejects(plamoCompletion(model, 'source'), /256-token output limit/);
  finish = 'stop'; output = ' '; await assert.rejects(plamoCompletion(model, 'source'), /no translation/);
  calls.length = 0;
  await assert.rejects(plamoCompletion(model, 'source', { context: '<|plamo:tag|>' }), /reserved/);
  assert.equal(calls.length, 0);
});

test('context-only updates are silent; empty/omitted grouped context clears without changing previous jobs', async () => {
  const f = await fixture();
  f.send('text', 'unconnected'); await tick();
  f.send('context', ''); f.send('text', 'empty'); f.send('context', '参考\n<xml>&'); f.send('text', 'reference');
  f.send('context', 'cleared by group'); f.group({ text: 'omitted', id: 20 });
  f.send('context', 'later'); await tick();
  for (const [i, context] of [undefined, undefined, '参考\n<xml>&', undefined].entries()) {
    assert.equal(f.requests[i].context, context); f.complete(i); await tick();
  }
  await f.pipeline.stop();
  assert.equal(f.requests.length, 4); assert.equal(f.outputs.at(-1).id, 20);
  await f.pipeline.dispose();
});

test('invalid context snapshots route final/preview errors with IDs; corrections recover', async () => {
  const f = await fixture();
  f.send('context', '<|plamo:tag|>output'); await tick(); assert.equal(f.requests.length, 0);
  f.group({ text: 'invalid', id: 40, context: 'x'.repeat(8001) });
  f.group({ provisional: 'invalid preview', provisionalId: 41, context: '<|endoftext|>' }); await tick();
  assert.match(f.outputs.find(o => o.id === 40).error, /8,000/);
  assert.match(f.outputs.find(o => o.provisionalId === 41).provisionalError, /reserved/);
  assert.equal(f.requests.length, 0);
  f.group({ text: 'recover', id: 42, context: '' }); await tick(); f.complete(0); await f.pipeline.stop();
  assert.equal(f.outputs.at(-1).id, 42); assert.equal(f.outputs.at(-1).error, '');
  assert.equal(f.outputs.filter(o => o.text).length, 1);
  await f.pipeline.dispose();
});

test('pending preview replacement snapshots context and suppresses obsolete results', async () => {
  const f = await fixture();
  f.group({ provisional: 'running', context: 'old', provisionalId: 1 }); await tick();
  f.group({ provisional: 'replaced', context: 'middle', provisionalId: 2 });
  f.group({ provisional: 'latest', context: 'new', provisionalId: 3 }); await tick();
  f.complete(0, 'obsolete'); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].text, 'latest'); assert.equal(f.requests[1].context, 'new');
  f.complete(1, 'preview'); await tick();
  assert.equal(f.outputs.some(o => o.provisionalText === 'obsolete'), false);
  assert.equal(f.outputs.at(-1).provisionalText, 'preview'); assert.equal(f.outputs.at(-1).provisionalId, 3);
  await f.pipeline.stop(); assert.equal(f.outputs.at(-1).provisionalText, ''); await f.pipeline.dispose();
});

test('Worker request errors affect only their snapshot; later FIFO jobs recover on the same Worker', async () => {
  const f = await fixture();
  f.group({ text: 'over budget', context: 'long context', id: 1 });
  f.group({ text: 'next', context: '', id: 2 }); await tick();
  f.complete(0, undefined, 'PLaMo context and text exceed the 1,792-token prompt budget'); await tick();
  assert.equal(f.requests[1].text, 'next'); assert.equal(f.requests[1].context, undefined);
  f.complete(1, 'recovered'); await f.pipeline.stop();
  assert.match(f.outputs[0].error, /1,792-token/); assert.equal(f.outputs[0].id, 1); assert.equal(f.outputs[0].text, undefined);
  assert.equal(f.outputs[1].text, 'recovered'); assert.equal(f.outputs[1].id, 2);
  assert.equal(f.workers.length, 1); assert.equal(f.workers[0].terminated, 0);
  assert.deepEqual(f.pipeline.errors, []); await f.pipeline.dispose();
});
