// The Live surface understands display sink types and plain text only. Processor
// identity, translation status, formatting and row correlation stay in Nodes.
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'LiveTextDisplay') || [];
  const existing = new Map(Array.from(root.children, region => [region.dataset.display, region]));
  for (const spec of specs) {
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
    region.querySelector('h2').textContent = spec.settings.label;
    region.setAttribute('aria-label', spec.settings.label); region.lang = spec.settings.language;
    const state = (Object.hasOwn(displays, spec.id) && displays[spec.id]) || { preview: '', items: [] };
    if (region.displayState !== state) {
      const items = region.querySelector('ol');
      items.replaceChildren(...state.items.map(text => {
        const item = document.createElement('li'), value = document.createElement('pre'); value.textContent = text; item.append(value, '\n'); return item;
      }));
      region.querySelector('.display-preview').textContent = state.preview;
      region.displayText = [...state.items, ...(state.preview ? [state.preview] : [])].join('\n');
      region.querySelector('button').disabled = !region.displayText;
      region.displayState = state;
    }
    root.append(region); existing.delete(spec.id);
  }
  for (const region of existing.values()) region.remove();
}
