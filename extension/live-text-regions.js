import { cloneDOM } from '../web/dom-nodes.js';

const scrollStates = new WeakMap();
const nearBottom = content => content.scrollHeight - content.clientHeight - content.scrollTop <= 24;
function updateScrollIntent(content, state) {
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
    // Observe the viewport and snapshot roots: wrapping, font/layout changes,
    // and a resized Live window can change the bottom after the initial mount.
    if (typeof ResizeObserver !== 'undefined') state.observer = new ResizeObserver(() => {
      if (state.following) content.scrollTop = content.scrollHeight;
      state.top = content.scrollTop;
    });
    scrollStates.set(content, state);
  }
  return scrollStates.get(content);
}

// The Live surface only mounts DOM snapshots. Processor
// identity, translation status, formatting and row correlation stay in Nodes.
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'LiveTextDisplay') || [];
  const existing = new Map(Array.from(root.children, region => [region.dataset.display, region]));
  for (const [index, spec] of specs.entries()) {
    let region = existing.get(spec.id);
    if (!region) {
      region = document.createElement('section'); region.className = 'panel live-text-region'; region.dataset.display = spec.id;
      const heading = document.createElement('h2'), copy = document.createElement('button'), notice = document.createElement('p'), content = document.createElement('div');
      heading.className = 'display-label'; content.className = 'display-content';
      content.tabIndex = 0; content.setAttribute('aria-live', 'polite'); content.setAttribute('aria-label', 'Content'); notice.setAttribute('role', 'status');
      copy.textContent = 'Copy text';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(region.querySelector('.display-content').innerText); notice.textContent = 'Text copied.'; }
        catch { notice.textContent = 'Clipboard unavailable. Select and copy the text in this region.'; }
      };
      const header = document.createElement('div'); header.className = 'section-heading'; header.append(heading, copy);
      region.append(header, notice, content);
    }
    const heading = region.querySelector('h2');
    if (heading.textContent !== spec.settings.label) heading.textContent = spec.settings.label;
    region.setAttribute('aria-label', spec.settings.label); region.lang = spec.settings.language;
    // Mount new regions before measuring layout. Reattaching an existing region
    // unnecessarily would clear browser text selection.
    if (root.children[index] !== region) root.insertBefore(region, root.children[index] || null);
    const snapshot = Object.hasOwn(displays, spec.id) ? displays[spec.id] : null;
    if (region.displayDOM !== snapshot) {
      const content = region.querySelector('.display-content');
      const state = scrollState(content), top = content.scrollTop;
      // Also catch user scrolling whose event has not yet been delivered.
      updateScrollIntent(content, state);
      state.observer?.disconnect();
      content.replaceChildren(...(snapshot === null ? [] : [cloneDOM(snapshot)]));
      // Explicitly restore after replaceChildren and synchronous layout; browser
      // anchoring is disabled in CSS. Shorter content naturally clamps the offset.
      content.scrollTop = state.following ? content.scrollHeight : top;
      state.top = content.scrollTop;
      state.observer?.observe(content);
      for (const child of content.children) state.observer?.observe(child);
      region.displayDOM = snapshot;
      // Styles are presentation, not part of the copyable document text.
      const copy = content.cloneNode(true);
      for (const style of copy.querySelectorAll('style')) style.remove();
      region.displayText = copy.textContent;
      region.querySelector('button').disabled = !region.displayText;
    }
    existing.delete(spec.id);
  }
  for (const region of existing.values()) {
    scrollStates.get(region.querySelector('.display-content'))?.observer?.disconnect();
    region.remove();
  }
}
