// The Live surface understands display sink types and plain text only. Processor
// identity, translation status, formatting and row correlation stay in Nodes.
export function renderTextRegions(root, graph, displays) {
  const specs = graph?.nodes.filter(node => node.type === 'LiveTextDisplay') || [];
  const existing = new Map(Array.from(root.children, region => [region.dataset.display, region]));
  for (const [index, spec] of specs.entries()) {
    let region = existing.get(spec.id);
    if (!region) {
      region = document.createElement('section'); region.className = 'panel live-text-region'; region.dataset.display = spec.id;
      const heading = document.createElement('h2'), copy = document.createElement('button'), notice = document.createElement('p'), content = document.createElement('pre');
      heading.className = 'display-label'; content.className = 'display-content';
      content.setAttribute('aria-live', 'polite'); content.setAttribute('aria-label', 'Content'); notice.setAttribute('role', 'status');
      copy.textContent = 'Copy text';
      copy.onclick = async () => {
        try { await navigator.clipboard.writeText(region.displayText); notice.textContent = 'Text copied.'; }
        catch { notice.textContent = 'Clipboard unavailable. Select and copy the text in this region.'; }
      };
      const header = document.createElement('div'); header.className = 'section-heading'; header.append(heading, copy);
      region.append(header, notice, content);
    }
    const heading = region.querySelector('h2');
    if (heading.textContent !== spec.settings.label) heading.textContent = spec.settings.label;
    region.setAttribute('aria-label', spec.settings.label); region.lang = spec.settings.language;
    const text = Object.hasOwn(displays, spec.id) ? displays[spec.id] : '';
    if (region.displayText !== text) {
      updateText(region.querySelector('.display-content'), region.displayText || '', text);
      region.displayText = text;
      region.querySelector('button').disabled = !text;
    }
    // Reattaching even the same region clears browser text selection.
    if (root.children[index] !== region) root.insertBefore(region, root.children[index] || null);
    existing.delete(spec.id);
  }
  for (const region of existing.values()) region.remove();
}

// Reconcile literal TEXT only. Bounded text nodes retain the unchanged prefix,
// selection and scroll without rebuilding a transcript-sized DOM on each event.
function updateText(root, previous, text) {
  let prefix = 0;
  while (prefix < previous.length && prefix < text.length && previous[prefix] === text[prefix]) prefix++;
  // Keep surrogate pairs in one DOM text node even at a chunk/change boundary.
  if (prefix && /[\uD800-\uDBFF]/.test(text[prefix - 1]) && /[\uDC00-\uDFFF]/.test(text[prefix] || '')) prefix--;
  let offset = 0, node = root.firstChild;
  while (node && offset + node.length <= prefix) { offset += node.length; node = node.nextSibling; }
  if (node) {
    node.deleteData(prefix - offset, node.length - (prefix - offset));
    while (node.nextSibling) node.nextSibling.remove();
    if (!node.length) node.remove();
  }
  const tail = root.lastChild;
  if (tail && tail.length < 4096) {
    const added = text.slice(prefix, chunkEnd(text, prefix, 4096 - tail.length));
    tail.appendData(added); prefix += added.length;
  }
  while (prefix < text.length) {
    const end = chunkEnd(text, prefix, 4096);
    root.append(document.createTextNode(text.slice(prefix, end))); prefix = end;
  }
}

function chunkEnd(text, start, length) {
  let end = Math.min(text.length, start + length);
  if (end > start && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return end;
}
