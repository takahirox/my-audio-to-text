import { assertSubgraph, extractSubgraph, resolveSubgraphs } from './subgraphs.js';
import { assertSubgraphUpdate } from './graph-library.js';
import { MAX_DISPLAY_INPUTS } from '../web/display-node.js';
import { createWireRouter, reusableWireRoute, wireColor, wireDistance } from './graph-wire-router.js';
import { compatiblePorts } from '../web/port-contracts.js';
import { NODE_TYPES, nodeDefinition, portDisplayEntries, graphNode, defaultGraph, edge, validateGraph, graphWarnings, assertGraph } from './graph.js';

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
const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5];
const MIN_ZOOM = .01, MAX_ZOOM = 1.5, ZOOM_STEP = .1;
// Leave room below content for the unscaled viewport controls.
const VIEWPORT_CONTROL_SPACE = 72;
const typeLabel = contract => contract.name.split(' {')[0];
export class GraphEditor {
  constructor(root, graph, { onSave, onDraft = () => {}, onLoad = () => {}, invalidSaved = false, definitions = [], kind = 'graph', graphId, onCreateSubgraph, onExport, onEditSubgraph }) {
    Object.assign(this, { definitions, kind, graphId, onCreateSubgraph, onExport, onEditSubgraph });
    this.multiSelection = new Set();
    this.root = root; this.onSave = onSave; this.onDraft = onDraft; this.onLoad = onLoad;
    this.saved = invalidSaved ? null : this.assert(graph); this.draft = this.assert(graph); this.zoom = 1;
    const toolbar = el('div', undefined, 'graph-toolbar');
    this.saveButton = button('Save', 'graph-save', async () => {
      this.actions.open = false; this.saveButton.disabled = true; this.saveButton.setAttribute('aria-busy', 'true'); this.summary.textContent = 'Saving…';
      try {
        const graph = this.assert(this.draft);
        this.saved = this.assert(await this.onSave(graph) || graph);
        this.externalChange = false; this.error = ''; this.draw();
      } catch (error) { this.error = error.message; this.draw(); }
      finally { this.saveButton.disabled = false; this.saveButton.setAttribute('aria-busy', 'false'); }
    });
    this.saveButton.className = 'primary'; this.saveButton.setAttribute('aria-label', 'Save graph');
    this.saveButton.title = 'Save graph for the next session';
    const status = el('div', undefined, 'graph-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-atomic', 'true');
    this.summary = el('p'); this.summary.id = 'graph-state';
    this.activity = el('span', undefined, 'graph-activity'); this.activity.hidden = true;
    status.append(this.summary, this.activity);
    this.actions = el('details', undefined, 'graph-actions');
    const actionsTrigger = el('summary', '…'); actionsTrigger.setAttribute('aria-label', 'Graph actions'); actionsTrigger.title = 'Graph actions';
    this.actions.append(actionsTrigger);
    const commands = el('div', undefined, 'graph-command-list');
    commands.append(
      button('Reset draft to default', 'graph-reset', () => {
        if (this.isDirty() && !confirm('Replace your unsaved draft with the default graph? Save is still required.')) return;
        this.closeActions(); this.draft = this.kind === 'subgraph' ? { version: 15, nodes: [], edges: [], interface: { inputs: [], outputs: [] } } : defaultGraph(); this.selected = null; this.selectedNode = null; this.draw();
      }),
      button('Load saved', 'graph-load', () => {
        if (this.isDirty() && !confirm('Discard your unsaved draft and load the saved graph?')) return;
        this.closeActions();
        try {
          this.saved = this.assert(this.onLoad() || this.saved);
          this.draft = structuredClone(this.saved); this.selected = null; this.selectedNode = null; this.externalChange = false;
        } catch (error) { this.error = error.message; }
        this.draw();
      }),
      button('Validate draft', 'graph-validate', () => { this.closeActions(); this.error = this.diagnostics(true) || 'Draft valid. Save to use next session.'; this.draw(); }));
    const importFile = el('input'); importFile.type = 'file'; importFile.accept = '.json,application/json'; importFile.hidden = true;
    importFile.onchange = async () => {
      const file = importFile.files?.[0]; if (!file) return;
      try {
        const value = JSON.parse(await file.text());
        if (value?.format === 'graph-bundle') throw Error('Import dependency bundles in Graph Library to preserve shared identities.');
        const next = this.assert(value);
        if (this.isDirty() && !confirm('Replace your unsaved draft with the imported graph? Save is still required.')) return;
        this.draft = next; this.selected = null; this.selectedNode = null; this.selectedEdge = null; this.error = ''; this.closeActions();
      } catch (error) { this.error = `Cannot import graph: ${error.message}`; }
      finally { importFile.value = ''; this.draw(); }
    };
    commands.append(button('Import graph JSON', 'graph-import', () => importFile.click()), importFile);
    commands.append(button('Export graph JSON', 'graph-export', () => {
      try {
        const graph = this.onExport ? structuredClone(this.draft) : this.assert(this.draft);
        const url = URL.createObjectURL(new Blob([this.onExport ? this.onExport(graph) : JSON.stringify(graph, null, 2) + '\n'], { type: 'application/json' }));
        const link = el('a'); link.href = url; link.download = 'processing-graph.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        this.error = ''; this.closeActions();
      } catch (error) { this.error = `Cannot export graph: ${error.message}`; }
      this.draw();
    }));
    this.createButton = button('Create Subgraph', 'graph-create-subgraph', () => this.createSubgraph());
    this.createButton.hidden = this.kind === 'subgraph' || !this.onCreateSubgraph;
    commands.append(this.createButton);
    if (this.kind === 'subgraph') commands.append(button('Edit exposed ports', 'graph-exposed-ports', () => { this.closeActions(); this.selectDetails(); this.inspector.querySelector('input, button')?.focus(); }));
    const warningLabel = el('label'); this.warningPreference = el('input'); this.warningPreference.type = 'checkbox';
    this.warningPreference.id = 'graph-optional-warnings';
    this.warningPreference.checked = localStorage.getItem('graph-show-optional-warnings') === 'true';
    this.warningPreference.onchange = () => {
      localStorage.setItem('graph-show-optional-warnings', String(this.warningPreference.checked)); this.draw();
    };
    warningLabel.append(this.warningPreference, ' Show optional warnings'); commands.append(warningLabel);
    this.actions.append(commands);
    this.paletteButton = button('Add Node', 'graph-palette-toggle', () => this.togglePalette()); this.paletteButton.setAttribute('aria-haspopup', 'dialog'); this.paletteButton.setAttribute('aria-expanded', 'false'); this.paletteButton.setAttribute('aria-controls', 'graph-palette');
    toolbar.append(status, this.paletteButton, this.saveButton, this.actions);
    // Only exceptional states get a row; routine Live activity stays in the toolbar.
    this.stateNotice = el('p', undefined, 'graph-state-notice'); this.stateNotice.setAttribute('role', 'status'); this.stateNotice.setAttribute('aria-atomic', 'true'); this.stateNotice.hidden = true;
    this.errors = el('pre'); this.errors.id = 'graph-errors'; this.errors.setAttribute('role', 'alert');
    this.workspace = el('div', undefined, 'graph-workspace');
    this.palette = el('aside', undefined, 'graph-palette'); this.palette.id = 'graph-palette'; this.palette.hidden = true;
    this.palette.setAttribute('role', 'dialog'); this.palette.setAttribute('aria-label', 'Add Node');
    this.search = el('input'); this.search.type = 'search'; this.search.placeholder = 'Search nodes'; this.search.setAttribute('aria-label', 'Search nodes');
    this.search.setAttribute('role', 'combobox'); this.search.setAttribute('aria-autocomplete', 'list');
    this.search.setAttribute('aria-controls', 'graph-node-type'); this.search.setAttribute('aria-expanded', 'false');
    this.category = el('select'); this.category.setAttribute('aria-label', 'Node category');
    for (const name of ['All categories', 'Sources / inputs', 'Processors', 'Constants / utilities', 'Outputs', 'Subgraphs']) { const option = el('option', name); this.category.append(option); }
    this.types = el('div', undefined, 'graph-node-list'); this.types.id = 'graph-node-type';
    this.types.setAttribute('role', 'listbox'); this.types.setAttribute('aria-label', 'Node types');
    this.paletteStatus = el('p', undefined, 'muted'); this.paletteStatus.setAttribute('role', 'status');
    this.search.oninput = () => {
      this.filterPalette();
      if (this.search.value.trim()) this.highlightPalette(this.types.querySelector('[role="option"]')?.dataset.type);
      this.positionPalette();
    };
    this.category.onchange = () => { this.filterPalette(); this.positionPalette(); };
    this.search.onkeydown = event => {
      if (event.isComposing) return;
      const options = [...this.types.querySelectorAll('[role="option"]')];
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        if (!options.length) return;
        const index = options.findIndex(option => option.dataset.type === this.paletteType);
        const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        this.highlightPalette(options[next].dataset.type, true);
      } else if (event.key === 'Enter') {
        event.preventDefault(); if (this.paletteType) this.addNode(this.paletteType);
      }
    };
    this.palette.append(this.search, this.category, this.types, this.paletteStatus); this.filterPalette();
    // Listen only while open, including events outside the editor itself.
    this.paletteOutside = event => {
      if (!this.palette.contains(event.target) && !this.paletteButton.contains(event.target)) this.togglePalette(false, false);
    };
    this.paletteGeometry = () => this.positionPalette();
    this.scroll = el('div', undefined, 'graph-scroll'); this.scroll.tabIndex = 0; this.scroll.setAttribute('aria-label', 'Scrollable graph canvas');
    // Chromium delivers trackpad pinch as Ctrl+wheel. Use only this path, on
    // the scrollport itself, so menus, Inspector and page scrolling stay native.
    this.scroll.addEventListener('wheel', event => {
      if (!event.ctrlKey || event.defaultPrevented || !event.cancelable) return;
      event.preventDefault(); // Also suppress browser zoom when already at a limit.
      if (this.draggingNode || this.draggingPort || this.cancelDetach) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroll.clientHeight : 1;
      // Normalize lines/pages to CSS pixels; bound single-event spikes while
      // retaining fractional precision and symmetric zoom-in/out factors.
      // Match Chromium's logarithmic pinch deltas; the 10px cap keeps a
      // mouse notch near a 10% change without coarsening trackpad fractions.
      const delta = Math.max(-10, Math.min(10, event.deltaY * unit));
      if (!Number.isFinite(delta) || !delta) return;
      this.setZoom(this.zoom * Math.exp(-delta * .01), { anchor: event });
    }, { passive: false });
    this.extent = el('div', undefined, 'graph-extent'); this.canvas = el('div', undefined, 'graph-canvas'); this.canvas.id = 'graph-canvas';
    this.canvas.addEventListener('focusin', event => {
      if (event.target.closest('.graph-node')) this.editingTarget = event.target.getAttribute('aria-label');
    });
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
      this.selectDetails(); this.scroll.focus({ preventScroll: true });
    };
    this.inspector = el('aside', undefined, 'graph-inspector'); this.inspector.setAttribute('aria-label', 'Graph details inspector');
    const viewport = el('div', undefined, 'graph-viewport');
    const surface = el('div', undefined, 'graph-surface');
    const viewportActions = el('div', undefined, 'graph-zoom-controls');
    viewportActions.setAttribute('role', 'group'); viewportActions.setAttribute('aria-label', 'Canvas navigation');
    this.zoomControl = el('select'); this.zoomControl.id = 'graph-zoom';
    this.zoomControl.setAttribute('aria-label', 'Canvas zoom');
    this.zoomControl.title = 'Canvas zoom; choose 100% to resume editing';
    for (const value of ZOOM_PRESETS) { const option = el('option', `${value * 100}%`); option.value = value; this.zoomControl.append(option); }
    this.zoomControl.value = '1';
    this.zoomControl.onchange = () => this.setZoom(Number(this.zoomControl.value), { focus: Number(this.zoomControl.value) === 1 });
    this.zoomOut = button('−', 'graph-zoom-out', () => this.setZoom(Number((this.zoom - ZOOM_STEP).toFixed(10))));
    this.zoomIn = button('+', 'graph-zoom-in', () => this.setZoom(Number((this.zoom + ZOOM_STEP).toFixed(10))));
    this.zoomOut.setAttribute('aria-label', 'Zoom out'); this.zoomOut.title = 'Zoom out';
    this.zoomIn.setAttribute('aria-label', 'Zoom in'); this.zoomIn.title = 'Zoom in';
    const fit = button('Fit', 'graph-fit', () => this.fit()); fit.setAttribute('aria-label', 'Fit graph'); fit.title = 'Fit graph in the canvas';
    viewportActions.append(this.zoomOut, this.zoomControl, this.zoomIn, fit);
    surface.append(this.scroll, viewportActions); viewport.append(surface); this.workspace.append(viewport, this.inspector, this.palette);
    root.replaceChildren(toolbar, this.stateNotice, this.errors, this.workspace);
    root.addEventListener('keydown', event => {
      const wire = event.target.closest('.graph-wire');
      if (event.key === 'Escape') {
        if (event.target.closest('dialog')) return;
        this.cancelDetach?.();
        if (!this.palette.hidden) { event.preventDefault(); this.togglePalette(false); return; }
        if (this.actions.open) { event.preventDefault(); this.actions.open = false; this.actions.querySelector('summary').focus(); return; }
        event.preventDefault(); const restoreFocus = wire || event.target === this.disconnectButton || this.inspector.contains(event.target);
        this.selectDetails();
        if (restoreFocus) this.scroll.focus({ preventScroll: true });
      }
      if (['Delete', 'Backspace'].includes(event.key) && wire) {
        event.preventDefault(); event.stopPropagation(); this.disconnect(this.draft.edges[Number(wire.dataset.edge)]); this.scroll.focus({ preventScroll: true });
      }
    });
    this.routingNotice = el('p', undefined, 'graph-routing-notice');
    this.routingNotice.setAttribute('role', 'status'); this.routingNotice.hidden = true;
    viewport.append(this.routingNotice);
    if (typeof ResizeObserver !== 'undefined') this.geometryObserver = new ResizeObserver(() => this.scheduleWires());
    document.fonts?.ready.then(() => this.scheduleWires());
    this.draw();
  }
  scheduleWires() {
    if (this.wireFrame) return;
    this.wireFrame = requestAnimationFrame(() => { this.wireFrame = null; this.drawWires(); });
  }
  assert(graph) { return assertGraph(graph, this.definitions); }
  definition(node) {
    try { const definition = nodeDefinition(node, this.draft, this.definitions); if (definition) return definition; } catch { /* Keep a stale draft visible for recovery. */ }
    return { label: `Unavailable subgraph ${node?.subgraphId || ''}`, inputs: {}, outputs: {} };
  }
  renderPortEditor(root, graph, changed) {
    const panel = el('details'); panel.open = true; panel.append(el('summary', 'Exposed ports'));
    panel.append(el('p', 'Names are editable labels; IDs preserve parent wires. Endpoint types are inferred. Incompatible changes are blocked while parents reference this definition.'));
    for (const side of ['inputs', 'outputs']) {
      const group = el('fieldset'); group.append(el('legend', side));
      const endpoints = graph.nodes.flatMap(node => Object.entries(nodeDefinition(node, graph)?.[side] || {}).filter(([port]) => side !== 'inputs' || !graph.edges.some(route => route.to[0] === node.id && route.to[1] === port)).map(([port, contract]) => ({ node: node.id, port, contract })));
      for (const port of graph.interface[side]) {
        const row = el('div'), name = el('input'), endpoint = el('select');
        name.value = port.name; name.maxLength = 120; name.setAttribute('aria-label', `${side} ${port.id} name`);
        name.oninput = () => {
          port.name = name.value;
          if (graph === this.draft) { this.errors.textContent = this.diagnostics(); this.updateSummary(); this.onDraft(structuredClone(this.draft)); }
        };
        endpoint.setAttribute('aria-label', `${side} ${port.id} endpoint`);
        const current = JSON.stringify([port.node, port.port]);
        if (!endpoints.some(item => JSON.stringify([item.node, item.port]) === current)) {
          const missing = el('option', `Unavailable: ${port.node}.${port.port}`); missing.value = current; endpoint.append(missing);
        }
        for (const item of endpoints) {
          const option = el('option', `${item.node}.${item.port} · ${item.contract.name}`); option.value = JSON.stringify([item.node, item.port]); endpoint.append(option);
        }
        endpoint.value = current;
        endpoint.onchange = () => { [port.node, port.port] = JSON.parse(endpoint.value); changed(); };
        row.append(el('span', `${port.id} `), name, endpoint, button(`Remove ${port.id}`, null, () => {
          graph.interface[side] = graph.interface[side].filter(item => item !== port); changed();
        })); group.append(row);
      }
      const available = endpoints.filter(item => !graph.interface[side].some(port => port.node === item.node && port.port === item.port));
      const add = button(`Expose ${side === 'inputs' ? 'input' : 'output'}`, null, () => {
        const item = available[0]; if (!item) return;
        let index = 1, id; do { id = `${side === 'inputs' ? 'in' : 'out'}${index++}`; } while (graph.interface[side].some(port => port.id === id));
        graph.interface[side].push({ id, name: `${item.node} ${item.port}`, node: item.node, port: item.port }); changed();
      }); add.disabled = !available.length; group.append(add); panel.append(group);
    }
    root.append(panel);
  }
  createSubgraph() {
    try {
      // The modal keeps an extracted snapshot even if a clean editor refreshes
      // from another tab. Keep that snapshot bound to its original revision.
      const parentRevision = this.definitions.find(entry => entry.id === this.graphId)?.revision;
      const id = crypto.randomUUID(), extracted = extractSubgraph(this.draft, this.multiSelection, id, this.definitions);
      const dialog = el('dialog', undefined, 'graph-subgraph-dialog'); dialog.setAttribute('aria-label', 'Create Subgraph');
      const title = el('h2', 'Create Subgraph'), name = el('input'), ports = el('div'), error = el('p');
      error.setAttribute('role', 'alert'); name.value = 'Shared processing'; name.setAttribute('aria-label', 'Subgraph name');
      const redrawPorts = () => { ports.replaceChildren(); this.renderPortEditor(ports, extracted.shared, redrawPorts); };
      redrawPorts();
      const create = button('Create Subgraph', 'graph-confirm-subgraph', async () => {
        create.disabled = true;
        try {
          assertSubgraph(extracted.shared);
          const definition = { id, name: name.value, kind: 'subgraph', graph: extracted.shared };
          const definitions = [...this.definitions, definition];
          const parent = assertGraph(extracted.parent, definitions);
          resolveSubgraphs(parent, definitions);
          const library = await this.onCreateSubgraph({ ...definition, replacementGraph: parent }, parentRevision);
          this.definitions = library.graphs; this.draft = parent;
          this.multiSelection.clear(); this.selectedNode = extracted.instance.id; this.error = ''; dialog.close(); this.draw();
        } catch (failure) { error.textContent = failure.message; }
        finally { create.disabled = false; }
      });
      dialog.append(title, el('label', 'Subgraph name'), name, ports, error, create, button('Cancel', null, () => dialog.close()));
      dialog.onclose = () => { dialog.remove(); this.actions.querySelector('summary').focus(); };
      this.root.append(dialog); this.actions.open = false; dialog.showModal(); name.focus(); name.select();
    } catch (error) { this.error = error.message; this.draw(); }
  }
  diagnostics(includeWarnings = this.warningPreference?.checked) {
    let boundaryError = '';
    try {
      if (this.kind === 'subgraph') {
        const graph = assertSubgraph(this.draft);
        assertSubgraphUpdate({ graphs: this.definitions }, this.graphId, graph);
      } else resolveSubgraphs(this.draft, this.definitions);
    } catch (error) { boundaryError = error.message; }
    return [...(boundaryError ? [boundaryError] : validateGraph(this.draft, false, this.definitions)).map(message => `Error: ${message}`),
      ...(includeWarnings && !boundaryError && this.kind !== 'subgraph' ? graphWarnings(resolveSubgraphs(this.draft, this.definitions)).map(message => `Warning: ${message}`) : [])].join('\n');
  }
  closeActions() {
    this.actions.open = false; this.actions.querySelector('summary').focus({ preventScroll: true });
  }
  togglePalette(open = this.palette.hidden, restoreFocus = true) {
    if (open) this.actions.open = false;
    this.palette.hidden = !open; this.paletteButton.setAttribute('aria-expanded', String(open));
    this.search.setAttribute('aria-expanded', String(open));
    if (open) {
      this.search.value = ''; this.category.value = 'All categories'; this.filterPalette(); this.positionPalette();
      document.addEventListener('pointerdown', this.paletteOutside, true);
      document.addEventListener('focusin', this.paletteOutside);
      window.addEventListener('resize', this.paletteGeometry);
      document.addEventListener('scroll', this.paletteGeometry, true);
      window.visualViewport?.addEventListener('resize', this.paletteGeometry);
      window.visualViewport?.addEventListener('scroll', this.paletteGeometry);
      this.search.focus({ preventScroll: true });
    } else {
      this.highlightPalette();
      document.removeEventListener('pointerdown', this.paletteOutside, true);
      document.removeEventListener('focusin', this.paletteOutside);
      window.removeEventListener('resize', this.paletteGeometry);
      document.removeEventListener('scroll', this.paletteGeometry, true);
      window.visualViewport?.removeEventListener('resize', this.paletteGeometry);
      window.visualViewport?.removeEventListener('scroll', this.paletteGeometry);
      if (restoreFocus) this.paletteButton.focus({ preventScroll: true });
    }
  }
  positionPalette() {
    if (this.palette.hidden) return;
    const anchor = this.paletteButton.getBoundingClientRect(), view = window.visualViewport;
    const left = (view?.offsetLeft || 0) + 8, top = (view?.offsetTop || 0) + 8;
    const right = left + (view?.width || document.documentElement.clientWidth) - 16;
    const bottom = top + (view?.height || document.documentElement.clientHeight) - 16;
    const below = Math.max(0, Math.min(bottom - top, bottom - anchor.bottom - 6)), above = Math.max(0, Math.min(bottom - top, anchor.top - top - 6));
    const flip = below < Math.min(360, above);
    this.palette.style.width = `${Math.max(0, Math.min(320, right - left))}px`;
    this.palette.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
    const box = this.palette.getBoundingClientRect();
    this.palette.style.left = `${Math.max(left, Math.min(anchor.right - box.width, right - box.width))}px`;
    this.palette.style.top = `${Math.max(top, Math.min(bottom - box.height, flip ? anchor.top - box.height - 6 : anchor.bottom + 6))}px`;
  }
  highlightPalette(type = null, reveal = false) {
    const options = [...this.types.querySelectorAll('[role="option"]')];
    this.paletteType = options.find(option => option.dataset.type === type)?.dataset.type ?? null;
    this.search.removeAttribute('aria-activedescendant');
    for (const option of options) {
      const active = option.dataset.type === this.paletteType;
      option.setAttribute('aria-selected', String(active));
      if (active) {
        this.search.setAttribute('aria-activedescendant', option.id);
        // Scroll only the results, never the page or canvas behind the menu.
        if (reveal) {
          const box = option.getBoundingClientRect(), list = this.types.getBoundingClientRect();
          if (box.top < list.top) this.types.scrollTop += box.top - list.top;
          else if (box.bottom > list.bottom) this.types.scrollTop += box.bottom - list.bottom;
        }
      }
    }
  }
  filterPalette() {
    const query = this.search.value.trim().toLowerCase(); this.types.replaceChildren();
    const groups = new Map(), matches = [];
    for (const [type, definition] of [...Object.entries(NODE_TYPES), ...(this.kind === 'subgraph' ? [] : (this.definitions || []).filter(entry => entry.kind === 'subgraph').map(entry => [`Subgraph:${entry.id}`, { label: entry.name, inputs: {}, outputs: {} }]))]) {
      const category = type.startsWith('Subgraph:') ? 'Subgraphs' : ['Number', 'Text', 'TextFormatter', 'Hold'].includes(type) ? 'Constants / utilities'
        : !Object.keys(definition.inputs).length ? 'Sources / inputs'
        : !Object.keys(definition.outputs).length ? 'Outputs' : 'Processors';
      if ((this.category.value !== 'All categories' && this.category.value !== category) || !`${type} ${definition.label}`.toLowerCase().includes(query)) continue;
      if (!groups.has(category)) {
        const group = el('div', undefined, 'graph-node-group'), heading = el('div', category, 'muted');
        heading.id = `graph-category-${groups.size}`; group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', heading.id);
        group.append(heading); groups.set(category, group); this.types.append(group);
      }
      const option = el('div', definition.label, 'graph-node-option'); option.id = `graph-option-${type}`;
      option.dataset.type = type; option.setAttribute('role', 'option');
      // Mouse keeps focus in search; touch must retain its native click path.
      option.onpointerdown = event => { if (event.pointerType === 'mouse') event.preventDefault(); };
      option.onclick = () => this.addNode(type);
      groups.get(category).append(option); matches.push(type);
    }
    // Rendering results never selects one; search and arrow navigation do so explicitly.
    this.highlightPalette();
    this.types.scrollTop = 0;
    this.paletteStatus.textContent = matches.length ? `${matches.length} node type${matches.length === 1 ? '' : 's'}` : 'No matching nodes';
  }
  fit() {
    const cards = [...this.canvas.querySelectorAll('.graph-node')];
    const right = Math.max(300, ...cards.map(card => card.offsetLeft + card.offsetWidth + 32));
    const bottom = Math.max(200, ...cards.map(card => card.offsetTop + card.offsetHeight + 32));
    this.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.scroll.clientWidth / right, (this.scroll.clientHeight - VIEWPORT_CONTROL_SPACE) / bottom));
    this.fitZoom = this.zoom;
    this.applyZoom(); this.scroll.scrollTo(0, 0);
  }
  setZoom(zoom, { focus = false, anchor = null } = {}) {
    if (!Number.isFinite(zoom)) return;
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Number(zoom.toFixed(12))));
    const previous = this.zoom;
    const viewport = this.scroll.getBoundingClientRect(), origin = this.canvas.getBoundingClientRect();
    const vx = viewport.width / this.scroll.offsetWidth, vy = viewport.height / this.scroll.offsetHeight;
    const x = anchor ? anchor.clientX : viewport.left + (this.scroll.clientLeft + this.scroll.clientWidth / 2) * vx;
    const y = anchor ? anchor.clientY : viewport.top + (this.scroll.clientTop + this.scroll.clientHeight / 2) * vy;
    // Bounding rects include the actual pan, viewport border and ancestor scale.
    const world = { x: (x - origin.left) / (vx * previous), y: (y - origin.top) / (vy * previous) };
    this.zoom = zoom; this.applyZoom();
    const next = this.canvas.getBoundingClientRect();
    // Read scroll again: reducing the extent may already have clamped it.
    this.scroll.scrollTo(this.scroll.scrollLeft + (next.left + world.x * vx * zoom - x) / vx,
      this.scroll.scrollTop + (next.top + world.y * vy * zoom - y) / vy);
    if (anchor) return;
    // Returning from an overview should reveal the control the user was editing.
    const target = this.svg.querySelector('.selected-wire')
      || [...this.canvas.querySelectorAll('.graph-node [aria-label]')].find(control => control.getAttribute('aria-label') === this.editingTarget)
      || this.canvas.querySelector('.selected-node .graph-heading');
    if (target && zoom > previous) target.scrollIntoView({ block: 'center', inline: 'center' });
    if (focus) {
      (target || this.scroll).focus({ preventScroll: true });
      (target || this.scroll).scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }
  syncZoomControls() {
    this.zoomControl.querySelector('[data-custom]')?.remove();
    if (!ZOOM_PRESETS.includes(this.zoom)) {
      const percent = Number((this.zoom * 100).toFixed(2));
      const option = el('option', `${percent}%${this.zoom === this.fitZoom ? ' (fit)' : ''}`);
      option.value = this.zoom; option.dataset.custom = ''; this.zoomControl.append(option);
    }
    this.zoomControl.value = String(this.zoom);
    this.zoomOut.disabled = this.zoom <= MIN_ZOOM; this.zoomIn.disabled = this.zoom >= MAX_ZOOM;
  }
  applyZoom() {
    this.syncZoomControls();
    this.canvas.style.transform = `scale(${this.zoom})`;
    this.extent.style.width = `${parseFloat(this.canvas.style.width) * this.zoom}px`;
    this.extent.style.height = `${parseFloat(this.canvas.style.height) * this.zoom + VIEWPORT_CONTROL_SPACE}px`;
    // Scaling changes neither world geometry nor routes. Keep focused controls,
    // pointer captures and wire elements intact; only their hit width changes.
    for (const hit of this.svg.querySelectorAll('.wire-hit')) hit.style.strokeWidth = `${16 / this.zoom}px`;
  }
  visibleGraphBounds() {
    const origin = this.canvas.getBoundingClientRect(), viewport = this.scroll.getBoundingClientRect();
    // The canvas rect includes zoom, ancestor scaling and the current pan. The
    // scrollport's client box excludes its border and native scrollbars.
    const sx = origin.width / this.canvas.offsetWidth, sy = origin.height / this.canvas.offsetHeight;
    const vx = viewport.width / this.scroll.offsetWidth, vy = viewport.height / this.scroll.offsetHeight;
    const view = window.visualViewport;
    const left = Math.max(viewport.left + this.scroll.clientLeft * vx, view?.offsetLeft || 0);
    const top = Math.max(viewport.top + this.scroll.clientTop * vy, view?.offsetTop || 0);
    const right = Math.min(viewport.left + (this.scroll.clientLeft + this.scroll.clientWidth) * vx,
      (view?.offsetLeft || 0) + (view?.width || document.documentElement.clientWidth));
    const bottom = Math.min(viewport.top + (this.scroll.clientTop + this.scroll.clientHeight) * vy,
      (view?.offsetTop || 0) + (view?.height || document.documentElement.clientHeight));
    return { left: Math.max(0, (left - origin.left) / sx), top: Math.max(0, (top - origin.top) / sy),
      right: Math.max(0, (right - origin.left) / sx), bottom: Math.max(0, (bottom - VIEWPORT_CONTROL_SPACE * vy - origin.top) / sy) };
  }
  nodePlacement(bounds, card) {
    const width = card.offsetWidth, height = card.offsetHeight, gap = 16;
    const minX = bounds.left, minY = bounds.top;
    // If a card exceeds the view (high zoom / narrow screen), keep its leading
    // edge and heading reachable rather than centering the card offscreen.
    const maxX = Math.max(minX, bounds.right - width), maxY = Math.max(minY, bounds.bottom - height);
    const clampX = x => Math.max(minX, Math.min(x, maxX)), clampY = y => Math.max(minY, Math.min(y, maxY));
    const center = { x: clampX((bounds.left + bounds.right - width) / 2), y: clampY((bounds.top + bounds.bottom - height) / 2) };
    const occupied = [...this.canvas.querySelectorAll('.graph-node')].filter(other => other !== card).map(other => ({
      x: other.offsetLeft, y: other.offsetTop, width: other.offsetWidth, height: other.offsetHeight,
    }));
    const candidates = [center];
    // A fixed grid plus obstacle boundaries finds gaps without an unbounded
    // spiral. In a packed view, minimize overlap, then distance from center.
    for (let y = 0; y <= 8; y++) for (let x = 0; x <= 8; x++) candidates.push({ x: minX + (maxX - minX) * x / 8, y: minY + (maxY - minY) * y / 8 });
    for (const other of occupied.filter(o => o.x < bounds.right && o.x + o.width > bounds.left && o.y < bounds.bottom && o.y + o.height > bounds.top).slice(0, 100)) {
      for (const x of [other.x - width - gap, other.x + other.width + gap]) for (const y of [center.y, other.y, other.y + other.height - height]) candidates.push({ x: clampX(x), y: clampY(y) });
      for (const y of [other.y - height - gap, other.y + other.height + gap]) for (const x of [center.x, other.x, other.x + other.width - width]) candidates.push({ x: clampX(x), y: clampY(y) });
    }
    let best, bestOverlap = Infinity, bestDistance = Infinity;
    for (const candidate of candidates) {
      const overlap = occupied.reduce((sum, other) => sum
        + Math.max(0, Math.min(candidate.x + width + gap, other.x + other.width + gap) - Math.max(candidate.x, other.x))
        * Math.max(0, Math.min(candidate.y + height + gap, other.y + other.height + gap) - Math.max(candidate.y, other.y)), 0);
      const distance = (candidate.x - center.x) ** 2 + (candidate.y - center.y) ** 2;
      if (overlap < bestOverlap || (overlap === bestOverlap && distance < bestDistance)) { best = candidate; bestOverlap = overlap; bestDistance = distance; }
    }
    return best;
  }
  addNode(type) {
    const shared = type.startsWith('Subgraph:') ? this.definitions.find(entry => entry.id === type.slice(9) && entry.kind === 'subgraph') : null;
    if (!shared && !Object.hasOwn(NODE_TYPES, type)) return;
    if (shared) { try { assertSubgraph(shared.graph); } catch (error) { this.error = error.message; this.draw(); return; } }
    const bounds = this.visibleGraphBounds();
    const pan = { left: this.scroll.scrollLeft, top: this.scroll.scrollTop };
    const baseID = shared ? 'subgraph' : type.toLowerCase();
    let id = baseID, suffix = 1;
    while (this.draft.nodes.some(node => node.id === id)) id = `${baseID}-${suffix++}`;
    const node = shared ? { id, type: 'Subgraph', subgraphId: shared.id, settings: {}, position: { x: bounds.left, y: bounds.top } } : graphNode(type, id, bounds.left, bounds.top);
    this.draft.nodes.push(node);
    this.multiSelection = new Set([id]);
    this.selected = null; this.selectedEdge = null; this.selectedNode = id;
    this.togglePalette(false, false);
    // Measure the real card, including dynamic ports and wrapped labels, before
    // publishing the draft. Both renders finish synchronously before paint.
    this.draw(false);
    const card = this.canvas.querySelector(`[data-node="${id}"]`);
    node.position = this.nodePlacement(bounds, card);
    this.draw(); this.scroll.scrollTo(pan.left, pan.top);
    this.canvas.querySelector(`[data-node="${id}"] .graph-heading`)?.focus({ preventScroll: true });
  }
  isDirty() { return JSON.stringify(this.draft) !== JSON.stringify(this.saved); }
  receiveSaved(graph) {
    const dirty = this.isDirty(); this.saved = this.assert(graph);
    if (dirty) this.externalChange = true;
    else { this.draft = structuredClone(this.saved); this.externalChange = false; }
    this.draw();
  }
  setSaved(graph) { this.saved = this.assert(graph); this.draft = structuredClone(this.saved); this.selected = null; this.externalChange = false; this.error = ''; this.draw(); }
  setActive(graph, state, tabId) { this.active = graph; this.state = state; this.tabId = tabId; this.updateSummary(); }
  updateSummary() {
    let savedSnapshot = this.saved;
    try { if (this.saved) savedSnapshot = resolveSubgraphs(this.saved, this.definitions); } catch { /* Show the pending warning if a dependency becomes invalid. */ }
    const running = this.state && this.state !== 'idle', pending = running && JSON.stringify(this.active) !== JSON.stringify(savedSnapshot);
    const summary = this.isDirty() ? 'Unsaved' : 'Saved';
    if (this.summary.textContent !== summary) this.summary.textContent = summary;
    if (this.activity.textContent !== 'Active') this.activity.textContent = 'Active';
    this.activity.hidden = !running;
    this.activity.title = running ? `Running in Live${Number.isInteger(this.tabId) ? ` · tab ${this.tabId}` : ''}` : '';
    const warning = [this.externalChange ? 'Saved graph changed elsewhere; draft kept. Load saved before saving.' : '', pending ? 'Live uses an earlier graph; saved edits apply next session.' : ''].filter(Boolean).join(' ');
    if (this.stateNotice.textContent !== warning) this.stateNotice.textContent = warning;
    this.stateNotice.hidden = !warning;
    this.summary.classList.toggle('graph-conflict', !!this.externalChange);
  }
  connect(id, port, contract, movingConnection = null) {
    if (this.selected && compatiblePorts(this.selected.contract, contract) && this.selected.id !== id) {
      const proposed = edge(this.selected.id, this.selected.port, id, port);
      const identical = this.draft.edges.some(e => JSON.stringify(e) === JSON.stringify(proposed));
      if (!identical) {
        const candidate = { ...this.draft, edges: this.draft.edges.filter(e => e !== movingConnection && (e.to[0] !== id || e.to[1] !== port)).concat(proposed) };
        // Drafts can be incomplete. Reject newly introduced structural errors.
        const previous = new Set(validateGraph(this.draft, false, this.definitions));
        const errors = validateGraph(candidate, false, this.definitions).filter(message => !previous.has(message));
        if (errors.length) this.error = errors.join('\n');
        else this.draft.edges = candidate.edges;
      }
      this.selected = null;
    }
    if (movingConnection) this.selected = null;
    this.draw();
    this.canvas.querySelector(`[data-node="${id}"] [data-side="input"][data-port="${port}"]`)?.focus();
  }
  disconnect(connection) {
    this.draft.edges = this.draft.edges.filter(e => e !== connection);
    if (this.selectedEdge === connection) this.selectedEdge = null;
    this.draw();
  }
  resizeInputs(node, delta) {
    const count = node.settings.inputCount + delta;
    if (count < 1 || (node.type === 'Display' && count > MAX_DISPLAY_INPUTS)) return;
    node.settings.inputCount = count;
    if (node.type === 'Display' && delta < 0 && node.settings.inputLabels) delete node.settings.inputLabels[`input${count + 1}`];
    // Remove only the last port; numbering and all unaffected wires stay stable.
    this.draft.edges = this.draft.edges.filter(route => route.to[0] !== node.id || route.to[1] !== `input${count + 1}` || delta > 0);
    this.selected = null; this.draw();
  }
  updateSetting(node, key, value) {
    node.settings[key] = value;
    // Settings do not change canvas geometry or ports. Keep controls in place
    // so a field's blur/change cannot remove the target of a pending click.
    this.errors.textContent = this.diagnostics(); this.updateSummary();
    this.onDraft(structuredClone(this.draft));
  }
  selectDetails(node = null, connection = null, extend = false) {
    if (extend && node) {
      this.multiSelection ||= new Set();
      if (this.multiSelection.has(node)) this.multiSelection.delete(node); else this.multiSelection.add(node);
      node = this.multiSelection.has(node) ? node : [...this.multiSelection].at(-1) || null;
    } else this.multiSelection = new Set(node ? [node] : []);
    if (this.createButton) this.createButton.disabled = !this.multiSelection.size;
    this.selected = null; this.selectedNode = node; this.selectedEdge = connection;
    for (const card of this.canvas.querySelectorAll('.graph-node')) {
      const selected = this.multiSelection.has(card.dataset.node);
      card.classList.toggle('selected-node', selected);
      card.querySelector('.graph-heading').setAttribute('aria-pressed', String(selected));
    }
    for (const port of this.canvas.querySelectorAll('.graph-ports button')) {
      port.classList.remove('selected-port'); port.disabled = false;
      if (port.dataset.side === 'output') port.setAttribute('aria-pressed', 'false');
    }
    for (const wire of this.svg.querySelectorAll('.graph-wire')) {
      const selected = this.draft.edges[Number(wire.dataset.edge)] === connection;
      wire.classList.toggle('selected-wire', selected); wire.setAttribute('aria-pressed', String(selected));
    }
    this.drawInspector();
  }
  drawInspector() {
    const focused = this.inspector.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    const node = this.draft.nodes.find(node => node.id === this.selectedNode);
    const header = el('div', undefined, 'graph-inspector-header'); header.append(el('h2', node ? 'Settings' : 'Details'));
    this.inspector.replaceChildren(header);
    this.disconnectButton.hidden = !this.selectedEdge;
    if (!node && !this.selectedEdge) { this.inspector.append(el('p', 'Select a node or connection. Shift+click or Shift+Enter on headings selects a connected group for Graph actions → Create Subgraph.', 'muted')); if (this.kind === 'subgraph') this.renderPortEditor(this.inspector, this.draft, () => this.draw()); return; }
    if (this.selectedEdge) {
      const { from, to } = this.selectedEdge;
      this.disconnectButton.setAttribute('aria-label', `Disconnect ${from.join('.')} to ${to.join('.')}`);
      this.inspector.append(el('h3', 'Connection'), el('p', `${from.join('.')} → ${to.join('.')}`), this.disconnectButton);
      if (focused === this.disconnectButton.getAttribute('aria-label')) this.disconnectButton.focus({ preventScroll: true });
      return;
    }
    const remove = button('Remove Node', null, () => { this.removeNode(node); this.scroll.focus({ preventScroll: true }); });
    remove.className = 'danger'; remove.setAttribute('aria-label', `Remove ${node.id}`); header.append(remove);
    if (node.type === 'Subgraph' && this.onEditSubgraph) this.inspector.append(button('Edit Subgraph', 'graph-edit-subgraph', () => this.onEditSubgraph(node.subgraphId)));
    if (this.multiSelection?.size > 1) this.inspector.append(el('p', `${this.multiSelection.size} nodes selected. Use Graph actions → Create Subgraph.`));
    const definition = this.definition(node); this.inspector.append(el('h3', definition.label), el('p', `Instance ID: ${node.id}`));
    for (const [key, values] of Object.entries(definition.settings || {})) {
      const label = el('label', key + ' '), select = el('select'); select.setAttribute('aria-label', `${node.id} ${key}`);
      for (const value of values) { const option = el('option', value); option.value = value; select.append(option); }
      select.value = node.settings[key]; select.onchange = () => this.updateSetting(node, key, select.value);
      label.append(select); this.inspector.append(label);
    }
    for (const [key, spec] of Object.entries(definition.textSettings || {})) {
      const label = el('label', key + ' '), control = el(spec.multiline ? 'textarea' : 'input');
      control.setAttribute('aria-label', `${node.id} ${key}`); if (spec.maxLength !== undefined) control.maxLength = spec.maxLength; control.value = node.settings[key] ?? spec.default;
      // Capture every keystroke before a cross-page storage update can redraw
      // the Inspector; a focused, unblurred edit must still count as a draft.
      control.oninput = () => this.updateSetting(node, key, control.value);
      label.append(control); this.inspector.append(label);
    }
    if (node.type === 'Display') for (let i = 1; i <= node.settings.inputCount; i++) {
      const port = `input${i}`, label = el('label', `Input ${i} tab label `), control = el('input');
      control.setAttribute('aria-label', `${node.id} ${port} tab label`);
      control.maxLength = 120; control.placeholder = `Input ${i}`;
      control.value = node.settings.inputLabels?.[port] ?? '';
      control.onchange = () => this.updateSetting(node, 'inputLabels', { ...node.settings.inputLabels, [port]: control.value });
      label.append(control); this.inspector.append(label);
    }
    if (['TextFormatter', 'Display'].includes(node.type)) {
      this.inspector.append(el('p', `${node.settings.inputCount} ${node.type === 'Display' ? 'ITEM' : 'TEXT'} inputs. Remove deletes only the last input and its wire. ${node.type === 'Display' ? 'Each input is a Live tab. Blank labels use Input 1, Input 2, etc. Save applies next session.' : 'Template references remain editable.'}`));
      const add = button('Add input', null, () => this.resizeInputs(node, 1));
      const remove = button('Remove last input', null, () => this.resizeInputs(node, -1));
      add.setAttribute('aria-label', `${node.id} Add input`); remove.setAttribute('aria-label', `${node.id} Remove last input`);
      remove.disabled = node.settings.inputCount <= 1;
      add.disabled = node.type === 'Display' && node.settings.inputCount >= MAX_DISPLAY_INPUTS;
      this.inspector.append(add, remove);
    }
    for (const key of Object.keys(definition.numberSettings || {}).filter(key => key !== 'inputCount')) {
      const label = el('label', key + ' '), control = el('input');
      control.type = 'number'; control.step = 'any'; control.value = node.settings[key];
      control.setAttribute('aria-label', `${node.id} ${key}`);
      control.oninput = () => {
        // Empty / malformed input must remain invalid, never become zero or a
        // default through coercion. JSON also preserves this as invalid null.
        this.updateSetting(node, key, control.valueAsNumber);
      };
      label.append(control); this.inspector.append(label);
    }
    if (focused) [...this.inspector.querySelectorAll('[aria-label]')].find(control => control.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
  }
  removeNode(node) {
    this.draft.nodes = this.draft.nodes.filter(n => n !== node);
    this.draft.edges = this.draft.edges.filter(e => e.from[0] !== node.id && e.to[0] !== node.id);
    this.selected = null; this.selectedNode = null; this.draw();
  }
  draw(notify = true) {
    this.geometryObserver?.disconnect();
    if (!this.selectedNode) this.multiSelection?.clear();
    else if (this.multiSelection) for (const id of this.multiSelection) if (!this.draft.nodes.some(node => node.id === id)) this.multiSelection.delete(id);
    if (this.createButton) this.createButton.disabled = !(this.multiSelection?.size);
    if (!this.draft.edges.includes(this.selectedEdge)) this.selectedEdge = null;
    this.syncZoomControls();
    this.canvas.replaceChildren(this.svg); this.svg.replaceChildren();
    this.errors.textContent = this.error || this.diagnostics(); this.error = '';
    this.updateSummary(); this.drawInspector();
    const width = Math.max(1100, ...this.draft.nodes.map(n => n.position.x + 285)), height = Math.max(700, ...this.draft.nodes.map(n => n.position.y + 250));
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.canvas.style.transform = `scale(${this.zoom})`;
    this.extent.style.width = `${width * this.zoom}px`; this.extent.style.height = `${height * this.zoom + VIEWPORT_CONTROL_SPACE}px`;
    for (const node of this.draft.nodes) {
      const definition = this.definition(node), card = el('section', undefined, 'graph-node'); card.dataset.node = node.id;
      card.classList.toggle('selected-node', this.multiSelection?.has(node.id) || this.selectedNode === node.id);
      card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
      const heading = el('button', definition.label, 'graph-heading'); heading.type = 'button';
      heading.setAttribute('aria-label', `Select ${node.id}`); heading.setAttribute('aria-pressed', String(this.selectedNode === node.id));
      heading.title = 'Select to inspect settings; Shift+click or Shift+Enter selects a group. Drag to move; arrow keys move by 10 pixels.';
      heading.onclick = event => { this.selectDetails(event.shiftKey ? node.id : this.selectedNode === node.id ? null : node.id, null, event.shiftKey); heading.focus({ preventScroll: true }); };
      if (node.type === 'Subgraph' && this.onEditSubgraph) heading.ondblclick = () => this.onEditSubgraph(node.subgraphId);
      heading.onkeydown = event => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta) return; event.preventDefault(); this.selectedEdge = null; this.selectedNode = node.id; this.multiSelection = new Set([node.id]);
        node.position.x = Math.max(0, node.position.x + delta[0]); node.position.y = Math.max(0, node.position.y + delta[1]); this.draw();
        this.canvas.querySelector(`[data-node="${node.id}"] .graph-heading`).focus();
      };
      heading.onpointerdown = event => {
        if (event.button !== 0) return; heading.setPointerCapture(event.pointerId); heading.focus({ preventScroll: true });
        const x = event.clientX, y = event.clientY, origin = { ...node.position }; let moved = false;
        heading.onpointermove = move => {
          if (Math.abs(move.clientX - x) + Math.abs(move.clientY - y) < 3) return;
          if (!moved) this.selectDetails(node.id);
          moved = true; this.draggingNode = node.id;
          node.position.x = Math.max(0, origin.x + (move.clientX - x) / this.zoom); node.position.y = Math.max(0, origin.y + (move.clientY - y) / this.zoom);
          card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`; this.scheduleWires();
        };
        const done = () => { this.draggingNode = null; heading.onpointermove = null; heading.onpointerup = heading.onpointercancel = null; if (moved) {
          this.draw(); this.canvas.querySelector(`[data-node="${node.id}"] .graph-heading`)?.focus({ preventScroll: true });
        } };
        heading.onpointerup = heading.onpointercancel = done;
      };
      card.append(heading);
      const ports = el('div', undefined, 'graph-ports');
      for (const side of ['input', 'output']) {
        const column = el('div');
        for (const [port, contract] of portDisplayEntries(definition, side)) {
          const portLabel = definition.portLabels?.[`${side}s`]?.[port] || port.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
          let suppressClick = false;
          const control = button(`${side === 'input' ? '←' : '→'} ${portLabel}`, null, () => {
            if (suppressClick) return;
            this.selectedEdge = null;
            if (side === 'output') this.selected = this.selected?.id === node.id && this.selected.port === port ? null : { id: node.id, port, contract };
            else return this.connect(node.id, port, contract);
            this.draw();
            this.canvas.querySelector(`[data-node="${node.id}"] [data-side="output"][data-port="${port}"]`)?.focus();
          });
          control.append(el('small', typeLabel(contract)));
          control.dataset.port = port; control.dataset.side = side; control.title = `${side}: ${port} (${contract.name})`;
          control.setAttribute('aria-label', `${node.id} ${side} ${port}`);
          if (side === 'input' && this.selected) control.disabled = !compatiblePorts(this.selected.contract, contract) || this.selected.id === node.id;
          if (side === 'output') {
            control.setAttribute('aria-pressed', String(this.selected?.id === node.id && this.selected.port === port));
            control.draggable = true;
            control.ondragstart = event => {
              this.draggingPort = true;
              this.selected = { id: node.id, port, contract }; event.dataTransfer.setData('text/plain', `${node.id}.${port}`);
              for (const input of this.canvas.querySelectorAll('[data-side="input"]')) {
                const target = this.draft.nodes.find(n => n.id === input.closest('[data-node]').dataset.node);
                input.disabled = target.id === node.id || !compatiblePorts(contract, this.definition(target).inputs[input.dataset.port]);
              }
            };
            control.ondragend = () => { this.draggingPort = false; this.selected = null; this.draw(); };
          } else {
            control.ondragover = event => { if (compatiblePorts(this.selected?.contract, contract) && this.selected.id !== node.id) event.preventDefault(); };
            control.ondrop = event => { event.preventDefault(); this.connect(node.id, port, contract); };
            const connection = this.draft.edges.find(e => e.to[0] === node.id && e.to[1] === port);
            if (connection) {
              control.classList.add('connected-input');
              control.title += '. Drag to blank canvas to detach, or to a matching input to reconnect.';
              control.onpointerdown = event => {
                if (event.button !== 0 || this.selected) return;
                const x = event.clientX, y = event.clientY; let moved = false;
                control.setPointerCapture(event.pointerId);
                control.onpointermove = move => {
                  if (!moved && Math.hypot(move.clientX - x, move.clientY - y) < 6) return;
                  if (!moved) this.selectDetails(null, connection);
                  moved = true;
                  this.detaching = { connection, x: move.clientX, y: move.clientY };
                  this.canvas.classList.add('detaching'); this.scheduleWires();
                };
                const done = up => {
                  control.onpointermove = control.onpointerup = control.onpointercancel = control.onlostpointercapture = null;
                  this.cancelDetach = null;
                  const target = document.elementFromPoint(up.clientX, up.clientY);
                  if (control.hasPointerCapture(event.pointerId)) control.releasePointerCapture(event.pointerId);
                  this.detaching = null; this.canvas.classList.remove('detaching');
                  if (!moved || up.type !== 'pointerup') { this.drawWires(); return; }
                  // Captured pointerup/click still targets the original input.
                  suppressClick = true; setTimeout(() => { suppressClick = false; }, 0);
                  if ([this.scroll, this.extent, this.canvas, this.svg].includes(target)) {
                    this.disconnect(connection); this.scroll.focus({ preventScroll: true });
                  } else {
                    const input = target?.closest('[data-side="input"]');
                    if (input && this.canvas.contains(input)) {
                      const id = input.closest('[data-node]').dataset.node;
                      const source = this.draft.nodes.find(n => n.id === connection.from[0]);
                      this.selected = { id: source.id, port: connection.from[1], contract: this.definition(source).outputs[connection.from[1]] };
                      this.connect(id, input.dataset.port, this.definition(this.draft.nodes.find(n => n.id === id)).inputs[input.dataset.port], connection);
                    } else this.drawWires();
                  }
                };
                this.cancelDetach = () => done({ type: 'pointercancel', clientX: x, clientY: y });
                control.onpointerup = control.onpointercancel = control.onlostpointercapture = done;
              };
            }
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
    for (const element of this.canvas.querySelectorAll('.graph-node, .graph-ports button')) this.geometryObserver?.observe(element);
    // Measure after placing rows in display order. Named button coordinates
    // invalidate the routing signature whenever the actual attachments change.
    this.drawWires(); if (notify) this.onDraft(structuredClone(this.draft));
  }
  drawWires() {
    if (this.wireFrame) { cancelAnimationFrame(this.wireFrame); this.wireFrame = null; }
    const origin = this.canvas.getBoundingClientRect();
    // Quantization removes subpixel transform noise across zoom/pan changes.
    const local = value => Math.round(value / this.zoom * 100) / 100;
    const cards = [], ports = new Map();
    for (const card of this.canvas.querySelectorAll('.graph-node')) {
      const r = card.getBoundingClientRect(), id = card.dataset.node;
      cards.push({ id, left: local(r.left - origin.left), right: local(r.right - origin.left),
        top: local(r.top - origin.top), bottom: local(r.bottom - origin.top) });
      for (const port of card.querySelectorAll('[data-side]')) {
        const r = port.getBoundingClientRect();
        ports.set(JSON.stringify([id, port.dataset.side, port.dataset.port]), {
          x: local((port.dataset.side === 'output' ? r.right : r.left) - origin.left),
          y: local(r.top + r.height / 2 - origin.top),
        });
      }
    }
    const connections = this.draft.edges.map(connection => ({
      key: JSON.stringify([connection.from, connection.to]),
      start: ports.get(JSON.stringify([connection.from[0], 'output', connection.from[1]])),
      end: this.detaching?.connection === connection
        ? { x: local(this.detaching.x - origin.left), y: local(this.detaching.y - origin.top) }
        : ports.get(JSON.stringify([connection.to[0], 'input', connection.to[1]])),
      from: connection.from[0], to: this.detaching?.connection === connection ? null : connection.to[0],
    }));
    const signature = JSON.stringify([cards, connections, !!this.draggingNode]);
    if (signature !== this.routeSignature) {
      const valid = connections.map(c => c.start && c.end ? c : { ...c, start: { x: 0, y: 0 }, end: { x: 0, y: 0 } });
      const router = createWireRouter(cards, valid);
      const reused = valid.map((connection, index) => this.draggingNode
        && reusableWireRoute(this.wireRoutes?.[index], this.routeConnections?.[index], connection, cards)
        ? this.wireRoutes[index] : null);
      this.wireRoutes = router.routeAll(reused);
      this.routeConnections = connections; this.routeSignature = signature;
    }
    const existing = new Map([...this.svg.children].map(wire => [wire.connection, wire]));
    for (const [index, connection] of this.draft.edges.entries()) {
      const { from, to } = connection, route = this.wireRoutes[index];
      if (!connections[index].start || !connections[index].end) continue;
      const previous = existing.get(connection);
      if (previous) {
        previous.querySelector('.wire-casing').setAttribute('d', route.d);
        previous.querySelector('.wire-line').setAttribute('d', route.d);
        previous.querySelector('.wire-hit').setAttribute('d', route.d);
        previous.querySelector('.wire-hit').style.strokeWidth = `${16 / this.zoom}px`;
        previous.classList.toggle('routing-fallback', !!route.fallback);
        previous.classList.toggle('routing-crowded', !!route.crowded);
        previous.dataset.routing = route.fallback || 'clear';
        existing.delete(connection); continue;
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', route.d);
      path.classList.add('wire-line');
      const casing = path.cloneNode(); casing.classList.remove('wire-line'); casing.classList.add('wire-casing');
      const hit = path.cloneNode(); hit.classList.remove('wire-line'); hit.classList.add('wire-hit');
      hit.style.strokeWidth = `${16 / this.zoom}px`;
      const wire = document.createElementNS('http://www.w3.org/2000/svg', 'g'); wire.classList.add('graph-wire'); wire.dataset.edge = index; wire.connection = connection;
      wire.style.setProperty('--wire-color', wireColor(JSON.stringify([from, to])));
      wire.classList.toggle('routing-fallback', !!route.fallback); wire.dataset.routing = route.fallback || 'clear';
      wire.classList.toggle('routing-crowded', !!route.crowded);
      wire.setAttribute('tabindex', '0'); wire.setAttribute('role', 'button');
      wire.setAttribute('aria-label', `Select connection ${from.join('.')} to ${to.join('.')}`);
      wire.setAttribute('aria-pressed', String(this.selectedEdge === connection));
      wire.classList.toggle('selected-wire', this.selectedEdge === connection);
      const select = event => {
        // Wide touch targets overlap in a lane. Choose the closest actual path;
        // exact crossings belong to the visible overpass (later SVG sibling).
        let target = wire;
        if (event.type === 'click' && event.detail && !this.wireRoutes[Number(wire.dataset.edge)].fallback) {
          const rect = this.canvas.getBoundingClientRect();
          const point = { x: (event.clientX - rect.left) / this.zoom, y: (event.clientY - rect.top) / this.zoom };
          let best = Infinity;
          for (const candidate of this.svg.children) {
            if (this.detaching?.connection === candidate.connection) continue;
            const candidateRoute = this.wireRoutes[Number(candidate.dataset.edge)];
            // Cubic fallbacks retain native SVG hit testing.
            if (candidateRoute.fallback) continue;
            const distance = wireDistance(candidateRoute.points, point);
            // Native mouse/touch coordinates can round fractional SVG pixels.
            // Treat subpixel ties as the visible overpass, without letting
            // successive ties drift away from the nearest path.
            if (distance <= 8 / this.zoom + 2 && distance <= best + .75 / this.zoom) {
              target = candidate; best = Math.min(best, distance);
            }
          }
        }
        event.preventDefault(); event.stopPropagation(); this.selectDetails(null, target.connection);
        target.focus({ preventScroll: true });
      };
      wire.onclick = select;
      wire.onpointerdown = event => event.stopPropagation();
      wire.onkeydown = event => {
        if (['Enter', ' '].includes(event.key)) select(event);
        if (event.key === 'Tab' && !event.shiftKey && this.selectedEdge === connection && !this.disconnectButton.hidden) {
          event.preventDefault(); this.disconnectButton.focus();
        }
      };
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${from.join('.')} → ${to.join('.')}. Select, then use Disconnect or Delete/Backspace.`;
      wire.append(title, casing, path, hit); this.svg.append(wire);
    }
    for (const wire of existing.values()) wire.remove();
    const failures = this.wireRoutes.filter(route => route.fallback).length;
    const crowded = this.wireRoutes.filter(route => route.crowded).length;
    this.routingNotice.hidden = !failures && !crowded;
    const notice = [failures ? `${failures} connection${failures === 1 ? '' : 's'} could not avoid cards (overlap or routing limit). Dashed amber wires show these routes.` : '',
      crowded ? `${crowded} connection${crowded === 1 ? '' : 's'} could not get separate lanes (space or routing limit). Dotted wires may overlap; use connection details to confirm endpoints.` : '',
      failures || crowded ? 'Move cards apart to clear them.' : ''].filter(Boolean).join(' ');
    if (this.routingNotice.textContent !== notice) this.routingNotice.textContent = notice;
    // Include detours and actual card sizes in the scrollable surface, including during drag.
    const points = this.wireRoutes.flatMap(route => route.points);
    const width = Math.max(1100, ...cards.map(r => r.right + 32), ...points.map(p => p.x + 32));
    const height = Math.max(700, ...cards.map(r => r.bottom + 32), ...points.map(p => p.y + 32));
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
    this.extent.style.width = `${width * this.zoom}px`; this.extent.style.height = `${height * this.zoom + VIEWPORT_CONTROL_SPACE}px`;
  }
}
