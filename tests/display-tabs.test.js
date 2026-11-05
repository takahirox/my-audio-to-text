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

test('Add/Remove changes only the last Display input wire and its instance; disconnected columns do not park ready paths', () => {
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

test('tab identity follows node IDs and graph order, duplicate/empty titles stay separate, inactive live regions are quiet', () => {
  const g = graph(), root = document.createElement('div'); g.nodes[3].settings.title = 'Main';
  const dom = text => { const el = document.createElement('div'); el.textContent = text; return el; };
  const states = { main: { input1: dom('left'), input2: dom('right') }, summary: { input1: dom('summary') } };
  renderTextRegions(root, g, states);
  const tabs = root.querySelectorAll('[role="tab"]'), panes = root.querySelectorAll('.display-content');
  assert.equal(tabs.length, 2); assert.deepEqual([...tabs].map(t => t.textContent), ['Main', 'Main']);
  assert.equal(panes.length, 3); assert.equal(panes[2].getAttribute('aria-live'), 'off');
  const existing = panes[0].firstChild; tabs[1].click();
  assert.equal(root.querySelector('[data-display="main"]').hidden, true);
  assert.equal(root.querySelector('[data-display="summary"]').hidden, false);
  states.main.input2 = dom('hidden update'); renderTextRegions(root, g, states); tabs[0].click();
  assert.equal(panes[0].firstChild, existing); assert.equal(panes[1].textContent, 'hidden update');
  assert.equal(panes[0].getAttribute('aria-live'), 'polite');
  g.nodes.splice(3, 1); g.nodes[2].settings.title = ''; renderTextRegions(root, g, states);
  assert.equal(root.querySelector('[role="tablist"]'), null); assert.equal(root.firstChild.getAttribute('aria-label'), 'Display main');
  renderTextRegions(root, { nodes: [] }, {}); assert.equal(root.children.length, 0);
});


test('tab order follows graph order after a graph edit while preserving pane identity', () => {
  const g = graph(), root = document.createElement('div');
  renderTextRegions(root, g, {});
  const main = root.querySelector('[data-display="main"]');
  [g.nodes[2], g.nodes[3]] = [g.nodes[3], g.nodes[2]];
  renderTextRegions(root, g, {});
  assert.deepEqual([...root.querySelectorAll('[role="tab"]')].map(tab => tab.dataset.tab), ['summary', 'main']);
  assert.equal(root.querySelector('[data-display="main"]'), main);
});
