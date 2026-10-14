import { NODE_TYPES, graphNode, defaultGraph, edge, validateGraph, assertGraph } from './graph.js';

const el = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const button = (label, id, action) => {
  const control = el('button', label); if (id) control.id = id;
  control.type = 'button'; control.onclick = action; return control;
};
const typeLabel = contract => contract.name.split(' {')[0];
export class GraphEditor {
  constructor(root, graph, { onSave, onDraft = () => {}, onLoad = () => {} }) {
    this.root = root; this.onSave = onSave; this.onDraft = onDraft; this.onLoad = onLoad;
    this.saved = assertGraph(graph); this.draft = structuredClone(this.saved); this.zoom = 1;
    const toolbar = el('div', undefined, 'graph-toolbar');
    this.types = el('select'); this.types.setAttribute('aria-label', 'Node type'); this.types.id = 'graph-node-type';
    for (const [type, definition] of Object.entries(NODE_TYPES)) {
      const option = el('option', definition.label); option.value = type; this.types.append(option);
    }
    this.saveButton = button('Save graph', 'graph-save', async () => {
      this.saveButton.disabled = true; this.saveButton.textContent = 'Saving…';
      try {
        const graph = assertGraph(this.draft);
        this.saved = assertGraph(await this.onSave(graph) || graph);
        this.externalChange = false; this.error = ''; this.draw();
      } catch (error) { this.error = error.message; this.draw(); }
      finally { this.saveButton.disabled = false; this.saveButton.textContent = 'Save graph'; }
    });
    toolbar.append(this.types, button('Add Node', 'graph-add', () => this.addNode(this.types.value)),
      button('Reset draft to default', 'graph-reset', () => { this.draft = defaultGraph(); this.selected = null; this.selectedNode = null; this.draw(); }),
      button('Load saved', 'graph-load', () => {
        try {
          this.saved = assertGraph(this.onLoad() || this.saved);
          this.draft = structuredClone(this.saved); this.selected = null; this.selectedNode = null; this.externalChange = false;
        } catch (error) { this.error = error.message; }
        this.draw();
      }),
      button('Validate draft', 'graph-validate', () => { this.error = validateGraph(this.draft).join('\n') || 'Draft valid. Save to use next session.'; this.draw(); }), this.saveButton);
    const zoomLabel = el('label', 'Canvas zoom '); this.zoomControl = el('select'); this.zoomControl.id = 'graph-zoom';
    for (const value of [0.5, 0.75, 1, 1.25, 1.5]) { const option = el('option', `${value * 100}%`); option.value = value; this.zoomControl.append(option); }
    this.zoomControl.value = '1'; this.zoomControl.onchange = () => { this.zoom = Number(this.zoomControl.value); this.draw(); };
    this.saveButton.className = 'primary';
    zoomLabel.append(this.zoomControl); toolbar.append(zoomLabel);
    this.summary = el('p'); this.summary.id = 'graph-state'; this.summary.setAttribute('role', 'status');
    this.errors = el('pre'); this.errors.id = 'graph-errors'; this.errors.setAttribute('role', 'alert');
    this.hint = el('p', 'Connect: click an output then a matching input, or drag between ports. Reconnecting replaces only that input’s wire. Click or tap a wire to select it, then use its nearby Disconnect button. Keyboard: select with Enter/Space, Tab to Disconnect, or Delete/Backspace on a wire. Escape or clicking blank canvas clears selection. Live text display: replace updates a preview/value; append commits an item and clears the preview. Add any number of labeled displays. Text formatter uses {1}–{4}, literal newlines and {{ / }} escapes; independent inputs use their latest values. Select a Node heading for settings; drag or use arrow keys to move it.');
    const workspace = el('div', undefined, 'graph-workspace');
    const palette = el('aside', undefined, 'graph-palette'); palette.setAttribute('aria-label', 'Node palette'); palette.append(el('h2', 'Nodes'));
    for (const [type, definition] of Object.entries(NODE_TYPES)) palette.append(button(`+ ${definition.label}`, null, () => this.addNode(type)));
    this.scroll = el('div', undefined, 'graph-scroll'); this.scroll.tabIndex = 0; this.scroll.setAttribute('aria-label', 'Scrollable graph canvas');
    this.extent = el('div', undefined, 'graph-extent'); this.canvas = el('div', undefined, 'graph-canvas'); this.canvas.id = 'graph-canvas';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.classList.add('graph-wires'); this.svg.setAttribute('aria-label', 'Graph connections');
    this.disconnectButton = button('Disconnect', 'graph-disconnect', () => {
      if (this.selectedEdge) this.disconnect(this.selectedEdge);
      this.scroll.focus({ preventScroll: true });
    });
    this.disconnectButton.hidden = true;
    this.disconnectButton.onkeydown = event => {
      if (event.key === 'Tab' && event.shiftKey && this.selectedEdge) {
        event.preventDefault(); this.svg.querySelector('.selected-wire')?.focus({ preventScroll: true });
      }
    };
    this.extent.append(this.canvas); this.scroll.append(this.extent);
    this.scroll.onclick = event => {
      if (![this.scroll, this.extent, this.canvas, this.svg].includes(event.target)) return;
      this.selected = null; this.selectedEdge = null; this.draw(); this.scroll.focus({ preventScroll: true });
    };
    this.scroll.addEventListener('scroll', () => this.positionDisconnect());
    new ResizeObserver(() => this.positionDisconnect()).observe(this.scroll);
    this.inspector = el('aside', undefined, 'graph-inspector'); this.inspector.setAttribute('aria-label', 'Node settings inspector');
    workspace.append(palette, this.scroll, this.inspector);
    root.replaceChildren(toolbar, this.summary, this.hint, this.errors, workspace);
    root.addEventListener('keydown', event => {
      const wire = event.target.closest('.graph-wire');
      if (event.key === 'Escape') {
        event.preventDefault(); const restoreFocus = wire || event.target === this.disconnectButton;
        this.selected = null; this.selectedEdge = null; this.draw();
        if (restoreFocus) this.scroll.focus({ preventScroll: true });
      }
      if (['Delete', 'Backspace'].includes(event.key) && wire) {
        event.preventDefault(); event.stopPropagation(); this.disconnect(this.draft.edges[Number(wire.dataset.edge)]); this.scroll.focus({ preventScroll: true });
      }
    });
    this.draw();
  }
  addNode(type) {
    let id = type.toLowerCase(), suffix = 1;
    while (this.draft.nodes.some(node => node.id === id)) id = `${type.toLowerCase()}-${suffix++}`;
    this.draft.nodes.push(graphNode(type, id, 30 + (this.draft.nodes.length % 4) * 285, 520 + Math.floor(this.draft.nodes.length / 4) * 60));
    this.selectedNode = id; this.draw();
    this.scroll.scrollTop = this.draft.nodes.at(-1).position.y * this.zoom;
  }
  isDirty() { return JSON.stringify(this.draft) !== JSON.stringify(this.saved); }
  receiveSaved(graph) {
    const dirty = this.isDirty(); this.saved = assertGraph(graph);
    if (dirty) this.externalChange = true;
    else { this.draft = structuredClone(this.saved); this.externalChange = false; }
    this.draw();
  }
  setSaved(graph) { this.saved = assertGraph(graph); this.draft = structuredClone(this.saved); this.selected = null; this.externalChange = false; this.error = ''; this.draw(); }
  setActive(graph, state, tabId) { this.active = graph; this.state = state; this.tabId = tabId; this.updateSummary(); }
  updateSummary() {
    const running = this.state && this.state !== 'idle', pending = running && JSON.stringify(this.active) !== JSON.stringify(this.saved);
    this.summary.textContent = `${this.isDirty() ? 'Unsaved draft. ' : 'Saved graph. '}${this.externalChange ? 'Saved graph changed in another page; draft kept. Load saved before saving. ' : ''}${running ? `Active session on tab ${this.tabId}: ${pending ? 'uses an earlier graph; saved edits apply next session.' : 'uses the saved graph.'}` : 'No active recording. Next session will use the saved graph.'}`;
  }
  connect(id, port, contract) {
    if (this.selected && this.selected.contract === contract && this.selected.id !== id) {
      const proposed = edge(this.selected.id, this.selected.port, id, port);
      const identical = this.draft.edges.some(e => JSON.stringify(e) === JSON.stringify(proposed));
      if (!identical) {
        const candidate = { ...this.draft, edges: this.draft.edges.filter(e => e.to[0] !== id || e.to[1] !== port).concat(proposed) };
        // Drafts can be incomplete. Reject newly introduced constraints, while
        // allowing the ordinary missing-input/unconnected-output draft errors.
        const previous = new Set(validateGraph(this.draft));
        const errors = validateGraph(candidate).filter(message => !previous.has(message) && !/^(Required connection missing:|Unconnected output Node:)/.test(message));
        if (errors.length) this.error = errors.join('\n');
        else this.draft.edges = candidate.edges;
      }
      this.selected = null;
    }
    this.draw();
    this.canvas.querySelector(`[data-node="${id}"] [data-side="input"][data-port="${port}"]`)?.focus();
  }
  disconnect(connection) {
    this.draft.edges = this.draft.edges.filter(e => e !== connection);
    if (this.selectedEdge === connection) this.selectedEdge = null;
    this.draw();
  }
  drawInspector() {
    this.inspector.replaceChildren(el('h2', 'Settings'));
    const node = this.draft.nodes.find(node => node.id === this.selectedNode);
    if (!node) { this.inspector.append(el('p', 'Select a Node heading to inspect its settings.')); return; }
    const definition = NODE_TYPES[node.type]; this.inspector.append(el('h3', definition.label), el('p', `Node: ${node.id}`));
    for (const [key, values] of Object.entries(definition.settings || {})) {
      const label = el('label', key + ' '), select = el('select'); select.setAttribute('aria-label', `${node.id} ${key}`);
      for (const value of values) { const option = el('option', value); option.value = value; select.append(option); }
      select.value = node.settings[key]; select.onchange = () => { node.settings[key] = select.value; this.draw(); };
      label.append(select); this.inspector.append(label);
    }
    for (const [key, spec] of Object.entries(definition.textSettings || {})) {
      const label = el('label', key + ' '), control = el(spec.multiline ? 'textarea' : 'input');
      control.setAttribute('aria-label', `${node.id} ${key}`); control.maxLength = spec.maxLength; control.value = node.settings[key];
      control.onchange = () => { node.settings[key] = control.value; this.draw(); };
      label.append(control); this.inspector.append(label);
    }
    for (const key of Object.keys(definition.numberSettings || {})) {
      const label = el('label', key + ' '), control = el('input');
      control.type = 'number'; control.step = 'any'; control.value = node.settings[key];
      control.setAttribute('aria-label', `${node.id} ${key}`);
      control.oninput = () => {
        // Empty / malformed input must remain invalid, never become zero or a
        // default through coercion. JSON also preserves this as invalid null.
        node.settings[key] = control.valueAsNumber;
        this.errors.textContent = validateGraph(this.draft).join('\n'); this.updateSummary();
      };
      label.append(control); this.inspector.append(label);
    }
    if (definition.help) this.inspector.append(el('p', definition.help));
    if (!definition.settings && !definition.textSettings && !definition.numberSettings) this.inspector.append(el('p', 'This Node has no configurable settings.'));
    for (const [side, ports] of [['Input', definition.inputs], ['Output', definition.outputs]]) {
      for (const [name, contract] of Object.entries(ports)) this.inspector.append(el('p', `${side} ${name}: ${contract.name}`, 'muted'));
    }
    this.inspector.append(button('Remove selected Node', null, () => this.removeNode(node)));
  }
  removeNode(node) {
    this.draft.nodes = this.draft.nodes.filter(n => n !== node);
    this.draft.edges = this.draft.edges.filter(e => e.from[0] !== node.id && e.to[0] !== node.id);
    this.selected = null; this.selectedNode = null; this.draw();
  }
  draw() {
    if (!this.draft.edges.includes(this.selectedEdge)) this.selectedEdge = null;
    this.canvas.replaceChildren(this.svg); this.svg.replaceChildren();
    this.errors.textContent = this.error || validateGraph(this.draft).join('\n'); this.error = '';
    this.updateSummary(); this.drawInspector();
    const width = Math.max(1100, ...this.draft.nodes.map(n => n.position.x + 285)), height = Math.max(700, ...this.draft.nodes.map(n => n.position.y + 250));
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.canvas.style.transform = `scale(${this.zoom})`;
    this.extent.style.width = `${width * this.zoom}px`; this.extent.style.height = `${height * this.zoom}px`;
    for (const node of this.draft.nodes) {
      const definition = NODE_TYPES[node.type], card = el('section', undefined, 'graph-node'); card.dataset.node = node.id;
      card.classList.toggle('selected-node', this.selectedNode === node.id);
      card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
      const heading = el('button', `${definition.label} (${node.id})`, 'graph-heading'); heading.type = 'button';
      heading.setAttribute('aria-label', `Select ${node.id}`); heading.setAttribute('aria-pressed', String(this.selectedNode === node.id));
      heading.title = 'Select to inspect settings. Drag to move; arrow keys move by 10 pixels.';
      heading.onclick = () => { this.selectedEdge = null; this.drawWires(); this.selectedNode = node.id; this.drawInspector(); for (const c of this.canvas.querySelectorAll('.graph-node')) { const selected = c.dataset.node === node.id; c.classList.toggle('selected-node', selected); c.querySelector('.graph-heading').setAttribute('aria-pressed', String(selected)); } };
      heading.onkeydown = event => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta) return; event.preventDefault(); this.selectedNode = node.id;
        node.position.x = Math.max(0, Math.min(4000, node.position.x + delta[0])); node.position.y = Math.max(0, Math.min(4000, node.position.y + delta[1])); this.draw();
        this.canvas.querySelector(`[data-node="${node.id}"] .graph-heading`).focus();
      };
      heading.onpointerdown = event => {
        if (event.button !== 0) return; heading.setPointerCapture(event.pointerId); this.selectedEdge = null; this.drawWires(); this.selectedNode = node.id; this.drawInspector();
        const x = event.clientX, y = event.clientY, origin = { ...node.position }; let moved = false;
        heading.onpointermove = move => {
          if (Math.abs(move.clientX - x) + Math.abs(move.clientY - y) < 3) return;
          moved = true;
          node.position.x = Math.max(0, Math.min(4000, origin.x + (move.clientX - x) / this.zoom)); node.position.y = Math.max(0, Math.min(4000, origin.y + (move.clientY - y) / this.zoom));
          card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`; this.drawWires();
        };
        const done = () => { heading.onpointermove = null; heading.onpointerup = heading.onpointercancel = null; if (moved) this.draw(); };
        heading.onpointerup = heading.onpointercancel = done;
      };
      const remove = button('Remove', null, () => this.removeNode(node)); remove.setAttribute('aria-label', `Remove ${node.id}`);
      card.append(heading, remove);
      const ports = el('div', undefined, 'graph-ports');
      for (const [side, declarations] of [['input', definition.inputs], ['output', definition.outputs]]) {
        const column = el('div');
        for (const [port, contract] of Object.entries(declarations)) {
          const control = button(`${side === 'input' ? '←' : '→'} ${port}`, null, () => {
            this.selectedEdge = null;
            if (side === 'output') this.selected = this.selected?.id === node.id && this.selected.port === port ? null : { id: node.id, port, contract };
            else return this.connect(node.id, port, contract);
            this.draw();
            this.canvas.querySelector(`[data-node="${node.id}"] [data-side="output"][data-port="${port}"]`)?.focus();
          });
          control.append(el('small', typeLabel(contract)));
          control.dataset.port = port; control.dataset.side = side; control.title = `${side}: ${port} (${contract.name})`;
          control.setAttribute('aria-label', `${node.id} ${side} ${port}`);
          if (side === 'input' && this.selected) control.disabled = this.selected.contract !== contract || this.selected.id === node.id;
          if (side === 'output') {
            control.setAttribute('aria-pressed', String(this.selected?.id === node.id && this.selected.port === port));
            control.draggable = true;
            control.ondragstart = event => {
              this.selected = { id: node.id, port, contract }; event.dataTransfer.setData('text/plain', `${node.id}.${port}`);
              for (const input of this.canvas.querySelectorAll('[data-side="input"]')) {
                const target = this.draft.nodes.find(n => n.id === input.closest('[data-node]').dataset.node);
                input.disabled = target.id === node.id || NODE_TYPES[target.type].inputs[input.dataset.port] !== contract;
              }
            };
            control.ondragend = () => { this.selected = null; this.draw(); };
          } else {
            control.ondragover = event => { if (this.selected?.contract === contract && this.selected.id !== node.id) event.preventDefault(); };
            control.ondrop = event => { event.preventDefault(); this.connect(node.id, port, contract); };
          }
          control.classList.toggle('selected-port', side === 'output' && this.selected?.id === node.id && this.selected.port === port);
          column.append(control);
        }
        ports.append(column);
      }
      card.append(ports); this.canvas.append(card);
    }
    // Multi-output Nodes can be taller than the old fixed card estimate.
    const renderedHeight = Math.max(height, ...Array.from(this.canvas.querySelectorAll('.graph-node'), card => card.offsetTop + card.offsetHeight + 20));
    this.canvas.style.height = `${renderedHeight}px`;
    this.extent.style.height = `${renderedHeight * this.zoom}px`;
    this.canvas.append(this.disconnectButton);
    this.drawWires(); this.onDraft(structuredClone(this.draft));
  }
  drawWires() {
    this.svg.replaceChildren(); const origin = this.canvas.getBoundingClientRect();
    for (const [index, connection] of this.draft.edges.entries()) {
      const { from, to } = connection;
      const port = (pair, side) => this.canvas.querySelector(`[data-node="${pair[0]}"] [data-side="${side}"][data-port="${pair[1]}"]`);
      const a = port(from, 'output')?.getBoundingClientRect(), b = port(to, 'input')?.getBoundingClientRect();
      if (!a || !b) continue;
      const x1 = (a.right - origin.left) / this.zoom, y1 = (a.top + a.height / 2 - origin.top) / this.zoom, x2 = (b.left - origin.left) / this.zoom, y2 = (b.top + b.height / 2 - origin.top) / this.zoom;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`);
      path.classList.add('wire-line');
      const hit = path.cloneNode(); hit.classList.remove('wire-line'); hit.classList.add('wire-hit');
      hit.style.strokeWidth = `${16 / this.zoom}px`;
      const wire = document.createElementNS('http://www.w3.org/2000/svg', 'g'); wire.classList.add('graph-wire'); wire.dataset.edge = index;
      wire.setAttribute('tabindex', '0'); wire.setAttribute('role', 'button');
      wire.setAttribute('aria-label', `Select connection ${from.join('.')} to ${to.join('.')}`);
      wire.setAttribute('aria-pressed', String(this.selectedEdge === connection));
      wire.classList.toggle('selected-wire', this.selectedEdge === connection);
      const select = event => {
        event.preventDefault(); event.stopPropagation(); this.selectedEdge = connection; this.selected = null; this.selectedNode = null;
        const position = this.canvas.getBoundingClientRect();
        this.selectedPoint = event.type === 'click' && event.detail ? { x: (event.clientX - position.left) / this.zoom, y: (event.clientY - position.top) / this.zoom } : null;
        this.draw(); this.svg.querySelector(`[data-edge="${index}"]`).focus({ preventScroll: true });
      };
      wire.onclick = select;
      wire.onpointerdown = event => event.stopPropagation();
      wire.onkeydown = event => {
        if (['Enter', ' '].includes(event.key)) select(event);
        if (event.key === 'Tab' && !event.shiftKey && this.selectedEdge === connection && !this.disconnectButton.hidden) {
          event.preventDefault(); this.disconnectButton.focus({ preventScroll: true });
        }
      };
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${from.join('.')} → ${to.join('.')}. Select, then use Disconnect or Delete/Backspace.`;
      wire.append(title, path, hit); this.svg.append(wire);
    }
    this.positionDisconnect();
  }
  positionDisconnect() {
    const path = this.selectedEdge && this.svg.querySelector('.selected-wire .wire-line');
    this.disconnectButton.hidden = !path;
    if (!path) return;
    this.disconnectButton.setAttribute('aria-label', `Disconnect ${this.selectedEdge.from.join('.')} to ${this.selectedEdge.to.join('.')}`);
    // Cancel the canvas scale so the native button stays a 44px touch target.
    this.disconnectButton.style.transform = `scale(${1 / this.zoom})`;
    const origin = this.canvas.getBoundingClientRect(), viewport = this.scroll.getBoundingClientRect();
    const left = Math.max(0, viewport.left + 8 - origin.left), top = Math.max(0, viewport.top + 8 - origin.top);
    const right = Math.min(origin.width, viewport.right - origin.left - 8), bottom = Math.min(origin.height, viewport.bottom - origin.top - 8);
    const width = this.disconnectButton.offsetWidth, height = this.disconnectButton.offsetHeight;
    const sample = line => {
      const length = line.getTotalLength();
      return Array.from({ length: 21 }, (_, i) => {
        const p = line.getPointAtLength(length * i / 20);
        return { x: p.x * this.zoom, y: p.y * this.zoom };
      });
    };
    const points = sample(path).filter(p => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom);
    // A short visible segment of a long wire may fall between samples. Keep
    // the actual pointer/touch selection point available as an anchor too.
    const anchor = this.selectedPoint && { x: this.selectedPoint.x * this.zoom, y: this.selectedPoint.y * this.zoom };
    if (anchor && anchor.x >= left - 8 && anchor.x <= right + 8 && anchor.y >= top - 8 && anchor.y <= bottom + 8) points.push(anchor);
    this.disconnectButton.hidden = !points.length;
    if (!points.length) return;
    const bounds = node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top };
    };
    const nodes = Array.from(this.canvas.querySelectorAll('.graph-node'), bounds);
    const ports = Array.from(this.canvas.querySelectorAll('.graph-ports button'), bounds);
    const wires = Array.from(this.svg.querySelectorAll('.wire-line'), sample).flat();
    let best;
    // Prefer the middle of the visible segment, then nearby free space. Penalize
    // covering cards/ports first, and wires second; clamp to the visible canvas.
    for (const [index, p] of points.entries()) {
      const candidates = [[p.x - width / 2, p.y - height - 12], [p.x - width / 2, p.y + 12], [p.x + 12, p.y - height / 2], [p.x - width - 12, p.y - height / 2]];
      // Tight gaps between cards cannot fit a labeled touch target. Also try
      // just outside their boundaries, instead of covering a neighboring port.
      for (const n of [...nodes, ...ports]) candidates.push([n.left - width - 12, p.y - height / 2], [n.right + 12, p.y - height / 2], [p.x - width / 2, n.top - height - 12], [p.x - width / 2, n.bottom + 12]);
      for (const [cx, cy] of candidates) {
        const x = Math.max(left, Math.min(right - width, cx)), y = Math.max(top, Math.min(bottom - height, cy));
        const overlaps = boxes => boxes.filter(n => x < n.right + 6 && x + width > n.left - 6 && y < n.bottom + 6 && y + height > n.top - 6).length;
        const covered = wires.filter(w => w.x >= x - 6 && w.x <= x + width + 6 && w.y >= y - 6 && w.y <= y + height + 6).length;
        const distance = Math.hypot(x + width / 2 - p.x, y + height / 2 - p.y);
        const score = overlaps(ports) * 1000000 + overlaps(nodes) * 10000 + covered * 100 + distance / 10 + Math.abs(index - (points.length - 1) / 2);
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    this.disconnectButton.style.left = `${best.x / this.zoom}px`;
    this.disconnectButton.style.top = `${best.y / this.zoom}px`;
  }
}
