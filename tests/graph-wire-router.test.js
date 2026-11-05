import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWireRouter, crossesRectangle, reusableWireRoute, WIRE_GAP } from '../extension/graph-wire-router.js';

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

function parallelFixture(fanout = false) {
  const cards = [card('a', 20, 100), card('b', 800, 100), card('obstacle', 390, 100)];
  const connections = Array.from({ length: 4 }, (_, i) => ({ ...connection(cards, 'a', 'b', fanout ? 50 : 50+i*10, 50+i*20), key: `e${i}` }));
  return { cards, connections };
}
function longSharedSegments(routes, connections) {
  const shared = [];
  for (let i=0;i<routes.length;i++) for (let j=i+1;j<routes.length;j++) {
    for (let n=1;n<routes[i].points.length;n++) for (let m=1;m<routes[j].points.length;m++) {
      const a=routes[i].points[n-1], b=routes[i].points[n], c=routes[j].points[m-1], d=routes[j].points[m];
      const horizontal=a.y===b.y;
      if(horizontal !== (c.y===d.y) || Math.abs((horizontal?a.y:a.x)-(horizontal?c.y:c.x))>=7) continue;
      const length=Math.min(Math.max(horizontal?a.x:a.y,horizontal?b.x:b.y),Math.max(horizontal?c.x:c.y,horizontal?d.x:d.y))
        -Math.max(Math.min(horizontal?a.x:a.y,horizontal?b.x:b.y),Math.min(horizontal?c.x:c.y,horizontal?d.x:d.y));
      if(length<=24) continue;
      // Legitimate branching is confined to the short escape of one output.
      if(horizontal && connections[i].start.y===connections[j].start.y && length<=80 && n===1 && m===1) continue;
      shared.push({i,j,length});
    }
  }
  return shared;
}
for (const fanout of [false,true]) test(`separates ${fanout?'fan-out':'nearby ports'} into clear lanes around a shared obstacle`, () => {
  const {cards,connections}=parallelFixture(fanout), before=structuredClone({cards,connections});
  const routes=createWireRouter(cards,connections).routeAll();
  routes.forEach((route,i)=>{clearRoute(cards,connections[i],route);assert.equal(route.crowded,false);});
  assert.deepEqual(longSharedSegments(routes,connections),[]);
  assert.equal(new Set(routes.map(r=>r.d)).size,4);
  assert.deepEqual(createWireRouter(cards,connections).routeAll(),routes);
  const reversed=[...connections].reverse();
  assert.deepEqual(createWireRouter(cards,reversed).routeAll().reverse(),routes,'input edge order cannot change lanes');
  assert.deepEqual({cards,connections},before);
});
test('bounded lane search preserves all node-clear baselines and visibly reports residual overlap', () => {
  const {cards,connections}=parallelFixture();
  const routes=createWireRouter(cards,connections,{maxTotalVisits:1500}).routeAll();
  routes.forEach((r,i)=>clearRoute(cards,connections[i],r));
  assert.ok(routes.some(r=>r.crowded));
  assert.ok(longSharedSegments(routes,connections).length);
  const shortest=connections.map(c=>createWireRouter(cards,[c]).route(0));
  routes.forEach((r,i)=>assert.ok(r.length<=shortest[i].length*1.6+160));
});
test('drag routes are reserved before changed connections, without mutating cached routes', () => {
  const {cards,connections}=parallelFixture();
  const previous=createWireRouter(cards,connections).routeAll(), before=structuredClone(previous);
  const routes=createWireRouter(cards,connections).routeAll([null,previous[1],previous[2],previous[3]]);
  assert.deepEqual(routes.slice(1).map(r=>r.d),previous.slice(1).map(r=>r.d));
  assert.deepEqual(longSharedSegments(routes,connections),[]);
  assert.deepEqual(previous,before);
});
test('fan-out escapes clamp to the available corridor without introducing a blocked-port fallback', () => {
  const cards=[card('a',20,100),card('b',260,100)];
  const connections=Array.from({length:8},(_,i)=>({...connection(cards,'a','b',50,20+i*15),key:`e${i}`}));
  const routes=createWireRouter(cards,connections).routeAll();
  routes.forEach((r,i)=>clearRoute(cards,connections[i],r));
});
