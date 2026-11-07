import { expect } from '@playwright/test';

export async function loadRoutingGraph(page, dense = false) {
  await page.evaluate(async dense => {
    const { graphNode, edge, GRAPH_VERSION } = await import(new URL('./graph.js', location.href)); const { saveLiveGraphData } = await import(new URL('./graph-library.js', location.href));
    const nodes = dense ? Array.from({ length: 40 }, (_, i) => graphNode('TextFormatter', `n${i}`, 30 + i % 8 * 330, 100 + Math.floor(i / 8) * 340))
      : [graphNode('Text', 'source', 30, 200), graphNode('TextFormatter', 'obstacle', 400, 120), graphNode('TextFormatter', 'target', 800, 200)];
    const edges = dense ? Array.from({ length: 60 }, (_, i) => edge(`n${i % 20}`, 'text', `n${20 + i % 20}`, `input${1 + Math.floor(i / 20)}`))
      : [edge('source', 'value', 'target', 'input1')];
    await saveLiveGraphData(localStorage, { version: GRAPH_VERSION, nodes, edges });
  }, dense);
  await page.reload(); await expect(page.locator('.graph-wire')).toHaveCount(dense ? 60 : 1);
}
export async function assertRoutingGeometry(page) {
  await expect.poll(() => page.evaluate(() => {
    const errors = [], canvas = document.querySelector('.graph-canvas'), origin = canvas.getBoundingClientRect();
    const scale = origin.width / parseFloat(canvas.style.width);
    const cards = [...canvas.querySelectorAll('.graph-node')].map(card => ({ id: card.dataset.node, r: card.getBoundingClientRect() }));
    for (const wire of canvas.querySelectorAll('.graph-wire')) {
      const path = wire.querySelector('.wire-line'), hit = wire.querySelector('.wire-hit'), matrix = path.getScreenCTM();
      if (path.getAttribute('d') !== hit.getAttribute('d') || path.getAttribute('d') !== wire.querySelector('.wire-casing').getAttribute('d')) errors.push('hit/casing geometry differs');
      if (wire.dataset.routing !== 'clear') { errors.push(wire.dataset.routing); continue; }
      const { from, to } = wire.connection;
      const port = (pair, side) => [...canvas.querySelectorAll('.graph-ports button')].find(p => p.closest('.graph-node').dataset.node === pair[0] && p.dataset.side === side && p.dataset.port === pair[1]).getBoundingClientRect();
      // SVG length measurement is expensive in WebKit; reuse it for every
      // sample without reducing clearance coverage or relaxing drag budgets.
      const totalLength = path.getTotalLength();
      const start = path.getPointAtLength(0), end = path.getPointAtLength(totalLength), a = port(from, 'output'), b = port(to, 'input');
      const screen = p => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f });
      const first = screen(start), last = screen(end);
      if (Math.abs(first.x - a.right) > .05 || Math.abs(first.y - a.top - a.height / 2) > .05
        || Math.abs(last.x - b.left) > .05 || Math.abs(last.y - b.top - b.height / 2) > .05) errors.push('port attachment');
      // Sample the actual SVG commands analytically. WebKit's repeated
      // getPointAtLength calls become very expensive on the additional lane
      // bends. Control-polygon length bounds every step to at most 2px.
      const tokens = path.getAttribute('d').match(/[MLQ]|-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi);
      const samples = []; let current;
      for (let i = 0; i < tokens.length;) {
        const command = tokens[i++], point = () => ({ x: Number(tokens[i++]), y: Number(tokens[i++]) });
        if (command === 'M') { current = point(); samples.push(current); continue; }
        const control = point(), end = command === 'Q' ? point() : control;
        const steps = Math.max(1, Math.ceil((Math.hypot(control.x-current.x,control.y-current.y) + (command === 'Q' ? Math.hypot(end.x-control.x,end.y-control.y) : 0)) / 2));
        for (let n = 1; n <= steps; n++) {
          const t = n / steps, u = 1-t;
          samples.push(command === 'Q' ? { x:u*u*current.x+2*u*t*control.x+t*t*end.x, y:u*u*current.y+2*u*t*control.y+t*t*end.y }
            : { x:current.x+t*(end.x-current.x), y:current.y+t*(end.y-current.y) });
        }
        current = end;
      }
      for (const sample of samples) {
        const p = screen(sample);
        for (const { id, r } of cards) {
          if (id === from[0] || id === to[0]) continue;
          // At least 5px of canvas-space clearance, including rounded corners.
          if (p.x > r.left - 5 * scale && p.x < r.right + 5 * scale && p.y > r.top - 5 * scale && p.y < r.bottom + 5 * scale) errors.push(`wire crosses ${id}`);
        }
      }
    }
    return [...new Set(errors)];
  }), { timeout: 2000 }).toEqual([]);
}
export async function detourPoint(page) {
  return page.locator('.wire-hit').first().evaluate(path => {
    const matrix = path.getScreenCTM(), viewport = path.closest('.graph-scroll').getBoundingClientRect();
    for (let l = 30; l < path.getTotalLength() - 30; l += 3) {
      const p = path.getPointAtLength(l), x = matrix.a * p.x + matrix.e, y = matrix.d * p.y + matrix.f;
      if (x <= viewport.left + 5 || x >= viewport.right - 5 || y <= viewport.top + 5 || y >= viewport.bottom - 5) continue;
      if (document.elementFromPoint(x, y)?.closest('.graph-wire') === path.parentElement) return { x, y };
    }
    throw Error('No exposed detour');
  });
}
export async function checkRoutingMovement(page) {
  await page.setViewportSize({ width: 1600, height: 1000 }); await loadRoutingGraph(page);
  await assertRoutingGeometry(page);
  const original = await page.locator('.wire-line').getAttribute('d');
  const heading = page.getByRole('button', { name: 'Select obstacle', exact: true });
  await heading.focus(); await heading.press('ArrowDown');
  await expect(page.locator('.wire-line')).not.toHaveAttribute('d', original); await assertRoutingGeometry(page);
  // Real pointer movement, with the pointer held down while checking rerouting.
  const box = await heading.boundingBox();
  await page.mouse.move(box.x + 60, box.y + 15); await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 95, { steps: 12 });
  await expect(page.locator('[data-node="obstacle"]')).toHaveCSS('top', '210px');
  await assertRoutingGeometry(page); await page.mouse.up(); await assertRoutingGeometry(page);
  // ResizeObserver must handle card/port reflow without any editor command.
  const beforeResize = await page.locator('.wire-line').getAttribute('d');
  await page.locator('[data-node="target"]').evaluate(card => { card.style.paddingTop = '80px'; });
  await page.locator('[data-node="obstacle"]').evaluate(card => { card.style.width = '290px'; card.style.height = '420px'; });
  await expect(page.locator('.wire-line')).not.toHaveAttribute('d', beforeResize);
  await assertRoutingGeometry(page);
  for (const zoom of ['0.25', '0.5', '0.75', '1', '1.25', '1.5']) {
    await page.locator('#graph-zoom').selectOption(zoom); await assertRoutingGeometry(page);
    await page.locator('.graph-scroll').evaluate(scroll => { scroll.scrollLeft = 80; scroll.scrollTop = 40; }); await assertRoutingGeometry(page);
  }
  await page.locator('#graph-fit').click(); await assertRoutingGeometry(page);
}
