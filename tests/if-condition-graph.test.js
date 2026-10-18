import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphNode, edge, validateGraph, assertGraph, defaultGraph, readGraph, saveGraph, GRAPH_KEY, GRAPH_VERSION } from '../extension/graph.js';
import { buildGraph } from '../extension/graph-runtime.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { GraphEditor } from '../extension/graph-editor.js';

function graph() {
  const nodes = ['Text','IfCondition','LiveTextDisplay','LiveTextDisplay','LiveTextDisplay'].map((t,i) => graphNode(t,['source','condition','yes','no','peer'][i]));
  nodes[0].settings.value = '  Same?\n';
  return { version: 9, nodes, edges: [edge('source','value','condition','text'),edge('condition','yes','yes','append'),edge('condition','no','no','append'),edge('source','value','peer','append')] };
}
function factory({ fail = false } = {}) {
  const workers = [];
  return { workers, workerFactory: () => {
    const worker = { terminate() { this.released = true; }, postMessage(data) {
      this.messages ||= []; this.messages.push(data);
      queueMicrotask(() => this.onmessage?.({ data: { id: data.id, type: fail ? 'error' : ({ load:'ready', decide:'result', drain:'drained' }[data.type]),
        message: 'Assets missing. Save graph to retry preparation.', branch:'yes', confidence:.9 } }));
    } }; workers.push(worker); return worker;
  } };
}

test('v9 save/reload retains conditions, two output wires, fan-out and unrelated defaults; no version migration', () => {
  const g = graph(), saved = new Map(), storage = { getItem: k => saved.get(k) ?? null, setItem: (k,v) => saved.set(k,v), removeItem: k => saved.delete(k) };
  assert.equal(GRAPH_VERSION,9); assert.deepEqual(validateGraph(g),[]);
  saveGraph(storage,g); const raw = storage.getItem(GRAPH_KEY); assert.deepEqual(readGraph(storage),g); assert.equal(storage.getItem(GRAPH_KEY),raw);
  assert.deepEqual(assertGraph(defaultGraph()),defaultGraph());
  const editor = Object.assign(Object.create(GraphEditor.prototype), { draft: structuredClone(g), draw() {}, canvas:{querySelector(){}} });
  editor.selected = { id:'condition',port:'no',contract:TEXT };
  // Reconnect only one input; the Yes path and source fan-out survive.
  editor.connect('peer','append',TEXT);
  assert.deepEqual(editor.draft.edges.filter(e=>e.from[0]==='condition'), [edge('condition','yes','yes','append'),edge('condition','no','no','append'),edge('condition','no','peer','append')]);
  g.nodes[1].settings.condition=' '; assert.match(validateGraph(g).join(' '),/nonempty/);
  g.nodes[1].settings.condition='x'.repeat(513); assert.match(validateGraph(g).join(' '),/condition/);
});
import { TEXT } from '../web/port-contracts.js';

test('graph runtime loads only selected conditional instances and branch errors leave peer paths running', async () => {
  for (const fail of [false,true]) {
    const g=graph(), f=factory({fail}), displays={}, events=[];
    const built=buildGraph(g,{ifConditionWorkerFactory:f.workerFactory,onDisplay:(id,state)=>displays[id]=state,onIfConditionEvent:(event,id)=>events.push([id,event])});
    await built.pipeline.start(); await built.pipeline.stop();
    assert.deepEqual(displays.peer.items,['  Same?\n']);
    assert.deepEqual(displays.yes.items,fail?[]:['  Same?\n']); assert.deepEqual(displays.no.items,[]);
    if(fail) assert.ok(events.some(([id,e])=>id==='condition'&&e.type==='error'&&/missing/.test(e.message)));
    assert.ok(f.workers.every(w=>w.released)); assert.deepEqual(built.pipeline.errors,[]); await built.pipeline.dispose();
  }
});

test('saved parked and multiple IfConditions share only their preparation assets, never their settings', () => {
  const g=graph(); const second=graphNode('IfCondition','other');second.settings.condition='Does this mention a cat?';g.nodes.push(second);
  assert.deepEqual(graphModelRequirements(g).map(r=>r.key),['if-condition']);
  assert.equal(g.nodes[1].settings.condition,'Is this a question?');assert.equal(second.settings.condition,'Does this mention a cat?');
});
