import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWireRouter, crossesRectangle, reusableWireRoute, roundedWirePath, WIRE_GAP } from '../extension/graph-wire-router.js';

const card = (id, left, top, width = 200, height = 160) => ({ id, left, top, right: left + width, bottom: top + height });
function connection(cards, from = 'a', to = 'b', y1 = 80, y2 = 80) {
  const a = cards.find(r => r.id === from), b = cards.find(r => r.id === to);
  return { from, to, start: { x: a.right - 8, y: a.top + y1 }, end: { x: b.left + 8, y: b.top + y2 } };
}
function clearRoute(cards, c, route) {
  assert.equal(route.fallback, null, route.fallback);
  assert.deepEqual(route.points[0], c.start); assert.deepEqual(route.points.at(-1), c.end);
  for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1], b = route.points[i];
    assert.ok(a.x === b.x || a.y === b.y);
    for (const r of cards) {
      if (i === 1 && r.id === c.from || i === route.points.length - 1 && r.id === c.to) continue;
      assert.equal(crossesRectangle(a, b, r), false, `segment ${i} crosses ${r.id}`);
    }
  }
  assert.ok(!/NaN|Infinity/.test(route.d));
}

for (const [name, cards] of [
  ['horizontal obstacle', [card('a', 20, 100), card('b', 800, 100), card('obstacle', 390, 100)]],
  ['backwards', [card('a', 800, 100), card('b', 20, 100), card('obstacle', 390, 100)]],
  ['downwards', [card('a', 20, 20), card('b', 20, 750), card('obstacle', 160, 300, 250, 250)]],
  ['upwards', [card('a', 20, 750), card('b', 20, 20), card('obstacle', 160, 300, 250, 250)]],
  ['staggered barriers', [card('a', 20, 100), card('b', 1100, 100), card('c', 350, 0, 150, 300), card('d', 650, 180, 150, 400)]],
]) test(`routes ${name} around cards deterministically without mutating inputs`, () => {
  const c = connection(cards), before = structuredClone({ cards, c });
  const route = createWireRouter(cards, [c]).route(0);
  clearRoute(cards, c, route);
  assert.deepEqual(createWireRouter(cards, [c]).route(0), route);
  assert.deepEqual({ cards, c }, before);
});

test('obstacle movement/resizing and port changes recompute paths with clearance for rounding', () => {
  const cards = [card('a', 20, 100), card('b', 800, 100), card('c', 400, 500)];
  const c = connection(cards), initial = createWireRouter(cards, [c]).route(0);
  cards[2] = card('c', 400, 100, 200, 250);
  const detour = createWireRouter(cards, [c]).route(0);
  assert.notEqual(detour.d, initial.d); clearRoute(cards, c, detour);
  // The polyline stays 12px away; quadratic corner cuts use at most 6px.
  const expanded = { ...cards[2], left: cards[2].left - WIRE_GAP, right: cards[2].right + WIRE_GAP,
    top: cards[2].top - WIRE_GAP, bottom: cards[2].bottom + WIRE_GAP };
  for (let i = 1; i < detour.points.length; i++) assert.equal(crossesRectangle(detour.points[i - 1], detour.points[i], expanded), false);
  c.end.y += 40; clearRoute(cards, c, createWireRouter(cards, [c]).route(0));
});

test('overlap, blocked escapes, canvas boundary, and finite search budgets return visible fallbacks', () => {
  for (const cards of [
    [card('a', 20, 100), card('b', 400, 100), card('c', 210, 100)],
    [card('a', 20, 100), card('b', 0, 100)],
  ]) {
    const route = createWireRouter(cards, [connection(cards)]).route(0);
    assert.match(route.fallback, /overlapping/); assert.match(route.d, /^M.+C/);
  }
  const cards = [card('a', 20, 100), card('b', 800, 100)], c = connection(cards);
  assert.match(createWireRouter(cards, [c], { maxVisits: 0 }).route(0).fallback, /search limit/);
  const router = createWireRouter(cards, [c, c], { maxTotalVisits: 1 });
  assert.match(router.route(0).fallback, /limit/); assert.match(router.route(1).fallback, /limit/);
  const large = Array.from({ length: 150 }, (_, i) => card(`n${i}`, 20 + i * 250, 20 + i * 200));
  assert.equal(createWireRouter(large, [connection(large, 'n0', 'n149')]).route(0).fallback, 'routing grid limit');
});

test('dense 60-card, 90-edge fixture stays within bounded work and keeps routes clear', t => {
  const cards = Array.from({ length: 60 }, (_, i) => card(`n${i}`, 20 + i % 10 * 290, 20 + Math.floor(i / 10) * 240));
  const connections = Array.from({ length: 90 }, (_, i) => connection(cards, `n${i % 30}`, `n${30 + i % 30}`, 50 + i % 3 * 30, 50 + i % 3 * 30));
  const start = performance.now(), router = createWireRouter(cards, connections);
  const routes = connections.map((c, i) => { const route = router.route(i); clearRoute(cards, c, route); return route; });
  t.diagnostic(`${routes.length} routes in ${(performance.now() - start).toFixed(1)} ms`);
  assert.ok(performance.now() - start < 2000, 'regression guard, not a frame-rate guarantee');
});

test('drag cache reuses clear paths, invalidates new collisions and changed attachments', () => {
  const cards = [card('a', 20, 100), card('b', 800, 100), card('c', 400, 500)];
  const c = connection(cards), route = createWireRouter(cards, [c]).route(0);
  assert.equal(reusableWireRoute(route, c, c, cards), true);
  cards[2] = card('c', 400, 100);
  assert.equal(reusableWireRoute(route, c, c, cards), false);
  assert.equal(reusableWireRoute(route, c, { ...c, end: { ...c.end, y: c.end.y + 10 } }, cards), false);
  assert.equal(reusableWireRoute({ ...route, fallback: 'limit' }, c, c, cards), false);
});

test('parallel connections use distinct visible lanes rather than drawing over each other', () => {
  const cards = [card('a', 20, 100), card('b', 800, 100)];
  const c = connection(cards), router = createWireRouter(cards, [c, c, c]);
  const paths = [0, 1, 2].map(i => router.route(i));
  for (const path of paths) clearRoute(cards, c, path);
  // Shared port stubs are unavoidable; the long center runs should separate.
  const longRuns = paths.map(path => path.points.slice(1).filter((point, i) =>
    Math.abs(point.x - path.points[i].x) > 300).map(point => point.y));
  assert.equal(new Set(longRuns.flat()).size, 3);
  assert.equal(new Set(paths.map(path => path.d)).size, 3);
  // Paths are deterministic given the same ordered set of edges.
  const repeat = createWireRouter(cards, [c, c, c]);
  assert.deepEqual([0, 1, 2].map(i => repeat.route(i).d), paths.map(path => path.d));
});

test('crossings show a permanent visual gap but the full wire remains selectable', () => {
  const cards = [card('a', 20, 20, 150, 100), card('b', 870, 140, 150, 100),
    card('c', 20, 340, 150, 100), card('d', 870, 20, 150, 100)];
  const a = connection(cards, 'a', 'b', 50, 50);
  const b = connection(cards, 'c', 'd', 50, 50);
  const router = createWireRouter(cards, [a, b]), first = router.route(0), second = router.route(1);
  clearRoute(cards, a, first); clearRoute(cards, b, second);
  assert.equal(first.visualD, first.d);
  assert.match(second.visualD, / M/);
  assert.doesNotMatch(second.d, / M/);
  assert.ok(second.visualD.length > second.d.length);
  // Cached drag routes must rebuild the visible crossing treatment in order.
  const cached = createWireRouter(cards, [a, b]);
  cached.reuse(first);
  assert.equal(cached.reuse(second).visualD, second.visualD);
});

test('rounded wire gaps never change the port endpoints', () => {
  const p = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const visible = roundedWirePath(p, new Map([[0, [50]]]));
  assert.equal(visible, 'M0,0 L44,0 M56,0 L100,0');
  assert.equal(roundedWirePath(p), 'M0,0 L100,0');
});
