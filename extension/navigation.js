// Auxiliary pages never invoke, retarget or tear down a recording session.
for (const link of document.querySelectorAll('[data-page]')) {
  link.addEventListener('click', event => {
    event.preventDefault();
    void chrome.tabs.create({ url: chrome.runtime.getURL(`extension/${link.dataset.page}`) });
  });
}
for (const button of document.querySelectorAll('[data-live]')) {
  button.addEventListener('click', async () => {
    const url = chrome.runtime.getURL('extension/recorder.html');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const live = contexts.find(context => context.documentUrl?.startsWith(url));
    if (live) await chrome.windows.update(live.windowId, { focused: true });
    else document.getElementById('navigation-status').textContent = 'Open Live with the toolbar action on the tab you want to transcribe.';
  });
}
