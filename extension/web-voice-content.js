// ISOLATED world, top HTTP(S) document only. No inference, page-world bridge,
// field discovery, persistent transcripts, or automatic capture.
(() => {
  if (globalThis.localWebVoice) { globalThis.localWebVoice(); return; }
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  const sensitive = /password|passcode|\bauth(?:entication)?\b|\blogin\b|\busername\b|\bpin\b|\biban\b|\bbic\b|\bswift\b|financial|transaction|payment|credit|cc-|card.?number|cvc|cvv|security|one.?time|otp|verification|social.?security|ssn|bank|routing|account.?number/i;
  function editable(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document || element.getRootNode() !== document) return false;
    if (element.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"],[aria-readonly="true"]') || !element.getClientRects().length) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      if (sensitive.test(['id', 'name', 'autocomplete', 'aria-label', 'placeholder'].map(key => ancestor.getAttribute(key) || '').join(' '))) return false;
    }
    if (sensitive.test((element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '))) return false;
    if (sensitive.test([...element.labels || []].map(label => label.textContent).join(' '))) return false;
    if (element.closest('form')?.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return false;
    if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type) && !element.matches(':disabled') && !element.readOnly;
    if (element instanceof HTMLTextAreaElement) return !element.matches(':disabled') && !element.readOnly;
    if (element.querySelector('input,textarea,iframe,img,video,canvas,[contenteditable="false"],[data-lexical-editor],.ProseMirror,.ql-editor') || element.matches('[data-lexical-editor],.ProseMirror,.ql-editor')) return false;
    return element.isContentEditable && element.getAttribute('contenteditable') !== 'false';
  }
  function field(element) {
    if (element?.isContentEditable) while (element.parentElement?.isContentEditable) element = element.parentElement;
    return element;
  }
  const native = element => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  const value = element => native(element) ? element.value : element.textContent;
  let control, enabled = false, disposed = true, target, session, host, button, status, observer, timer, state = 'idle', inserting = false;
  const listeners = new AbortController();
  function send(message) { try { control?.postMessage(message); } catch { disable(); } }
  function stateUI(next, error = '') {
    state = next;
    host?.setAttribute('data-voice-state', next);
    if (!button) return;
    const labels = { idle: 'Start voice typing', preparing: 'Preparing… Click to cancel', recording: 'Recording · Stop voice typing', stopping: 'Stopping…', error: 'Voice typing error · Retry' };
    button.textContent = { idle: '🎙', preparing: '…', recording: '■', stopping: '…', error: '!' }[next];
    button.setAttribute('aria-label', labels[next]); button.title = error || labels[next]; host.title = error || labels[next]; button.disabled = next === 'stopping';
    button.dataset.state = next;
    status.textContent = error || (next === 'preparing' ? 'Preparing…' : next === 'recording' ? 'Recording' : next === 'stopping' ? 'Stopping…' : '');
    position();
  }
  function position() {
    if (!host || !target) return;
    if (!editable(target)) {
      if (session) abort('Target field removed or no longer supported. Focus a supported field to retry.');
      else if (state === 'error') host.style.setProperty('visibility', 'visible', 'important');
      else removeWidget();
      return;
    }
    const rect = target.getBoundingClientRect();
    // Outside the upper edge when space permits; no host layout changes.
    const x = Math.max(4, Math.min(innerWidth - 42, rect.right - 34));
    const y = Math.max(4, Math.min(innerHeight - 42, rect.top >= 38 ? rect.top - 34 : rect.bottom + 4));
    host.style.setProperty('left', `${x}px`, 'important'); host.style.setProperty('top', `${y}px`, 'important');
    host.style.setProperty('visibility', !session && (!editable(target) || rect.bottom < 0 || rect.top > innerHeight) ? 'hidden' : 'visible', 'important');
  }
  function removeWidget() { host?.remove(); host = button = status = null; if (!session) target = null; }
  function saveCaret(owner) {
    if (native(owner.element)) { owner.start = owner.element.selectionStart; owner.end = owner.element.selectionEnd; }
    else {
      const selection = getSelection();
      if (!selection?.rangeCount || !owner.element.contains(selection.anchorNode) || !owner.element.contains(selection.focusNode)) throw Error('Select a caret in this basic editable field first.');
      owner.range = selection.getRangeAt(0).cloneRange();
    }
    owner.expected = value(owner.element);
  }
  function abort(error) {
    const old = session; session = null;
    try { old?.connection?.disconnect(); } catch { /* Context may have been revoked. */ }
    if (old) send({ type: 'cancel', error });
    stateUI('error', error);
  }
  function widget(element) {
    target = element;
    if (!host) {
      host = document.createElement('div'); host.setAttribute('data-local-web-voice', '');
      host.style.cssText = 'all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;width:34px!important;height:30px!important;';
      const shadow = host.attachShadow({ mode: 'closed' }), style = document.createElement('style');
      style.textContent = ':host([hidden]){display:none!important}button{width:32px;height:30px;border:1px solid #98a2b3;border-radius:16px;background:#fff;color:#152334;cursor:pointer;font:16px system-ui;box-shadow:0 1px 5px #0003}button[data-state="recording"]{color:#b42318;border-color:#b42318}button:focus-visible{outline:3px solid #4263eb}span{position:absolute;right:0;top:33px;width:max-content;max-width:260px;padding:3px 6px;border-radius:4px;background:#fff;color:#152334;font:12px system-ui;box-shadow:0 1px 5px #0003}span:empty{display:none}';
      button = document.createElement('button'); button.type = 'button';
      status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      // Pointer activation leaves the page selection intact. Keyboard activation
      // uses the same saved field and never redirects to the widget or new focus.
      button.addEventListener('pointerdown', event => { if (event.isTrusted) event.preventDefault(); });
      button.addEventListener('click', event => {
        if (!event.isTrusted || !enabled) return;
        if (session) {
          if (state === 'preparing') abort('Preparation canceled. Click the mic to retry.');
          else { stateUI('stopping'); send({ type: 'stop' }); }
          return;
        }
        try {
          if (!editable(target)) throw Error('Focus a supported writable field first.');
          const owner = { element: target, capability: crypto.randomUUID(), last: -1 };
          saveCaret(owner); session = owner; stateUI('preparing');
          send({ type: 'start', capability: owner.capability });
        } catch (error) { abort(error.message); }
      });
      shadow.append(style, button, status); document.documentElement.append(host);
    }
    stateUI(session ? state : 'idle');
  }
  function focus() {
    if (!enabled || session) return;
    const element = field(document.activeElement);
    if (element === host) return;
    if (editable(element)) widget(element); else removeWidget();
  }
  function disable() {
    enabled = false; disposed = true;
    const owner = session, previous = control; session = null; control = null;
    observer?.disconnect(); observer = null; clearInterval(timer);
    removeWidget();
    // Extension reload can invalidate messaging methods before disconnect is
    // delivered. Always remove the UI first, even in an invalidated context.
    try { owner?.connection?.disconnect(); } catch {}
    try { previous?.disconnect(); } catch {}
  }
  function connect() {
    if (!disposed) { focus(); return; }
    disposed = false;
    control = chrome.runtime.connect({ name: 'web-voice-control' });
    control.onDisconnect.addListener(disable);
    control.onMessage.addListener(message => {
      if (message.type === 'disabled') { disable(); return; }
      if (message.type === 'enabled') {
        enabled = true; focus();
        observer = new MutationObserver(() => position());
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden', 'type', 'contenteditable', 'autocomplete', 'name', 'aria-disabled', 'aria-readonly'] });
        // Layout, zoom and transforms can change without DOM mutation.
        let ticks = 0;
        timer = setInterval(() => { position(); if (++ticks % 20 === 0) send({ type: 'heartbeat' }); }, 1000);
      }
      if (message.type === 'state' && session) stateUI(message.state, message.error);
      if (message.type === 'ended') {
        session?.connection?.disconnect(); session = null;
        stateUI(message.error ? 'error' : 'idle', message.error || '');
        // Preserve actionable errors until next focus or explicit retry.
      }
    });
  }
  globalThis.localWebVoice = connect;
  const options = { capture: true, signal: listeners.signal };
  document.addEventListener('focusin', focus, options);
  document.addEventListener('focusout', () => queueMicrotask(focus), options);
  for (const event of ['scroll', 'resize']) window.addEventListener(event, position, options);
  visualViewport?.addEventListener('resize', position, options);
  document.addEventListener('selectionchange', () => {
    if (!inserting && session && document.activeElement === session.element) try { saveCaret(session); } catch { /* A later insertion validates the saved range. */ }
  }, options);
  document.addEventListener('input', event => {
    if (!inserting && event.isTrusted && session?.element === event.target) saveCaret(session);
  }, options);
  window.addEventListener('pagehide', () => { send({ type: 'cancel' }); disable(); listeners.abort(); }, { once: true });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['web-voice-typing-v1'] && !(changes['web-voice-typing-v1'].newValue?.version === 1 && changes['web-voice-typing-v1'].newValue.enabled === true)) disable();
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'web-voice-output') return;
    if (port.sender?.id !== chrome.runtime.id || port.sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('extension/web-voice-runtime.html')) { port.disconnect(); return; }
    const owner = session;
    if (!enabled || !owner || owner.connection) { port.disconnect(); return; }
    owner.connection = port;
    port.onDisconnect.addListener(() => {
      if (session === owner && state !== 'stopping') abort('Output connection lost. Click the mic to retry.');
    });
    port.onMessage.addListener(message => {
      if (!Number.isSafeInteger(message.request)) return;
      const reply = result => { try { port.postMessage({ request: message.request, result }); } catch {} };
      try {
        if (!enabled || session !== owner || message.capability !== owner.capability || !editable(owner.element)) throw Error('Stale, unauthorized or removed voice target.');
        if (message.action === 'output') { reply(true); return; }
        if (message.action !== 'append' || !Number.isSafeInteger(message.sequence) || message.sequence < 0 || typeof message.text !== 'string' || message.text.length > 100000) throw Error('Invalid voice output message.');
        if (message.sequence <= owner.last) { reply({ duplicate: true }); return; }
        owner.last = message.sequence; // Never retry even an ambiguous edit.
        if (value(owner.element) !== owner.expected) throw Error('Field changed outside normal editing. Stop and select the insertion point again.');
        const element = owner.element, text = message.text;
        inserting = true;
        try {
          if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))) throw Error('The editor rejected insertion. Use another field.');
          if (!enabled || session !== owner || !editable(element) || value(element) !== owner.expected) throw Error('Field changed during insertion.');
          if (native(element)) {
            const next = owner.expected.slice(0, owner.start) + text + owner.expected.slice(owner.end);
            if (element.maxLength >= 0 && next.length > element.maxLength) throw Error('Field length limit reached.');
            const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
            Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, next);
            owner.start += text.length; owner.end = owner.start;
            if (document.activeElement === element) element.setSelectionRange(owner.start, owner.end);
          } else {
            const range = owner.range;
            if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) throw Error('Editable selection was removed.');
            range.deleteContents(); const node = document.createTextNode(text); range.insertNode(node); range.setStartAfter(node); range.collapse(true);
            if (document.activeElement === element) { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range.cloneRange()); }
          }
          owner.expected = value(element);
          element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          if (value(element) !== owner.expected) throw Error('Website changed the inserted text. Stop and select a field again.');
          reply({ inserted: true });
        } finally { inserting = false; }
      } catch (error) {
        try { port.postMessage({ request: message.request, error: error.message }); } catch {}
        abort(error.message);
      }
    });
  });
  connect();
})();
