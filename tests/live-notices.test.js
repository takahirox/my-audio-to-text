import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSession } from '../extension/session.js';
import { GRAPH_VERSION, graphNode, edge } from '../extension/graph.js';
import './fixtures/dom.js';

test('Live notices require explicit error metadata; message wording and unfamiliar Node event types cannot promote diagnostics', () => {
  const session = new TabSession(() => {});
  for (const type of ['waiting', 'ready', 'loading', 'generating', 'processing', 'completed', 'progress', 'future-event', undefined]) {
    session.nodeEvent({ type, message: 'Error unavailable failed: these words are ordinary diagnostic data.' }, 'future-node');
  }
  assert.equal(session.view.error, '');
  session.nodeEvent({ type: 'error', message: 'Opaque failure 42. Retry the operation.' }, 'future-node');
  session.nodeEvent({ severity: 'error', message: 'Opaque failure 42. Retry the operation.' }, 'future-node');
  assert.equal(session.view.error, 'future-node: Opaque failure 42. Retry the operation.');
  session.nodeEvent({ type: 'ready', message: 'Ready' }, 'peer');
  assert.equal(session.view.error.split('\n').length, 1);
  session.nodeEvent({ severity: 'error', message: 'Grant permission and retry.' }, 'peer');
  assert.equal(session.view.error.split('\n').length, 2, 'an unrelated branch cannot overwrite an existing error');
  session.fail('Pipeline failed. Start a new session.');
  assert.match(session.view.error, /Opaque failure 42/);
  assert.match(session.view.error, /Pipeline failed/);
});

test('a fatal translation backlog failure replaces an earlier validation notice and repeated reports stay deduplicated', async () => {
  const graph = { version: GRAPH_VERSION,
    nodes: [graphNode('Text', 'source'), graphNode('OpusMtJaEn', 'translator'), graphNode('Display', 'display')],
    edges: [edge('source', 'value', 'translator', 'text'), edge('translator', 'text', 'display', 'input1')] };
  const session = new TabSession(() => {}, { graph, prepareTranslation: async () => {},
    translationWorkerFactory: () => {
      const worker = { postMessage(data) {
        queueMicrotask(() => worker.onmessage?.({ data: { id: data.id, type: data.type === 'load' ? 'ready' : 'drained' } }));
      }, terminate() {} };
      return worker;
    } });
  try {
    await session.start();
    const pipeline = session.session.pipeline;
    const send = async text => {
      pipeline.entries.get('source').context.emit('value', text);
      await new Promise(resolve => setImmediate(resolve));
    };
    await send('x'.repeat(1001));
    assert.match(session.view.error, /translator: Translation unavailable: .*1,000 characters/);
    await send('x'.repeat(32769));
    assert.equal(pipeline.entries.get('translator').failed, true);
    assert.match(session.view.error, /^translator: Translation backlog limit exceeded/);
    assert.match(session.view.error, /Start a new session to retry/);
    assert.doesNotMatch(session.view.error, /1,000 characters/);
    const notice = session.view.error;
    pipeline.onError(pipeline.errors[0], 'translator');
    assert.equal(session.view.error, notice, 'the same Pipeline failure keeps one notice');
    await session.cancel();
    await session.start();
    assert.equal(session.view.error, '', 'fresh Start clears the previous session failure');
  } finally { await session.cancel(); }
});
