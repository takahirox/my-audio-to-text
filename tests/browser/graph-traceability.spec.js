import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadTraceabilityGraph, assertTraceability, checkCrossingSelection, traceabilityGraph } from '../fixtures/graph-traceability.js';
import { assertRoutingGeometry } from '../fixtures/graph-routing.js';
const before = JSON.parse(await readFile(new URL('../fixtures/dense-routing-before.json', import.meta.url)));
const evidencePath = name => process.env.GRAPH_ROUTING_EVIDENCE ? `docs/evidence/${name}` : test.info().outputPath(name);

test.beforeEach(async ({ page }) => {
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!/^\/(extension|web)\/[\w.-]+\.(js|html|css)$/.test(pathname)) return route.continue();
    await route.fulfill({ body: await readFile(path.resolve(pathname.slice(1))), contentType: pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await page.setViewportSize({ width: 1600, height: 1500 });
  await page.goto('/extension/graph-editor.html'); await loadTraceabilityGraph(page);
});

test('unselected fan-out, close inputs, parallel detours, crossings and Hold feedback have distinct paths', async ({ page }) => {
  await expect(page.locator('.selected-wire')).toHaveCount(0);
  await assertTraceability(page); await assertRoutingGeometry(page);
  const original = await page.locator('.wire-line').evaluateAll(paths => paths.map(p => p.getAttribute('d')));
  for (const zoom of ['0.5','0.75','1','1.5','1']) {
    await page.locator('#graph-zoom').selectOption(zoom); await assertRoutingGeometry(page);
    expect(await page.locator('.wire-line').evaluateAll(paths=>paths.map(p=>p.getAttribute('d')))).toEqual(original);
  }
  await page.locator('.graph-scroll').evaluate(s=>{s.scrollLeft=30;s.scrollTop=90;});
  await assertTraceability(page); await page.locator('#graph-fit').click(); await assertTraceability(page);
  await page.locator('#graph-zoom').selectOption('1'); await page.reload();
  expect(await page.locator('.wire-line').evaluateAll(paths=>paths.map(p=>p.getAttribute('d')))).toEqual(original);
  expect(await page.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual(traceabilityGraph);
});

test('mouse hit resolution follows the crossing gap, keyboard Delete removes only that connection', async ({ page }) => {
  let under;
  for (const zoom of ['0.5','1','1.5','1']) {
    await page.locator('#graph-zoom').selectOption(zoom);
    under=await checkCrossingSelection(page);
  }
  await expect(page.locator(`.graph-wire[data-edge="${under}"]`)).toBeFocused();
  await page.keyboard.press('Delete'); await expect(page.locator('.graph-wire')).toHaveCount(traceabilityGraph.edges.length-1);
  await page.locator('#graph-save').click(); await expect(page.locator('#graph-save')).toBeEnabled();
  expect(await page.evaluate(()=>(() => { const library = JSON.parse(localStorage.getItem('processing-graph-library-v1')); return library.graphs.find(entry => entry.id === library.assignments.live).graph; })())).toEqual({...traceabilityGraph,edges:traceabilityGraph.edges.filter((_,i)=>i!==under)});
  await page.reload(); await assertRoutingGeometry(page);
});

test('dense lanes follow movement, card reflow and an added nearby input', async ({ page }) => {
  const original = await page.locator('.wire-line').first().getAttribute('d');
  await page.getByRole('button', {name:'Select mix',exact:true}).press('ArrowDown');
  await expect(page.locator('.wire-line').first()).not.toHaveAttribute('d',original);
  await assertRoutingGeometry(page); await assertTraceability(page);
  const moved = await page.locator('.wire-line').first().getAttribute('d');
  await page.locator('[data-node="mix"]').evaluate(card=>{card.style.width='280px';card.style.paddingTop='28px';});
  await expect(page.locator('.wire-line').first()).not.toHaveAttribute('d',moved);
  await assertRoutingGeometry(page); await assertTraceability(page);
  await page.getByRole('button',{name:'Select upper',exact:true}).click();
  await page.getByRole('button',{name:'upper Add input',exact:true}).click();
  await page.getByRole('button',{name:'beta output value',exact:true}).click();
  await page.getByRole('button',{name:'upper input input5',exact:true}).click();
  await expect(page.locator('.graph-wire')).toHaveCount(traceabilityGraph.edges.length+1);
  await assertRoutingGeometry(page); await assertTraceability(page);
});

test('dense before/after at 100% with identical nodes and no selected or hovered wire', async ({ page, browserName }) => {
  test.skip(browserName!=='chromium','one evidence pair at normal scale');
  const geometry=await assertTraceability(page);
  // Hold gained an optional trigger since the historical #204 snapshot.
  // Preserve placement/width and endpoints; validate routes against current
  // card heights below, including the additional real port.
  const placement = cards => cards.map(({ id, left, right, top }) => ({ id, left, right, top }));
  expect(placement(geometry.cards)).toEqual(placement(before.cards));
  expect(geometry.connections).toEqual(before.connections);
  await page.locator('.graph-scroll').evaluate(e=>e.style.height='1200px');
  await page.mouse.move(1500,1450);
  // Captured from the real #204 router at the recorded commit and measured
  // card/port snapshot, not a hand-drawn approximation of the old routes.
  await page.evaluate(async routes=>{
    const {GraphEditor}=await import('./graph-editor.js'), draw=GraphEditor.prototype.drawWires;
    window.restoreTraceDrawing=()=>{GraphEditor.prototype.drawWires=draw;}; GraphEditor.prototype.drawWires=()=>{};
    [...document.querySelectorAll('.graph-wire')].forEach((wire,i)=>{
      for(const p of wire.querySelectorAll('path'))p.setAttribute('d',routes[i].d);
      wire.querySelector('.wire-line').style.stroke='#9bbfff'; wire.querySelector('.wire-casing').style.display='none';
    });
  },before.routes);
  try {
    await assertRoutingGeometry(page); await page.screenshot({path:evidencePath('graph-215-before.png')});
  } finally {
    await page.evaluate(routes=>{
      window.restoreTraceDrawing();delete window.restoreTraceDrawing;
      [...document.querySelectorAll('.graph-wire')].forEach((wire,i)=>{
        for(const p of wire.querySelectorAll('path'))p.setAttribute('d',routes[i].d);
        wire.querySelector('.wire-line').style.removeProperty('stroke');wire.querySelector('.wire-casing').style.removeProperty('display');
      });
    },geometry.routes);
  }
  await assertTraceability(page); await assertRoutingGeometry(page);
  await page.screenshot({path:evidencePath('graph-215-after.png')});
});
