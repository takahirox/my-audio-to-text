import { test, expect, openGraph } from './graph-fixture.js';
import { loadRoutingGraph, assertRoutingGeometry, detourPoint, checkRoutingMovement } from '../fixtures/graph-routing.js';
import { clickGraphAction } from './ui-controls.js';

test('packaged MV3 routes track dragging, resized cards, zoom, scroll and Fit', async ({ graphExtension: f }) => {
  const live = await openGraph(f); await checkRoutingMovement(live.editor);
});

test('native touch selects a detour and Disconnect persists only the intended removal', async ({ graphExtension: f }) => {
  const live = await openGraph(f), page = live.editor;
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page);
  const before = await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  const p = await detourPoint(page), session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(page.locator('.selected-wire')).toHaveCount(1);
  const control = await page.locator('#graph-disconnect').boundingBox();
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: control.x + control.width / 2, y: control.y + control.height / 2 }] });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await session.detach();
  await expect(page.locator('.graph-wire')).toHaveCount(0);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual({ ...before, edges: [] });
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(0);
  // Native drag-to-connect restores the routed connection without changing nodes.
  await page.getByRole('button', { name: 'source output value', exact: true }).dragTo(page.getByRole('button', { name: 'target input input1', exact: true }));
  await expect(page.locator('.graph-wire')).toHaveCount(1); await assertRoutingGeometry(page);
});

test('import, Save, Load saved and reset retain logical graph data independently of routing', async ({ graphExtension: f }) => {
  const live = await openGraph(f), page = live.editor; await loadRoutingGraph(page);
  const before = await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })());
  const imported = structuredClone(before); imported.nodes[1].position.y += 30;
  await page.locator('input[type="file"]').setInputFiles({ name: 'graph.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
  await assertRoutingGeometry(page); await expect(page.locator('#graph-state')).toContainText('Unsaved');
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(imported);
  await page.getByRole('button', { name: 'Select obstacle', exact: true }).press('ArrowDown');
  await clickGraphAction(page, 'graph-load');
  await expect(page.locator('[data-node="obstacle"]')).toHaveCSS('top', `${imported.nodes[1].position.y}px`); await assertRoutingGeometry(page);
  await clickGraphAction(page, 'graph-validate'); await expect(page.locator('#graph-errors')).not.toContainText('Error:');
  expect(await page.evaluate(async () => { const { validateGraph } = await import('./graph.js'); return validateGraph((() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })()); })).toEqual([]);
  await clickGraphAction(page, 'graph-reset');
  await expect(page.locator('[data-node="source"]')).toHaveCount(0);
  await clickGraphAction(page, 'graph-load');
  await expect(page.locator('.graph-wire')).toHaveCount(1); await assertRoutingGeometry(page);
  expect(await page.evaluate(() => (() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(imported);
});

// Same dense topology as the browser evidence, inside the packaged MV3 page.
test('native touch resolves a crossing gap, disconnects its actual edge and reconnects only that input', async ({ graphExtension: f }) => {
  const { loadTraceabilityGraph, assertTraceability, checkCrossingSelection, traceabilityGraph } = await import('../fixtures/graph-traceability.js');
  const live=await openGraph(f), page=live.editor;
  await page.setViewportSize({width:1600,height:1500});await loadTraceabilityGraph(page);
  await assertRoutingGeometry(page);
  const session=await page.context().newCDPSession(page);
  const tap=async point=>{
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
    await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  const under=await checkCrossingSelection(page,tap), removed=traceabilityGraph.edges[under];
  const box=await page.locator('#graph-disconnect').boundingBox();
  await tap({x:box.x+box.width/2,y:box.y+box.height/2});await session.detach();
  await expect(page.locator('.graph-wire')).toHaveCount(traceabilityGraph.edges.length-1);
  await page.locator('#graph-save').click();await expect(page.locator('#graph-save')).toBeEnabled();
  const remaining=traceabilityGraph.edges.filter((_,i)=>i!==under);
  expect(await page.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual({...traceabilityGraph,edges:remaining});
  await page.reload();
  await page.getByRole('button',{name:`${removed.from[0]} output ${removed.from[1]}`,exact:true}).dragTo(page.getByRole('button',{name:`${removed.to[0]} input ${removed.to[1]}`,exact:true}));
  await expect(page.locator('.graph-wire')).toHaveCount(traceabilityGraph.edges.length);
  await assertTraceability(page);await assertRoutingGeometry(page);
  await page.locator('#graph-save').click();await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual({...traceabilityGraph,edges:[...remaining,removed]});
});
