// Shared ISOLATED-world editing primitives. Authorization stays with each caller.
(() => {
  if (globalThis.LocalTextInsertion) return;
  const sensitive = /password|passcode|\bauth(?:entication)?\b|\blogin\b|\busername\b|\bpin\b|\biban\b|\bbic\b|\bswift\b|financial|transaction|payment|credit|cc-|card.?number|cvc|cvv|security|one.?time|otp|verification|social.?security|ssn|bank|routing|account.?number/i;
  const parent = element => element.parentElement || element.getRootNode()?.host;
  const native = element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  function active() {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return field(element);
  }
  // Inspect only the viewport center, descending shadow roots there to find
  // the topmost modal. Recovery and Stop must stay in its interactive subtree.
  function activeModal(ignore) {
    const viewport = window.visualViewport, visited = new Set();
    const x = (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) / 2;
    const y = (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) / 2;
    const modalAt = root => {
      if (visited.has(root)) return null;
      visited.add(root);
      for (const element of root.elementsFromPoint(x, y)) {
        if (element === ignore) continue;
        const shadow = element instanceof HTMLElement && (globalThis.chrome?.dom?.openOrClosedShadowRoot(element) || element.shadowRoot);
        const modal = (shadow && modalAt(shadow)) || element.closest('dialog:modal');
        if (modal) return modal;
      }
      return null;
    };
    return modalAt(document);
  }
  function field(element) {
    if (element?.nodeType === Node.TEXT_NODE) element = element.parentElement;
    if (native(element)) return element;
    if (element?.isContentEditable) while (element.parentElement?.isContentEditable) element = element.parentElement;
    return element;
  }
  function editable(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document || field(element) !== element) return false;
    // Only document and accessible open shadow trees; never traverse frames.
    for (let root = element.getRootNode(); root !== document; root = root.host?.getRootNode()) {
      if (!(root instanceof ShadowRoot) || root.mode !== 'open') return false;
    }
    if (!element.getClientRects().length) return false;
    for (let ancestor = element; ancestor; ancestor = parent(ancestor)) {
      if (ancestor.matches('[hidden],[inert],[readonly],[aria-hidden="true"],[aria-disabled="true"],[aria-readonly="true"]') || ancestor.hasAttribute('disabled') && !(native(element) && ancestor.matches('fieldset') && !element.matches(':disabled'))) return false;
      const style = getComputedStyle(ancestor);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      if (sensitive.test(['id', 'name', 'autocomplete', 'aria-label', 'placeholder'].map(key => ancestor.getAttribute(key) || '').join(' '))) return false;
      const root = ancestor.getRootNode();
      if (sensitive.test((ancestor.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => root.getElementById(id)?.textContent || '').join(' '))) return false;
      if (ancestor.matches('form') && ancestor.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return false;
    }
    if (sensitive.test([...element.labels || []].map(label => label.textContent).join(' '))) return false;
    if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type) && !element.matches(':disabled') && !element.readOnly;
    if (element instanceof HTMLTextAreaElement) return !element.matches(':disabled') && !element.readOnly;
    if (element.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return false;
    return element.isContentEditable && element.getAttribute('contenteditable') !== 'false';
  }
  const value = element => native(element) ? element.value : element.textContent;
  const canonical = text => text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  // A small DOM text projection keeps paragraph/BR boundaries, unlike
  // textContent, without reading a framework's private state or page scripts.
  function richText(root) {
    const block = node => node.nodeType === Node.ELEMENT_NODE && /^(P|DIV|LI|BLOCKQUOTE|PRE|H[1-6])$/.test(node.tagName);
    if (root.nodeType === Node.TEXT_NODE) return root.data;
    if (root.nodeName === 'BR') return !root.nextSibling && (!root.previousSibling || root.previousSibling.nodeName === 'BR') ? '' : '\n';
    let result = '', previous;
    for (const child of root.childNodes) {
      if (previous && (block(previous) || block(child))) result += '\n';
      result += richText(child); previous = child;
    }
    return result;
  }
  function range(element) {
    const selection = getSelection(), root = element.getRootNode();
    let current;
    if (root instanceof ShadowRoot && selection?.getComposedRanges) {
      const saved = selection.getComposedRanges({ shadowRoots: [root] })[0];
      if (saved) { current = document.createRange(); current.setStart(saved.startContainer, saved.startOffset); current.setEnd(saved.endContainer, saved.endOffset); }
    } else if (selection?.rangeCount) current = selection.getRangeAt(0).cloneRange();
    if (!current || !element.contains(current.startContainer) || !element.contains(current.endContainer)) throw Error('Reselect the insertion point in the original field.');
    for (const widget of element.querySelectorAll('[contenteditable="false"],input,textarea,iframe')) {
      if (current.intersectsNode(widget)) throw Error('Select text outside embedded controls.');
    }
    return current;
  }
  function saveCaret(owner) {
    const element = owner.element;
    if (native(element)) { owner.start = element.selectionStart; owner.end = element.selectionEnd; owner.direction = element.selectionDirection; }
    else { owner.range = range(element); owner.anchor = owner.range.startContainer; owner.focus = owner.range.endContainer; }
    owner.expected = value(element);
  }
  const notInserted = reason => ({ outcome: 'not-inserted', skipped: reason });
  const ambiguous = reason => ({ outcome: 'ambiguous', skipped: reason + ' Review before copying; text may already be present.' });
  let composing = new WeakSet();
  document.addEventListener('compositionstart', event => { const element = field(event.composedPath()[0]); if (element) composing.add(element); }, true);
  document.addEventListener('compositionend', event => composing.delete(field(event.composedPath()[0])), true);
  async function insert(owner, text, authorized = () => true, { allowInactiveNative = false, appendNative = false, changeEvent = false } = {}) {
    const element = owner.element;
    if (!element) return notInserted('Focus a visible writable field in the toolbar tab and Retry, or copy the retained text.');
    const valid = () => authorized() && editable(element);
    if (!valid()) return notInserted('Original field is unavailable. Reselect it to retry, or copy the retained text.');
    if (!native(element) && /[\r\n]/.test(text) && element.matches('[data-lexical-editor],.public-DraftEditor-content')) return notInserted('This editor cannot safely accept multiline browser edits. Copy the retained text.');
    if (composing.has(element)) return notInserted('Finish composing, then reselect the insertion point and retry.');
    if (!(allowInactiveNative && native(element)) && (!document.hasFocus() || active() !== element)) return notInserted('Reselect the original field to retry.');
    try {
      // Use the current caret only in the verified original field. Inactive
      // native fields may use their saved caret for the toolbar's separate grant.
      if (owner.expected === undefined) saveCaret(owner);
      if (!native(element) && (!owner.anchor?.isConnected || !owner.focus?.isConnected)) return notInserted('Editor selection was replaced. Reselect the insertion point and retry.');
      if (value(element) !== owner.expected) return notInserted('Field changed. Reselect the insertion point and retry.');
      if (!native(element)) {
        const current = range(element);
        if (current.startContainer !== owner.range.startContainer || current.startOffset !== owner.range.startOffset || current.endContainer !== owner.range.endContainer || current.endOffset !== owner.range.endOffset) return notInserted('Selection changed. Reselect the insertion point and retry.');
      }
    } catch (error) { return notInserted(error.message); }
    let changed = false, input = false, attempted = false;
    const observer = new MutationObserver(() => { changed = true; });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    const onInput = () => { input = true; };
    element.addEventListener('input', onInput);
    const before = value(element);
    let expected;
    try {
      if (native(element)) {
        if (appendNative) { owner.start = before.length; owner.end = before.length; }
        expected = before.slice(0, owner.start) + text + before.slice(owner.end);
        if (element.maxLength >= 0 && expected.length > element.maxLength) return notInserted('Field length limit reached.');
      } else {
        const prefix = document.createRange(), suffix = document.createRange();
        prefix.selectNodeContents(element); prefix.setEnd(owner.range.startContainer, owner.range.startOffset);
        suffix.selectNodeContents(element); suffix.setStart(owner.range.endContainer, owner.range.endOffset);
        expected = canonical(richText(prefix.cloneContents()) + text + richText(suffix.cloneContents()));
      }
      // A cancellable preflight is useful for policy/IME handlers. It is never
      // evidence of acceptance; actual input, DOM and reconciliation are checked.
      const accepted = element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: text }));
      await new Promise(resolve => setTimeout(resolve, 60));
      // Native value changes are not MutationObserver records. An input event
      // also records a preflight edit that application reconciliation reverted.
      const preflightChanged = input || value(element) !== before || observer.takeRecords().length || changed;
      if (!valid()) return preflightChanged ? ambiguous('Field changed during insertion.') : notInserted('Field became unavailable.');
      // No edit has been attempted yet. Even matching text could come from
      // concurrent user input, so it cannot confirm delivery of this segment.
      if (preflightChanged) return ambiguous('Field changed during insertion.');
      if (!accepted) return notInserted('The editor rejected insertion.');
      if (!(allowInactiveNative && native(element)) && (!document.hasFocus() || active() !== element)) return notInserted('Field focus changed.');
      if (!native(element)) {
        const current = range(element);
        if (current.startContainer !== owner.range.startContainer || current.startOffset !== owner.range.startOffset || current.endContainer !== owner.range.endContainer || current.endOffset !== owner.range.endOffset) return notInserted('Selection changed during insertion.');
      } else if (!appendNative && active() === element && (element.selectionStart !== owner.start || element.selectionEnd !== owner.end)) return notInserted('Selection changed during insertion.');
      // Composition can start during the asynchronous preflight even when a
      // controlled field consumes its input event and restores its prior value.
      if (composing.has(element)) return notInserted('Finish composing, then reselect the insertion point and retry.');
      if (native(element)) {
        attempted = true;
        const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, expected);
        element.setSelectionRange(owner.start + text.length, owner.start + text.length);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        if (changeEvent) element.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        if (typeof document.execCommand !== 'function') return notInserted('Browser text editing is unavailable. Copy the retained text.');
        // Browser editing notifies the editor and preserves its undo path. Never
        // fall back to Range mutations, even when execCommand returns false.
        attempted = true;
        document.execCommand('insertText', false, text);
      }
      // Give input handlers, MutationObservers and scheduled framework renders
      // time to reconcile. No public DOM API can inspect a private editor model.
      await new Promise(resolve => setTimeout(resolve, 60));
      changed ||= observer.takeRecords().length > 0;
      const actual = native(element) ? value(element) : canonical(richText(element));
      if (!valid() || actual !== expected || (!native(element) && !input && !changed)) {
        if (!input && !changed && value(element) === before && valid()) return notInserted('Browser editing had no observable effect.');
        return ambiguous('The editor did not confirm insertion.');
      }
      try { saveCaret(owner); } catch { owner.expected = value(element); }
      return { outcome: 'inserted', inserted: true };
    } catch (error) { return attempted || input || changed || observer.takeRecords().length ? ambiguous('Insertion could not be confirmed.') : notInserted(error.message); }
    finally { observer.disconnect(); element.removeEventListener('input', onInput); }
  }
  // Queues are owned by a single authorized output session. A failed head blocks
  // later segments. Ambiguous edits are never retried, including by Retry.
  class Delivery {
    constructor(element, authorized, onChange = () => {}, options) {
      this.owner = { element }; this.authorized = authorized; this.onChange = onChange; this.options = options;
      try { saveCaret(this.owner); } catch {}
      this.pending = []; this.chars = 0; this.last = -1; this.chain = Promise.resolve(); this.revision = 0; this.retrying = 0;
      this.listeners = new AbortController();
      const listenerOptions = { capture: true, signal: this.listeners.signal };
      const remember = event => {
        if (!event.isTrusted || this.delivering || this.disposed || active() !== this.owner.element) return;
        try { saveCaret(this.owner); } catch {}
      };
      for (const name of ['input', 'pointerup', 'keyup']) document.addEventListener(name, remember, listenerOptions);
      document.addEventListener('selectionchange', event => {
        if (this.owner.element && value(this.owner.element) === this.owner.expected && (native(this.owner.element) || this.owner.anchor?.isConnected)) remember(event);
      }, listenerOptions);
    }
    append(sequence, text) {
      if (this.disposed) return Promise.resolve(notInserted('Output session ended.'));
      if (sequence <= this.last) return Promise.resolve({ duplicate: true });
      this.last = sequence;
      // Saturation is destination backpressure, not a broken output transport.
      // A rejected RPC closes the toolbar port and destroys retained recovery.
      if (this.pending.length >= 128 || this.chars + text.length > 1000000) return Promise.resolve({
        ...notInserted('Retained text capacity reached. This segment was not retained. Stop this output and copy retained text.'), backpressure: true,
      });
      const item = { sequence, text, outcome: 'not-inserted' };
      this.pending.push(item); this.chars += text.length;
      // Admission must not wait for Retry to drain older segments: that can
      // outlast the output RPC timeout and disconnect this recovery session.
      // Retry remains the sole editor while new text joins its bounded queue.
      if (this.pending[0] !== item || this.retrying) {
        this.onChange(this); return Promise.resolve(notInserted('Text retained; earlier delivery or recovery is pending.'));
      }
      return this.run(async () => {
        if (this.pending[0] !== item) { this.onChange(this); return notInserted('Delivery paused; earlier text needs recovery.'); }
        return this.deliver(item);
      });
    }
    run(task) { const result = this.chain.then(task); this.chain = result.catch(() => {}); return result; }
    async deliver(item) {
      if (this.disposed) return notInserted('Output session ended.');
      const revision = this.revision;
      this.delivering = true;
      let result;
      try { result = await insert(this.owner, item.text, () => !this.disposed && revision === this.revision && this.authorized(), this.options); }
      finally { this.delivering = false; }
      if (this.disposed || revision !== this.revision) return result;
      item.outcome = result.outcome; item.reason = result.skipped;
      if (result.inserted) { this.pending.shift(); this.chars -= item.text.length; }
      this.onChange(this); return result;
    }
    retry(element) {
      this.retrying++;
      return this.run(async () => {
        // Only the toolbar caller opts into authorizing a first target through
        // explicit recovery. An existing target identity is never replaced here.
        const initial = !this.owner.element && this.options?.allowInitialTarget;
        if (this.disposed || (!initial && element !== this.owner.element) || active() !== element || !document.hasFocus() || !editable(element) || !this.authorized(element)) return notInserted('Reselect the original field. Replacement fields require a new session; copy retained text.');
        if (initial) this.owner = { element };
        try { saveCaret(this.owner); } catch (error) { return notInserted(error.message); }
        while (this.pending.length && this.pending[0].outcome === 'not-inserted') {
          const result = await this.deliver(this.pending[0]); if (!result.inserted) return result;
        }
        return this.pending.length ? ambiguous('Review the uncertain edit before continuing.') : { inserted: true };
      }).finally(() => { this.retrying--; });
    }
    text() { return this.pending.map(item => item.text).join(''); }
    clear() { this.revision++; this.pending = []; this.chars = 0; this.onChange(this); }
    dispose() { this.disposed = true; this.listeners.abort(); this.clear(); }
  }
  function recoveryView(delivery, anchor, onClear = () => {}) {
    const host = document.createElement('div'); host.setAttribute('data-local-text-recovery', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;max-width:300px!important;';
    const shadow = host.attachShadow({ mode: 'closed' }), style = document.createElement('style');
    style.textContent = `:host{color-scheme:light dark}section{font:13px/1.4 system-ui;padding:8px;border:1px solid GrayText;border-radius:6px;background:Canvas;color:CanvasText;box-shadow:0 2px 6px #0003}button{font:inherit;margin:4px 4px 0 0;min-height:28px}textarea[hidden]{display:none}textarea{display:block;box-sizing:border-box;width:100%;height:90px}button:focus-visible,textarea:focus-visible{outline:2px solid Highlight;outline-offset:2px}`;
    const panel = document.createElement('section'); panel.setAttribute('aria-label', 'Retained dictation');
    const status = document.createElement('div'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const preview = document.createElement('textarea'); preview.readOnly = true; preview.hidden = true; preview.setAttribute('aria-label', 'Retained text for review; uncertain text may already be inserted');
    const add = (label, action) => {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
      button.addEventListener('pointerdown', event => { if (event.isTrusted) event.preventDefault(); });
      button.addEventListener('click', event => { if (event.isTrusted) void action(); }); panel.append(button); return button;
    };
    panel.append(status, preview);
    let selected = null;
    const focusListener = event => {
      const target = field(event.composedPath()[0]);
      if (event.composedPath().includes(host)) return;
      selected = target === delivery.owner.element ? delivery.owner : !delivery.owner.element && delivery.options?.allowInitialTarget && editable(target) ? { element: target } : null;
      rememberSelection(event);
    };
    const rememberSelection = event => {
      // Bound owners already track trusted edits through Delivery. Only keep a
      // candidate caret here for keyboard activation of targetless recovery.
      if (event.isTrusted && selected && selected !== delivery.owner && active() === selected.element) { try { saveCaret(selected); } catch {} }
    };
    document.addEventListener('focusin', focusListener, true);
    for (const name of ['input', 'pointerup', 'keyup']) document.addEventListener(name, rememberSelection, true);
    const retry = add('Retry in original field', async () => {
      const owner = selected;
      if (active() === host && owner && value(owner.element) === owner.expected && editable(owner.element)) {
        owner.element.focus({ preventScroll: true });
        if (native(owner.element)) owner.element.setSelectionRange(owner.start, owner.end, owner.direction);
        else if (owner.anchor?.isConnected && owner.focus?.isConnected) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(owner.range); }
      }
      const result = await delivery.retry(active());
      if (result.skipped) status.textContent = result.skipped;
    });
    add('Review text', () => { preview.hidden = false; preview.value = delivery.text(); position(); preview.focus(); });
    add('Copy for review', async () => {
      try { await navigator.clipboard.writeText(delivery.text()); status.textContent = 'Copied for review. Uncertain text may already be inserted.'; }
      catch { preview.hidden = false; preview.value = delivery.text(); preview.focus(); preview.select(); status.textContent = 'Select and copy the retained text.'; position(); }
    });
    add('Discard retained text', () => { delivery.clear(); onClear(); });
    shadow.append(style, panel);
    let focusRoot;
    function position() {
      const parent = activeModal(host) || document.documentElement;
      if (host.parentElement !== parent) parent.append(host);
      // Focus moves within a shadow tree may not reach document when the
      // retargeted relatedTarget is the same wrapper. Observe that root too so
      // explicitly reselecting the editor still authorizes keyboard Retry.
      const root = host.getRootNode(), nextFocusRoot = root === document ? null : root;
      if (focusRoot !== nextFocusRoot) {
        focusRoot?.removeEventListener('focusin', focusListener, true);
        focusRoot = nextFocusRoot;
        focusRoot?.addEventListener('focusin', focusListener, true);
      }
      const rect = anchor()?.getBoundingClientRect(), bounds = host.getBoundingClientRect();
      const left = rect?.width ? rect.left : innerWidth - bounds.width - 8;
      const top = rect?.width ? rect.bottom + 6 : innerHeight - bounds.height - 8;
      host.style.setProperty('left', `${Math.max(4, Math.min(left, innerWidth - bounds.width - 4))}px`, 'important');
      host.style.setProperty('top', `${Math.max(4, Math.min(top, innerHeight - bounds.height - 4))}px`, 'important');
    }
    // Recovery can outlive capture and its placement observer. Follow modal
    // changes (including closed shadow dialogs) even without another segment.
    const timer = setInterval(position, 1000);
    for (const name of ['scroll', 'resize']) window.addEventListener(name, position, true);
    host.update = () => {
      const uncertain = delivery.pending.some(item => item.outcome === 'ambiguous');
      retry.disabled = uncertain;
      retry.textContent = delivery.owner.element ? 'Retry in original field' : 'Retry in selected field';
      status.textContent = uncertain ? 'Insertion uncertain. Review text before copying; Retry is disabled to avoid duplicates.' : delivery.owner.element ? 'Text retained. Reselect the original field and Retry, or copy for review.' : 'Text retained. Select a writable field and Retry, or copy for review.';
      if (!preview.hidden) preview.value = delivery.text();
      position();
    };
    const remove = host.remove.bind(host);
    host.remove = () => {
      clearInterval(timer);
      focusRoot?.removeEventListener('focusin', focusListener, true);
      for (const name of ['scroll', 'resize']) window.removeEventListener(name, position, true);
      document.removeEventListener('focusin', focusListener, true);
      for (const name of ['input', 'pointerup', 'keyup']) document.removeEventListener(name, rememberSelection, true);
      remove();
    };
    host.review = () => { preview.hidden = false; preview.value = delivery.text(); position(); preview.focus(); };
    host.update(); return host;
  }
  globalThis.LocalTextInsertion = { active, activeModal, field, editable, native, value, range, saveCaret, insert, Delivery, recoveryView };
})();
