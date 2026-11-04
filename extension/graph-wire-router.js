// Visual-only, rectilinear routing. Coordinates are unscaled canvas pixels.
export const WIRE_GAP = 12;
const BEND_COST = 24;
const MAX_GRID = 60000;
const MAX_VISITS = 12000;
const MAX_TOTAL_VISITS = 100000;
const inside = (p, r) => p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
export function crossesRectangle(a, b, r) {
  if (a.y === b.y) return a.y > r.top && a.y < r.bottom && Math.max(a.x, b.x) > r.left && Math.min(a.x, b.x) < r.right;
  if (a.x === b.x) return a.x > r.left && a.x < r.right && Math.max(a.y, b.y) > r.top && Math.min(a.y, b.y) < r.bottom;
  throw new Error('Expected an orthogonal segment');
}
// During node dragging, retain unaffected routes; optimize all paths on release.
export function reusableWireRoute(route, previous, connection, cards) {
  if (!route || route.fallback || !previous || JSON.stringify(previous) !== JSON.stringify(connection)) return false;
  return cards.every(card => {
    const r = { left: card.left - WIRE_GAP, right: card.right + WIRE_GAP, top: card.top - WIRE_GAP, bottom: card.bottom + WIRE_GAP };
    return route.points.slice(1).every((b, i) =>
      (i === 0 && card.id === connection.from) || (i === route.points.length - 2 && card.id === connection.to)
      || !crossesRectangle(route.points[i], b, r));
  });
}
function simplify(points) {
  const result = [];
  for (const point of points) {
    if (result.length && point.x === result.at(-1).x && point.y === result.at(-1).y) continue;
    while (result.length > 1) {
      const a = result.at(-2), b = result.at(-1);
      // Do not erase reversals in an endpoint escape segment.
      if ((a.x === b.x && b.x === point.x && (b.y - a.y) * (point.y - b.y) >= 0)
        || (a.y === b.y && b.y === point.y && (b.x - a.x) * (point.x - b.x) >= 0)) result.pop();
      else break;
    }
    result.push(point);
  }
  return result;
}
export function roundedWirePath(points) {
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1];
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const radius = Math.min(6, before / 2, after / 2);
    const p = { x: b.x + (a.x - b.x) * radius / before, y: b.y + (a.y - b.y) * radius / before };
    const q = { x: b.x + (c.x - b.x) * radius / after, y: b.y + (c.y - b.y) * radius / after };
    d += ` L${p.x},${p.y} Q${b.x},${b.y} ${q.x},${q.y}`;
  }
  return d + ` L${points.at(-1).x},${points.at(-1).y}`;
}
class MinHeap {
  items = [];
  push(item) {
    const items = this.items; let i = items.length; items.push(item);
    while (i) { const parent = (i - 1) >> 1; if (items[parent].score <= item.score) break; items[i] = items[parent]; i = parent; }
    items[i] = item;
  }
  pop() {
    const items = this.items, first = items[0], last = items.pop();
    if (items.length) {
      let i = 0;
      while (i * 2 + 1 < items.length) {
        let child = i * 2 + 1;
        if (child + 1 < items.length && items[child + 1].score < items[child].score) child++;
        if (last.score <= items[child].score) break;
        items[i] = items[child]; i = child;
      }
      items[i] = last;
    }
    return first;
  }
}

// Share coordinate lines and lazy visibility checks across all edges in a frame.
// A* includes incoming direction so a bend penalty favors understandable paths.
export function createWireRouter(cards, connections, { maxVisits = MAX_VISITS, maxTotalVisits = MAX_TOTAL_VISITS } = {}) {
  const obstacles = cards.map(r => ({ id: r.id, left: r.left - WIRE_GAP, right: r.right + WIRE_GAP,
    top: r.top - WIRE_GAP, bottom: r.bottom + WIRE_GAP }));
  const byId = new Map(obstacles.map(r => [r.id, r]));
  const terminals = connections.map(({ start, end, from, to }) => ({
    start: { x: byId.get(from)?.right ?? start.x, y: start.y },
    end: { x: byId.get(to)?.left ?? end.x, y: end.y },
  }));
  const sorted = values => [...new Set(values.filter(v => v >= 0))].sort((a, b) => a - b);
  const xs = sorted([0, ...obstacles.flatMap(r => [r.left, r.right]), ...terminals.flatMap(t => [t.start.x, t.end.x]),
    Math.max(0, ...obstacles.map(r => r.right), ...terminals.map(t => t.end.x)) + 32]);
  const ys = sorted([0, ...obstacles.flatMap(r => [r.top, r.bottom]), ...terminals.flatMap(t => [t.start.y, t.end.y]),
    Math.max(0, ...obstacles.map(r => r.bottom), ...terminals.map(t => t.end.y)) + 32]);
  const size = xs.length * ys.length, bounded = size <= MAX_GRID;
  const rows = bounded ? ys.map(y => obstacles.filter(r => y > r.top && y < r.bottom)) : [];
  const columns = bounded ? xs.map(x => obstacles.filter(r => x > r.left && x < r.right)) : [];
  const visibility = bounded ? new Map() : null;
  let totalVisits = 0;
  function visible(a, b, horizontal) {
    const key = Math.min(a, b) * 2 + (horizontal ? 0 : 1);
    if (visibility.has(key)) return visibility.get(key);
    const ax = a % xs.length, ay = Math.floor(a / xs.length), bx = b % xs.length, by = Math.floor(b / xs.length);
    const clear = horizontal ? !rows[ay].some(r => Math.max(xs[ax], xs[bx]) > r.left && Math.min(xs[ax], xs[bx]) < r.right)
      : !columns[ax].some(r => Math.max(ys[ay], ys[by]) > r.top && Math.min(ys[ay], ys[by]) < r.bottom);
    visibility.set(key, clear); return clear;
  }
  return {
    route(index) {
      const { start, end, from, to } = connections[index], t = terminals[index];
      const fallback = reason => ({ fallback: reason, points: [start, end],
        d: `M${start.x},${start.y} C${start.x + 60},${start.y} ${end.x - 60},${end.y} ${end.x},${end.y}` });
      if (!bounded) return fallback('routing grid limit');
      if (t.start.x < 0 || t.end.x < 0 || t.start.y < 0 || t.end.y < 0
        || obstacles.some(r => inside(t.start, r) || inside(t.end, r)
          || (r.id !== from && crossesRectangle(start, t.start, r))
          || (r.id !== to && crossesRectangle(t.end, end, r)))) return fallback('overlapping cards or blocked port');
      const source = ys.indexOf(t.start.y) * xs.length + xs.indexOf(t.start.x);
      const target = ys.indexOf(t.end.y) * xs.length + xs.indexOf(t.end.x);
      const distance = new Map([[source * 2, 0]]), previous = new Map(), queue = new MinHeap();
      const estimate = id => Math.abs(xs[id % xs.length] - t.end.x) + Math.abs(ys[Math.floor(id / xs.length)] - t.end.y);
      queue.push({ state: source * 2, cost: 0, score: estimate(source) });
      let visits = 0;
      while (queue.items.length && visits < maxVisits && totalVisits < maxTotalVisits) {
        const current = queue.pop(), id = Math.floor(current.state / 2), dir = current.state % 2;
        if (current.cost !== distance.get(current.state)) continue;
        visits++; totalVisits++;
        if (id === target) {
          const points = [end, t.end]; let state = current.state;
          while (state !== undefined) {
            const point = Math.floor(state / 2);
            points.push({ x: xs[point % xs.length], y: ys[Math.floor(point / xs.length)] });
            state = previous.get(state);
          }
          points.push(start); points.reverse();
          const simplified = simplify(points);
          return { points: simplified, d: roundedWirePath(simplified), fallback: null };
        }
        const x = id % xs.length, y = Math.floor(id / xs.length);
        for (const [next, direction] of [[x + 1 < xs.length ? id + 1 : -1, 0], [y + 1 < ys.length ? id + xs.length : -1, 1],
          [y > 0 ? id - xs.length : -1, 1], [x > 0 ? id - 1 : -1, 0]]) {
          if (next < 0 || !visible(id, next, direction === 0)) continue;
          const state = next * 2 + direction;
          const cost = current.cost + (direction === 0 ? Math.abs(xs[next % xs.length] - xs[x]) : Math.abs(ys[Math.floor(next / xs.length)] - ys[y]))
            + (direction === dir ? 0 : BEND_COST);
          if (cost >= (distance.get(state) ?? Infinity)) continue;
          distance.set(state, cost); previous.set(state, current.state);
          queue.push({ state, cost, score: cost + estimate(next) });
        }
      }
      return fallback(queue.items.length ? 'routing search limit' : 'no open route');
    },
  };
}
