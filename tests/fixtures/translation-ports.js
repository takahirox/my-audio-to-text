import { expect } from '@playwright/test';

// Only inference is controlled. Real module Workers, runtime allocation,
// scheduling, Pipeline, graph persistence and TEXT display rendering execute.
export const translationPortWorker = `
  const pending = new Map();
  self.onmessage = ({data:m}) => {
    if (m.type === 'load') postMessage({id:m.id,type:'ready'});
    if (m.type === 'drain') postMessage({id:m.id,type:'drained'});
    if (m.type === 'translate') pending.set(m.id,m.text);
    if (m.type === 'fixture-complete') postMessage(m.error
      ? {id:m.id,type:'error',message:m.error}
      : {id:m.id,type:'result',texts:[m.text]});
  };`;

export async function checkTranslationPorts(page, type, base = './') {
  const runs = await page.evaluate(async ({ type, base }) => {
    const { buildGraph } = await import(new URL('graph-runtime.js', new URL(base, location.href)));
    const { graphNode, edge, GRAPH_VERSION, saveGraph, readGraph } = await import(new URL('graph.js', new URL(base, location.href)));
    const nodes = [graphNode('Text', 'final'), graphNode('Text', 'draft'), graphNode(type, 'translator'),
      graphNode('TextAccumulator', 'history'), graphNode('Display', 'committed'), graphNode('Display', 'preview')];
    nodes[0].settings.value = 'seed';
    const graph = { version: GRAPH_VERSION, nodes, edges: [
      edge('final', 'value', 'translator', 'text'), edge('draft', 'value', 'translator', 'provisional'),
      edge('translator', 'text', 'history', 'append'), edge('history', 'text', 'committed', 'input1'),
      edge('translator', 'provisionalText', 'preview', 'input1'),
    ] };
    saveGraph(localStorage, graph);
    const saved = localStorage.getItem('processing-graph-v1'), runs = [];
    const wait = async predicate => {
      const deadline = Date.now() + 5000;
      while (!predicate()) { if (Date.now() > deadline) throw Error('Translation port fixture timed out'); await new Promise(r => setTimeout(r, 5)); }
    };
    for (let run = 0; run < 2; run++) {
      const requests = [], workers = [], displays = {}, events = [];
      const factory = url => {
        const worker = new Worker(url, { type: 'module' }), post = worker.postMessage.bind(worker), terminate = worker.terminate.bind(worker);
        worker.postMessage = m => { if (m.type === 'translate') requests.push({ ...m, worker }); post(m); };
        worker.terminate = () => { worker.released = true; terminate(); }; workers.push(worker); return worker;
      };
      const built = buildGraph(readGraph(localStorage), { translationWorkerFactory: factory, prepareTranslation() {}, prepareTranslateGemma() {},
        onDisplay(id, dom) { displays[id] = dom.textContent; events.push({ id, text: dom.textContent }); } });
      const send = (id, text) => built.pipeline.entries.get(id).context.emit('value', text);
      const complete = (i, text) => { const r = requests[i]; r.worker.postMessage({ type: 'fixture-complete', id: r.id, text }); };
      try {
        await built.pipeline.start(); await wait(() => requests.length === 1);
        complete(0, 'seed translation'); await wait(() => displays.committed === 'seed translation');
        send('draft', 'preview source'); await wait(() => requests.length === 2);
        complete(1, 'preview translation'); await wait(() => displays.preview === 'preview translation');
        const previewState = { ...displays };
        send('draft', 'stale preview'); await wait(() => requests.length === 3);
        send('final', 'closed'); await wait(() => displays.preview === '');
        const clearBeforeCompletion = { ...displays };
        complete(2, 'late stale result'); await wait(() => requests.length === 4);
        complete(3, 'closed translation'); await wait(() => displays.committed === 'seed translation\nclosed translation');
        send('draft', 'ending preview'); await wait(() => requests.length === 5);
        complete(4, 'ending translation'); await wait(() => displays.preview === 'ending translation');
        await built.pipeline[run === 0 ? 'stop' : 'cancel'](); complete(4, 'late after ending');
        await built.pipeline.dispose();
        runs.push({ previewState, clearBeforeCompletion, displays, events, errors: built.pipeline.errors.map(e => e.message),
          workerCount: workers.length, released: workers.every(w => w.released), count: built.pipeline.entries.get('history').node.count,
          saved: localStorage.getItem('processing-graph-v1') === saved });
      } finally { await built.pipeline.dispose(); }
    }
    return runs;
  }, { type, base });
  for (const run of runs) {
    expect(run.previewState).toEqual({ committed: 'seed translation', preview: 'preview translation' });
    expect(run.clearBeforeCompletion).toEqual({ committed: 'seed translation', preview: '' });
    expect(run.displays).toEqual({ committed: 'seed translation\nclosed translation', preview: '' });
    expect(run.events.some(e => e.text.includes('late'))).toBe(false);
    expect(run.count).toBe(2); expect(run.workerCount).toBe(1); expect(run.released).toBe(true); expect(run.saved).toBe(true);
    expect(run.errors).toEqual([]);
  }
}

export async function checkTranslationPortRecovery(editor, type) {
  const raw = await editor.evaluate(async type => {
    const { defaultGraph, GRAPH_KEY } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph({ enabled: true }); graph.version = 13;
    graph.nodes.find(n => n.id === 'translation').type = type;
    const raw = JSON.stringify(graph, null, 2); localStorage.setItem(GRAPH_KEY, raw); return raw;
  }, type);
  await editor.reload(); await expect(editor.locator('#errors')).toContainText('Expected version 15');
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await editor.locator('.graph-actions > summary').click();
  editor.once('dialog', dialog => dialog.accept());
  await editor.locator('#graph-reset').click();
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await editor.reload(); await expect(editor.locator('#errors')).toBeEmpty();
}
