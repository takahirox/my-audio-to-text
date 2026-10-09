import { FIELD_TYPES, INPUT_TYPES } from './graph.js';
import { authorizePage, PageConnection } from './page-target.js';

export class TargetControls {
  constructor(root, session) { this.root = root; this.session = session; this.render(); }
  render() {
    const running = !!this.session.session, graph = running ? this.session.view.activeGraph : this.session.graph;
    const targets = running ? this.session.session.targets : this.session.targets;
    const signature = JSON.stringify([graph, running, this.session.view.tabId, targets, this.pendingOutput, this.busy, !!this.picker]);
    if (signature === this.signature) return;
    this.signature = signature; this.root.replaceChildren();
    const help = document.createElement('p'); help.className = 'muted';
    help.textContent = 'Capture uses the toolbar-invoked tab. Page targets are top frame only. Authorize each output here, or choose “Use next toolbar tab” and invoke the extension on a different output page. Stop before changing targets.';
    this.root.append(help);
    for (const node of graph.nodes.filter(n => INPUT_TYPES.includes(n.type) || FIELD_TYPES.includes(n.type))) {
      const row = document.createElement('div'); row.className = 'target-row'; row.dataset.targetNode = node.id;
      const label = document.createElement('p'), target = targets[node.id];
      label.textContent = `${node.id}: ${node.type === 'MicrophoneAudio' ? 'Microphone · explicit Start permission' : node.type === 'ChromeTabAudio' ? `Whole capture tab ${this.session.view.tabId ?? 'not selected'}` : target ? `${target.label}${target.fieldLabel ? ` · ${target.fieldLabel}` : ''}${target.mediaLabel ? ` · ${target.mediaLabel}` : ''}` : 'No target selected'}`;
      row.append(label);
      const button = (text, action) => {
        const control = document.createElement('button'); control.type = 'button'; control.textContent = text; control.disabled = running || !!this.busy;
        control.onclick = () => { void this.perform(action); }; row.append(control); return control;
      };
      if (FIELD_TYPES.includes(node.type)) {
        button('Authorize capture tab for output', () => this.selectOutput(node, this.session.view.tabId));
        button('Use next toolbar tab for output', async () => {
          this.pendingOutput = node.id;
          this.session.update({ targetStatus: `Invoke the toolbar action on the desired output tab for ${node.id}. Capture target will stay unchanged.` });
        });
        if (node.type === 'SelectedFormFieldTextOutputNode') button('Pick field', () => this.pick(node));
      } else if (node.type === 'SelectedPageMediaAudio') {
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
      if (target) button('Clear target', async () => {
        const connection = new PageConnection(target);
        try { if (target.fieldId || target.mediaId) await connection.request('forget', { target: target.fieldId || target.mediaId }); } finally { connection.close(); if (this.mediaList?.id === node.id) this.mediaList.select.value = ''; this.session.setTarget(node.id, null); }
      });
      if (this.mediaList?.id === node.id && !running) row.append(this.mediaList.select);
      this.root.append(row);
    }
    if (this.picker) {
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel field picker'; cancel.onclick = () => this.picker?.close(); this.root.append(cancel);
    }
    if (this.pendingOutput) {
      const cancel = document.createElement('button'); cancel.textContent = 'Cancel output-tab selection'; cancel.onclick = () => { this.pendingOutput = null; this.render(); this.session.update(); }; cancel.disabled = running; this.root.append(cancel);
    }
  }
  async perform(action) {
    if (this.session.session || this.busy) return;
    this.busy = true; this.render();
    try { await action(); }
    catch (error) { this.session.update({ targetStatus: `Target unavailable: ${error.message} Invoke the toolbar on a normal web page and try again.` }); }
    finally { this.busy = false; this.render(); this.session.update(); }
  }
  async selectOutput(node, tabId) {
    const target = await authorizePage(tabId);
    if (this.session.session) return;
    this.session.setTarget(node.id, target);
    this.session.update({ targetStatus: `${node.id}: authorized ${target.label}. ${node.type === 'SelectedFormFieldTextOutputNode' ? 'Pick a field before Start.' : 'Focus a supported field in this page before finalized speech arrives.'}` });
  }
  async pick(node) {
    const target = this.session.targets[node.id];
    if (!target) throw Error('Authorize the output tab before picking.');
    const connection = this.picker = new PageConnection(target);
    try {
      await chrome.tabs.update(target.tabId, { active: true });
      const tab = await chrome.tabs.get(target.tabId); await chrome.windows.update(tab.windowId, { focused: true });
      this.session.update({ targetStatus: 'Click a visible editable field in the output page. Escape cancels.' });
      const field = await connection.request('pick');
      if (this.session.session) return;
      this.session.setTarget(node.id, { ...target, fieldId: field.id, fieldLabel: field.label });
      this.session.update({ targetStatus: `${node.id}: selected ${field.label}. Start to append confirmed text.` });
    } finally { connection.close(); this.picker = null; }
  }
  async invokeOutput(tabId) {
    const id = this.pendingOutput; if (!id || this.session.session) return false;
    this.pendingOutput = null;
    const node = this.session.graph.nodes.find(node => node.id === id && FIELD_TYPES.includes(node.type));
    if (node) await this.perform(() => this.selectOutput(node, tabId));
    return true;
  }
  tabEnded(tabId) {
    if (this.mediaList?.authorized.tabId === tabId) { this.mediaList = null; this.signature = null; }
    if (this.picker?.target.tabId === tabId) this.picker.close();
  }
  close() { this.picker?.close(); }
}
