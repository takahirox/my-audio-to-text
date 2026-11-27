import { GraphEditor } from '../extension/graph-editor.js';
import { GraphDraftSession, recoveryDrafts } from '../extension/graph-draft-session.js';
import { DisplayNode } from '../web/display-node.js';
import { audioToWav } from '../web/synthesized-audio.js';
import { graphModelRequirements } from '../extension/graph-model-preparation.js';
import { resolveSubgraphs } from '../extension/subgraphs.js';
import { desktopModels } from './models.js';
import { assertDesktopGraph, defaultDesktopGraph, desktopNodeTypes, planGraph } from './graph.js';

const host = window.desktop;
const element = id => document.getElementById(id);
const sections = [...document.querySelectorAll('main > section')];
const nav = [...document.querySelectorAll('nav [data-page]')];
const displays = new Map(), audioPlayers = new Map(), modelViews = new Map(), statusRows = new Map();
let modelOperation, sessionId, licenseTicket = 0;
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
  control.type = 'button';
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
  if (page === 'models') void inspectModel();
}

async function flush() {
  editor?.commitEdit();
  await draft?.flush();
}

function bindDraft(entry, graph) {
  draft?.close();
  draft = new GraphDraftSession({
    id: entry.id, graph, base: entry.revision, storage: localStorage, sessionId: crypto.randomUUID(),
    validate: graph => assertDesktopGraph(graph, current.library.graphs, entry.kind),
    persist: async (graph, revision) => ({ base: (await host.save(entry.id, revision, graph)).revision }),
    onSaved: graph => { editor.saved = structuredClone(graph); editor.updateSummary(); renderGraphModels(); },
    onState: (state, error) => editor.setSaveState(state, error),
  });
}

async function edit(entry) {
  if (editorId !== entry.id) {
    await flush();
    const graph = assertDesktopGraph(entry.graph, current.library.graphs, entry.kind);
    editor?.dispose();
    const mount = document.createElement('div');
    element('graph-editor').replaceChildren(mount);
    editor = new GraphEditor(mount, graph, {
      nodeTypes: desktopNodeTypes, makeDefault: defaultDesktopGraph,
      definitions: current.library.graphs, kind: entry.kind, graphId: entry.id, subgraphExecutionError: null,
      assertHostGraph: graph => assertDesktopGraph(graph, current.library.graphs, entry.kind),
      onDraft: graph => draft.changed(graph), onRetry: run(flush), onFlush: flush,
      exportFile: graph => host.exportGraph(graph, entry.id),
      onEditSubgraph: run(id => edit(current.library.graphs.find(candidate => candidate.id === id))),
      onCreateSubgraph: async (shared, revision) => {
        const library = await host.extract(entry.id, revision, shared);
        const saved = library.graphs.find(candidate => candidate.id === entry.id);
        bindDraft(saved, saved.graph);
        editor.saved = structuredClone(saved.graph);
        return library;
      },
    });
    bindDraft(entry, graph);
    const checkpoints = recoveryDrafts(localStorage, entry.id).filter(item => item.base === entry.revision);
    for (const checkpoint of checkpoints) draft.keys.add(checkpoint.key);
    const [recovery] = checkpoints;
    if (recovery && JSON.stringify(recovery.graph) !== JSON.stringify(graph)) {
      // Checkpoints can contain invalid settings. Restore the edit for repair
      // or Undo, and let Auto Save validate it before replacing the saved graph.
      editor.edit(() => { editor.draft = recovery.graph; });
      editor.draw();
    }
    editorId = entry.id;
  }
  element('editor-title').textContent = entry.name;
  navigate('editor');
  renderGraphModels();
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
    name.textContent = entry.kind === 'subgraph' ? `${entry.name} · Subgraph` : entry.name;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (entry.id === library.selected) {
      const selected = document.createElement('span');
      selected.textContent = 'Shortcut graph';
      selected.className = 'current-graph';
      actions.append(selected);
    } else if (entry.kind !== 'subgraph') {
      const select = button('Use for shortcut', () => host.select(entry.id));
      select.dataset.graphId = entry.id; select.dataset.action = 'select';
      actions.append(select);
    }
    const editButton = button('Edit', () => edit(current.library.graphs.find(candidate => candidate.id === entry.id)));
    editButton.dataset.graphId = entry.id; editButton.dataset.action = 'edit';
    actions.append(editButton, button('Duplicate', async () => {
      await flush();
      const saved = current.library.graphs.find(candidate => candidate.id === entry.id);
      await edit(await host.add(`${saved.name.slice(0, 115)} copy`, saved.graph, saved.kind === 'subgraph' ? saved.kind : undefined));
    }), button('Export JSON', async () => {
      await flush();
      await host.exportGraph(current.library.graphs.find(candidate => candidate.id === entry.id).graph, entry.id);
    }));
    row.append(name, actions);
    graphs.append(row);
    try {
      if (entry.kind === 'subgraph') continue;
      planGraph(entry.graph, 'live', library.graphs);
      picker.add(new Option(entry.name, entry.id));
    } catch { /* Keep drafts and graphs requiring a native caret in the library. */ }
  }
  if (Array.from(picker.options).some(option => option.value === previous)) picker.value = previous;
  if (active?.graphId && currentPage === 'library') {
    const controls = [...graphs.querySelectorAll('button[data-graph-id]')];
    (controls.find(control => control.dataset.graphId === active.graphId && control.dataset.action === active.action)
      || controls.find(control => control.dataset.graphId === active.graphId))?.focus();
  }
}

const modelPicker = element('model-picker');
for (const model of desktopModels) modelPicker.add(new Option(model.title, model.key));
modelPicker.value = 'moonshine-small-ja';
const selectedModel = () => desktopModels.find(model => model.key === modelPicker.value);

function progressBar(id, view) {
  const progress = element(id);
  progress.hidden = view?.state !== 'Downloading';
  if (view?.totalBytes) {
    progress.max = view.totalBytes;
    progress.value = view.downloadedBytes || 0;
  }
}

function renderModel() {
  const model = modelViews.get(modelPicker.value), state = model?.state || 'Unchecked';
  const active = current?.session.phase !== 'idle', busy = !!modelOperation;
  element('model-status').textContent = state === 'Checking' ? 'Checking cache…' : state;
  element('model-error').textContent = model?.error || '';
  const prepare = element('prepare');
  prepare.textContent = ['Error', 'Canceled'].includes(state) ? 'Retry' : 'Prepare';
  prepare.disabled = active || busy || state === 'Ready';
  prepare.onclick = () => modelAction(model?.retry || 'modelPrepare');
  element('cancel-download').hidden = modelOperation?.key !== modelPicker.value || modelOperation.action !== 'modelPrepare';
  element('delete-model').disabled = active || busy || !model?.cachedBytes;
  progressBar('model-progress', model);
}

const modelAction = run(async (action, key = modelPicker.value) => {
  await host.model(action, key);
  // Progress and the final state arrive through the model update event.
});

function modelUpdate({ key, value, operation, reset }) {
  const finished = modelOperation && !operation;
  modelOperation = operation;
  if (reset) modelViews.clear();
  modelViews.set(key, value);
  renderModel();
  renderGraphModels();
  if (finished && currentPage === 'models' && key !== modelPicker.value) void modelAction('modelStatus');
}

async function inspectModel() {
  const model = selectedModel(), ticket = ++licenseTicket;
  element('model-title').textContent = model.title;
  element('model-size').textContent = model.size;
  element('model-requirements').textContent = model.requirements || '';
  const notice = element('model-license');
  notice.textContent = '';
  const verifying = modelOperation ? undefined : modelAction('modelStatus');
  const licenses = [model.url, ...(model.links || []).map(link => link.url).filter(url => url.endsWith('.txt'))];
  try {
    const contents = await Promise.all(licenses.map(async url => {
      const response = await fetch(url);
      if (!response.ok) throw Error('License notice unavailable.');
      return response.text();
    }));
    if (ticket === licenseTicket) notice.textContent = contents.join('\n\n');
  } catch (error) { if (ticket === licenseTicket) notice.textContent = error.message; }
  await verifying;
}

function renderGraphModels() {
  if (!current) return;
  for (const [id, graph] of [
    ['editor-models', editor?.saved],
    ['live-models', current.library.graphs.find(entry => entry.id === element('live-graph').value)?.graph],
  ]) {
    const container = element(id);
    let requirements = [];
    if (graph) try { requirements = graphModelRequirements(resolveSubgraphs(graph, current.library.graphs)); }
    catch { /* Graph validation presents the structural error. */ }
    const signature = JSON.stringify(requirements.map(({ key }) => [key, modelViews.get(key)?.state]));
    if (signature === container.dataset.models) continue;
    container.dataset.models = signature;
    container.hidden = !requirements.length;
    container.replaceChildren(...requirements.map(({ key, title }) => {
      const label = desktopModels.find(model => model.key === key)?.title || title;
      const state = modelViews.get(key)?.state;
      return button(state ? `${label} · ${state}` : label, () => {
        modelPicker.value = key;
        navigate('models');
      });
    }));
  }
}

function renderPreparation(view) {
  const label = element('preparation');
  label.hidden = !view;
  label.textContent = view ? `${view.title} · ${view.state}` : '';
  progressBar('preparation-progress', view);
}

function renderActions({ id, phase, actions = [] }) {
  const container = element('live-action-buttons');
  element('live-actions').hidden = !actions.length;
  const existing = new Map([...container.children].map(control => [control.dataset.node, control]));
  for (const [index, action] of actions.entries()) {
    const control = existing.get(action.id) || button(action.label, () => {});
    existing.delete(action.id);
    control.dataset.node = action.id;
    control.textContent = action.label;
    control.disabled = phase !== 'running' || !!action.disabled;
    control.title = action.reason || action.id;
    control.onclick = run(() => host.press(id, action.id));
    if (container.children[index] !== control) container.insertBefore(control, container.children[index] || null);
  }
  for (const control of existing.values()) control.remove();
}

function renderSpeakerControl() {
  element('enable-speakers').hidden = !['running', 'stopping'].includes(current?.session.phase)
    || ![...statusRows.values()].some(row => row.dataset.needsActivation === 'true');
}

function showStatus({ node, message, severity, needsActivation }) {
  const list = element('node-status');
  let row = statusRows.get(node);
  if (!row) {
    row = document.createElement('li');
    statusRows.set(node, row);
    list.append(row);
  }
  row.textContent = `${node} · ${message}`;
  row.dataset.severity = severity || '';
  row.dataset.needsActivation = String(needsActivation);
  list.hidden = false;
  renderSpeakerControl();
}

function clearAudio() {
  for (const { url } of audioPlayers.values()) URL.revokeObjectURL(url);
  audioPlayers.clear();
  element('audio-outputs').replaceChildren();
}

function showAudio({ clip, node, audio }) {
  if (audioPlayers.has(clip)) return;
  const url = URL.createObjectURL(audioToWav(audio));
  const card = document.createElement('article'), player = document.createElement('audio');
  card.className = 'panel actions';
  player.controls = true;
  player.src = url;
  player.setAttribute('aria-label', `Generated speech · ${node}`);
  card.append(player, button('Save WAV', () => host.saveWav(clip)));
  audioPlayers.set(clip, { url });
  element('audio-outputs').append(card);
}

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
  if (editor) editor.definitions = value.library.graphs;
  modelOperation = value.modelOperation;
  modelViews.clear();
  for (const [key, model] of Object.entries(value.models)) modelViews.set(key, model);
  if (value.session.id && value.session.id !== sessionId) {
    sessionId = value.session.id;
    statusRows.clear();
    element('node-status').replaceChildren();
    element('node-status').hidden = true;
    clearAudio();
  }
  value.nodeStatus.forEach(showStatus);
  renderSpeakerControl();
  renderActions(value.session);
  renderPreparation(value.session.phase === 'preparing' ? value.preparation : undefined);
  renderGraphModels();
  element('library-shortcut').textContent = value.shortcutError ? 'See Settings' : value.library.shortcut;
  element('accessibility-help').textContent = value.platform === 'darwin'
    ? 'Enable My Audio to Text in System Settings → Privacy & Security → Device Control and Data Access (Accessibility). Use a supported text field for dictation.'
    : 'Enable assistive technology in your X11 desktop session and reopen the target application. Use a supported text field for dictation.';
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
  renderModel();
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
    await edit(await host.importGraph(file.name.replace(/\.json$/i, '').slice(0, 120) || 'Imported graph', JSON.parse(await file.text())));
  } finally { target.value = ''; }
});
element('shortcut-form').onsubmit = run(async event => { event.preventDefault(); await host.shortcut(element('shortcut').value); });
element('cancel-download').onclick = () => modelAction('modelCancel');
element('delete-model').onclick = () => modelAction('modelDelete');
modelPicker.onchange = () => { renderModel(); void inspectModel(); };
element('live-graph').onchange = () => {
  element('start-live').disabled = current.session.phase !== 'idle' || !element('live-graph').value;
  renderGraphModels();
};
element('start-live').onclick = run(async () => { await flush(); await host.startLive(element('live-graph').value); });
element('stop-live').onclick = run(host.stop);
element('cancel-live').onclick = run(host.cancel);
element('enable-speakers').onclick = run(() => host.enableSpeakers(current.session.id));
host.onUpdate(update);
host.onNavigate(page => { actionError = ''; navigate(page); errorNotice(); });
host.onDisplay(showItem);
host.onModel(modelUpdate);
host.onAudio(showAudio);
host.onNodeStatus(showStatus);
host.onPreparation(renderPreparation);
update(await host.get());
(await host.audio()).forEach(showAudio);
navigate('library');
