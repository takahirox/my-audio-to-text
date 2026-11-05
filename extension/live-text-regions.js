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

// Tabs change presentation only. Every pane stays mounted, including hidden
// panes, and receives only its own complete DOM snapshot from the runtime.
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'Display') || [];
  let surface = surfaces.get(root);
  if (!surface) {
    surface = { prefix: `live-${++nextSurface}`, active: null, regions: new Map(), tabs: new Map() };
    surface.strip = document.createElement('div'); surface.strip.className = 'display-tabs';
    surface.strip.setAttribute('role', 'tablist'); surface.strip.setAttribute('aria-label', 'Live displays');
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
    surfaces.set(root, surface);
  }
  surface.order = specs.map(spec => spec.id);
  const ids = new Set(surface.order), multiple = specs.length > 1;
  for (const [id, region] of surface.regions) if (!ids.has(id)) {
    release(region); surface.regions.delete(id); surface.tabs.get(id)?.remove(); surface.tabs.delete(id);
  }
  if (!ids.has(surface.active)) surface.active = specs[0]?.id ?? null;
  if (multiple) { if (root.firstChild !== surface.strip) root.prepend(surface.strip); }
  else surface.strip.remove();
  for (const [index, spec] of specs.entries()) {
    const label = spec.settings?.title?.trim() || `Display ${spec.id}`;
    let region = surface.regions.get(spec.id), tab = surface.tabs.get(spec.id);
    if (!region) {
      region = document.createElement('div'); region.className = 'live-display'; region.dataset.display = spec.id;
      region.id = `${surface.prefix}-panel-${spec.id}`; region.hidden = spec.id !== surface.active;
      surface.regions.set(spec.id, region);
      tab = document.createElement('button'); tab.type = 'button'; tab.dataset.tab = spec.id;
      tab.id = `${surface.prefix}-tab-${spec.id}`; tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', region.id); tab.onclick = () => activate(surface, spec.id);
      surface.tabs.set(spec.id, tab);
    }
    if (tab.textContent !== label) tab.textContent = label;
    region.setAttribute('aria-label', label);
    if (multiple) { region.setAttribute('role', 'tabpanel'); region.setAttribute('aria-labelledby', tab.id); }
    else { region.setAttribute('role', 'group'); region.removeAttribute('aria-labelledby'); }
    if (multiple && surface.strip.children[index] !== tab) surface.strip.insertBefore(tab, surface.strip.children[index] || null);
    const offset = multiple ? 1 : 0;
    if (root.children[index + offset] !== region) root.insertBefore(region, root.children[index + offset] || null);
    const count = spec.settings?.inputCount ?? 1;
    const ports = new Set(Array.from({ length: count }, (_, i) => `input${i + 1}`));
    for (const pane of [...region.children]) if (!ports.has(pane.dataset.port)) release(pane);
    for (const [i, port] of [...ports].entries()) {
      let pane = region.children[i];
      if (!pane) { pane = paneFor(port, `Input ${i + 1}`); region.append(pane); }
      const nodeSnapshots = displays[spec.id];
      // Accept old host adapters' single DOM snapshot during integration too.
      const snapshot = nodeSnapshots?.nodeType ? (i === 0 ? nodeSnapshots : null) : nodeSnapshots?.[port] ?? null;
      mountSnapshot(pane, snapshot, region.hidden);
    }
  }
  activate(surface, surface.active);
}
