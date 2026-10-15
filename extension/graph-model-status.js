import { GraphModelPreparation } from './graph-model-preparation.js';

const el = (tag, text) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; return element; };

export function graphModelStatus(root) {
  const channel = new BroadcastChannel('model-cache-updates'), cards = new Map();
  const preparation = new GraphModelPreparation({ onChange: render, onComplete: id => channel.postMessage({ id }) });
  function render(entries) {
    root.hidden = !entries.length;
    for (const [key, card] of cards) if (!entries.some(entry => entry.key === key)) { card.root.remove(); cards.delete(key); }
    for (const entry of entries) {
      let card = cards.get(entry.key);
      if (!card) {
        const section = el('section'); section.className = 'panel model-card'; section.setAttribute('aria-label', entry.title);
        const status = el('p'); status.className = 'model-status'; status.setAttribute('role', 'status');
        const error = el('p'); error.className = 'model-error'; error.setAttribute('role', 'alert');
        const progress = el('progress'); progress.setAttribute('aria-label', `${entry.title} download progress`);
        const bytes = el('p'); bytes.className = 'muted';
        const controls = el('div'); controls.className = 'actions';
        const cancel = el('button', 'Cancel preparation'), retry = el('button', 'Retry preparation'), check = el('button', 'Check cache');
        for (const button of [cancel, retry, check]) button.type = 'button';
        controls.append(cancel, retry, check);
        section.append(el('h3', entry.title), status, error, progress, bytes, controls); root.append(section);
        card = { root: section, status, error, progress, bytes, cancel, retry, check }; cards.set(entry.key, card);
      }
      // A later Save can retain the same card but must target its new entry.
      card.cancel.onclick = () => preparation.cancel(entry);
      card.retry.onclick = () => { void preparation.run(entry); };
      card.check.onclick = () => { void preparation.run(entry, true); };
      const view = entry.view;
      card.root.dataset.state = view.state;
      card.status.textContent = view.state === 'Ready' ? 'Ready · Cached and verified' : view.state;
      card.error.textContent = view.error;
      card.progress.max = view.totalBytes || 1; card.progress.value = view.downloadedBytes;
      card.bytes.textContent = `${view.downloadedBytes.toLocaleString()} / ${view.totalBytes.toLocaleString()} bytes`;
      card.cancel.disabled = !entry.controller;
      card.retry.disabled = card.check.disabled = !!entry.controller;
    }
  }
  channel.onmessage = ({ data }) => preparation.inspect(data.id);
  window.addEventListener('focus', () => preparation.inspect());
  window.addEventListener('pagehide', () => { preparation.close(); channel.close(); });
  return preparation;
}
