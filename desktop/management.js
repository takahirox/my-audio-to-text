import { GraphEditor } from '../extension/graph-editor.js';
import { GraphDraftSession, recoveryDrafts } from '../extension/graph-draft-session.js';
import { DisplayNode } from '../web/display-node.js';
import { assertDesktopGraph, defaultDesktopGraph, desktopNodeTypes, planGraph } from './graph.js';

const host = window.desktop;
const element = id => document.getElementById(id);
const sections = [...document.querySelectorAll('main > section')];
const nav = [...document.querySelectorAll('nav [data-page]')];
const displays = new Map();
let current, currentPage, editor, draft, editorId, lastLibrary, lastDisplaySpecs, actionError = '';

function errorNotice() { element('errors').textContent = actionError || current?.session.error || ''; }
function run(action) {
  return async (...args) => {
    actionError = '';
    try { await action(...args); }
    catch (error) { actionError = error.message.replace(/^Error invoking remote method '[^']+': Error: /, ''); }
    errorNotice();
  };
}

function button(label, action) {
  const control = document.createElement('button');
  control.textContent = label;
  control.onclick = run(action);
  return control;
}

function navigate(page) {
  currentPage = page;
  for (const section of sections) section.hidden = section.id !== page;
  for (const control of nav) {
    if (control.dataset.page === (page === 'editor' ? 'library' : page)) control.setAttribute('aria-current', 'page');
    else control.removeAttribute('aria-current');
  }
  if (page === 'models') void modelAction('modelStatus');
}

async function flush() {
  editor?.commitEdit();
  await draft?.flush();
}

async function edit(entry) {
  if (editorId !== entry.id) {
    await flush();
    draft?.close();
    const graph = assertDesktopGraph(entry.graph);
    if (!editor) {
      editor = new GraphEditor(element('graph-editor'), graph, {
        nodeTypes: desktopNodeTypes, makeDefault: defaultDesktopGraph, assertHostGraph: assertDesktopGraph,
        onDraft: graph => draft.changed(graph), onRetry: run(flush), onFlush: flush, exportFile: host.exportGraph,
      });
    } else editor.setSaved(graph);
    draft = new GraphDraftSession({
      id: entry.id, graph, base: entry.revision, storage: localStorage, sessionId: crypto.randomUUID(),
      validate: assertDesktopGraph,
      persist: async (graph, revision) => ({ base: (await host.save(entry.id, revision, graph)).revision }),
      onSaved: graph => { editor.saved = structuredClone(graph); editor.updateSummary(); },
      onState: (state, error) => editor.setSaveState(state, error),
    });
    const recovery = recoveryDrafts(localStorage, entry.id).find(item => item.base === entry.revision);
    if (recovery && JSON.stringify(recovery.graph) !== JSON.stringify(graph)) {
      editor.draft = assertDesktopGraph(recovery.graph);
      draft.keys.add(recovery.key);
      draft.changed(editor.draft);
      editor.draw();
    }
    editorId = entry.id;
  }
  element('editor-title').textContent = entry.name;
  navigate('editor');
  editor.scheduleWires();
}

function renderLibrary(library) {
  const signature = JSON.stringify(library.graphs.map(({ id, revision }) => [id, revision])) + library.selected;
  if (signature === lastLibrary) return;
  lastLibrary = signature;
  const graphs = element('graphs'), picker = element('live-graph'), previous = picker.value;
  const active = document.activeElement?.dataset;
  graphs.replaceChildren();
  picker.replaceChildren();
  for (const entry of library.graphs) {
    const row = document.createElement('article');
    row.className = 'panel graph-entry';
    row.setAttribute('aria-label', entry.name);
    const name = document.createElement('strong');
    name.textContent = entry.name;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (entry.id === library.selected) {
      const selected = document.createElement('span');
      selected.textContent = 'Shortcut graph';
      selected.className = 'current-graph';
      actions.append(selected);
    } else {
      const select = button('Use for shortcut', () => host.select(entry.id));
      select.dataset.graphId = entry.id; select.dataset.action = 'select';
      actions.append(select);
    }
    const editButton = button('Edit', () => edit(current.library.graphs.find(candidate => candidate.id === entry.id)));
    editButton.dataset.graphId = entry.id; editButton.dataset.action = 'edit';
    actions.append(editButton, button('Duplicate', async () => {
      await flush();
      const saved = current.library.graphs.find(candidate => candidate.id === entry.id);
      await edit(await host.add(`${saved.name.slice(0, 115)} copy`, saved.graph));
    }), button('Export JSON', async () => {
      await flush();
      await host.exportGraph(current.library.graphs.find(candidate => candidate.id === entry.id).graph);
    }));
    row.append(name, actions);
    graphs.append(row);
    try {
      planGraph(entry.graph, 'live');
      picker.add(new Option(entry.name, entry.id));
    } catch { /* Graphs that require an external caret run from the tray or shortcut. */ }
  }
  if (Array.from(picker.options).some(option => option.value === previous)) picker.value = previous;
  if (active?.graphId && currentPage === 'library') {
    const controls = [...graphs.querySelectorAll('button[data-graph-id]')];
    (controls.find(control => control.dataset.graphId === active.graphId && control.dataset.action === active.action)
      || controls.find(control => control.dataset.graphId === active.graphId))?.focus();
  }
}

function modelUpdate(model) {
  const state = model?.state || 'Checking cache…';
  const busy = ['Checking cache…', 'Downloading'].includes(state);
  element('model-status').textContent = state;
  element('model-error').textContent = model?.error || '';
  const prepare = element('prepare');
  prepare.textContent = ['Error', 'Canceled'].includes(state) ? 'Retry' : 'Prepare';
  prepare.disabled = busy || state === 'Ready';
  prepare.onclick = () => modelAction(model?.retry || 'modelPrepare');
  element('cancel-download').hidden = !busy || state === 'Checking cache…';
  element('delete-model').disabled = busy || !model?.cachedBytes || current?.session.phase !== 'idle';
  const progress = element('model-progress');
  progress.hidden = state !== 'Downloading';
  if (model?.totalBytes) { progress.max = model.totalBytes; progress.value = model.downloadedBytes || 0; }
}

const modelAction = run(async action => {
  const result = await host.model(action);
  if (result) modelUpdate(result);
});

function renderDisplays(specs) {
  const signature = JSON.stringify(specs);
  if (lastDisplaySpecs === signature) return;
  lastDisplaySpecs = signature;
  displays.clear();
  element('displays').replaceChildren();
  for (const { id, settings } of specs) {
    const card = document.createElement('article');
    card.className = 'panel';
    const title = document.createElement('h3');
    title.textContent = settings.title || `Display · ${id}`;
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', title.textContent);
    const panels = {}, tabs = {};
    function select(port) {
      for (const key of Object.keys(tabs)) {
        tabs[key].setAttribute('aria-selected', String(port === key));
        tabs[key].tabIndex = port === key ? 0 : -1;
        panels[key].hidden = port !== key;
      }
    }
    const display = new DisplayNode((fragment, port) => panels[port].replaceChildren(fragment), settings);
    for (const [index, port] of Object.keys(display.inputs).entries()) {
      const tab = button(settings.inputLabels?.[port] || `Input ${index + 1}`, () => select(port));
      tab.setAttribute('role', 'tab');
      tab.id = `live-${id}-${port}-tab`;
      tabs[port] = tab;
      const panel = document.createElement('div');
      panel.id = `live-${id}-${port}`;
      panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); panel.tabIndex = 0;
      tab.setAttribute('aria-controls', panel.id);
      panels[port] = panel;
      list.append(tab);
    }
    list.onkeydown = event => {
      const keys = Object.keys(tabs), index = Object.values(tabs).indexOf(event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = ({ Home: 0, End: keys.length - 1, ArrowLeft: (index + keys.length - 1) % keys.length,
        ArrowRight: (index + 1) % keys.length })[event.key];
      select(keys[next]); tabs[keys[next]].focus();
    };
    select(Object.keys(tabs)[0]);
    card.append(title, list, ...Object.values(panels));
    element('displays').append(card);
    displays.set(id, display);
  }
}

function showItem({ node, port, item }) { displays.get(node)?.render(item, port); }
function update(value) {
  current = value;
  renderLibrary(value.library);
  element('library-shortcut').textContent = value.shortcutError ? 'See Settings' : value.library.shortcut;
  const shortcut = element('shortcut');
  if (!shortcut.value || (!value.shortcutError && document.activeElement !== shortcut)) shortcut.value = value.library.shortcut;
  element('shortcut-error').textContent = value.shortcutError;
  const { phase, microphone } = value.session;
  const active = phase !== 'idle';
  element('start-live').disabled = active || !element('live-graph').value;
  element('live-graph').disabled = active;
  element('stop-live').hidden = phase !== 'running';
  element('cancel-live').hidden = !active || phase === 'canceling';
  element('live-state').textContent = ({ preparing: 'Preparing…', running: microphone ? 'Recording' : 'Running',
    stopping: 'Finishing…', canceling: 'Canceling…' })[phase] || '';
  renderDisplays(value.session.displays || []);
  if (phase === 'preparing') for (const display of displays.values()) {
    for (const port of Object.keys(display.inputs)) display.render([], port);
  }
  value.items.forEach(showItem);
  modelUpdate(value.model);
  errorNotice();
}

for (const control of nav) control.onclick = () => { actionError = ''; navigate(control.dataset.page); errorNotice(); };
element('back').onclick = run(async () => { await flush(); navigate('library'); });
element('add-graph').onsubmit = run(async event => {
  event.preventDefault();
  await flush();
  const input = element('graph-name');
  await edit(await host.add(input.value));
  input.value = '';
});
element('import').onclick = () => element('import-file').click();
element('import-file').onchange = run(async ({ target }) => {
  try {
    const file = target.files[0];
    if (!file) return;
    await flush();
    const graph = assertDesktopGraph(JSON.parse(await file.text()));
    await edit(await host.add(file.name.replace(/\.json$/i, '').slice(0, 120) || 'Imported graph', graph));
  } finally { target.value = ''; }
});
element('shortcut-form').onsubmit = run(async event => { event.preventDefault(); await host.shortcut(element('shortcut').value); });
element('cancel-download').onclick = () => modelAction('modelCancel');
element('delete-model').onclick = () => modelAction('modelDelete');
element('start-live').onclick = run(async () => { await flush(); await host.startLive(element('live-graph').value); });
element('stop-live').onclick = run(host.stop);
element('cancel-live').onclick = run(host.cancel);
host.onUpdate(update);
host.onNavigate(page => { actionError = ''; navigate(page); errorNotice(); });
host.onDisplay(showItem);
host.onModel(modelUpdate);
update(await host.get());
navigate('library');
