// The toolbar invocation grants access to this specific tab. No page injection.
chrome.action.onClicked.addListener(async tab => {
  if (!Number.isInteger(tab.id)) return;
  const url = chrome.runtime.getURL('extension/recorder.html');
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const existing = contexts.find(context => context.documentUrl?.startsWith(url));
    if (existing) {
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.runtime.sendMessage({ type: 'invoke', tabId: tab.id });
    } else {
      await chrome.windows.create({ url: `${url}?tab=${tab.id}`, type: 'popup', width: 620, height: 800 });
    }
  } catch (error) {
    // A visible fallback is still available if the previous window closed mid-click.
    await chrome.windows.create({ url: `${url}?tab=${tab.id}&error=${encodeURIComponent(error.message)}`,
      type: 'popup', width: 620, height: 800 });
  }
});
