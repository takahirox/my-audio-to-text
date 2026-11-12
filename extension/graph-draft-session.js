// A session owns a per-graph lease. Recovery records are deliberately outside
// the library schema: they never become runnable until revision-checked save.
export const DRAFT_PREFIX = 'processing-graph-draft:';
export class GraphDraftSession {
  constructor({ id, base, graph, storage, sessionId, persist, validate = graph => graph, onState = () => {}, onSaved = () => {}, delay = 300 }) {
    Object.assign(this, { id, base, storage, sessionId, persist, validate, onState, onSaved, delay });
    this.savedText = JSON.stringify(graph); this.text = this.savedText; this.graph = graph;
    this.keys = new Set(); this.recoverable = true; this.closed = false;
  }
  state(status, error = '') {
    if (this.blocked) { status = 'Save failed'; error = this.blocked; }
    this.status = status; this.error = error; this.onState(status, error);
  }
  checkpoint() {
    if (this.text === this.savedText && !this.inflight && !this.blocked) return true;
    if (this.keys.has(this.activeKey) && this.checkpointText === this.text && this.checkpointBase === this.base) return true;
    try {
      const key = `${DRAFT_PREFIX}${this.id}:${this.sessionId}:${this.base}`;
      this.storage.setItem(key, JSON.stringify({ id: this.id, sessionId: this.sessionId, base: this.base, graph: this.graph, updatedAt: Date.now() }));
      this.keys.add(key); this.activeKey = key; this.checkpointText = this.text; this.checkpointBase = this.base; this.recoverable = true; return true;
    } catch (error) {
      this.recoverable = false; this.state('Save failed', `Recovery checkpoint failed: ${error.message}. Retry or export the draft before closing.`); return false;
    }
  }
  changed(graph) {
    if (this.closed) return;
    const text = JSON.stringify(graph);
    if (text === this.text) { this.onState(this.status || 'Saved', this.error || ''); return; }
    this.graph = structuredClone(graph); this.text = text;
    this.checkpoint();
    if (this.blocked) this.state('Save failed', this.blocked);
    else if (this.recoverable) this.state(text === this.savedText && !this.inflight ? 'Saved' : 'Saving…');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, this.delay);
  }
  async flush() {
    clearTimeout(this.timer);
    if (this.closed) throw Error('Editor session closed.');
    if (this.blocked) { this.checkpoint(); this.state('Save failed', this.blocked); throw Error(this.blocked); }
    if (this.inflight) { await this.inflight; return this.flush(); }
    if (this.text === this.savedText) {
      this.clearCheckpoints(); this.recoverable = true; this.state('Saved'); return;
    }
    const graph = structuredClone(this.graph), text = this.text;
    const pending = (async () => {
      try {
        // Retry recovery too; a previous quota failure must never look Saved
        // while the newest draft still cannot be recovered or persisted.
        if (this.checkpoint()) this.state('Saving…');
        const valid = this.validate(graph);
        const result = await this.persist(valid, this.base);
        this.base = result.base; this.savedText = text;
        if (this.blocked) { this.checkpoint(); this.state('Save failed', this.blocked); return; }
        if (this.text !== text) {
          // Never delete the newest checkpoint just because an older write
          // finished. Install its new-base replacement before removing it.
          const previousKeys = [...this.keys];
          if (this.checkpoint()) for (const key of previousKeys) if (key !== this.activeKey) {
            try { this.storage.removeItem(key); this.keys.delete(key); } catch { /* Keep a harmless extra recovery copy. */ }
          }
        } else { this.clearCheckpoints(); this.recoverable = true; }
        this.onSaved(graph);
        this.state(this.text === this.savedText ? 'Saved' : this.recoverable ? 'Saving…' : 'Save failed', this.recoverable ? '' : this.error);
      } catch (error) {
        this.state('Save failed', `${error.message} Your draft is kept for repair/export. Retry Auto Save when ready.`);
        throw error;
      }
    })();
    this.inflight = pending;
    try { await pending; } finally { this.inflight = null; }
    if (this.text !== this.savedText) return this.flush();
  }
  clearCheckpoints() {
    for (const key of this.keys) {
      try { this.storage.removeItem(key); this.keys.delete(key); } catch { /* A confirmed saved checkpoint is harmless on reopen. */ }
    }
  }
  close() { clearTimeout(this.timer); this.closed = true; }
}
export function recoveryDrafts(storage, id) {
  const drafts = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try { const value = JSON.parse(storage.getItem(key)); if (value.id === id) drafts.push({ ...value, key }); } catch { /* Do not destroy malformed recovery records. */ }
  }
  return drafts.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ifAvailable makes the second page a viewer immediately. A release is always
// explicit; no polling or silent takeover and no library-wide lifetime lock.
export async function acquireGraphLease(locks, id) {
  if (!locks?.request) throw Error('This browser cannot coordinate safe editing (Web Locks unavailable).');
  return new Promise((resolve, reject) => {
    locks.request(`processing-graph-edit:${id}`, { ifAvailable: true }, lock => {
      if (!lock) { resolve(null); return; }
      return new Promise(release => resolve({ release }));
    }).catch(reject);
  });
}
