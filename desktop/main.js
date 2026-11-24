import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, Notification, protocol, screen, session, Tray } from 'electron';
import { mkdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { DesktopLibrary } from './library.js';
import { assertDesktopGraph, planGraph } from './graph.js';
import { DesktopSession } from './session.js';
import { X11Target } from './x11-target.js';

const root = resolve(import.meta.dirname, '..');
const origin = 'local-voice://desktop';
const appURL = page => `${origin}/desktop/${page}.html`;
const icon = join(root, 'extension/icons/icon-32.png');
const csp = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://download.moonshine.ai; base-uri 'none'; frame-ancestors 'none'";
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const files = JSON.parse(readFileSync(join(root, 'extension/moonshine-small-ja-assets.json'), 'utf8')).files;
const modelURLs = new Set(files.map(file => file.sourceURL));

app.setName('My Audio to Text');
app.commandLine.appendSwitch('ozone-platform', 'x11');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{ scheme: 'local-voice', privileges: {
  standard: true, secure: true, supportFetchAPI: true, allowServiceWorkers: true, corsEnabled: true,
} }]);

let library, controller, target, tray, runtime, management, indicator, runtimeReady;
let modelView, shortcutError = '', registeredShortcut, quitting = false, shutDown = false;
let modelOperation, shortcutTimer, runtimeSequence = 0;
const pendingCommands = new Map(), displayItems = new Map();

function isFrom(event, window, page) {
  return window && !window.isDestroyed() && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appURL(page);
}

function send(window, channel, value) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, value);
}

function view() {
  return { library: library.value, session: controller.state, shortcutError, model: modelView,
    items: [...displayItems.values()] };
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
  if (state.phase === 'canceling' || (state.phase === 'idle' && !state.error)) {
    indicator?.hide();
    return;
  }
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const width = state.error ? 430 : 226, height = state.error ? 120 : 52;
  indicator.setBounds({ width, height, x: workArea.x + workArea.width - width - 16, y: workArea.y + workArea.height - height - 16 });
  send(indicator, 'indicator:update', state);
  if (!indicator.isVisible()) indicator.showInactive();
}

function updateTray() {
  const state = controller.state;
  tray.setToolTip(`My Audio to Text · ${statusText()} · ${registeredShortcut || 'Set a shortcut in Settings'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: state.phase === 'preparing' ? 'Cancel preparation' : state.phase === 'idle' ? 'Start voice typing' : 'Stop voice typing',
      enabled: !['stopping', 'canceling'].includes(state.phase), click: trayToggle },
    ...(state.phase === 'running' || state.phase === 'stopping' ? [
      { label: 'Cancel voice typing', click: () => { void controller.cancel(); } },
    ] : []),
    { label: 'Shortcut graph', submenu: library.value.graphs.map(entry => ({
      label: entry.name, type: 'radio', checked: entry.id === library.value.selected,
      click: () => { try { library.select(entry.id); publish(); } catch (error) { controller.update({ error: error.message }); } },
    })) },
    { type: 'separator' },
    { label: 'Graph Library', click: () => showManagement('library') },
    { label: 'Models', click: () => showManagement('models') },
    { label: 'Settings', click: () => showManagement('settings') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
}

function showManagement(page) {
  send(management, 'management:navigate', page);
  management.show();
  management.focus();
}

function start(id, mode, binding) {
  if (controller.current || quitting) return;
  try {
    const plan = planGraph(library.lookup(id).graph, mode);
    if (modelOperation === 'modelDelete') throw Error('Wait for model deletion to finish, then start again.');
    displayItems.clear();
    return controller.start(plan, binding);
  } catch (error) { controller.update({ error: error.message }); }
}

function toggle() { void controller.toggle(); }

function trayToggle() {
  const session = controller.current;
  if (session) {
    setTimeout(() => { if (controller.current === session) toggle(); }, 90);
  } else {
    // Let GTK finish dismissing the menu before publish rebuilds it.
    // The helper already owns the pre-menu focus snapshot.
    const id = library.value.selected;
    setImmediate(() => { void start(id, 'dictation', 'bind-tray'); });
  }
}

let lastShortcut = -Infinity;
function shortcutPressed() {
  const time = performance.now(), elapsed = time - lastShortcut;
  lastShortcut = time;
  if (elapsed <= 250) return;
  if (!controller.current) {
    void start(library.value.selected, 'dictation', 'bind-shortcut');
  } else {
    // Give the keyboard grab time to release before draining into the bound field.
    const session = controller.current;
    shortcutTimer = setTimeout(() => { if (controller.current === session) toggle(); }, 90);
  }
}

function registerShortcut(value, save = false) {
  if (value === registeredShortcut) return;
  const modifiers = value.split('+').slice(0, -1);
  if (!/^(?:(?:Control|Alt|Shift|Super)\+){2,4}(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(value)
      || new Set(modifiers).size !== modifiers.length || !modifiers.some(key => key !== 'Shift')) {
    throw Error('Use at least two distinct modifiers (Control, Alt, Shift, Super) and a letter, digit, or F1–F12.');
  }
  if (!globalShortcut.register(value, shortcutPressed)) {
    throw Error(`${value} is unavailable. Choose a different shortcut in Settings.`);
  }
  try { if (save) library.shortcut(value); }
  catch (error) { globalShortcut.unregister(value); throw error; }
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
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
    const path = resolve(root, '.' + decodeURIComponent(url.pathname));
    const contentType = mime[extname(path)];
    if (url.host !== 'desktop' || request.method !== 'GET' || !path.startsWith(root + sep) || !contentType
        || !/^\/(desktop|extension|web)\//.test(url.pathname)) return new Response(null, { status: 404 });
    try {
      return new Response(await readFile(path), { headers: {
        'Content-Type': contentType,
        'Content-Security-Policy': csp,
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'X-Content-Type-Options': 'nosniff',
      } });
    } catch { return new Response(null, { status: 404 }); }
  });
  const profile = session.defaultSession;
  profile.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, done) => {
    done({ cancel: details.method !== 'GET' || details.webContentsId !== runtime?.webContents.id || !modelURLs.has(details.url) });
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
  await runtimeReady;
  if (window !== runtime || window.isDestroyed()) throw Error('The local graph runtime closed.');
  const request = ++runtimeSequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resetRuntime('The local graph runtime did not respond and was restarted.');
    }, action === 'modelPrepare' ? 900000 : 90000);
    pendingCommands.set(request, ({ error, value }) => {
      clearTimeout(timer);
      pendingCommands.delete(request);
      if (error) reject(Error(error));
      else resolve(value);
    });
    send(window, 'runtime:command', { request, action, args });
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
  old.destroy();
  for (const complete of pendingCommands.values()) complete({ error });
  if (!quitting) {
    createRuntime();
    if (controller.current) void controller.cancel(error);
    else controller.update({ error });
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
  ui('add', (name, graph) => { const entry = library.add(name, graph); publish(); return entry; });
  ui('save', (id, revision, graph) => { const entry = library.save(id, revision, graph); publish(); return entry; });
  ui('export', async graph => {
    const valid = assertDesktopGraph(graph);
    const result = await dialog.showSaveDialog(management, {
      title: 'Export graph JSON', defaultPath: 'processing-graph.json',
      filters: [{ name: 'Graph JSON', extensions: ['json'] }],
    });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify(valid, null, 2) + '\n', { mode: 0o600 });
  });
  ui('select', id => { library.select(id); publish(); });
  ui('shortcut', value => {
    try {
      if (typeof value !== 'string' || value.length > 64) throw Error('Enter a supported key combination.');
      registerShortcut(value.trim(), true);
    } catch (error) { shortcutError = error.message; publish(); throw error; }
  });
  ui('live', id => { if (typeof id === 'string') void start(id, 'live'); });
  ui('stop', () => { void controller.stop(); });
  ui('cancel', () => { void controller.cancel(); });
  ui('model', async action => {
    if (!['modelStatus', 'modelPrepare', 'modelCancel', 'modelDelete'].includes(action)) throw Error('Unknown model action.');
    if (action === 'modelCancel') return run(action);
    if (modelOperation) {
      if (action === 'modelStatus') return modelView;
      throw Error('Wait for the current model operation to finish.');
    }
    if (action === 'modelDelete' && controller.current) throw Error('Stop the active session before deleting the model.');
    modelOperation = action;
    try {
      if (action === 'modelPrepare') {
        modelView = { state: 'Checking cache…' };
        send(management, 'management:model', modelView);
      }
      modelView = await run(action);
      send(management, 'management:model', modelView);
      return modelView;
    } finally { modelOperation = null; }
  });
  handle('runtime', () => runtime, 'runtime:insert', (id, text) => controller.insert(id, text));
  fromRuntime('response', result => pendingCommands.get(result.request)?.(result));
  fromRuntime('failure', (id, message) => { void controller.cancel(String(message).slice(0, 700), id); });
  fromRuntime('capture-ended', id => controller.captureEnded(id));
  fromRuntime('display', (...args) => controller.display(...args));
  fromRuntime('model-progress', progress => { modelView = progress; send(management, 'management:model', progress); });
  fromIndicator('stop', () => { if (controller.current) toggle(); });
  fromIndicator('dismiss', () => controller.update({ error: '' }));
}

app.on('window-all-closed', () => {});
app.on('before-quit', event => {
  if (shutDown || !controller) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  clearTimeout(shortcutTimer);
  globalShortcut.unregisterAll();
  tray?.destroy();
  indicator?.hide();
  const deadline = setTimeout(() => {
    target.close();
    shutDown = true;
    app.quit();
  }, 3000);
  void Promise.allSettled([controller.cancel(), run('modelCancel')]).then(() => {
    clearTimeout(deadline);
    target.close();
    shutDown = true;
    app.quit();
  });
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (management && !quitting) showManagement('library'); });
  app.whenReady().then(async () => {
    if (process.platform !== 'linux' || !process.env.DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
      throw Error('My Audio to Text Desktop requires a Linux X11 session.');
    }
    const path = app.getPath('userData');
    mkdirSync(path, { recursive: true, mode: 0o700 });
    library = new DesktopLibrary(join(path, 'desktop-library.json'));
    await installProtocol();
    target = new X11Target(join(import.meta.dirname, 'x11-accessibility.py'), (id, error) => { void controller.cancel(error, id); });
    target.connect();
    controller = new DesktopSession({ target, run, onChange: publish, onDisplay: item => {
      displayItems.set(JSON.stringify([item.node, item.port]), item);
      send(management, 'management:display', item);
    } });
    bindIPC();
    createRuntime();
    indicator = makeWindow('indicator', { frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false });
    await indicator.loadURL(appURL('indicator'));
    management = makeWindow('management', { width: 1100, height: 760, minWidth: 650, minHeight: 470, icon });
    management.on('close', event => { if (!quitting) { event.preventDefault(); management.hide(); } });
    await management.loadURL(appURL('management'));
    tray = new Tray(icon);
    try { registerShortcut(library.value.shortcut); }
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
