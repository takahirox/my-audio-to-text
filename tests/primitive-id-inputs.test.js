import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { document } from './fixtures/dom.js';
import { independentIDGraph } from './fixtures/keyed-dom-graph.js';
import { PairedTextToDOMNode, KeyedDOMAccumulatorNode } from '../web/dom-nodes.js';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { NODE_TYPES, graphNode, edge, validateGraph, executableGraph, graphWarnings, saveGraph, readGraph } from '../extension/graph.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const context = extra => ({ signal: new AbortController().signal, ...extra });
const cells = dom => [...dom.querySelectorAll('td')].map(cell => cell.textContent);
const contents = fragment => [...fragment.childNodes].map(node => node.textContent).join('');
const dom = text => { const node = document.createElement('div'); node.textContent = text; return node; };

for (const first of ['id', 'payload']) test(`paired ${first}-first: latest text, duplicates, empty updates and ID changes`, () => {
  const out = [], pair = new PairedTextToDOMNode(), c = context({ connectedInputs: ['id', 'input1', 'input2'], emitOutputs: value => out.push(value) });
  pair.start();
  if (first === 'id') pair.receive('id', -2.5, c);
  pair.receive('input2', 'right', c);
  if (first === 'payload') { assert.equal(out.length, 0); pair.receive('id', -2.5, c); }
  assert.deepEqual(cells(out.at(-1).dom), ['', 'right']); assert.equal(out.at(-1).id, -2.5);
  pair.receive('id', -2.5, c); assert.equal(out.length, 1, 'duplicate ID does not replay text');
  for (const text of ['left', 'left', '', '']) pair.receive('input1', text, c);
  assert.equal(out.length, 5); assert.deepEqual(cells(out.at(-1).dom), ['', 'right']);
  pair.receive('id', 1e30, c); assert.equal(out.length, 5);
  pair.receive('input1', 'new', c); assert.deepEqual(cells(out.at(-1).dom), ['new', '']);
  assert.equal(out.at(-1).id, 1e30);
  pair.receiveInputs({ input2: 'atomic', input1: 'both', id: 7 }, { ...c, groupInputs: ['id', 'input1', 'input2'] });
  assert.equal(out.length, 7); assert.deepEqual(cells(out.at(-1).dom), ['both', 'atomic']);
  pair.receiveInputs({ id: 7, input1: 'failure source' }, { ...c, groupInputs: ['id', 'input1', 'input2'] });
  assert.deepEqual(cells(out.at(-1).dom), ['failure source', '']);
  pair.receiveInputs({ input1: 'unidentified result' }, { ...c, groupInputs: ['id', 'input1', 'input2'] });
  assert.equal(out.length, 8, 'missing ID in an explicit snapshot cannot borrow ID 7');
  pair.start(); pair.receive('input1', 'fresh', c); assert.equal(out.length, 8);
  pair.receive('id', 8, c); assert.deepEqual(cells(out.at(-1).dom), ['fresh', '']);
});

for (const slot of [1, 2, 3]) for (const first of ['id', 'payload']) test(`history slot ${slot}, ${first}-first: buffering, no ID-only replay, numeric keys and precedence`, () => {
  const out = [], history = new KeyedDOMAccumulatorNode(), c = context({ emit: (_, value) => out.push(value) });
  const id = `id${slot}`, payload = `dom${slot}`;
  history.start(c);
  if (first === 'id') history.receive(id, -0.25, c);
  history.receive(payload, dom('initial'), c);
  if (first === 'payload') { assert.equal(out.length, 1); history.receive(id, -0.25, c); }
  assert.equal(contents(out.at(-1)), 'initial');
  history.receive(id, -0.25, c); history.receive(id, 1e30, c); assert.equal(out.length, 2);
  history.receive(payload, dom('next'), c); assert.equal(contents(out.at(-1)), 'initialnext');
  history.receive(payload, dom('next'), c); assert.equal(out.length, 4, 'duplicate DOM is an update');
  history.receive(payload, document.createDocumentFragment(), c); assert.equal(contents(out.at(-1)), 'initial');
  history.receiveInputs({ [payload]: dom('atomic'), [id]: 5 }, { ...c, groupInputs: [id, payload] });
  assert.equal(out.length, 6); assert.deepEqual([...history.rows.keys()], [-0.25, 1e30, 5]);
  history.receiveInputs({ dom3: dom('high'), id3: -0.25 }, c);
  history.receiveInputs({ id1: -0.25, dom1: dom('low') }, c);
  assert.equal(out.at(-1).firstChild.textContent, 'high');
  const count = out.length;
  history.receiveInputs({ [payload]: dom('unidentified') }, { ...c, groupInputs: [id, payload] });
  assert.equal(out.length, count, 'missing ID in an explicit snapshot cannot borrow the last ID');
});

function workers() {
  const requests = []; let worker;
  return {
    requests,
    factory() {
      worker = { postMessage(job) {
        if (job.type === 'translate') requests.push(job);
        else queueMicrotask(() => worker.onmessage?.({ data: { type: job.type === 'load' ? 'ready' : 'drained', id: job.id } }));
      }, terminate() {} }; return worker;
    },
    complete(index, error) { worker.onmessage({ data: { id: requests[index].id, type: error ? 'error' : 'result', message: error, texts: [`translated:${requests[index].text}`] } }); },
  };
}

for (const Node of [TranslationSchedulerNode, OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode]) {
  test(`${Node.name}: independent ID changes cannot relabel accepted/queued or unidentified translation jobs`, async () => {
    const f = workers(), out = [], node = new Node({ workerFactory: f.factory });
    const c = context({ connectedInputs: ['id', 'text'], emitOutputs: values => out.push(values), fail: assert.fail });
    await node.start(c); await node.ready;
    const jobs = [];
    // Deliver directly to allow ID changes while inference is held. The Pipeline
    // also serializes standalone async receives, but the job snapshot must not.
    jobs.push(node.receive('text', 'orphan', c)); await tick();
    node.receive('id', -1.5, c);
    jobs.push(node.receive('text', 'same', c));
    node.receive('id', 1e30, c);
    jobs.push(node.receive('text', 'same', c));
    jobs.push(node.receive('text', '', c));
    node.receive('id', 100, c); await tick();
    assert.equal(out.some(value => value.id === 100), false);
    f.complete(0); await tick(); f.complete(1); await tick(); f.complete(2); await tick();
    await Promise.all(jobs);
    const results = Object.fromEntries(out.filter(value => value.source !== 'same').map(value => [value.source, value]));
    assert.equal(Object.hasOwn(results.orphan, 'id'), false);
    assert.equal(results.orphan.text, 'translated:orphan');
    assert.equal(results[''].id, 1e30); assert.equal(results[''].text, '');
    assert.deepEqual(out.filter(value => value.source === 'same'), [
      { id: -1.5, source: 'same', text: 'translated:same', error: '' },
      { id: 1e30, source: 'same', text: 'translated:same', error: '' },
    ]);
    const explicit = node.receiveInputs({ text: 'snapshot', id: 42 }, { ...c, groupInputs: ['id', 'text'] });
    node.receive('id', 99, c); await tick(); f.complete(3); await explicit; await tick();
    assert.equal(out.at(-1).id, 42);
    const missing = node.receiveInputs({ text: 'no ID' }, { ...c, groupInputs: ['id', 'text'] });
    node.receive('id', 101, c); await tick(); f.complete(4); await missing; await tick();
    assert.equal(Object.hasOwn(out.at(-1), 'id'), false, 'omitted atomic metadata never borrows an old ID');
    const failed = node.receive('text', 'failure', c); node.receive('id', 202, c);
    await tick(); f.complete(5, 'controlled failure'); await failed; await tick();
    assert.deepEqual(out.at(-1), { id: 101, source: 'failure', error: 'controlled failure' });
    for (const id of [NaN, Infinity, -Infinity, '1', null, undefined]) assert.throws(() => node.receive('id', id, c), /finite number/);
    await node.stop(); await node.dispose();
  });
}

test('scheduler keeps independent preview and committed ID snapshots through final acceptance', async () => {
  const f = workers(), out = [], node = new TranslationSchedulerNode({ workerFactory: f.factory });
  const c = context({ emitOutputs: values => out.push(values) });
  node.start(c); await node.ready;
  node.receive('provisionalId', -0.5, c); node.receive('provisional', 'preview', c); await tick();
  node.receive('provisionalId', 99, c); node.receive('id', 7.5, c); node.receive('text', 'final', c);
  assert.deepEqual(out, [{ provisionalId: -0.5, provisionalSource: '', provisionalText: '', provisionalError: '' }]);
  f.complete(0); await tick(); f.complete(1); await tick();
  assert.equal(out.at(-1).id, 7.5); assert.equal(out.at(-1).text, 'translated:final');
  node.receiveInputs({ provisionalId: 8, provisional: 'obsolete', id: 9, text: '' }, { ...c, groupInputs: ['id', 'text', 'provisionalId', 'provisional'] });
  await tick(); assert.equal(out.at(-1).id, 9); assert.equal(out.at(-1).text, '');
  assert.equal(f.requests.length, 2); await node.stop(); await node.dispose();
});

for (const type of ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa']) {
  test(`${type}: saved Number → ID connections execute independently of payload producers`, async () => {
    const graph = independentIDGraph(type), values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    assert.deepEqual(validateGraph(graph), []); assert.deepEqual(graphWarnings(graph), []);
    saveGraph(storage, graph); assert.deepEqual(readGraph(storage), graph);
    assert.deepEqual(executableGraph(graph), graph);
    const out = [], f = workers(), built = buildGraph(graph, { workerFactory: f.factory, translationWorkerFactory: f.factory,
      prepareTranslation() {}, prepareTranslateGemma() {}, onDisplay: (_, value) => out.push(value) });
    await built.pipeline.start(); await built.translations[0].ready; await tick();
    assert.equal(built.pipeline.entries.get('history').node.rows.size, 1);
    f.complete(0); await tick(); assert.deepEqual(built.pipeline.errors, []);
    assert.deepEqual(cells(out.at(-1)), ['independent', 'translated:independent']);
    await built.pipeline.stop(); await built.pipeline.dispose();
    const wrong = structuredClone(graph); wrong.edges.push(edge('number', 'value', 'pair', 'input2'));
    assert.match(validateGraph(wrong).join(), /Incompatible port types/);
  });
}

test('all current same-contract ID routes are producer/family-independent', () => {
  for (const [sourceType, source] of Object.entries(NODE_TYPES)) for (const [output, contract] of Object.entries(source.outputs)) {
    for (const targetType of ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', 'PairedTextToDOM', 'KeyedDOMAccumulator']) {
      for (const [input, expected] of Object.entries(NODE_TYPES[targetType].inputs)) {
        if (contract !== expected) continue;
        const graph = independentIDGraph();
        graph.nodes.push(graphNode(sourceType, 'any-source'), graphNode(targetType, 'any-target'));
        graph.edges.push(edge('any-source', output, 'any-target', input));
        assert.deepEqual(validateGraph(graph), [], `${sourceType}.${output} → ${targetType}.${input}`);
      }
    }
  }
});

test('ID documentation and palette help describe independent arrival and optional atomic snapshots', () => {
  const doc = readFileSync(new URL('../docs/keyed-dom-history.md', import.meta.url), 'utf8');
  for (const rule of ['ID-first', 'payload-first', 'ID-only', 'finite', 'no ID', 'atomic', 'independent']) assert.ok(doc.includes(rule), rule);
  for (const type of ['PairedTextToDOM', 'KeyedDOMAccumulator', 'OpusMtEnJa']) assert.match(NODE_TYPES[type].help, /independent/i);
  assert.doesNotMatch(doc, /must.*grouped|nonnegative safe integer|require direct outputs/);
});

test('pending payloads retain only the latest values; each history slot owns its ID and numeric equality', () => {
  const pair = new PairedTextToDOMNode(), out = [], c = context({ connectedInputs: ['id'], emitOutputs: value => out.push(value) });
  pair.start();
  pair.receive('input1', 'discarded', c); pair.receive('input1', '', c); pair.receive('input2', 'latest', c);
  assert.deepEqual(out, []);
  pair.receive('id', 0, c); assert.deepEqual(cells(out[0].dom), ['', 'latest']);
  pair.receive('id', -0, c); assert.equal(out.length, 1);
  const history = new KeyedDOMAccumulatorNode(), snapshots = [], h = context({ emit: (_, value) => snapshots.push(value) });
  history.start(h); history.receive('dom1', dom('discarded'), h); history.receive('dom1', dom('latest'), h);
  history.receive('id2', 55, h); assert.equal(snapshots.length, 1, 'slot 1 cannot borrow slot 2 ID');
  history.receive('id1', 0, h); assert.equal(contents(snapshots.at(-1)), 'latest');
  history.receiveInputs({ id1: -0, dom1: dom('replacement') }, h); assert.equal(history.rows.size, 1);
  history.receive('id1', 55, h); assert.equal(history.rows.size, 1, 'ID changes do not move the existing DOM');
  history.receive('dom2', dom('other slot'), h); assert.equal(history.rows.size, 2);
  assert.deepEqual([...history.rows.keys()], [0, 55]);
});

test('an unavailable optional ID source does not park ready translation or paired TEXT paths', () => {
  const graph = independentIDGraph();
  graph.nodes.push(graphNode('OpusMtJaEn', 'parked'));
  for (const route of graph.edges) if (['pair.id', 'translation.id'].includes(route.to.join('.'))) route.from = ['parked', 'id'];
  assert.deepEqual(validateGraph(graph), []);
  const selected = executableGraph(graph);
  for (const id of ['pair', 'translation', 'history']) assert.ok(selected.nodes.some(node => node.id === id));
  assert.ok(!selected.nodes.some(node => node.id === 'parked'));
});
