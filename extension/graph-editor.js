import { NODE_TYPES, graphNode, defaultGraph, edge, validateGraph, assertGraph } from './graph.js';

const el = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
export class GraphEditor {
  constructor(root, graph, { onSave, onDraft = () => {} }) {
    this.root = root; this.onSave = onSave; this.onDraft = onDraft; this.saved = assertGraph(graph); this.draft = structuredClone(graph);
    const toolbar = el('div', undefined, 'graph-toolbar');
    this.types = el('select'); this.types.setAttribute('aria-label', 'Node type'); this.types.id = 'graph-node-type';
    for (const [type, definition] of Object.entries(NODE_TYPES)) {
      const option = el('option', definition.label); option.value = type; this.types.append(option);
    }
    const button = (label, id, action) => { const control = el('button', label); control.id = id; control.type = 'button'; control.onclick = action; return control; };
    toolbar.append(this.types, button('Add Node', 'graph-add', () => {
      let id = this.types.value.toLowerCase(), suffix = 1;
      while (this.draft.nodes.some(node => node.id === id)) id = `${this.types.value.toLowerCase()}-${suffix++}`;
      this.draft.nodes.push(graphNode(this.types.value, id, 30 + (this.draft.nodes.length % 4) * 250, 450)); this.draw();
    }), button('Reset draft to default', 'graph-reset', () => { this.draft = defaultGraph(); this.selected = null; this.draw(); }),
    button('Load saved', 'graph-load', () => { this.draft = structuredClone(this.saved); this.selected = null; this.draw(); }),
    button('Save graph', 'graph-save', () => {
      try {
        const graph = assertGraph(this.draft); this.onSave(graph); this.saved = graph; this.error = ''; this.draw();
      } catch (error) { this.error = error.message; this.draw(); }
    }));
    this.summary = el('p'); this.summary.id = 'graph-state'; this.summary.setAttribute('role', 'status');
    this.errors = el('pre'); this.errors.id = 'graph-errors'; this.errors.setAttribute('role', 'alert');
    this.hint = el('p', 'Click an output port, then a compatible input port. Drag a Node heading to move it. Select Disconnect below to remove a link. Edits apply after Save, at the next session.');
    this.scroll = el('div', undefined, 'graph-scroll'); this.canvas = el('div', undefined, 'graph-canvas'); this.canvas.id = 'graph-canvas';
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.classList.add('graph-wires'); this.svg.setAttribute('aria-hidden', 'true');
    this.scroll.append(this.canvas); this.connections = el('ul'); this.connections.id = 'graph-connections';
    root.replaceChildren(toolbar, this.summary, this.hint, this.errors, this.scroll, this.connections); this.draw();
  }
  setSaved(graph) { this.saved = assertGraph(graph); this.draft = structuredClone(graph); this.selected = null; this.error = ''; this.draw(); }
  setActive(graph, state) { this.active = graph; this.state = state; this.updateSummary(); }
  updateSummary() {
    const dirty = JSON.stringify(this.draft) !== JSON.stringify(this.saved);
    const running = this.state && this.state !== 'idle';
    const pending = running && JSON.stringify(this.active) !== JSON.stringify(this.saved);
    this.summary.textContent = `${dirty ? 'Unsaved draft. ' : 'Saved graph. '}${running ? (pending ? 'Active session uses an earlier graph; saved edits apply next session.' : 'Active session uses the saved graph.') : 'Next session will use the saved graph.'}`;
  }
  draw() {
    this.canvas.replaceChildren(this.svg); this.svg.replaceChildren(); this.connections.replaceChildren();
    const errors = validateGraph(this.draft); this.errors.textContent = this.error || errors.join('\n'); this.error = '';
    this.updateSummary();
    this.canvas.style.width = `${Math.max(800, ...this.draft.nodes.map(n => n.position.x + 245))}px`;
    this.canvas.style.height = `${Math.max(520, ...this.draft.nodes.map(n => n.position.y + 240))}px`;
    for (const node of this.draft.nodes) {
      const definition = NODE_TYPES[node.type], card = el('section', undefined, 'graph-node'); card.dataset.node = node.id;
      card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
      const heading = el('div', `${definition.label} (${node.id})`, 'graph-heading'); heading.tabIndex = 0;
      heading.title = 'Drag to move; arrow keys move by 10 pixels.';
      heading.onkeydown = event => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta) return; event.preventDefault();
        node.position.x = Math.max(0, Math.min(4000, node.position.x + delta[0])); node.position.y = Math.max(0, Math.min(4000, node.position.y + delta[1])); this.draw();
        this.canvas.querySelector(`[data-node="${node.id}"] .graph-heading`).focus();
      };
      heading.onpointerdown = event => {
        if (event.button !== 0) return; event.preventDefault(); heading.setPointerCapture(event.pointerId);
        const x = event.clientX, y = event.clientY, origin = { ...node.position };
        heading.onpointermove = move => {
          node.position.x = Math.max(0, Math.min(4000, origin.x + move.clientX - x)); node.position.y = Math.max(0, Math.min(4000, origin.y + move.clientY - y));
          card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`; this.drawWires();
        };
        const done = () => { heading.onpointermove = null; heading.onpointerup = heading.onpointercancel = null; this.draw(); };
        heading.onpointerup = heading.onpointercancel = done;
      };
      const remove = el('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${node.id}`);
      remove.onclick = () => { this.draft.nodes = this.draft.nodes.filter(n => n !== node); this.draft.edges = this.draft.edges.filter(e => e.from[0] !== node.id && e.to[0] !== node.id); this.selected = null; this.draw(); };
      card.append(heading, remove);
      for (const [key, values] of Object.entries(definition.settings || {})) {
        const label = el('label', key + ' '), select = el('select'); select.setAttribute('aria-label', `${node.id} ${key}`);
        for (const value of values) { const option = el('option', value); option.value = value; select.append(option); }
        select.value = node.settings[key]; select.onchange = () => { node.settings[key] = select.value; this.draw(); };
        label.append(select); card.append(label);
      }
      const ports = el('div', undefined, 'graph-ports');
      for (const [side, declarations] of [['input', definition.inputs], ['output', definition.outputs]]) {
        const column = el('div');
        for (const [port, contract] of Object.entries(declarations)) {
          const control = el('button', `${side === 'input' ? '←' : '→'} ${port}`); control.type = 'button';
          control.dataset.port = port; control.dataset.side = side;
          control.title = `${side}: ${port} (${contract.name})`; control.setAttribute('aria-label', `${node.id} ${side} ${port}`);
          if (side === 'input' && this.selected) control.disabled = this.selected.contract !== contract || this.selected.id === node.id;
          control.classList.toggle('selected-port', side === 'output' && this.selected?.id === node.id && this.selected.port === port);
          control.onclick = () => {
            if (side === 'output') this.selected = this.selected?.id === node.id && this.selected.port === port ? null : { id: node.id, port, contract };
            else if (this.selected) { this.draft.edges.push(edge(this.selected.id, this.selected.port, node.id, port)); this.selected = null; }
            this.draw();
          };
          column.append(control);
        }
        ports.append(column);
      }
      card.append(ports); this.canvas.append(card);
    }
    for (const [index, connection] of this.draft.edges.entries()) {
      const row = el('li', `${connection.from.join('.')} → ${connection.to.join('.')} `), disconnect = el('button', 'Disconnect'); disconnect.type = 'button';
      disconnect.setAttribute('aria-label', `Disconnect ${connection.from.join('.')} to ${connection.to.join('.')}`);
      disconnect.onclick = () => { this.draft.edges.splice(index, 1); this.draw(); }; row.append(disconnect); this.connections.append(row);
    }
    this.drawWires(); this.onDraft(structuredClone(this.draft));
  }
  drawWires() {
    this.svg.replaceChildren(); const origin = this.canvas.getBoundingClientRect();
    for (const { from, to } of this.draft.edges) {
      const port = (pair, side) => this.canvas.querySelector(`[data-node="${pair[0]}"] [data-side="${side}"][data-port="${pair[1]}"]`);
      const a = port(from, 'output')?.getBoundingClientRect(), b = port(to, 'input')?.getBoundingClientRect();
      if (!a || !b) continue;
      const x1 = a.right - origin.left, y1 = a.top + a.height / 2 - origin.top, x2 = b.left - origin.left, y2 = b.top + b.height / 2 - origin.top;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M${x1},${y1} C${x1 + 60},${y1} ${x2 - 60},${y2} ${x2},${y2}`); this.svg.append(path);
    }
  }
}
