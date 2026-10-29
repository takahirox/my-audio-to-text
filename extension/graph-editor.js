import { NODE_TYPES, nodeDefinition, graphNode, defaultGraph, edge, validateGraph, graphWarnings, assertGraph } from './graph.js';

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
  constructor(root, graph, { onSave, onDraft = () => {}, onLoad = () => {}, recoveryGraph }) {
    this.root = root; this.onSave = onSave; this.onDraft = onDraft; this.onLoad = onLoad;
    this.saved = recoveryGraph ? null : assertGraph(graph); this.draft = structuredClone(recoveryGraph || this.saved); this.zoom = 1;
    const toolbar = el('div', undefined, 'graph-toolbar');
    this.saveButton = button('Save graph', 'graph-save', async () => {
      this.actions.open = false; this.saveButton.disabled = true; this.saveButton.textContent = 'Saving…';
      try {
        const graph = assertGraph(this.draft);
        this.saved = assertGraph(await this.onSave(graph) || graph);
        this.externalChange = false; this.error = ''; this.draw();
      } catch (error) { this.error = error.message; this.draw(); }
      finally { this.saveButton.disabled = false; this.saveButton.textContent = 'Save graph'; }
    });
    this.saveButton.className = 'primary';
    this.summary = el('p'); this.summary.id = 'graph-state'; this.summary.setAttribute('role', 'status');
    this.actions = el('details', undefined, 'graph-actions'); this.actions.append(el('summary', 'Graph actions'));
    const commands = el('div', undefined, 'graph-command-list');
    commands.append(
      button('Reset draft to default', 'graph-reset', () => {
        if (this.isDirty() && !confirm('Replace your unsaved draft with the default graph? Save is still required.')) return;
        this.closeActions(); this.draft = defaultGraph(); this.selected = null; this.selectedNode = null; this.draw();
      }),
      button('Load saved', 'graph-load', () => {
        if (this.isDirty() && !confirm('Discard your unsaved draft and load the saved graph?')) return;
        this.closeActions();
        try {
          this.saved = assertGraph(this.onLoad() || this.saved);
          this.draft = structuredClone(this.saved); this.selected = null; this.selectedNode = null; this.externalChange = false;
        } catch (error) { this.error = error.message; }
        this.draw();
      }),
      button('Validate draft', 'graph-validate', () => { this.closeActions(); this.error = this.diagnostics(true) || 'Draft valid. Save to use next session.'; this.draw(); }));
    const warningLabel = el('label'); this.warningPreference = el('input'); this.warningPreference.type = 'checkbox';
    this.warningPreference.id = 'graph-optional-warnings';
    this.warningPreference.checked = localStorage.getItem('graph-show-optional-warnings') === 'true';
    this.warningPreference.onchange = () => {
      localStorage.setItem('graph-show-optional-warnings', String(this.warningPreference.checked)); this.draw();
    };
    warningLabel.append(this.warningPreference, ' Show optional warnings'); commands.append(warningLabel);
    this.actions.append(commands);
    this.help = el('dialog', undefined, 'graph-help'); this.help.setAttribute('aria-label', 'Graph Editor help');
    this.help.append(el('h2', 'Graph Editor help'),
      el('p', 'Save applies to the next session. Start runs complete paths to outputs; incomplete Nodes remain in the draft. Graph actions provides validation, Load saved and Reset.'),
      el('p', 'Add nodes using search and categories. Select a node heading for settings and optional node help. Drag a heading or use arrow keys to move it.'),
      el('p', 'Connect by clicking an output then a matching input, or drag between ports. Reconnecting replaces only that input’s wire. Select a wire, then use its nearby Disconnect button. Keyboard: Enter or Space selects, Tab reaches Disconnect, Delete or Backspace removes a focused wire. Escape or blank canvas clears selection.'),
      el('p', 'Use Canvas zoom and Fit graph to navigate; scroll or swipe the canvas to pan. Touch: tap ports to connect and tap a wire to reveal Disconnect.'),
      el('p', 'LiveTextDisplay mounts DOM and follows the bottom while you are reading there. TextToDOM formats plain text; PairedTextToDOM formats one grouped translation pair. DOMAccumulator keeps DOM history; DOMCombiner combines the latest first and second snapshots, such as history above an ASR preview. TextAccumulator keeps text history and preview. Configure languages in Node settings. Save prepares required model weights; Models provides asset recovery.'),
      el('p', 'TextWindow batches committed ASR fragments before any translator. Connect text → translator.text → TextAccumulator.append. For opt-in retranslation, also connect provisional → translator.provisional; connect TextWindow.text → TranslationCommit.boundary and translator.source/text/error directly to TranslationCommit.source/text/error. TranslationCommit.provisional → TextAccumulator.preview; final → TextAccumulator.append. Only bounded closed windows commit; this does not retain conversation-wide context.'),
      el('p', 'TranslateGemma 4B English → Japanese: connect English ASR.final or Text.value → text, then text → TextAccumulator.append, or source/text/error → TextFormatter inputs. Both directions share a 3.112 GB download; allow 7 GB free storage and several GB free RAM/GPU memory. Requires Worker WebGPU; no fallback. Saving a graph containing either direction prepares these weights, including parked Nodes. Google Gemma Terms of Use and Prohibited Use Policy apply to use of this public ONNX conversion.'),
      (() => { const link = el('a', 'TranslateGemma terms, prohibited-use policy and attribution'); link.href = '../web/licenses/gemma-notices.txt'; return link; })(),
      button('Close help', null, () => this.help.close()));
    this.paletteButton = button('Add Node', 'graph-palette-toggle', () => this.togglePalette()); this.paletteButton.setAttribute('aria-expanded', 'false'); this.paletteButton.setAttribute('aria-controls', 'graph-palette');
    this.helpButton = button('Help', 'graph-help', () => this.help.showModal());
    this.help.onclose = () => this.helpButton.focus();
    toolbar.append(this.saveButton, this.summary, this.paletteButton, this.actions, this.helpButton);
    this.assetNotice = el('details'); this.assetNotice.id = 'graph-asset-notice'; this.assetNotice.hidden = true;
    this.assetRequirements = el('p'); this.assetNotice.append(el('summary', 'Model requirements and terms'), this.assetRequirements);
    this.errors = el('pre'); this.errors.id = 'graph-errors'; this.errors.setAttribute('role', 'alert');
    this.workspace = el('div', undefined, 'graph-workspace');
    this.palette = el('aside', undefined, 'graph-palette'); this.palette.id = 'graph-palette'; this.palette.hidden = true; this.palette.setAttribute('aria-label', 'Node palette');
    const paletteHeading = el('div', undefined, 'section-heading'); paletteHeading.append(el('h2', 'Add Node'), button('Close', null, () => this.togglePalette(false)));
    this.search = el('input'); this.search.type = 'search'; this.search.placeholder = 'Search nodes'; this.search.setAttribute('aria-label', 'Search nodes');
    this.category = el('select'); this.category.setAttribute('aria-label', 'Node category');
    for (const name of ['All categories', 'Sources / inputs', 'Processors', 'Constants / utilities', 'Outputs']) { const option = el('option', name); this.category.append(option); }
    this.types = el('select'); this.types.setAttribute('aria-label', 'Node type'); this.types.id = 'graph-node-type'; this.types.size = 8;
    this.paletteStatus = el('p', undefined, 'muted'); this.paletteStatus.setAttribute('role', 'status');
    this.addButton = button('Add selected node', 'graph-add', () => this.addNode(this.types.value));
    this.search.oninput = this.category.onchange = () => this.filterPalette();
    this.types.onkeydown = event => { if (event.key === 'Enter' && this.types.value) { event.preventDefault(); this.addNode(this.types.value); } };
    this.palette.append(paletteHeading, this.search, this.category, this.types, this.paletteStatus, this.addButton); this.filterPalette();
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
      this.selected = null; this.selectedEdge = null; this.selectedNode = null; this.draw(); this.scroll.focus({ preventScroll: true });
    };
    this.scroll.addEventListener('scroll', () => this.positionDisconnect());
    new ResizeObserver(() => this.positionDisconnect()).observe(this.scroll);
    this.inspector = el('aside', undefined, 'graph-inspector'); this.inspector.setAttribute('aria-label', 'Node settings inspector');
    const viewport = el('div', undefined, 'graph-viewport');
    const viewportActions = el('div', undefined, 'graph-viewport-actions');
    const zoomLabel = el('label', 'Canvas zoom '); this.zoomControl = el('select'); this.zoomControl.id = 'graph-zoom';
    for (const value of [0.25, 0.5, 0.75, 1, 1.25, 1.5]) { const option = el('option', `${value * 100}%`); option.value = value; this.zoomControl.append(option); }
    this.zoomControl.value = '1'; this.zoomControl.onchange = () => { this.zoom = Number(this.zoomControl.value); this.draw(); };
    zoomLabel.append(this.zoomControl); viewportActions.append(zoomLabel, button('Fit graph', 'graph-fit', () => this.fit()));
    viewport.append(viewportActions, this.scroll); this.workspace.append(viewport, this.inspector, this.palette);
    root.replaceChildren(toolbar, this.assetNotice, this.errors, this.workspace, this.help);
    root.addEventListener('keydown', event => {
      const wire = event.target.closest('.graph-wire');
      if (event.key === 'Escape') {
        if (event.target.closest('dialog')) return;
        if (!this.palette.hidden) { event.preventDefault(); this.togglePalette(false); return; }
        if (this.actions.open) { event.preventDefault(); this.actions.open = false; this.actions.querySelector('summary').focus(); return; }
        event.preventDefault(); const restoreFocus = wire || event.target === this.disconnectButton || this.inspector.contains(event.target);
        this.selected = null; this.selectedEdge = null; this.selectedNode = null; this.draw();
        if (restoreFocus) this.scroll.focus({ preventScroll: true });
      }
      if (['Delete', 'Backspace'].includes(event.key) && wire) {
        event.preventDefault(); event.stopPropagation(); this.disconnect(this.draft.edges[Number(wire.dataset.edge)]); this.scroll.focus({ preventScroll: true });
      }
    });
    this.draw();
  }
  diagnostics(includeWarnings = this.warningPreference?.checked) {
    return [...validateGraph(this.draft).map(message => `Error: ${message}`),
      ...(includeWarnings ? graphWarnings(this.draft).map(message => `Warning: ${message}`) : [])].join('\n');
  }
  closeActions() {
    this.actions.open = false; this.actions.querySelector('summary').focus({ preventScroll: true });
  }
  togglePalette(open = this.palette.hidden) {
    if (open) this.actions.open = false;
    this.palette.hidden = !open; this.paletteButton.setAttribute('aria-expanded', String(open));
    if (open) this.search.focus(); else this.paletteButton.focus();
  }
  filterPalette() {
    const selected = this.types.value, query = this.search.value.trim().toLowerCase(); this.types.replaceChildren();
    const groups = new Map();
    for (const [type, definition] of Object.entries(NODE_TYPES)) {
      const category = ['Number', 'Text', 'TextFormatter'].includes(type) ? 'Constants / utilities'
        : !Object.keys(definition.inputs).length ? 'Sources / inputs'
        : !Object.keys(definition.outputs).length ? 'Outputs' : 'Processors';
      if ((this.category.value !== 'All categories' && this.category.value !== category) || !`${type} ${definition.label}`.toLowerCase().includes(query)) continue;
      if (!groups.has(category)) { const group = el('optgroup'); group.label = category; groups.set(category, group); this.types.append(group); }
      const option = el('option', definition.label); option.value = type; groups.get(category).append(option);
    }
    if ([...this.types.options].some(option => option.value === selected)) this.types.value = selected;
    else this.types.selectedIndex = this.types.options.length ? 0 : -1;
    this.addButton.disabled = !this.types.options.length;
    this.paletteStatus.textContent = this.types.options.length ? `${this.types.options.length} node type${this.types.options.length === 1 ? '' : 's'}` : 'No matching nodes';
  }
  fit() {
    const cards = [...this.canvas.querySelectorAll('.graph-node')];
    const right = Math.max(300, ...cards.map(card => card.offsetLeft + card.offsetWidth + 32));
    const bottom = Math.max(200, ...cards.map(card => card.offsetTop + card.offsetHeight + 32));
    this.zoom = Math.max(.01, Math.min(1.5, this.scroll.clientWidth / right, this.scroll.clientHeight / bottom));
    this.zoomControl.querySelector('[data-fit]')?.remove();
    const option = el('option', `${Math.round(this.zoom * 100)}% (fit)`); option.value = this.zoom; option.dataset.fit = ''; this.zoomControl.append(option); this.zoomControl.value = String(this.zoom);
    this.draw(); this.scroll.scrollTo(0, 0);
  }
  addNode(type) {
    let id = type.toLowerCase(), suffix = 1;
    while (this.draft.nodes.some(node => node.id === id)) id = `${type.toLowerCase()}-${suffix++}`;
    this.draft.nodes.push(graphNode(type, id, 30 + (this.draft.nodes.length % 4) * 285, 520 + Math.floor(this.draft.nodes.length / 4) * 60));
    this.selectedNode = id; this.draw();
    const card = this.canvas.querySelector(`[data-node="${id}"]`); card?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const setting = this.inspector.querySelector('input, select, textarea') || this.inspector.querySelector('button');
    setting?.focus({ preventScroll: true });
    // The inspector stacks below the canvas in narrow windows.
    setting?.scrollIntoView({ block: 'center', inline: 'nearest' });
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
    const notices = [...new Set(this.draft.nodes.map(node => NODE_TYPES[node.type]?.preparationNotice).filter(Boolean))];
    this.assetNotice.hidden = !notices.length; this.assetRequirements.textContent = notices.join(' ');
    this.summary.textContent = `${this.isDirty() ? 'Unsaved draft' : 'Saved graph'} · ${running ? `Active${Number.isInteger(this.tabId) ? ` · tab ${this.tabId}` : ''}${pending ? ' · earlier graph; saved edits apply next session' : ''}` : 'No active recording'}`;
    if (this.externalChange) this.summary.textContent += ' · Saved graph changed elsewhere; draft kept. Load saved before saving.';
    this.summary.classList.toggle('graph-conflict', !!this.externalChange);
  }
  connect(id, port, contract) {
    if (this.selected && this.selected.contract === contract && this.selected.id !== id) {
      const proposed = edge(this.selected.id, this.selected.port, id, port);
      const identical = this.draft.edges.some(e => JSON.stringify(e) === JSON.stringify(proposed));
      if (!identical) {
        const candidate = { ...this.draft, edges: this.draft.edges.filter(e => e.to[0] !== id || e.to[1] !== port).concat(proposed) };
        // Drafts can be incomplete. Reject newly introduced structural errors.
        const previous = new Set(validateGraph(this.draft));
        const errors = validateGraph(candidate).filter(message => !previous.has(message));
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
  resizeFormatter(node, delta) {
    const count = node.settings.inputCount + delta;
    if (count < 1) return;
    node.settings.inputCount = count;
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
  drawInspector() {
    const focused = this.inspector.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
    this.inspector.replaceChildren(el('h2', 'Settings'));
    const node = this.draft.nodes.find(node => node.id === this.selectedNode);
    this.inspector.hidden = !node; this.workspace.classList.toggle('has-selection', !!node);
    if (!node) return;
    const close = button('Close settings', null, () => { this.selectedNode = null; this.draw(); this.scroll.focus({ preventScroll: true }); }); this.inspector.append(close);
    const definition = nodeDefinition(node); this.inspector.append(el('h3', definition.label), el('p', `Node: ${node.id}`));
    for (const [key, values] of Object.entries(definition.settings || {})) {
      const label = el('label', key + ' '), select = el('select'); select.setAttribute('aria-label', `${node.id} ${key}`);
      for (const value of values) { const option = el('option', value); option.value = value; select.append(option); }
      select.value = node.settings[key]; select.onchange = () => this.updateSetting(node, key, select.value);
      label.append(select); this.inspector.append(label);
    }
    for (const [key, spec] of Object.entries(definition.textSettings || {})) {
      const label = el('label', key + ' '), control = el(spec.multiline ? 'textarea' : 'input');
      control.setAttribute('aria-label', `${node.id} ${key}`); if (spec.maxLength !== undefined) control.maxLength = spec.maxLength; control.value = node.settings[key];
      control.onchange = () => this.updateSetting(node, key, control.value);
      label.append(control); this.inspector.append(label);
    }
    if (node.type === 'TextFormatter') {
      this.inspector.append(el('p', `${node.settings.inputCount} TEXT inputs. Remove deletes the last input and its wire; template references remain editable.`));
      const add = button('Add input', null, () => this.resizeFormatter(node, 1));
      const remove = button('Remove last input', null, () => this.resizeFormatter(node, -1));
      add.setAttribute('aria-label', `${node.id} Add input`); remove.setAttribute('aria-label', `${node.id} Remove last input`);
      remove.disabled = node.settings.inputCount <= 1;
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
    const details = el('details'); details.append(el('summary', 'Node help and ports'));
    if (definition.help) details.append(el('p', definition.help));
    if (!definition.settings && !definition.textSettings && !definition.numberSettings) this.inspector.append(el('p', 'This Node has no configurable settings.'));
    for (const [side, ports] of [['Input', definition.inputs], ['Output', definition.outputs]]) {
      for (const [name, contract] of Object.entries(ports)) details.append(el('p', `${side} ${name}: ${contract.name}`, 'muted'));
    }
    this.inspector.append(details);
    const remove = button('Remove Node', null, () => { this.removeNode(node); this.scroll.focus({ preventScroll: true }); });
    remove.setAttribute('aria-label', `Remove ${node.id}`); this.inspector.append(remove);
    if (focused) [...this.inspector.querySelectorAll('[aria-label]')].find(control => control.getAttribute('aria-label') === focused)?.focus({ preventScroll: true });
  }
  removeNode(node) {
    this.draft.nodes = this.draft.nodes.filter(n => n !== node);
    this.draft.edges = this.draft.edges.filter(e => e.from[0] !== node.id && e.to[0] !== node.id);
    this.selected = null; this.selectedNode = null; this.draw();
  }
  draw() {
    if (!this.draft.edges.includes(this.selectedEdge)) this.selectedEdge = null;
    this.canvas.replaceChildren(this.svg); this.svg.replaceChildren();
    this.errors.textContent = this.error || this.diagnostics(); this.error = '';
    this.updateSummary(); this.drawInspector();
    const width = Math.max(1100, ...this.draft.nodes.map(n => n.position.x + 285)), height = Math.max(700, ...this.draft.nodes.map(n => n.position.y + 250));
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.canvas.style.transform = `scale(${this.zoom})`;
    this.extent.style.width = `${width * this.zoom}px`; this.extent.style.height = `${height * this.zoom}px`;
    for (const node of this.draft.nodes) {
      const definition = nodeDefinition(node), card = el('section', undefined, 'graph-node'); card.dataset.node = node.id;
      card.classList.toggle('selected-node', this.selectedNode === node.id);
      card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`;
      const heading = el('button', `${definition.label} (${node.id})`, 'graph-heading'); heading.type = 'button';
      heading.setAttribute('aria-label', `Select ${node.id}`); heading.setAttribute('aria-pressed', String(this.selectedNode === node.id));
      heading.title = 'Select to inspect settings. Drag to move; arrow keys move by 10 pixels.';
      heading.onclick = () => { this.selectedEdge = null; this.drawWires(); this.selectedNode = node.id; this.drawInspector(); for (const c of this.canvas.querySelectorAll('.graph-node')) { const selected = c.dataset.node === node.id; c.classList.toggle('selected-node', selected); c.querySelector('.graph-heading').setAttribute('aria-pressed', String(selected)); } };
      heading.onkeydown = event => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key];
        if (!delta) return; event.preventDefault(); this.selectedNode = node.id;
        node.position.x = Math.max(0, node.position.x + delta[0]); node.position.y = Math.max(0, node.position.y + delta[1]); this.draw();
        this.canvas.querySelector(`[data-node="${node.id}"] .graph-heading`).focus();
      };
      heading.onpointerdown = event => {
        if (event.button !== 0) return; heading.setPointerCapture(event.pointerId); this.selectedEdge = null; this.drawWires(); this.selectedNode = node.id; this.drawInspector();
        const x = event.clientX, y = event.clientY, origin = { ...node.position }; let moved = false;
        heading.onpointermove = move => {
          if (Math.abs(move.clientX - x) + Math.abs(move.clientY - y) < 3) return;
          moved = true;
          node.position.x = Math.max(0, origin.x + (move.clientX - x) / this.zoom); node.position.y = Math.max(0, origin.y + (move.clientY - y) / this.zoom);
          card.style.left = `${node.position.x}px`; card.style.top = `${node.position.y}px`; this.drawWires();
        };
        const done = () => { heading.onpointermove = null; heading.onpointerup = heading.onpointercancel = null; if (moved) this.draw(); };
        heading.onpointerup = heading.onpointercancel = done;
      };
      card.append(heading);
      const ports = el('div', undefined, 'graph-ports');
      for (const [side, declarations] of [['input', definition.inputs], ['output', definition.outputs]]) {
        const column = el('div');
        for (const [port, contract] of Object.entries(declarations)) {
          const portLabel = port.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
          const control = button(`${side === 'input' ? '←' : '→'} ${portLabel}`, null, () => {
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
                input.disabled = target.id === node.id || nodeDefinition(target).inputs[input.dataset.port] !== contract;
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
