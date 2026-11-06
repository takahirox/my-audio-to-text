// Visual-only, rectilinear routing. Coordinates are unscaled canvas pixels.
export const WIRE_GAP = 12;
export const WIRE_LANE = 10;
const BEND_COST = 24;
const MAX_GRID = 60000;
const MAX_VISITS = 12000;
const MAX_TOTAL_VISITS = 400000;
const lowerBound = (values, value) => {
  let low = 0, high = values.length;
  while (low < high) { const mid = (low + high) >> 1; if (values[mid] < value) low = mid + 1; else high = mid; }
  return low;
};

// Colors supplement geometry; they never encode port types or graph semantics.
export function wireColor(key) {
  const palette = ['#386aa3', '#946018', '#267565', '#7852a2', '#ac496b', '#6c721f'];
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export function wireDistance(points, p) {
  let distance = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    distance = Math.min(distance, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy));
  }
  return distance;
}
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
  const key = c => c.key ?? JSON.stringify([c.from, c.start, c.to, c.end]);
  const order = connections.map((_, i) => i).sort((a, b) => key(connections[a]) < key(connections[b]) ? -1 : key(connections[a]) > key(connections[b]) ? 1 : 0);
  const fanout = new Map(), ranks = [];
  for (const i of order) {
    const c = connections[i], port = JSON.stringify([c.from, c.start]);
    ranks[i] = fanout.get(port) ?? 0; fanout.set(port, ranks[i] + 1);
  }
  const terminals = connections.map(({ start, end, from, to }, i) => ({
    // Only the short escape from the same output can form a real branch.
    // Stagger turns before assigning lanes to the independent connections.
    start: { x: Math.min((byId.get(from)?.right ?? start.x) + Math.min(ranks[i], 6) * WIRE_LANE,
      ...obstacles.filter(r => r.id !== from && start.y > r.top && start.y < r.bottom && r.left >= (byId.get(from)?.right ?? start.x)).map(r => r.left)), y: start.y },
    end: { x: byId.get(to)?.left ?? end.x, y: end.y },
  }));
  const sorted = values => [...new Set(values.filter(v => v >= 0))].sort((a, b) => a - b);
  let xs, ys;
  // Offer multiple lanes outside each obstacle, with fewer optional lines if
  // an irregular layout would otherwise exceed the existing grid budget.
  for (let lanes = 4; lanes >= 0; lanes--) {
    const offsets = Array.from({ length: lanes + 1 }, (_, i) => i * WIRE_LANE);
    xs = sorted([0, ...obstacles.flatMap(r => offsets.flatMap(d => [r.left - d, r.right + d])),
      ...terminals.flatMap(t => [t.start.x, t.end.x]),
      Math.max(0, ...obstacles.map(r => r.right), ...terminals.map(t => t.start.x), ...terminals.map(t => t.end.x)) + 60]);
    ys = sorted([0, ...obstacles.flatMap(r => offsets.flatMap(d => [r.top - d, r.bottom + d])),
      ...terminals.flatMap(t => [t.start.y, t.end.y, ...(lanes ? [t.start.y - WIRE_LANE, t.start.y + WIRE_LANE, t.end.y - WIRE_LANE, t.end.y + WIRE_LANE] : [])]),
      Math.max(0, ...obstacles.map(r => r.bottom), ...terminals.map(t => t.end.y)) + 60]);
    if (xs.length * ys.length <= MAX_GRID) break;
  }
  const size = xs.length * ys.length, bounded = size <= MAX_GRID;
  const rows = bounded ? ys.map(y => obstacles.filter(r => y > r.top && y < r.bottom)) : [];
  const columns = bounded ? xs.map(x => obstacles.filter(r => x > r.left && x < r.right)) : [];
  const visibility = bounded ? new Map() : null;
  const congestion = bounded ? new Float64Array(size * 2) : null;
  const routes = new Map();
  const baselines = new Map(), baselineVisits = new Map();
  const occupied = [new Map(), new Map()];
  let comparisons = 0;
  let totalVisits = 0;
  function reserve(index, route) {
    if (routes.has(index)) return routes.get(index);
    route = { ...route, crowded: false };
    routes.set(index, route);
    if (route.fallback || !bounded) return route;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i], horizontal = a.y === b.y;
      const along = horizontal ? xs : ys, across = horizontal ? ys : xs;
      const low = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      const high = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      const fixed = horizontal ? a.y : a.x;
      const corridors = occupied[horizontal ? 0 : 1], bucket = Math.floor(fixed / 7);
      for (const segment of [bucket - 1, bucket, bucket + 1].flatMap(b => corridors.get(b) ?? [])) {
        if (segment.index === index) continue;
        // Bound the diagnostic too, independently of A* work. Unchecked routes
        // are visibly marked rather than silently claiming separated lanes.
        if (++comparisons > 100000) { route.crowded = true; break; }
        if (Math.abs(segment.fixed - fixed) >= 7) continue;
        const left = Math.max(low, segment.low), right = Math.min(high, segment.high);
        if (right - left <= 24) continue;
        const c = connections[index], other = connections[segment.index];
        const sharedOutput = horizontal && c.from === other.from && c.start.x === other.start.x && c.start.y === other.start.y
          && fixed === c.start.y && segment.fixed === fixed && left >= c.start.x
          && right <= Math.max(terminals[index].start.x, terminals[segment.index].start.x);
        if (!sharedOutput) { route.crowded = true; routes.get(segment.index).crowded = true; }
      }
      if (!corridors.has(bucket)) corridors.set(bucket, []);
      corridors.get(bucket).push({ index, fixed, low, high });
      for (let line = lowerBound(across, fixed - WIRE_LANE + .01); line < across.length && across[line] < fixed + WIRE_LANE - .01; line++) {
        for (let step = Math.max(0, lowerBound(along, low) - 1); step < along.length - 1 && along[step] < high; step++) {
          const overlap = Math.min(high, along[step + 1]) - Math.max(low, along[step]);
          if (overlap <= 0) continue;
          const id = horizontal ? line * xs.length + step : step * xs.length + line;
          congestion[id * 2 + (horizontal ? 0 : 1)] += overlap * 24 * (1 - Math.abs(across[line] - fixed) / WIRE_LANE);
        }
      }
    }
    return route;
  }
  function congested(route) {
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i], horizontal = a.y === b.y;
      const along = horizontal ? xs : ys, line = (horizontal ? ys : xs).indexOf(horizontal ? a.y : a.x);
      if (line < 0) continue;
      const low = Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      const high = Math.max(horizontal ? a.x : a.y, horizontal ? b.x : b.y);
      for (let step = Math.max(0, lowerBound(along, low) - 1); step < along.length - 1 && along[step] < high; step++) {
        if (along[step + 1] <= low) continue;
        const id = horizontal ? line * xs.length + step : step * xs.length + line;
        if (congestion[id * 2 + (horizontal ? 0 : 1)] > 0) return true;
      }
    }
    return false;
  }
  function visible(a, b, horizontal) {
    const key = Math.min(a, b) * 2 + (horizontal ? 0 : 1);
    if (visibility.has(key)) return visibility.get(key);
    const ax = a % xs.length, ay = Math.floor(a / xs.length), bx = b % xs.length, by = Math.floor(b / xs.length);
    const clear = horizontal ? !rows[ay].some(r => Math.max(xs[ax], xs[bx]) > r.left && Math.min(xs[ax], xs[bx]) < r.right)
      : !columns[ax].some(r => Math.max(ys[ay], ys[by]) > r.top && Math.min(ys[ay], ys[by]) < r.bottom);
    visibility.set(key, clear); return clear;
  }
  function route(index, baseOnly = false) {
    if (routes.has(index)) return routes.get(index);
    if (baseOnly && baselines.has(index)) return baselines.get(index);
    const { start, end, from, to } = connections[index], t = terminals[index];
    const fallback = reason => {
      const result = { fallback: reason, points: [start, end],
        d: `M${start.x},${start.y} C${start.x + 60},${start.y} ${end.x - 60},${end.y} ${end.x},${end.y}` };
      if (baseOnly) { baselines.set(index, result); return result; }
      return reserve(index, result);
    };
    if (!bounded) return fallback('routing grid limit');
    if (t.start.x < 0 || t.end.x < 0 || t.start.y < 0 || t.end.y < 0
      || obstacles.some(r => inside(t.start, r) || inside(t.end, r)
        || (r.id !== from && crossesRectangle(start, t.start, r))
        || (r.id !== to && crossesRectangle(t.end, end, r)))) return fallback('overlapping cards or blocked port');
    const source = ys.indexOf(t.start.y) * xs.length + xs.indexOf(t.start.x);
    const target = ys.indexOf(t.end.y) * xs.length + xs.indexOf(t.end.x);
    let visits = baselineVisits.get(index) ?? 0;
    function search(useLanes, maxLength = Infinity) {
      const distance = new Map([[source * 2, 0]]), previous = new Map(), queue = new MinHeap();
      const estimate = id => Math.abs(xs[id % xs.length] - t.end.x) + Math.abs(ys[Math.floor(id / xs.length)] - t.end.y);
      queue.push({ state: source * 2, cost: 0, length: 0, score: estimate(source) });
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
          return { points: simplified, d: roundedWirePath(simplified), fallback: null, length: current.length };
        }
        const x = id % xs.length, y = Math.floor(id / xs.length);
        for (const [next, direction] of [[x + 1 < xs.length ? id + 1 : -1, 0], [y + 1 < ys.length ? id + xs.length : -1, 1],
          [y > 0 ? id - xs.length : -1, 1], [x > 0 ? id - 1 : -1, 0]]) {
          if (next < 0 || !visible(id, next, direction === 0)) continue;
          // Never double back over an attachment and fabricate a hairpin at a
          // port. The terminal's first/last turn must face the open corridor.
          if (id === source && direction === 0 && next < id) continue;
          if (next === target && direction === 0 && id > next) continue;
          const state = next * 2 + direction;
          const length = current.length + (direction === 0 ? Math.abs(xs[next % xs.length] - xs[x]) : Math.abs(ys[Math.floor(next / xs.length)] - ys[y]));
          if (length + estimate(next) > maxLength) continue;
          const cost = current.cost + length - current.length + (direction === dir ? 0 : BEND_COST)
            + (useLanes ? congestion[Math.min(id, next) * 2 + direction] : 0);
          if (cost >= (distance.get(state) ?? Infinity)) continue;
          distance.set(state, cost); previous.set(state, current.state);
          queue.push({ state, cost, length, score: cost + estimate(next) });
        }
      }
      return null;
    }
    // Establish a clear, short route first. Lane search cannot sacrifice node
    // avoidance or create an unbounded detour when the corridor is too tight.
    const base = baselines.get(index) ?? search(false);
    if (!base) return fallback(visits >= maxVisits || totalVisits >= maxTotalVisits ? 'routing search limit' : 'no open route');
    if (baseOnly) { baselines.set(index, base); baselineVisits.set(index, visits); return base; }
    if (base.fallback) return reserve(index, base);
    return reserve(index, congested(base) ? search(true, base.length * 1.6 + 160) ?? base : base);
  }

  return {
    route,
    routeAll(reused = []) {
      // Reserve every unaffected drag route before routing changed connections.
      for (const i of order) if (reused[i]) reserve(i, reused[i]);
      // Preserve a node-clear baseline for every edge before spending the rest
      // of the snapshot budget on readability. Congestion cannot starve edges.
      for (const i of order) route(i, true);
      for (const i of order) route(i);
      return connections.map((_, i) => routes.get(i));
    },
  };
}
