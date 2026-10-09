import { FIELD_TYPES, INPUT_TYPES } from './graph.js';
import { authorizePage, PageConnection } from './page-target.js';

export class TargetControls {
  constructor(root, session) { this.root = root; this.session = session; this.render(); }
  render() {
    const running = !!this.session.session, graph = running ? this.session.view.activeGraph : this.session.graph;
    const targets = running ? this.session.session.targets : this.session.targets;
    const signature = JSON.stringify([graph, running, this.session.view.tabId, targets, this.session.outputTarget, this.busy]);
    if (signature === this.signature) return;
    this.signature = signature; this.root.replaceChildren();
    const help = document.createElement('p'); help.className = 'muted';
    help.textContent = 'Focused output follows a supported user-focused field in the toolbar-invoked tab, top frame only. No field picker or extra authorization is needed. Stop before changing capture targets.';
    this.root.append(help);
    for (const node of graph.nodes.filter(n => INPUT_TYPES.includes(n.type) || FIELD_TYPES.includes(n.type))) {
      const row = document.createElement('div'); row.className = 'target-row'; row.dataset.targetNode = node.id;
      const label = document.createElement('p'), target = FIELD_TYPES.includes(node.type) ? this.session.outputTarget : targets[node.id];
      label.textContent = `${node.id}: ${node.type === 'MicrophoneAudio' ? 'Microphone · explicit Start permission' : node.type === 'ChromeTabAudio' ? `Whole capture tab ${this.session.view.tabId ?? 'not selected'}` : target ? `${target.label}${target.mediaLabel ? ` · ${target.mediaLabel}` : ''}` : 'No target selected'}`;
      row.append(label);
      const button = (text, action) => {
        const control = document.createElement('button'); control.type = 'button'; control.textContent = text; control.disabled = running || !!this.busy;
        control.onclick = () => { void this.perform(action); }; row.append(control); return control;
      };
      if (node.type === 'SelectedPageMediaAudio') {
        button('Discover media in capture tab', async () => {
          const authorized = await authorizePage(this.session.view.tabId), connection = new PageConnection(authorized);
          try {
            const media = await connection.request('discover');
            const select = document.createElement('select'); select.setAttribute('aria-label', `${node.id} media element`);
            const placeholder = document.createElement('option'); placeholder.textContent = 'Choose one media element'; placeholder.value = ''; select.append(placeholder);
            for (const item of media) {
              const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.label}${item.error ? ` · ${item.error}` : ''}`; option.disabled = !!item.error; select.append(option);
            }
            this.mediaList = { id: node.id, authorized, media, select };
            select.onchange = () => { if (this.session.session || !select.value) return; const item = media.find(item => item.id === select.value); this.session.setTarget(node.id, { ...authorized, mediaId: item.id, mediaLabel: item.label }); };
            this.session.update({ targetStatus: media.length ? 'Select one media element below. Unsupported media: choose Chrome tab audio in Graph Editor.' : 'No media in the top frame. Play audio/video and discover again, or choose Chrome tab audio in Graph Editor.' });
          } finally { connection.close(); }
        });
      }
      if (target && node.type === 'SelectedPageMediaAudio') button('Clear target', async () => {
        const connection = new PageConnection(target);
        try { if (target.mediaId) await connection.request('forget', { target: target.mediaId }); } finally { connection.close(); if (this.mediaList?.id === node.id) this.mediaList.select.value = ''; this.session.setTarget(node.id, null); }
      });
      if (this.mediaList?.id === node.id && !running) row.append(this.mediaList.select);
      this.root.append(row);
    }
  }
  async perform(action) {
    if (this.session.session || this.busy) return;
    this.busy = true; this.render();
    try { await action(); }
    catch (error) { this.session.update({ targetStatus: `Target unavailable: ${error.message} Invoke the toolbar on a normal web page and try again.` }); }
    finally { this.busy = false; this.render(); this.session.update(); }
  }
  async prepareFocusedOutput(tabId) {
    this.session.outputTarget = null;
    if (!this.session.graph.nodes.some(node => FIELD_TYPES.includes(node.type))) return;
    this.busy = true; this.render(); this.session.update();
    try {
      const target = await authorizePage(tabId);
      if (!this.session.session) this.session.outputTarget = target;
    } catch (error) {
      this.session.update({ targetStatus: `Focused output unavailable: ${error.message} Other branches continue.` });
    } finally { this.busy = false; this.render(); this.session.update(); }
  }
  tabEnded(tabId) {
    if (this.mediaList?.authorized.tabId === tabId) { this.mediaList = null; this.signature = null; }
  }
}
