// Detail edits keep their original graph revision until a serialized rename commits.
// The per-tab draft is written synchronously, never by an unload-time promise.
export const DETAILS_DRAFT_KEY = 'graph-library-details-draft';
export class GraphDetailsAutosave {
  constructor({ store, storage, name, description, status, retry, onSaved, delay = 400 }) {
    Object.assign(this, { store, storage, name, description, status, retry, onSaved, delay });
    this.compositions = new Set();
    for (const field of [name, description]) {
      field.addEventListener('compositionstart', () => {
        this.compositions.add(field); clearTimeout(this.timer); this.keepDraft(); this.show('Unsaved changes · finish composing to save.');
      });
      field.addEventListener('compositionend', () => { this.compositions.delete(field); this.changed(); });
      field.addEventListener('input', event => { if (event.isComposing) this.compositions.add(field); this.changed(); });
    }
    retry.onclick = () => { this.failure = ''; void this.flush({ force: true }); };
  }
  get composing() { return this.compositions.size > 0; }
  get dirty() { return !!this.entry && (this.name.value !== this.entry.name || this.description.value !== this.entry.description); }
  get editing() { return this.dirty || !!this.pending || this.composing || !!this.failure || !!this.reviewRequired; }
  show(message = '', failed = false) {
    clearTimeout(this.statusTimer);
    this.status.textContent = message; this.status.classList.toggle('save-error', failed); this.retry.hidden = !failed;
  }
  conflict() {
    this.failure = 'This graph changed in another page. Your details are kept. Copy your text and Load saved details to review current data.';
    clearTimeout(this.timer); this.keepDraft(); this.show(this.failure, true);
  }
  load(entry) {
    clearTimeout(this.timer); this.compositions.clear(); this.failure = ''; this.reviewRequired = false;
    this.entry = entry ? structuredClone(entry) : null;
    if (entry) { this.name.value = entry.name; this.description.value = entry.description; }
    this.show();
  }
  validation() {
    if (!this.name.value.trim()) return 'Enter a graph name to save details.';
    if (this.name.value.length > 160) return 'Use at most 160 characters for the graph name.';
    if (this.description.value.length > 2000) return 'Use at most 2000 characters for the description.';
    return '';
  }
  keepDraft(force = false) {
    try {
      if (force || this.editing) this.storage.setItem(DETAILS_DRAFT_KEY, JSON.stringify({ entry: this.entry, name: this.name.value, description: this.description.value }));
      else this.storage.removeItem(DETAILS_DRAFT_KEY);
      this.draftError = '';
    } catch { this.draftError = 'Draft recovery unavailable. Keep this page open until details are saved, or copy your text.'; }
  }
  clearDraft() { try { this.storage.removeItem(DETAILS_DRAFT_KEY); } catch {} }
  restore(draft) {
    this.load(draft.entry); this.name.value = draft.name; this.description.value = draft.description;
    this.reviewRequired = true; this.keepDraft();
    // A restored draft may contain an interrupted IME composition. Require a new
    // edit (or Load saved details), rather than automatically committing it.
    this.show('Recovered unsaved details. Review the text, then edit to autosave or Load saved details.');
  }
  changed() {
    clearTimeout(this.timer); this.reviewRequired = false; this.keepDraft();
    if (this.failure) { this.show(this.failure, true); return; }
    if (this.composing) { this.show('Unsaved changes · finish composing to save.'); return; }
    if (!this.dirty && !this.pending) { this.show(); return; }
    const error = this.validation();
    if (error) { this.show(error); return; }
    this.show(this.draftError || 'Saving…'); this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  async flush({ force = false } = {}) {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.failure || this.reviewRequired) return false;
    if (this.composing) { this.show('Unsaved changes · finish composing before continuing.'); return false; }
    if (!this.dirty && !force) return true;
    const error = this.validation();
    if (error) { this.show(error); return false; }
    this.pending = this.save(force);
    try { return await this.pending; }
    finally { this.pending = null; this.keepDraft(); }
  }
  async save(force) {
    while (this.dirty || force) {
      force = false;
      if (this.failure) return false;
      if (this.composing) { this.show('Unsaved changes · finish composing before continuing.'); return false; }
      const error = this.validation();
      if (error) { this.show(error); return false; }
      const { id, revision } = this.entry, name = this.name.value, description = this.description.value;
      this.keepDraft(true); this.show(this.draftError || 'Saving…');
      try {
        const next = await this.store.rename(id, name, description, revision);
        this.entry = structuredClone(next.graphs.find(entry => entry.id === id));
        // Normalize only the input that was committed, keeping later typing and
        // the caret/IME session intact while a write was waiting for its lock.
        if (!this.composing && this.name.value === name && name !== this.entry.name) this.name.value = this.entry.name;
        this.keepDraft(); this.onSaved(next);
      } catch (error) {
        this.failure = `${error.message} Your details are kept. Retry saving, or copy your text and Load saved details to review current data.`;
        this.keepDraft(); this.show([this.failure, this.draftError].filter(Boolean).join(' '), true); return false;
      }
    }
    if (this.failure) { this.show(this.failure, true); return false; }
    if (this.composing) { this.show('Unsaved changes · finish composing to save.'); return false; }
    this.show('Saved'); this.statusTimer = setTimeout(() => this.show(), 1800);
    return true;
  }
}
