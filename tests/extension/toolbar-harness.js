// Headless Chrome owns the native menus but has no toolbar to click. Expose the
// registered production listeners and mirror create/update/remove for assertions.
export const toolbarHarness = `
  globalThis.toolbarEvents = {}; globalThis.toolbarMenus = {};
  for (const [name, event] of [['action', chrome.action.onClicked], ['menu', chrome.contextMenus.onClicked]]) {
    const add = event.addListener.bind(event);
    event.addListener = listener => { toolbarEvents[name] = listener; add(listener); };
  }
  const create = chrome.contextMenus.create.bind(chrome.contextMenus);
  chrome.contextMenus.create = (item, done) => { toolbarMenus[item.id] = item; return create(item, done); };
  const update = chrome.contextMenus.update.bind(chrome.contextMenus);
  chrome.contextMenus.update = async (id, properties) => { await update(id, properties); Object.assign(toolbarMenus[id] || {}, properties); };
  const remove = chrome.contextMenus.removeAll.bind(chrome.contextMenus);
  chrome.contextMenus.removeAll = async () => { toolbarMenus = {}; return remove(); };
`;
