import { test } from 'node:test';
import assert from 'node:assert/strict';
import { document, domText } from './fixtures/dom.js';
import { DisplayNode, displayInputs, MAX_DISPLAY_INPUTS } from '../web/display-node.js';
import { ITEM, TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST } from '../web/port-contracts.js';
import { graphNode, edge, defaultGraph, GRAPH_VERSION, GRAPH_KEY, validateGraph, assertGraph, executableGraph, readGraph, saveGraph, nodeDefinition } from '../extension/graph.js';
import { GraphEditor } from '../extension/graph-editor.js';
import { TabSession } from '../extension/session.js';
import { Pipeline } from '../web/pipeline.js';
import { renderTextRegions } from '../extension/live-text-regions.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
const graph = () => {
  const main = graphNode('Display', 'main'); main.settings = { inputCount: 2, title: 'Main' };
  const summary = graphNode('Display', 'summary'); summary.settings.title = 'Summary';
  return { version: GRAPH_VERSION, nodes: [graphNode('Text', 'a'), graphNode('Text', 'b'), main, summary], edges: [
    edge('a', 'value', 'main', 'input1'), edge('b', 'value', 'main', 'input2'), edge('a', 'value', 'summary', 'input1'),
  ] };
};
const storage = value => {
  const values = new Map(value ? [[GRAPH_KEY, value]] : []);
  return { getItem: key => values.get(key) ?? null, setItem: (key, next) => values.set(key, next) };
};

test('Display has bounded independent ITEM ports and strict editable title validation', () => {
  const g = graph(), main = g.nodes[2];
  assert.deepEqual(nodeDefinition(main).inputs, { input1: ITEM, input2: ITEM });
  assert.deepEqual(nodeDefinition(main).outputs, {});
  for (const inputCount of [0, -1, 1.5, '2', null, NaN, Infinity, MAX_DISPLAY_INPUTS + 1]) {
    main.settings.inputCount = inputCount; assert.ok(validateGraph(g).length); assert.throws(() => displayInputs(inputCount));
  }
  main.settings.inputCount = MAX_DISPLAY_INPUTS; assert.equal(Object.keys(nodeDefinition(main).inputs).length, MAX_DISPLAY_INPUTS);
  for (const title of [null, 1, 'a'.repeat(121)]) { main.settings.title = title; assert.match(validateGraph(g).join(), /main.title/); }
  main.settings.title = ' '; assert.deepEqual(validateGraph(g), []);
});

test('Display conversion preserves IDs, unrelated Hold.input, settings, source data and stored original; Save/export canonicalizes', () => {
  const g = graph(); g.nodes[2].settings = {}; g.nodes.push(graphNode('Hold', 'held'));
  g.edges = g.edges.filter(e => e.to[1] !== 'input2'); g.edges[0].to[1] = 'input';
  g.edges.push(edge('a', 'value', 'held', 'input')); g.nodes[0].settings.value = '<literal>';
  const raw = JSON.stringify(g), store = storage(raw), canonical = readGraph(store);
  assert.equal(JSON.stringify(g), raw); assert.equal(store.getItem(GRAPH_KEY), raw);
  assert.deepEqual(canonical.nodes[2], { ...g.nodes[2], settings: { inputCount: 1, title: '' } });
  assert.deepEqual(canonical.edges[0], edge('a', 'value', 'main', 'input1'));
  assert.deepEqual(canonical.edges.at(-1), edge('a', 'value', 'held', 'input'));
  assert.deepEqual(validateGraph(g), []); assert.deepEqual(assertGraph(canonical), canonical);
  assert.deepEqual(assertGraph(JSON.parse(JSON.stringify(canonical))), canonical);
  assert.deepEqual(saveGraph(store, canonical), canonical); assert.deepEqual(readGraph(store), canonical);
  assert.deepEqual(readGraph(storage()), defaultGraph());
  const collision = structuredClone(g); collision.edges.push(edge('b', 'value', 'main', 'input1'));
  assert.match(validateGraph(collision).join(), /Only one connection/);
  const invalid = structuredClone(g); invalid.edges.push(edge('a', 'value', 'held', 'input1'));
  assert.match(validateGraph(invalid).join(), /Unknown port/);
});

test('Add/Remove changes only the last Display input wire and its instance; disconnected tabs do not park ready paths', () => {
  const g = graph(), main = g.nodes[2], editor = Object.assign(Object.create(GraphEditor.prototype), { draft: g, draw() {} });
  const original = structuredClone(g.edges);
  const partial = structuredClone(g); partial.edges = [edge('b', 'value', 'main', 'input2')];
  assert.deepEqual(executableGraph(partial).nodes.map(n => n.id), ['b', 'main']);
  editor.resizeInputs(main, 1); assert.equal(main.settings.inputCount, 3);
  assert.deepEqual(g.edges, original); assert.deepEqual(executableGraph(g).nodes, g.nodes);
  editor.resizeInputs(main, -1); editor.resizeInputs(main, -1);
  assert.deepEqual(g.edges, original.filter(e => !(e.to[0] === 'main' && e.to[1] === 'input2')));
  assert.equal(g.nodes[3].settings.inputCount, 1);
  editor.resizeInputs(main, -1); assert.equal(main.settings.inputCount, 1);
  main.settings.inputCount = MAX_DISPLAY_INPUTS; editor.resizeInputs(main, 1); assert.equal(main.settings.inputCount, MAX_DISPLAY_INPUTS);
  const store = storage(); saveGraph(store, g); assert.deepEqual(readGraph(store), g);
  g.edges = []; assert.deepEqual(executableGraph(g).nodes, []);
});

for (const contract of [TEXT, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST]) test(`independent complete ITEM snapshots through grouped ${contract.name} delivery retain omitted panes`, async () => {
  let source; const states = {}, callbacks = [];
  const display = new DisplayNode((dom, port) => { states[port] = dom; callbacks.push(port); }, { inputCount: 2 });
  const p = new Pipeline({ nodes: {
    source: { outputs: { left: contract, right: contract }, outputGroups: [['left', 'right']], start(c) { source = c; } }, display,
  }, connections: [edge('source', 'left', 'display', 'input1'), edge('source', 'right', 'display', 'input2')] });
  const item = text => contract === TEXT ? text : contract === KEYED_PAIRED_TEXT ? { id: 1, first: text, second: '' } : [{ id: 1, first: text, second: '' }];
  await p.start(); source.emitOutputs({ left: item('<img>'), right: item('right') }); await tick();
  const left = states.input1; source.emitOutputs({ right: item('updated') }); await tick();
  assert.equal(states.input1, left); assert.equal(domText(left), '<img>'); assert.equal(domText(states.input2), 'updated');
  assert.equal(left.querySelector('img'), null); assert.equal(callbacks.at(-1), 'input2');
  assert.throws(() => display.receiveInputs({ input1: item('valid'), input2: {} }, p.entries.get('display').context));
  assert.equal(states.input1, left); await p.stop(); await p.dispose();
});

for (const ending of ['stop', 'cancel']) test(`session ${ending}/restart keeps per-port snapshots isolated and rejects stale deliveries`, async () => {
  const g = graph(); g.nodes[0].settings.value = 'left'; g.nodes[1].settings.value = 'right';
  const session = new TabSession(() => {}, { graph: g });
  await session.start(); await tick();
  const old = session.session.pipeline.entries.get('a').context;
  const left = session.view.displays.main.input1;
  session.session.pipeline.entries.get('b').context.emit('value', 'new right'); await tick();
  assert.equal(session.view.displays.main.input1, left); assert.equal(domText(session.view.displays.main.input2), 'new right');
  await session[ending](); const retained = session.view.displays;
  old.emit('value', 'late'); await tick(); assert.equal(session.view.displays, retained);
  await session.start(); await tick(); old.emit('value', 'old session'); await tick();
  assert.equal(domText(session.view.displays.main.input1), 'left'); assert.equal(domText(session.view.displays.main.input2), 'right');
  await session.cancel();
});

test('ports create tabs within one Display; duplicate/empty labels and separate Displays keep state independent', () => {
  const g = graph(), root = document.createElement('div'), main = g.nodes[2];
  main.settings.inputCount = 3; main.settings.inputLabels = { input1: 'Same', input2: 'Same', input3: ' ' };
  const dom = text => { const el = document.createElement('div'); el.textContent = text; return el; };
  const states = { main: { input1: dom('left'), input2: dom('right'), input3: dom('third') }, summary: { input1: dom('summary') } };
  renderTextRegions(root, g, states);
  const output = root.querySelector('[data-display="main"]'), other = root.querySelector('[data-display="summary"]');
  const tabs = output.querySelectorAll('[role="tab"]'), panes = output.querySelectorAll('[data-port]');
  assert.equal(tabs.length, 3); assert.deepEqual([...tabs].map(t => t.textContent), ['Same', 'Same', 'Input 3']);
  assert.equal(other.querySelector('[role="tablist"]'), null); assert.equal(other.hidden, false);
  assert.equal(other.querySelector('[data-port]').getAttribute('aria-label'), 'Input 1');
  for (const pane of root.querySelectorAll('[data-port]')) {
    assert.equal(pane.children.length, 1);
    assert.equal(pane.firstChild.className, 'display-content');
    assert.equal(pane.querySelector('h2, button, [role="status"], .section-heading'), null);
  }
  assert.deepEqual([...panes].map(p => p.hidden), [false, true, true]);
  assert.equal(panes[1].querySelector('.display-content').getAttribute('aria-live'), 'off');
  const existing = panes[0].querySelector('.display-content').firstChild; tabs[1].click();
  assert.deepEqual([...panes].map(p => p.hidden), [true, false, true]);
  states.main.input1 = dom('hidden update'); renderTextRegions(root, g, states);
  assert.equal(panes[1].querySelector('.display-content').textContent, 'right');
  tabs[0].click(); assert.equal(panes[0].querySelector('.display-content').textContent, 'hidden update');
  tabs[2].click(); main.settings.inputLabels.input3 = 'Changed'; renderTextRegions(root, g, states);
  assert.equal(panes[2].hidden, false); assert.equal(tabs[2].textContent, 'Changed');
  assert.equal(panes[2].getAttribute('aria-label'), 'Changed');
  assert.equal(panes[2].getAttribute('aria-labelledby'), tabs[2].id);
  assert.equal(tabs[2].getAttribute('aria-controls'), panes[2].id);
  states.main.input2 = null; states.main.input3 = document.createDocumentFragment();
  renderTextRegions(root, g, states);
  assert.equal(panes[1].querySelector('.display-content').children.length, 0);
  assert.equal(panes[2].querySelector('.display-content').textContent, '');
  assert.equal(other.querySelector('.display-content').getAttribute('aria-live'), 'polite');
  assert.notEqual(panes[0].querySelector('.display-content').firstChild, existing);
  // Removing the active last port selects the first remaining port without remounting it.
  main.settings.inputCount = 2; delete main.settings.inputLabels.input3; renderTextRegions(root, g, states);
  assert.equal(panes[0].hidden, false); assert.equal(panes[2].parentNode, null);
  main.settings.inputCount = 1; delete main.settings.inputLabels.input2; renderTextRegions(root, g, states);
  assert.equal(output.querySelector('[role="tablist"]'), null);
  assert.equal(output.querySelector('[data-port]'), panes[0]); assert.equal(panes[0].getAttribute('role'), 'group');
  assert.equal(panes[0].getAttribute('aria-labelledby'), null);
  main.settings.inputLabels.input1 = 'Solo'; renderTextRegions(root, g, states);
  assert.equal(panes[0].getAttribute('aria-label'), 'Solo');
  renderTextRegions(root, { nodes: [] }, {}); assert.equal(root.children.length, 0);
});

test('Display order follows graph order and input tabs preserve DOM identity across edits', () => {
  const g = graph(), root = document.createElement('div'); renderTextRegions(root, g, {});
  const main = root.querySelector('[data-display="main"]'), pane = main.querySelector('[data-port="input1"]');
  [g.nodes[2], g.nodes[3]] = [g.nodes[3], g.nodes[2]]; renderTextRegions(root, g, {});
  assert.deepEqual([...root.children].map(output => output.dataset.display), ['summary', 'main']);
  assert.deepEqual([...root.querySelectorAll('[role="tab"]')].map(tab => tab.dataset.tab), ['input1', 'input2']);
  assert.equal(root.querySelector('[data-display="main"]'), main);
  assert.equal(main.querySelector('[data-port="input1"]'), pane);
});

test('editable per-port labels validate, persist, and removing an input deletes only its label and wire', () => {
  const g = graph(), main = g.nodes[2], editor = Object.assign(Object.create(GraphEditor.prototype), { draft: g, draw() {} });
  for (const inputLabels of [null, [], 'bad', { input0: 'bad' }, { input3: 'bad' }, { input1: null }, { input1: 3 }, { input1: 'x'.repeat(121) }]) {
    main.settings.inputLabels = inputLabels; assert.match(validateGraph(g).join(), /inputLabels/);
  }
  main.settings.inputLabels = { input1: 'Same', input2: 'Same' };
  assert.deepEqual(validateGraph(g), []);
  const store = storage(); saveGraph(store, g); assert.deepEqual(readGraph(store), g);
  assert.deepEqual(assertGraph(JSON.parse(JSON.stringify(g))), g);
  const firstWire = structuredClone(g.edges[0]); editor.resizeInputs(main, -1);
  assert.deepEqual(main.settings.inputLabels, { input1: 'Same' }); assert.deepEqual(g.edges[0], firstWire);
  editor.resizeInputs(main, 1); assert.equal(main.settings.inputLabels.input2, undefined);
  main.settings.inputLabels.input2 = ''; assert.deepEqual(validateGraph(g), []);
});
