import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphDetailsAutosave, DETAILS_DRAFT_KEY } from '../extension/graph-library-details.js';
import { GraphLibrary, openLibrary, readLibrary } from '../extension/graph-library.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Field extends EventTarget {
  value = '';
  input(value, composing = false) { this.value = value; this.dispatchEvent(Object.assign(new Event('input'), { isComposing: composing })); }
  composition(type) { this.dispatchEvent(new Event(`composition${type}`)); }
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem(key, value) { values.set(key, value); }, removeItem: key => values.delete(key) };
}
async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const data = storage(), drafts = storage();
  let queue = Promise.resolve();
  const locks = { request(key, work) { const next = queue.then(work); queue = next.catch(() => {}); return next; } };
  const store = new GraphLibrary(data, locks), opened = await openLibrary(data, locks);
  const calls = [], renamed = store.rename.bind(store);
  store.rename = (...args) => { calls.push(args); return renamed(...args); };
  const name = new Field(), description = new Field(), status = { classList: { toggle() {} } }, retry = {};
  const saved = [], editor = new GraphDetailsAutosave({ store, storage: drafts, name, description, status, retry, onSaved: next => saved.push(next) });
  editor.load(opened.library.graphs[0]);
  return { editor, store, data, drafts, calls, name, description, status, retry, saved, current: () => readLibrary(data).graphs[0] };
}

test('details debounce both fields, use one rename and retire success feedback', async t => {
  const f = await fixture(t), original = f.current();
  f.name.input('  会議のメモ  '); t.mock.timers.tick(200); f.description.input('日本語の説明');
  t.mock.timers.tick(399); assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1); await tick();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], [original.id, '  会議のメモ  ', '日本語の説明', original.revision]);
  assert.equal(f.current().name, '会議のメモ'); assert.equal(f.name.value, '会議のメモ');
  assert.equal(f.current().description, '日本語の説明'); assert.deepEqual(f.current().graph, original.graph);
  assert.equal(f.drafts.getItem(DETAILS_DRAFT_KEY), null); assert.equal(f.status.textContent, 'Saved');
  t.mock.timers.tick(1800); assert.equal(f.status.textContent, '');
});

test('IME cancels earlier timers and blocks flush until composition ends with valid input', async t => {
  const f = await fixture(t);
  f.description.input('Before composing'); f.name.composition('start'); f.name.input('にほ', true);
  t.mock.timers.tick(1000); assert.equal(await f.editor.flush(), false); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).name, 'にほ');
  f.name.value = '日本語'; f.name.composition('end'); t.mock.timers.tick(399); assert.equal(f.calls.length, 0);
  t.mock.timers.tick(1); await tick(); assert.equal(f.current().name, '日本語');
  f.name.composition('start'); f.name.input('', true); f.name.composition('end');
  t.mock.timers.tick(5000); assert.equal(f.calls.length, 1); assert.match(f.status.textContent, /Enter a graph name/);
});

test('invalid intermediate values stay in a recoverable draft without write attempts', async t => {
  const f = await fixture(t), original = f.current();
  for (const [field, value, message] of [[f.name, '   ', /Enter a graph name/], [f.name, 'a'.repeat(161), /160/], [f.description, 'a'.repeat(2001), /2000/]]) {
    f.name.value = original.name; f.description.value = '';
    field.input(value); t.mock.timers.tick(5000);
    assert.equal(await f.editor.flush(), false); assert.match(f.status.textContent, message);
    assert.equal(f.calls.length, 0); assert.equal(f.current().revision, original.revision);
  }
  f.description.input('Valid'); await f.editor.flush(); assert.equal(f.calls.length, 1);
});

test('pending writes keep controls editable, coalesce newer fields and capture the next revision', async t => {
  const f = await fixture(t), first = f.current(), gate = deferred(), rename = f.store.rename;
  f.store.rename = async (...args) => { await gate.promise; return rename(...args); };
  f.name.input('First'); const pending = f.editor.flush();
  f.name.input('Latest'); f.description.input('Description'); t.mock.timers.tick(1000);
  assert.equal(f.editor.editing, true); assert.equal(f.calls.length, 0);
  gate.resolve(); assert.equal(await pending, true);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0][3], first.revision);
  assert.notEqual(f.calls[1][3], first.revision); assert.equal(f.calls[1][1], 'Latest');
  assert.equal(f.current().name, 'Latest'); assert.equal(f.current().description, 'Description');
  assert.equal(f.drafts.getItem(DETAILS_DRAFT_KEY), null);
});

test('reverting input during a write still preserves it until the compensating write completes', async t => {
  const f = await fixture(t), first = f.current(), gate = deferred(), rename = f.store.rename;
  f.store.rename = async (...args) => { await gate.promise; return rename(...args); };
  f.name.input('Temporary'); const pending = f.editor.flush(); f.name.input(first.name);
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).name, first.name);
  gate.resolve(); await pending; assert.equal(f.current().name, first.name); assert.equal(f.calls.length, 2);
});

test('composition begun during a pending save is never written by that save loop', async t => {
  const f = await fixture(t), gate = deferred(), rename = f.store.rename;
  f.store.rename = async (...args) => { await gate.promise; return rename(...args); };
  f.name.input('Committed before IME'); const pending = f.editor.flush();
  f.name.composition('start'); f.name.input('未確', true); gate.resolve();
  assert.equal(await pending, false); assert.equal(f.current().name, 'Committed before IME');
  assert.equal(f.name.value, '未確'); assert.equal(f.calls.length, 1);
  f.name.value = '未確定から確定'; f.name.composition('end'); t.mock.timers.tick(400); await tick();
  assert.equal(f.current().name, '未確定から確定'); assert.equal(f.calls.length, 2);
});

test('conflicts preserve graph edits and drafts; retries retain the original revision', async t => {
  const f = await fixture(t), original = f.current();
  f.name.input('My draft');
  const graph = structuredClone(original.graph); graph.nodes[0].position.x += 77;
  await f.store.save(original.id, original.revision, graph);
  assert.equal(await f.editor.flush(), false); const remote = f.current();
  assert.match(f.status.textContent, /Load saved/); assert.equal(f.retry.hidden, false);
  f.description.input('More local text'); t.mock.timers.tick(5000); assert.equal(f.calls.length, 1);
  f.retry.onclick(); await tick(); assert.equal(f.calls.length, 2); assert.equal(f.calls[1][3], original.revision);
  assert.deepEqual(f.current(), remote);
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).description, 'More local text');
});

test('failed writes stop retrying until requested and recovered drafts never commit automatically', async t => {
  const f = await fixture(t), rename = f.store.rename;
  f.store.rename = () => Promise.reject(Error('Quota exceeded'));
  f.name.input('Recover me'); assert.equal(await f.editor.flush(), false);
  assert.match(f.status.textContent, /Quota exceeded.*Retry/); t.mock.timers.tick(5000);
  const draft = JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY));
  f.editor.load(f.current()); f.editor.restore(draft);
  assert.match(f.status.textContent, /Recovered/); assert.equal(await f.editor.flush(), false);
  f.store.rename = rename; f.description.input('Reviewed'); assert.equal(await f.editor.flush(), true);
  assert.equal(f.current().name, 'Recover me');
});

test('description IME and invalid input introduced during a pending save remain unsaved', async t => {
  const f = await fixture(t), gate = deferred(), rename = f.store.rename;
  f.store.rename = async (...args) => { await gate.promise; return rename(...args); };
  f.name.input('Valid first'); const pending = f.editor.flush();
  f.description.composition('start'); f.description.input('説明のとちゅ', true);
  gate.resolve(); assert.equal(await pending, false); assert.equal(f.current().description, '');
  f.name.input(''); f.description.value = '説明'; f.description.composition('end');
  t.mock.timers.tick(5000); assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).description, '説明');
  f.name.input('Complete'); t.mock.timers.tick(400); await tick();
  assert.equal(f.current().description, '説明'); assert.equal(f.current().name, 'Complete');
});

test('conflict state and original revision survive reverting to the old saved values', async t => {
  const f = await fixture(t), original = f.current();
  f.name.input('Local edit'); await f.store.rename(original.id, 'Remote edit', '', original.revision);
  await f.editor.flush(); f.name.input(original.name);
  assert.equal(f.editor.dirty, false); assert.equal(f.editor.editing, true);
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).entry.revision, original.revision);
  assert.equal(await f.editor.flush(), false); assert.equal(f.current().name, 'Remote edit');
  f.retry.onclick(); await tick();
  assert.equal(f.editor.editing, true); assert.match(f.status.textContent, /Load saved/);
  assert.equal(f.current().name, 'Remote edit'); assert.equal(f.calls.at(-1)[3], original.revision);
});

test('autosave still commits when draft storage is unavailable and warns during a delayed write', async t => {
  const f = await fixture(t), gate = deferred(), rename = f.store.rename;
  f.editor.storage = { setItem() { throw Error('Draft quota'); }, removeItem() {} };
  f.store.rename = async (...args) => { await gate.promise; return rename(...args); };
  f.name.input('Save despite draft quota'); assert.match(f.status.textContent, /Draft recovery unavailable/);
  const pending = f.editor.flush(); assert.match(f.status.textContent, /Keep this page open/);
  gate.resolve(); assert.equal(await pending, true); assert.equal(f.current().name, 'Save despite draft quota');
});

test('a concurrent update noticed after rename commits cannot be hidden by Saved feedback', async t => {
  const f = await fixture(t), gate = deferred(), rename = f.store.rename;
  f.store.rename = async (...args) => {
    const next = await rename(...args); await gate.promise; return next;
  };
  f.name.input('Local commit'); const pending = f.editor.flush(); await tick();
  const committed = f.current(); await rename(committed.id, 'Newer remote commit', '', committed.revision);
  f.editor.conflict(); gate.resolve();
  assert.equal(await pending, false); assert.match(f.status.textContent, /changed in another page/);
  assert.equal(f.retry.hidden, false); assert.equal(f.current().name, 'Newer remote commit');
  assert.equal(f.editor.editing, true); assert.equal(f.name.value, 'Local commit');
  assert.equal(JSON.parse(f.drafts.getItem(DETAILS_DRAFT_KEY)).name, 'Local commit');
});
