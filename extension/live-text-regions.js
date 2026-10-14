// The Live surface understands display sink types and plain text only. Processor
// identity, translation status, formatting and row correlation stay in Nodes.
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'LiveTextDisplay') || [];
  const existing = new Map(Array.from(root.children, region => [region.dataset.display, region]));
  for (const [index, spec] of specs.entries()) {
    let region = existing.get(spec.id);
    if (!region) {
      region = document.createElement('section'); region.className = 'panel live-text-region'; region.dataset.display = spec.id;
      const heading = document.createElement('h2'), copy = document.createElement('button'), notice = document.createElement('p'), preview = document.createElement('pre'), items = document.createElement('ol');
      heading.className = 'display-label'; preview.className = 'display-preview'; items.className = 'display-items';
      preview.setAttribute('aria-live', 'polite'); items.setAttribute('aria-live', 'polite'); notice.setAttribute('role', 'status');
      copy.textContent = 'Copy text';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(region.displayText); notice.textContent = 'Text copied.'; }
        catch { notice.textContent = 'Clipboard unavailable. Select and copy the text in this region.'; }
      };
      region.append(heading, copy, notice, items, preview);
    }
    const heading = region.querySelector('h2');
    if (heading.textContent !== spec.settings.label) heading.textContent = spec.settings.label;
    region.setAttribute('aria-label', spec.settings.label); region.lang = spec.settings.language;
    const state = (Object.hasOwn(displays, spec.id) && displays[spec.id]) || { preview: '', items: [] };
    if (region.displayState !== state) {
      const items = region.querySelector('ol');
      const previous = region.displayState?.items || [];
      let prefix = 0;
      while (prefix < previous.length && prefix < state.items.length && previous[prefix] === state.items[prefix]) prefix++;
      // Keep the unchanged prefix attached, including repeated and empty items.
      // Shorter/replaced histories (including new sessions) remove stale tails.
      while (items.children.length > prefix) items.lastElementChild.remove();
      for (const text of state.items.slice(prefix)) {
        const item = document.createElement('li'), value = document.createElement('pre'); value.textContent = text; item.append(value, '\n'); items.append(item);
      }
      const preview = region.querySelector('.display-preview');
      if (preview.textContent !== state.preview) preview.textContent = state.preview;
      region.displayText = [...state.items, ...(state.preview ? [state.preview] : [])].join('\n');
      region.querySelector('button').disabled = !region.displayText;
      region.displayState = state;
    }
    // Reattaching even the same region clears browser text selection.
    if (root.children[index] !== region) root.insertBefore(region, root.children[index] || null);
    existing.delete(spec.id);
  }
  for (const region of existing.values()) region.remove();
}
