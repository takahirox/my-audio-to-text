import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';
export const traceabilityGraph = JSON.parse(readFileSync(new URL('./dense-routing.json', import.meta.url)));

export async function loadTraceabilityGraph(page) {
  await page.evaluate(async graph => {
    const { saveGraph } = await import('./graph.js'); saveGraph(localStorage, graph);
  }, traceabilityGraph);
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(traceabilityGraph.edges.length);
}

// Measure the router's actual geometry from the same DOM snapshot used by the
// editor. This also provides deterministic crossings for real hit testing.
export async function traceabilityGeometry(page) {
  return page.evaluate(async () => {
    const { createWireRouter } = await import('./graph-wire-router.js');
    const canvas = document.querySelector('.graph-canvas'), origin = canvas.getBoundingClientRect();
    const zoom = origin.width / parseFloat(canvas.style.width), local = v => Math.round(v / zoom * 100) / 100;
    const cards = [...canvas.querySelectorAll('.graph-node')].map(card => {
      const r = card.getBoundingClientRect(); return { id: card.dataset.node, left: local(r.left-origin.left), right: local(r.right-origin.left), top: local(r.top-origin.top), bottom: local(r.bottom-origin.top) };
    });
    const wires = [...canvas.querySelectorAll('.graph-wire')];
    const connections = wires.map(wire => {
      const { from, to } = wire.connection;
      const port = (pair, side) => [...canvas.querySelectorAll('.graph-ports button')].find(p => p.closest('.graph-node').dataset.node === pair[0] && p.dataset.side === side && p.dataset.port === pair[1]).getBoundingClientRect();
      const a = port(from,'output'), b = port(to,'input');
      return { key: JSON.stringify([from,to]), from: from[0], to: to[0], start: { x: local(a.right-origin.left), y: local(a.top+a.height/2-origin.top) }, end: { x: local(b.left-origin.left), y: local(b.top+b.height/2-origin.top) } };
    });
    const routes = createWireRouter(cards, connections).routeAll();
    const segments = routes.map(r => r.points.slice(1).map((b,i) => ({a:r.points[i], b})));
    const crossings = [], overlaps = [];
    for (let i=0;i<segments.length;i++) for (let j=i+1;j<segments.length;j++) {
      for (const a of segments[i]) for (const b of segments[j]) {
        const ah = a.a.y === a.b.y, bh = b.a.y === b.b.y;
        if (ah === bh) {
          if ((ah ? a.a.y === b.a.y : a.a.x === b.a.x)) {
            const length = Math.min(Math.max(ah?a.a.x:a.a.y,ah?a.b.x:a.b.y),Math.max(ah?b.a.x:b.a.y,ah?b.b.x:b.b.y)) - Math.max(Math.min(ah?a.a.x:a.a.y,ah?a.b.x:a.b.y),Math.min(ah?b.a.x:b.a.y,ah?b.b.x:b.b.y));
            if(length>0) overlaps.push({i,j,length,sharedSource:connections[i].from===connections[j].from && connections[i].start.y===connections[j].start.y});
          }
        } else {
          const h = ah?a:b, v=ah?b:a, x=v.a.x,y=h.a.y;
          // Leave room for rounded corners and an exposed hit position on each
          // side of the crossing, not an incidental meeting at a bend.
          if(x>Math.min(h.a.x,h.b.x)+12 && x<Math.max(h.a.x,h.b.x)-12 && y>Math.min(v.a.y,v.b.y)+12 && y<Math.max(v.a.y,v.b.y)-12) crossings.push({i,j,x:origin.left+x*zoom,y:origin.top+y*zoom,horizontal:ah?i:j,vertical:ah?j:i,zoom});
        }
      }
    }
    return { cards, routes, crossings, overlaps, connections, zoom };
  });
}

export async function assertTraceability(page) {
  const geometry = await traceabilityGeometry(page);
  expect(geometry.routes.every(r => !r.fallback && !r.crowded)).toBe(true);
  expect(geometry.crossings.length).toBeGreaterThanOrEqual(5);
  expect(geometry.overlaps.filter(o => !o.sharedSource || o.length > 80)).toEqual([]);
  expect(await page.locator('.wire-line').evaluateAll(paths => paths.map(p => p.getAttribute('d')))).toEqual(geometry.routes.map(r => r.d));
  expect(await page.locator('.graph-wire').evaluateAll(wires => wires.every(w => {
    const line=w.querySelector('.wire-line'), casing=w.querySelector('.wire-casing'), hit=w.querySelector('.wire-hit');
    return line.getAttribute('d')===casing.getAttribute('d') && line.getAttribute('d')===hit.getAttribute('d')
      && Number.parseFloat(getComputedStyle(casing).strokeWidth)>Number.parseFloat(getComputedStyle(line).strokeWidth)
      && getComputedStyle(casing).pointerEvents==='none' && getComputedStyle(hit).pointerEvents==='stroke';
  }))).toBe(true);
  return geometry;
}

export async function checkCrossingSelection(page, activate = p => page.mouse.click(p.x, p.y)) {
  const {crossings}=await assertTraceability(page), c=crossings[0];
  // The exact intersection belongs to the visible overpass. Four pixels down
  // the underpass are still within the overpass's broad native hit target;
  // nearest-path resolution must select the actual continuation instead.
  const over=Math.max(c.i,c.j), under=Math.min(c.i,c.j);
  const cases=[{x:c.x,y:c.y,index:over},
    {x:c.x+(under===c.horizontal?4*c.zoom:0),y:c.y+(under===c.vertical?4*c.zoom:0),index:under}];
  for(const point of cases) {
    await activate({x:point.x,y:point.y});
    await expect(page.locator(`.graph-wire[data-edge="${point.index}"]`)).toHaveAttribute('aria-pressed','true');
    const edge=traceabilityGraph.edges[point.index];
    await expect(page.getByRole('button',{name:`Disconnect ${edge.from.join('.')} to ${edge.to.join('.')}`,exact:true})).toBeVisible();
  }
  return under;
}
