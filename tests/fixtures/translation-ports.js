import { expect } from '@playwright/test';

// Only inference is controlled. Real module Workers, runtime allocation,
// scheduling, Pipeline, graph persistence and generic DOM composition execute.
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
      graphNode('TextAccumulator', 'history'), graphNode('TextToDOM', 'history-dom'), graphNode('LiveTextDisplay', 'committed'),
      graphNode('TextToDOM', 'preview-dom'), graphNode('LiveTextDisplay', 'preview'),
      graphNode('PairedTextToDOM', 'pair'), graphNode('LiveTextDisplay', 'comparison')];
    nodes[0].settings.value = 'seed';
    const graph = { version: GRAPH_VERSION, nodes, edges: [
      edge('final', 'value', 'translator', 'text'), edge('draft', 'value', 'translator', 'provisional'),
      edge('translator', 'text', 'history', 'append'), edge('history', 'text', 'history-dom', 'text'), edge('history-dom', 'dom', 'committed', 'dom'),
      edge('translator', 'provisionalText', 'preview-dom', 'text'), edge('preview-dom', 'dom', 'preview', 'dom'),
      edge('translator', 'source', 'pair', 'input1'), edge('translator', 'text', 'pair', 'input2'), edge('pair', 'dom', 'comparison', 'dom'),
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
        onDisplay(id, dom) { const snapshot = dom.cloneNode(true); for (const style of snapshot.querySelectorAll('style')) style.remove(); displays[id] = snapshot.textContent; events.push({ id, text: snapshot.textContent }); } });
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
        send('draft', 'cancel preview'); await wait(() => requests.length === 5);
        complete(4, 'cancel translation'); await wait(() => displays.preview === 'cancel translation');
        await built.pipeline.cancel(); complete(4, 'late after cancel');
        runs.push({ previewState, clearBeforeCompletion, displays, events, errors: built.pipeline.errors.map(e => e.message),
          workerCount: workers.length, released: workers.every(w => w.released), count: built.pipeline.entries.get('history').node.count,
          saved: localStorage.getItem('processing-graph-v1') === saved });
      } finally { await built.pipeline.dispose(); }
    }
    return runs;
  }, { type, base });
  for (const run of runs) {
    expect(run.previewState).toEqual({ committed: 'seed translation', preview: 'preview translation', comparison: 'seedseed translation' });
    expect(run.clearBeforeCompletion.preview).toBe(''); expect(run.clearBeforeCompletion.committed).toBe('seed translation');
    expect(run.displays).toEqual({ committed: 'seed translation\nclosed translation', preview: '', comparison: 'closedclosed translation' });
    expect(run.events.some(e => e.text.includes('late'))).toBe(false);
    expect(run.count).toBe(2); expect(run.workerCount).toBe(1); expect(run.released).toBe(true); expect(run.saved).toBe(true);
    expect(run.errors).toEqual([]);
  }
}

export async function checkTranslationPortRecovery(editor, type) {
  const raw = await editor.evaluate(async type => {
    const { defaultGraph, graphNode, edge, GRAPH_KEY, GRAPH_RECOVERY_KEY } = await import(new URL('./graph.js', location.href));
    const graph = defaultGraph({ enabled: true }); graph.version = 12;
    graph.nodes.find(n => n.id === 'translation').type = type;
    graph.nodes.push(graphNode('TextToDOM', 'preview-dom'), graphNode('LiveTextDisplay', 'preview'));
    graph.edges.push(edge('speech', 'provisional', 'translation', 'provisional'),
      edge('translation', 'text', 'preview-dom', 'text'), edge('preview-dom', 'dom', 'preview', 'dom'));
    const raw = JSON.stringify(graph, null, 2).replaceAll('\n', '\r\n');
    localStorage.setItem(GRAPH_KEY, raw); localStorage.setItem(GRAPH_RECOVERY_KEY, 'older recovery');
    localStorage.setItem('processing-graph-before-v12', 'previous version'); return raw;
  }, type);
  await editor.reload();
  await expect(editor.locator('#errors')).toContainText('Translation output graph v13 requires review');
  await expect(editor.locator('#errors')).toContainText('provisionalText');
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(raw);
  await editor.locator('.graph-actions > summary').click();
  await editor.locator('.graph-recovery > summary').click();
  await editor.getByLabel('Graph recovery version').selectOption({ label: 'Unsaved original' });
  await editor.evaluate(() => { navigator.clipboard.writeText = async text => { window.copiedRecovery = text; }; });
  await editor.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  expect(await editor.evaluate(() => window.copiedRecovery)).toBe(raw);
  const [download] = await Promise.all([editor.waitForEvent('download'), editor.getByRole('button', { name: 'Download JSON', exact: true }).click()]);
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(raw);
  await editor.locator('.graph-actions > summary').click();
  // Deliberately replace the old mixed-text route with the explicit preview
  // route. The other committed routes must remain unchanged in the saved graph.
  await editor.getByRole('button', { name: 'translation output provisionalText', exact: true }).press('Enter');
  await editor.getByRole('button', { name: 'preview-dom input text', exact: true }).press('Enter');
  await editor.locator('#graph-save').click(); await expect(editor.locator('#graph-save')).toBeEnabled();
  await expect(editor.locator('#errors')).toBeEmpty();
  const saved = await editor.evaluate(() => localStorage.getItem('processing-graph-v1'));
  const graph = JSON.parse(saved), expected = JSON.parse(raw); expected.version = 13;
  const replacement = expected.edges.find(e => e.to[0] === 'preview-dom');
  expected.edges = expected.edges.filter(e => e !== replacement); replacement.from[1] = 'provisionalText'; expected.edges.push(replacement);
  expect(graph).toEqual(expected);
  await editor.reload(); await expect(editor.locator('#errors')).toBeEmpty();
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-v1'))).toBe(saved);
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-before-v13-2'))).toBe(raw);
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-before-v13'))).toBe('older recovery');
  expect(await editor.evaluate(() => localStorage.getItem('processing-graph-before-v12'))).toBe('previous version');
}
