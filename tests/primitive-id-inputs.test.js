import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpusMtTranslationNode, EnglishToJapaneseOpusMtTranslationNode, TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
import { TranslationSchedulerNode } from '../extension/translation-scheduler.js';
import { NODE_TYPES, GRAPH_VERSION, graphNode, edge, validateGraph } from '../extension/graph.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const context = extra => ({ signal: new AbortController().signal,
  defer() { return { context: this, complete() {} }; }, ...extra });

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

test('current same-contract ID routes are producer/family-independent', () => {
  for (const [sourceType, source] of Object.entries(NODE_TYPES)) for (const [output, contract] of Object.entries(source.outputs)) {
    for (const targetType of ['OpusMtJaEn', 'OpusMtEnJa', 'TranslateGemmaJaEn', 'TranslateGemmaEnJa', 'KeyedTextPair', 'KeyedTextCoalesce']) {
      for (const [input, expected] of Object.entries(NODE_TYPES[targetType].inputs)) {
        if (contract !== expected) continue;
        const graph = { version: GRAPH_VERSION, nodes: [graphNode(sourceType, 'any-source'), graphNode(targetType, 'any-target')],
          edges: [edge('any-source', output, 'any-target', input)] };
        assert.deepEqual(validateGraph(graph), [], `${sourceType}.${output} → ${targetType}.${input}`);
      }
    }
  }
});
