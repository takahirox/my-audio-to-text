// Toolbar invocation grants access to this tab. Default capture needs no page
// injection; configured focused output uses only this activeTab document.
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  const url = chrome.runtime.getURL('extension/recorder.html');
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const existing = contexts.find(context => context.documentUrl?.startsWith(url));
    if (existing) {
      // Prepare focus tracking before Live takes browser-window focus.
      await chrome.runtime.sendMessage({ type: 'invoke', tabId: tab.id });
      await chrome.windows.update(existing.windowId, { focused: true });
    } else {
      await chrome.windows.create({ url: `${url}?tab=${tab.id}`, type: 'popup', focused: false, width: 620, height: 800 });
    }
  } catch (error) {
    // A visible fallback is still available if the previous window closed mid-click.
    await chrome.windows.create({ url: `${url}?tab=${tab.id}&error=${encodeURIComponent(error.message)}`,
      type: 'popup', focused: true, width: 620, height: 800 });
  }
});
