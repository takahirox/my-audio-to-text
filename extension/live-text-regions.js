import { cloneDOM } from '../web/dom-nodes.js';

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
    const snapshot = Object.hasOwn(displays, spec.id) ? displays[spec.id] : null;
    if (region.displayDOM !== snapshot) {
      const content = region.querySelector('.display-content');
      content.replaceChildren(...(snapshot === null ? [] : [cloneDOM(snapshot)]));
      region.displayDOM = snapshot;
      // Styles are presentation, not part of the copyable document text.
      const copy = content.cloneNode(true);
      for (const style of copy.querySelectorAll('style')) style.remove();
      region.displayText = copy.textContent;
      region.querySelector('button').disabled = !region.displayText;
    }
    // Reattaching even the same region clears browser text selection.
    if (root.children[index] !== region) root.insertBefore(region, root.children[index] || null);
    existing.delete(spec.id);
  }
  for (const region of existing.values()) region.remove();
}
