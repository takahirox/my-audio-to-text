import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, screen, session, systemPreferences, Tray } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { DesktopLibrary } from './library.js';
import { planGraph } from './graph.js';
import { exportDraft } from '../extension/graph-library.js';
import { audioToWav } from '../web/synthesized-audio.js';
import { desktopModels } from './models.js';
import { fetchPinnedModelAsset } from './model-transport.js';
import { DesktopSession } from './session.js';
import { FocusedTarget } from './focused-target.js';

const root = resolve(import.meta.dirname, '..');
const origin = 'local-voice://desktop';
const appURL = page => `${origin}/desktop/${page}.html`;
const icon = join(root, 'extension/icons/icon-32.png');
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src blob:; base-uri 'none'; frame-ancestors 'none'";
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.txt': 'text/plain', '.jinja': 'text/plain', '.gz': 'application/gzip' };
const modelSources = JSON.parse(readFileSync(join(import.meta.dirname, 'model-sources.json'), 'utf8'));
const sourcesFor = keys => new Map(keys.flatMap(key => Object.entries(modelSources[key])));
const modelActivity = () => modelOperation && { key: modelOperation.key, action: modelOperation.action };
const defaultModel = 'moonshine-small-ja';
const mac = process.platform === 'darwin';

app.setName('My Audio to Text');
if (!mac) app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'local-voice', privileges: {
  standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true, corsEnabled: true,
} }]);

let library, controller, target, tray, runtime, management, indicator, runtimeReady;
let shortcutError = '', registeredShortcut, quitting = false, shutDown = false;
let modelOperation, graphDownload, shortcutChanging = false, runtimeSequence = 0, audioSequence = 0;
let shortcutSession, shortcutContext = 0;
let trayMenu;
const pendingCommands = new Map(), displayItems = new Map(), audioItems = new Map(), modelViews = new Map();

function isFrom(event, window, page) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appURL(page);
}

function send(window, channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function view() {
  const session = { ...controller.state, modelKeys: controller.current?.plan.modelKeys || [] };
  return { library: library.value, session, shortcutError, models: Object.fromEntries(modelViews), modelOperation: modelActivity(),
    platform: process.platform, items: [...displayItems.values()],
    nodeStatus: [...(controller.current?.status.values() || [])], preparation: controller.current?.preparation };
}

function statusText() {
  const { phase, microphone } = controller.state;
  return ({ preparing: 'Preparing…', running: microphone ? 'Recording' : 'Running',
    stopping: 'Finishing…', canceling: 'Canceling…' })[phase] || (controller.state.error ? 'Voice typing stopped' : 'Ready');
}

function publish() {
  if (quitting) return;
  send(management, 'management:update', view());
  updateTray();
  showIndicator();
}

function showIndicator() {
  const state = controller.state;
  const text = controller.current?.floatingText ?? '';
  send(indicator, 'indicator:update', { ...state, text });
  if (state.phase === 'canceling' || (state.phase === 'idle' && !state.error)) {
    indicator?.hide();
    return;
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = state.error || text ? 430 : 226, height = (state.error ? 120 : 52) + (text ? 80 : 0);
  const bounds = { width, height, x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16 };
  const previous = indicator.getBounds();
  if (Object.keys(bounds).some(key => bounds[key] !== previous[key])) indicator.setBounds(bounds);
  if (!indicator.isVisible()) indicator.showInactive();
}

function updateTray() {
  const state = controller.state;
  tray.setToolTip(`My Audio to Text · ${statusText()} · ${registeredShortcut || 'Set a shortcut in Settings'}`);
  trayMenu = Menu.buildFromTemplate([
    { label: state.phase === 'preparing' ? 'Cancel preparation' : state.phase === 'idle' ? 'Start voice typing' : 'Stop voice typing',
      enabled: !['stopping', 'canceling'].includes(state.phase), click: trayToggle },
    ...(state.phase === 'running' || state.phase === 'stopping' ? [
      { label: 'Cancel voice typing', click: () => { void controller.cancel(); } },
    ] : []),
    { label: 'Shortcut graph', submenu: library.value.graphs.filter(entry => entry.kind !== 'subgraph').map(entry => ({
      label: entry.name, type: 'radio', checked: entry.id === library.value.selected,
      click: () => { try { library.select(entry.id); publish(); } catch (error) { controller.update({ error: error.message }); } },
    })) },
    { type: 'separator' },
    { label: 'Graph Library', click: () => showManagement('library') },
    { label: 'Models', click: () => showManagement('models') },
    { label: 'Settings', click: () => showManagement('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  if (!mac) tray.setContextMenu(trayMenu);
}

function showManagement(page) {
  send(management, 'management:navigate', page);
  management.show();
  if (mac) app.focus({ steal: true });
  management.focus();
}

function start(id, mode) {
  if (controller.current || quitting) return;
  try {
    const entry = library.lookup(id);
    if (entry.kind === 'subgraph') throw Error('Choose a parent graph to run.');
    const plan = planGraph(entry.graph, mode, library.value.graphs);
    if (modelOperation?.action === 'modelDelete') throw Error('Wait for model deletion to finish, then start again.');
    if (modelOperation?.action === 'modelPrepare') throw Error('Finish or cancel the Models download before starting a graph.');
    displayItems.clear();
    audioItems.clear();
    return controller.start(plan);
  } catch (error) { controller.update({ error: error.message }); }
}

function toggle() { void controller.toggle(); }

function trayToggle() {
  const session = controller.current;
  if (session) {
    setTimeout(() => { if (controller.current === session) toggle(); }, 90);
  } else {
    // Let GTK finish dismissing the menu before publish rebuilds it.
    const id = library.value.selected;
    setImmediate(() => { void start(id, 'dictation'); });
  }
}

function updateSession() {
  const { id, preparation } = controller.current || {};
  if (controller.state.phase === 'canceling' && ['Checking', 'Downloading'].includes(preparation?.state)) {
    modelViews.set(preparation.key, { ...modelViews.get(preparation.key), state: 'Canceled', error: 'Model preparation canceled. Retry to finish downloading.' });
  }
  if (!quitting && id !== shortcutSession) {
    // A held shortcut belongs to the session or idle period where it began.
    shortcutSession = id;
    void target.request('shortcut-context', id ?? null, ++shortcutContext).catch(() => {});
  }
  publish();
}

function shortcutReleased(value, context) {
  if (quitting || value !== registeredShortcut || context !== shortcutContext) return;
  if (!controller.current) {
    void start(library.value.selected, 'dictation');
  } else {
    // The helper waits for focus to settle before applying any final TEXT.
    toggle();
  }
}

async function registerShortcut(value, save = false) {
  if (value === registeredShortcut) return;
  const modifiers = value.split('+').slice(0, -1);
  if (!/^(?:(?:Control|Alt|Shift|Super)\+){2,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(value)
      || new Set(modifiers).size !== modifiers.length || !modifiers.some(key => key !== 'Shift')) {
    throw Error('Use at least two distinct modifiers (Control, Alt, Shift, Super) and a letter, digit, or F1–F12.');
  }
  await target.request('shortcut-context', shortcutSession ?? null, shortcutContext);
  await target.request('set-shortcut', null, value);
  try { if (save) library.shortcut(value); }
  catch (error) {
    try { await target.request('set-shortcut', null, registeredShortcut || ''); }
    catch { target.close(); }
    throw error;
  }
  registeredShortcut = value;
  const previousError = shortcutError;
  shortcutError = '';
  if (previousError && controller.state.error === previousError) controller.update({ error: '' });
  else publish();
}

function makeWindow(page, options) {
  const window = new BrowserWindow({ show: false, ...options,
    webPreferences: { preload: join(import.meta.dirname, `${page}-preload.cjs`),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  return window;
}

async function installProtocol() {
  await protocol.handle('local-voice', async request => {
    const url = new URL(request.url);
    if (url.host === 'desktop' && url.pathname === '/model-asset') {
      const preparation = graphDownload || modelOperation?.download;
      if (!preparation) return new Response(null, { status: 404 });
      return fetchPinnedModelAsset(request, preparation.sources, preparation.controller.signal);
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    const contentType = mime[extname(path)];
    if (url.host !== 'desktop' || request.method !== 'GET' || !path.startsWith(root + sep) || !contentType
        || !/^\/(desktop|extension|web)\//.test(url.pathname)) return new Response(null, { status: 404 });
    try {
      // Open JTalk accepts a URL for the voice bytes read from verified storage.
      const policy = url.pathname === '/web/kokoro-worker.js'
        ? csp.replace("connect-src 'self'", "connect-src 'self' blob:") : csp;
      return new Response(await readFile(path), { headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': policy,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  const profile = session.defaultSession;
  profile.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, done) => {
    // Downloads cross only the model transport route from the hidden runtime.
    const external = /^(?:https?|wss?):/.test(details.url);
    const model = details.url.startsWith(`${origin}/model-asset?`);
    done({ cancel: external || (model && details.webContentsId !== runtime?.webContents.id) });
  });
  const canCapture = (contents, permission, mediaTypes) => runtime && !runtime.isDestroyed() && contents === runtime.webContents
    && permission === 'media' && mediaTypes?.length === 1 && mediaTypes[0] === 'audio'
    && controller.current?.plan.microphone && controller.state.phase === 'preparing';
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(details.isMainFrame && details.requestingUrl === appURL('runtime')
      && canCapture(contents, permission, details.mediaTypes)));
  });
  profile.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => Boolean(
    requestingOrigin.replace(/\/$/, '') === origin && canCapture(contents, permission, [details.mediaType])));
  profile.on('will-download', event => event.preventDefault());
}

async function run(action, ...args) {
  const window = runtime;
  if (quitting && !['cancel', 'modelCancel'].includes(action)) throw Error('Desktop is quitting.');
  if (action === 'cancel') graphDownload?.controller.abort();
  if (action === 'modelCancel') modelOperation?.download?.controller.abort();
  await runtimeReady;
  if (window !== runtime || window.isDestroyed()) throw Error('The local graph runtime closed.');
  if (action === 'start' && (controller.current?.id !== args[0] || controller.state.phase !== 'preparing')) return;
  const request = ++runtimeSequence;
  const download = action === 'start' ? {
    controller: new AbortController(), sources: sourcesFor(controller.current.plan.modelKeys),
  } : null;
  if (download) graphDownload = download;
  const timeout = ['start', 'modelPrepare'].includes(action) ? 3_600_000 : action === 'press' ? 300_000 : 180_000;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetRuntime('The local graph runtime did not respond and was restarted.');
    }, timeout);
    pendingCommands.set(request, ({ error, value }) => {
      clearTimeout(timer);
      pendingCommands.delete(request);
      if (error) reject(Error(error));
      else resolve(value);
    });
    send(window, 'runtime:command', { request, action, args });
  }).finally(() => {
    if (download && graphDownload === download) {
      download.controller.abort();
      graphDownload = null;
    }
  });
}

function createRuntime() {
  runtime = makeWindow('runtime', {});
  const window = runtime;
  runtimeReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Could not load the local graph runtime. Reopen the desktop app.')), 10000);
    const ready = event => {
      if (!isFrom(event, window, 'runtime')) return;
      ipcMain.removeListener('runtime:ready', ready);
      clearTimeout(timeout);
      resolve();
    };
    ipcMain.on('runtime:ready', ready);
    window.on('closed', () => {
      clearTimeout(timeout);
      ipcMain.removeListener('runtime:ready', ready);
      reject(Error('The local graph runtime closed.'));
    });
    window.loadURL(appURL('runtime')).catch(reject);
  });
  void runtimeReady.catch(() => {});
  window.webContents.on('render-process-gone', () => {
    if (runtime === window && !quitting) resetRuntime('The local graph runtime closed unexpectedly.');
  });
}

function resetRuntime(error) {
  const old = runtime;
  graphDownload?.controller.abort();
  modelOperation?.download?.controller.abort();
  old.destroy();
  for (const complete of pendingCommands.values()) complete({ error });
  if (!quitting) {
    createRuntime();
    if (controller.current) void controller.cancel(error);
    else if (!['modelStatus', 'modelPrepare'].includes(modelOperation?.action)) controller.update({ error });
  }
}

function bindIPC() {
  const handle = (page, window, channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    if (!isFrom(event, window(), page)) throw Error('Untrusted desktop request.');
    return handler(...args);
  });
  const listen = (page, window, channel, handler) => ipcMain.on(channel, (event, ...args) => {
    if (isFrom(event, window(), page)) handler(...args);
  });
  const ui = (name, handler) => handle('management', () => management, `management:${name}`, handler);
  const fromRuntime = (name, handler) => listen('runtime', () => runtime, `runtime:${name}`, handler);
  const fromIndicator = (name, handler) => listen('indicator', () => indicator, `indicator:${name}`, handler);

  ui('get', view);
  ui('add', (name, graph, kind) => {
    if (kind !== undefined && kind !== 'subgraph') throw Error('Unknown graph kind.');
    const entry = library.add(name, graph, kind); publish(); return entry;
  });
  ui('import', (name, value) => { const entry = library.import(name, value); publish(); return entry; });
  ui('extract', (id, revision, shared) => { const result = library.extract(id, revision, shared); publish(); return result; });
  ui('save', (id, revision, graph) => { const entry = library.save(id, revision, graph); publish(); return entry; });
  ui('export', async (graph, id) => {
    const entry = id === undefined ? { id: 'graph', name: 'Graph', description: '' } : library.lookup(id);
    const json = exportDraft({ ...entry, description: entry.description ?? '' }, graph, library.value);
    const result = await dialog.showSaveDialog(management, {
      title: 'Export graph JSON', defaultPath: 'processing-graph.json',
      filters: [{ name: 'Graph JSON', extensions: ['json'] }],
    });
    if (!result.canceled && result.filePath) {
      await writeFile(result.filePath, json, { mode: 0o600 });
    }
  });
  ui('select', id => { library.select(id); publish(); });
  ui('shortcut', async value => {
    if (shortcutChanging) throw Error('Wait for the current shortcut change to finish.');
    shortcutChanging = true;
    try {
      if (typeof value !== 'string' || value.length > 64) throw Error('Enter a supported key combination.');
      await registerShortcut(value.trim(), true);
    } catch (error) { shortcutError = error.message; publish(); throw error; }
    finally { shortcutChanging = false; }
  });
  ui('live', id => { if (typeof id === 'string') void start(id, 'live'); });
  ui('stop', () => { void controller.stop(); });
  ui('cancel', () => { void controller.cancel(); });
  ui('press', (id, node) => {
    if (controller.state.phase === 'running' && controller.current?.id === id
        && controller.current.plan.actions.some(action => action.id === node)) return run('press', id, node);
  });
  ui('enable-speakers', id => {
    if (controller.current?.id === id && ['running', 'stopping'].includes(controller.state.phase)) return run('enableSpeakers', id);
  });
  ui('audio', () => [...audioItems.values()]);
  ui('save-wav', async clip => {
    const audio = audioItems.get(clip)?.audio;
    if (!audio) return;
    const result = await dialog.showSaveDialog(management, {
      title: 'Save WAV', defaultPath: 'speech.wav', filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, new Uint8Array(await audioToWav(audio).arrayBuffer()), { mode: 0o600 });
  });
  const updateModel = (key, value, reset = false) => {
    if (reset) modelViews.clear();
    modelViews.set(key, value);
    send(management, 'management:model', { key, value, operation: modelActivity(), reset });
  };
  ui('model', async (action, key = defaultModel) => {
    if (!['modelStatus', 'modelPrepare', 'modelCancel', 'modelDelete'].includes(action)
        || !desktopModels.some(model => model.key === key)) throw Error('Unknown model action or model.');
    if (action === 'modelCancel') {
      if (modelOperation?.key === key && modelOperation.action === 'modelPrepare') return run(action);
      return;
    }
    if (modelOperation) {
      if (action === 'modelStatus') return modelViews.get(key);
      throw Error('Wait for the current model operation to finish.');
    }
    if (action !== 'modelStatus' && controller.current) throw Error('Stop the active session before changing cached models.');
    modelOperation = { key, action };
    if (action === 'modelPrepare') modelOperation.download = { controller: new AbortController(), sources: sourcesFor([key]) };
    updateModel(key, { state: action === 'modelDelete' ? 'Deleting' : 'Checking' });
    let value;
    try { value = await run(action, key); }
    catch (error) { value = { state: 'Error', error: error.message, retry: action }; }
    finally {
      modelOperation.download?.controller.abort();
      modelOperation = null;
    }
    if (action === 'modelStatus' && value.state === 'Error') value.retry = action;
    // Voice variants can share the removed files.
    updateModel(key, value, action === 'modelDelete' && value.state !== 'Error');
    return value;
  });
  handle('runtime', () => runtime, 'runtime:microphone', async id => {
    const authorized = () => controller.current?.id === id && controller.current.plan.microphone && controller.state.phase === 'preparing';
    if (!authorized()) throw Error('The graph is no longer authorized to request microphone access.');
    if (mac) {
      const status = systemPreferences.getMediaAccessStatus('microphone');
      const allowed = status === 'granted' || (status === 'not-determined' && await systemPreferences.askForMediaAccess('microphone'));
      if (!allowed) throw Error('Allow microphone access in System Settings → Privacy & Security → Microphone, then start again.');
    }
    if (!authorized()) throw Error('Microphone start was canceled.');
  });
  handle('runtime', () => runtime, 'runtime:insert', (id, text) => controller.insert(id, text));
  fromRuntime('response', result => pendingCommands.get(result.request)?.(result));
  fromRuntime('failure', (id, message) => { void controller.cancel(String(message).slice(0, 700), id); });
  fromRuntime('capture-ended', (id, message) => controller.captureEnded(id, typeof message === 'string' ? message.slice(0, 700) : undefined));
  fromRuntime('display', (...args) => controller.display(...args));
  fromRuntime('floating-display', (id, text) => controller.floatingDisplay(id, text));
  fromRuntime('actions', (id, actions) => {
    if (controller.current?.id === id && controller.current.admitted) controller.update({ actions });
  });
  fromRuntime('status', (id, node, message, severity, needsActivation) => {
    if (controller.current?.id !== id || !controller.current.admitted) return;
    const status = { node, message: String(message).slice(0, 700), severity, needsActivation: needsActivation === true };
    controller.current.status.set(node, status);
    send(management, 'management:node-status', status);
  });
  fromRuntime('preparation', (id, key, title, value) => {
    if (controller.current?.id !== id || !controller.current.admitted) return;
    controller.current.preparation = { key, title, ...value };
    send(management, 'management:preparation', controller.current.preparation);
    updateModel(key, value);
  });
  fromRuntime('audio', (id, node, audio) => {
    if (controller.current?.id !== id || !controller.current.admitted
        || !controller.current.plan.graph.nodes.some(spec => spec.id === node && spec.type === 'AudioOutput')) return;
    const item = { clip: ++audioSequence, node, audio };
    audioItems.set(item.clip, item);
    send(management, 'management:audio', item);
  });
  fromRuntime('model-progress', (key, progress) => {
    if (modelOperation?.key === key && modelOperation.action === 'modelPrepare') updateModel(key, progress);
  });
  fromIndicator('stop', () => { if (controller.current) toggle(); });
  fromIndicator('dismiss', () => controller.update({ error: '' }));
}

app.on('window-all-closed', () => {});
app.on('before-quit', async event => {
  if (shutDown || !controller) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  tray?.destroy();
  indicator?.hide();
  let deadline;
  const runtimeCleanup = Promise.race([
    Promise.allSettled([controller.cancel(), run('modelCancel')]),
    new Promise(resolve => { deadline = setTimeout(resolve, 3000); }),
  ]).finally(() => clearTimeout(deadline));
  await Promise.all([runtimeCleanup, mac && target.closeGracefully()]);
  if (!mac) target.close();
  shutDown = true;
  app.quit();
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (management && !quitting) showManagement('library'); });
  app.whenReady().then(async () => {
    if (!mac && (process.platform !== 'linux' || !process.env.DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')) {
      throw Error('My Audio to Text Desktop requires macOS or a Linux X11 session.');
    }
    const path = app.getPath('userData');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    library = new DesktopLibrary(join(path, 'desktop-library.json'), mac ? 'Control+Alt+Super+D' : undefined);
    await installProtocol();
    const helper = mac ? [join(dirname(process.execPath), 'focused-text'), []]
      : ['/usr/bin/python3', ['-u', join(import.meta.dirname, 'x11-accessibility.py')]];
    target = new FocusedTarget(...helper, {
      onFailure: (id, error) => { void controller.cancel(error, id); },
      onShortcut: shortcutReleased,
      onLost: () => {
        if (!registeredShortcut || quitting) return;
        registeredShortcut = undefined;
        shortcutError = 'The shortcut was released. Save the shortcut again in Settings.';
        controller.update({ error: shortcutError });
      },
    });
    target.connect();
    controller = new DesktopSession({ target, run, onChange: updateSession, onFloatingDisplay: showIndicator, onDisplay: item => {
      displayItems.set(JSON.stringify([item.node, item.port]), item);
      send(management, 'management:display', item);
    } });
    bindIPC();
    createRuntime();
    indicator = makeWindow('indicator', {
      ...(mac && { type: 'panel' }), frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
    });
    await indicator.loadURL(appURL('indicator'));
    management = makeWindow('management', { width: 1100, height: 760, minWidth: 650, minHeight: 470, icon });
    management.on('close', event => { if (!quitting) { event.preventDefault(); management.hide(); } });
    await management.loadURL(appURL('management'));
    tray = new Tray(icon);
    if (mac) {
      tray.on('mouse-down', () => {
        if (!quitting) tray.popUpContextMenu(trayMenu);
      });
    }
    try { await registerShortcut(library.value.shortcut); }
    catch (error) {
      shortcutError = error.message;
      controller.update({ error: shortcutError });
    }
    publish();
    management.show();
  }).catch(error => {
    console.error(error.message);
    if (Notification.isSupported()) new Notification({ title: 'My Audio to Text', body: error.message }).show();
    app.quit();
  });
}
