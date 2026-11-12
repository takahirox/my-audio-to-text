import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphDraftSession, recoveryDrafts } from '../extension/graph-draft-session.js';
import { GraphEditor } from '../extension/graph-editor.js';
import { defaultGraph } from '../extension/graph.js';
const storage = () => { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i], getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
function setup(options = {}) {
  const writes = [], states = [], saved = [], local = storage();
  const session = new GraphDraftSession({ id: 'graph', base: 'r0', sessionId: 'session', graph: { value: 0 }, storage: local, delay: 100000,
    persist: async (graph, base) => { writes.push({ graph, base }); return { base: `r${writes.length}` }; },
    onState: (state, error) => states.push({ state, error }), onSaved: graph => saved.push(graph), ...options });
  return { session, local, writes, states, saved };
}
test('transactions checkpoint synchronously, serialize writes and drain only the newest draft without stale acknowledgement', async () => {
  let finish, active = 0, maximum = 0;
  const writes = [];
  const { session, local, saved } = setup({ persist: async (graph, base) => {
    writes.push({ graph, base }); maximum = Math.max(maximum, ++active);
    if (writes.length === 1) await new Promise(resolve => { finish = resolve; });
    active--; return { base: `r${writes.length}` };
  } });
  session.changed({ value: 1 });
  assert.equal(recoveryDrafts(local, 'graph')[0].base, 'r0');
  const saving = session.flush();
  session.changed({ value: 2 }); session.changed({ value: 3 });
  const otherFlush = session.flush(); finish(); await Promise.all([saving, otherFlush]);
  assert.equal(maximum, 1); assert.deepEqual(writes, [{ graph: { value: 1 }, base: 'r0' }, { graph: { value: 3 }, base: 'r1' }]);
  assert.deepEqual(saved, [{ value: 1 }, { value: 3 }]); assert.equal(local.length, 0); assert.equal(session.status, 'Saved');
  session.changed({ value: 3 }); await session.flush(); assert.equal(writes.length, 2); session.close();
});
test('invalid drafts, failed writes and quota failures preserve the last good version and expose recovery failure', async () => {
  const { session, local, writes } = setup({ validate: graph => { if (graph.value === null) throw Error('finite number required'); return graph; } });
  session.changed({ value: null }); await assert.rejects(session.flush(), /finite number/);
  assert.equal(writes.length, 0); assert.equal(session.status, 'Save failed'); assert.equal(recoveryDrafts(local, 'graph')[0].graph.value, null);
  const reopened = recoveryDrafts(local, 'graph'); session.close(); assert.equal(reopened[0].sessionId, 'session');
  const denied = setup({ storage: { setItem() { throw Error('quota'); }, removeItem() {} }, persist: async () => { throw Error('storage denied'); } });
  denied.session.changed({ value: 1 }); assert.equal(denied.session.recoverable, false); assert.match(denied.session.error, /checkpoint failed/);
  await assert.rejects(denied.session.flush(), /storage denied/); assert.equal(denied.session.status, 'Save failed'); denied.session.close();
});
test('checkpoint base advances only after confirmed persistence, including newer edits during a write', async () => {
  let finish;
  const { session, local } = setup({ persist: () => new Promise(resolve => { finish = resolve; }) });
  session.changed({ value: 1 }); const pending = session.flush(); session.changed({ value: 2 });
  finish({ base: 'r1' });
  // Stop the second save at its await and inspect the synchronous checkpoint.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recoveryDrafts(local, 'graph')[0].base, 'r1');
  assert.equal(recoveryDrafts(local, 'graph')[0].graph.value, 2);
  finish({ base: 'r2' }); await pending; session.close();
});
function historyEditor() {
  const editor = Object.create(GraphEditor.prototype), changes = [];
  Object.assign(editor, { draft: defaultGraph(), undoStack: [], redoStack: [], readOnly: false,
    markPending() {}, updateSummary() {}, updateHistory() {}, draw() {}, diagnostics() { return ''; }, errors: {}, onDraft: graph => changes.push(structuredClone(graph)) });
  editor.saved = structuredClone(editor.draft); return { editor, changes };
}
test('continuous edits group into one step, no-ops disappear, Undo/Redo publish for persistence and new edits clear redo', () => {
  const { editor: e, changes } = historyEditor(), node = e.draft.nodes[0], before = structuredClone(e.draft);
  for (let i = 0; i < 1000; i++) e.edit(() => { node.position.x++; }, 'drag');
  assert.equal(changes.length, 0); e.commitEdit(); assert.equal(changes.length, 1); assert.equal(e.undoStack.length, 1);
  const after = structuredClone(e.draft); e.undo(); assert.deepEqual(e.draft, before); e.redo(); assert.deepEqual(e.draft, after);
  e.edit(() => {}); assert.equal(e.undoStack.length, 1);
  e.undo(); e.edit(() => { e.draft.nodes[0].position.y++; }); assert.equal(e.redoStack.length, 0);
  for (let i = 0; i < 105; i++) e.edit(() => { e.draft.nodes[0].position.x++; });
  assert.equal(e.undoStack.length, 100); e.readOnly = true; const current = structuredClone(e.draft);
  e.edit(() => { e.draft.nodes = []; }); e.undo(); assert.deepEqual(e.draft, current);
});
test('node deletion and affected wires are atomic; Undo of extraction retains the shared library entry', () => {
  const { editor: e } = historyEditor(), before = structuredClone(e.draft);
  e.edit(() => e.removeNode(e.draft.nodes[1])); e.undo(); assert.deepEqual(e.draft, before);
  e.definitions = [{ id: 'shared', kind: 'subgraph' }];
  e.edit(() => { e.draft.nodes = [{ id: 'replacement', type: 'Subgraph', subgraphId: 'shared' }]; e.draft.edges = []; });
  e.undo(); assert.deepEqual(e.draft, before); assert.equal(e.definitions.length, 1);
});

test('Undo to the old saved content while a write is in flight stays pending and checkpoints the reversion', async () => {
  let finish; const writes = [];
  const { session, local } = setup({ persist: async graph => { writes.push(graph); if (writes.length === 1) await new Promise(resolve => { finish = resolve; }); return { base: `r${writes.length}` }; } });
  session.changed({ value: 1 }); const saving = session.flush(); session.changed({ value: 0 });
  assert.equal(session.status, 'Saving…'); assert.deepEqual(recoveryDrafts(local, 'graph')[0].graph, { value: 0 });
  finish(); await saving; assert.deepEqual(writes, [{ value: 1 }, { value: 0 }]); assert.equal(session.status, 'Saved'); session.close();
});
test('a conflict cannot be cleared by Undo returning to the earlier saved content', async () => {
  const { session, local, writes } = setup(); session.changed({ value: 1 });
  session.blocked = 'External revision: reload latest'; session.changed({ value: 0 });
  await assert.rejects(session.flush(), /External revision/);
  assert.equal(session.status, 'Save failed'); assert.equal(writes.length, 0);
  assert.deepEqual(recoveryDrafts(local, 'graph')[0].graph, { value: 0 }); session.close();
});

test('a remote revision arriving before a save acknowledgement preserves conflict status and its recovery record', async () => {
  let finish;
  const { session, local, saved } = setup({ persist: () => new Promise(resolve => { finish = resolve; }) });
  session.changed({ value: 1 }); const pending = session.flush();
  session.blocked = 'A newer remote revision exists'; finish({ base: 'own-write' }); await pending;
  assert.equal(session.status, 'Save failed'); assert.equal(saved.length, 0);
  assert.deepEqual(recoveryDrafts(local, 'graph')[0].graph, { value: 1 }); session.close();
});
