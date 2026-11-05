const scrollStates = new WeakMap();
const nearBottom = content => content.scrollHeight - content.clientHeight - content.scrollTop <= 24;
function updateScrollIntent(content, state) {
  if (state.suspended) return;
  // Layout can change the bottom before ResizeObserver runs. Preserve intent
  // unless the offset changed beyond layout clamping, or reached the bottom.
  const clamped = Math.min(state.top, Math.max(0, content.scrollHeight - content.clientHeight));
  if (Math.abs(content.scrollTop - clamped) > 1 || nearBottom(content)) {
    state.following = nearBottom(content);
    state.top = content.scrollTop;
  } else {
    // Preserve the baseline for small movements so they accumulate across
    // events, while still accounting for offsets clamped by shorter layouts.
    state.top = clamped;
  }
}
function scrollState(content) {
  if (!scrollStates.has(content)) {
    const state = { following: true, top: content.scrollTop };
    content.addEventListener('scroll', () => updateScrollIntent(content, state));
    // Observe the viewport and the snapshot's flow box: wrapping, font changes,
    // and a resized Live window can change the bottom after the initial mount.
    if (typeof ResizeObserver !== 'undefined') state.observer = new ResizeObserver(() => {
      if (state.suspended) return;
      if (state.following) content.scrollTop = content.scrollHeight;
      state.top = content.scrollTop;
    });
    scrollStates.set(content, state);
  }
  return scrollStates.get(content);
}

const surfaces = new WeakMap();
let nextSurface = 0;
function contents(region) { return region.querySelectorAll('.display-content'); }
function activate(surface, id, focus = false) {
  surface.active = id;
  for (const [key, region] of surface.regions) {
    const selected = key === id;
    // Capture intent while layout still exists; hidden scroll events/observers
    // must never turn a saved reading offset into bottom-following intent.
    if (!region.hidden && !selected) for (const content of contents(region)) {
      const state = scrollState(content); updateScrollIntent(content, state); state.suspended = true;
    }
    const wasHidden = region.hidden; region.hidden = !selected;
    for (const content of contents(region)) {
      const state = scrollState(content); state.suspended = !selected;
      content.setAttribute('aria-live', selected ? 'polite' : 'off');
      if (selected && wasHidden) {
        content.scrollTop = state.following ? content.scrollHeight : state.top;
        state.top = content.scrollTop;
      }
    }
    region.querySelector('[role="status"]')?.setAttribute('aria-live', selected ? 'polite' : 'off');
    const tab = surface.tabs.get(key);
    if (tab) { tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; }
  }
  if (focus) surface.tabs.get(id)?.focus({ preventScroll: true });
}
function paneFor(port, label) {
  const pane = document.createElement('section'); pane.className = 'panel live-text-region'; pane.dataset.port = port;
  const heading = document.createElement('h2'), copy = document.createElement('button'), notice = document.createElement('p'), content = document.createElement('div');
  heading.className = 'display-label'; heading.textContent = label; content.className = 'display-content';
  pane.setAttribute('aria-label', label); pane.lang = 'und';
  content.tabIndex = 0; content.setAttribute('aria-label', 'Content'); notice.setAttribute('role', 'status');
  copy.textContent = 'Copy text'; copy.setAttribute('aria-label', `Copy ${label} text`); copy.disabled = true;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(content.innerText); notice.textContent = 'Text copied.'; }
    catch { notice.textContent = 'Clipboard unavailable. Select and copy the text in this region.'; }
  };
  const header = document.createElement('div'); header.className = 'section-heading'; header.append(heading, copy);
  pane.append(header, notice, content); return pane;
}
function mountSnapshot(pane, snapshot, hidden) {
  if (pane.displayDOM === snapshot) return;
  const content = pane.querySelector('.display-content'), state = scrollState(content);
  state.suspended = hidden;
  if (!hidden) updateScrollIntent(content, state);
  const top = state.top;
  state.observer?.disconnect();
  const flow = document.createElement('div'); flow.className = 'display-flow';
  if (snapshot !== null) flow.append(snapshot.cloneNode(true));
  content.replaceChildren(...(snapshot === null ? [] : [flow]));
  if (!hidden) {
    content.scrollTop = state.following ? content.scrollHeight : top;
    state.top = content.scrollTop;
  }
  state.observer?.observe(content);
  if (snapshot !== null) state.observer?.observe(flow);
  pane.displayDOM = snapshot;
  pane.querySelector('button').disabled = !content.textContent;
}
function release(region) {
  for (const content of contents(region)) scrollStates.get(content)?.observer?.disconnect();
  region.remove();
}

// Each Display is an independent output. Only its numbered input ports form
// tabs; every panel stays mounted and receives its own complete snapshot.
function createDisplay(id) {
  const surface = { prefix: `live-${++nextSurface}`, active: 'input1', regions: new Map(), tabs: new Map() };
  surface.container = document.createElement('div');
  surface.container.className = 'live-display'; surface.container.dataset.display = id;
  surface.container.setAttribute('role', 'group');
  surface.strip = document.createElement('div'); surface.strip.className = 'display-tabs';
  surface.strip.setAttribute('role', 'tablist');
  surface.strip.addEventListener('keydown', event => {
    const ids = surface.order, index = ids.indexOf(event.target.dataset.tab);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % ids.length;
    if (event.key === 'ArrowLeft') next = (index + ids.length - 1) % ids.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = ids.length - 1;
    if (next !== undefined) { event.preventDefault(); activate(surface, ids[next], true); }
  });
  return surface;
}
function labelPane(pane, label) {
  pane.setAttribute('aria-label', label);
  const heading = pane.querySelector('.display-label');
  if (heading.textContent !== label) heading.textContent = label;
  pane.querySelector('button').setAttribute('aria-label', `Copy ${label} text`);
}
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'Display') || [];
  let outputs = surfaces.get(root);
  if (!outputs) { outputs = new Map(); surfaces.set(root, outputs); }
  const ids = new Set(specs.map(spec => spec.id));
  for (const [id, surface] of outputs) if (!ids.has(id)) {
    release(surface.container); outputs.delete(id);
  }
  for (const [index, spec] of specs.entries()) {
    let surface = outputs.get(spec.id);
    if (!surface) { surface = createDisplay(spec.id); outputs.set(spec.id, surface); }
    const { container, strip } = surface;
    const title = spec.settings?.title?.trim() || `Display ${spec.id}`;
    container.setAttribute('aria-label', title); strip.setAttribute('aria-label', `${title} inputs`);
    if (root.children[index] !== container) root.insertBefore(container, root.children[index] || null);
    const count = spec.settings?.inputCount ?? 1, multiple = count > 1;
    surface.order = Array.from({ length: count }, (_, i) => `input${i + 1}`);
    const ports = new Set(surface.order);
    const removedFocus = (!multiple && strip.contains(document.activeElement))
      || [...surface.tabs].some(([port, tab]) => !ports.has(port) && document.activeElement === tab)
      || [...surface.regions].some(([port, pane]) => !ports.has(port) && pane.contains(document.activeElement));
    for (const [port, pane] of surface.regions) if (!ports.has(port)) {
      release(pane); surface.regions.delete(port); surface.tabs.get(port)?.remove(); surface.tabs.delete(port);
    }
    if (!ports.has(surface.active)) surface.active = surface.order[0];
    if (multiple) { if (container.firstChild !== strip) container.prepend(strip); }
    else strip.remove();
    for (const [i, port] of surface.order.entries()) {
      const label = spec.settings?.inputLabels?.[port]?.trim() || `Input ${i + 1}`;
      let pane = surface.regions.get(port), tab = surface.tabs.get(port);
      if (!pane) {
        pane = paneFor(port, label); pane.id = `${surface.prefix}-panel-${port}`;
        pane.hidden = port !== surface.active; surface.regions.set(port, pane);
        tab = document.createElement('button'); tab.type = 'button'; tab.dataset.tab = port;
        tab.id = `${surface.prefix}-tab-${port}`; tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', pane.id); tab.onclick = () => activate(surface, port);
        surface.tabs.set(port, tab);
      }
      labelPane(pane, label);
      if (tab.textContent !== label) tab.textContent = label;
      if (multiple) { pane.setAttribute('role', 'tabpanel'); pane.setAttribute('aria-labelledby', tab.id); }
      else { pane.setAttribute('role', 'group'); pane.removeAttribute('aria-labelledby'); }
      if (multiple && strip.children[i] !== tab) strip.insertBefore(tab, strip.children[i] || null);
      const offset = multiple ? 1 : 0;
      if (container.children[i + offset] !== pane) container.insertBefore(pane, container.children[i + offset] || null);
      const nodeSnapshots = displays[spec.id];
      // Accept old host adapters' single DOM snapshot during integration too.
      const snapshot = nodeSnapshots?.nodeType ? (i === 0 ? nodeSnapshots : null) : nodeSnapshots?.[port] ?? null;
      mountSnapshot(pane, snapshot, pane.hidden);
    }
    activate(surface, surface.active, removedFocus && multiple);
    if (removedFocus && !multiple) surface.regions.get(surface.active)?.querySelector('.display-content').focus();
  }
}
