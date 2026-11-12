// Injected only for the toolbar-invoked top-level document, in Chrome's ISOLATED world.
// No page-world messages, evaluated strings, HTML insertion or frame traversal.
(() => {
  if (globalThis.localTextPageAgent) return;
  globalThis.localTextPageAgent = true;
  const sensitive = /password|passcode|\bauth(?:entication)?\b|\blogin\b|\busername\b|\bpin\b|\biban\b|\bbic\b|\bswift\b|financial|transaction|payment|credit|cc-|card.?number|cvc|cvv|security|one.?time|otp|verification|social.?security|ssn|bank|routing|account.?number/i;
  function editable(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document || element.getRootNode() !== document) return false;
    if (element.closest('[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"],[aria-readonly="true"]') || element.getClientRects().length === 0) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
      if (sensitive.test(['id', 'name', 'autocomplete', 'aria-label', 'placeholder'].map(key => ancestor.getAttribute(key) || '').join(' '))) return false;
    }
    if (sensitive.test((element.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '))) return false;
    if (sensitive.test([...element.labels || []].map(label => label.textContent).join(' '))) return false;
    // Conservative: never insert in authentication/payment forms.
    if (element.closest('form')?.querySelector('input[type="password"],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]')) return false;
    // :disabled includes state inherited from a fieldset and respects legend exceptions.
    if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type) && !element.matches(':disabled') && !element.readOnly;
    if (element instanceof HTMLTextAreaElement) return !element.matches(':disabled') && !element.readOnly;
    if (element.querySelector('input,textarea,iframe,img,video,canvas,[contenteditable="false"],[data-lexical-editor],.ProseMirror,.ql-editor') || element.matches('[data-lexical-editor],.ProseMirror,.ql-editor')) return false;
    return element.isContentEditable && element.getAttribute('contenteditable') !== 'false' && !element.closest('[role="textbox"][aria-readonly="true"]');
  }
  function field(element) {
    if (element?.isContentEditable) {
      while (element.parentElement?.isContentEditable) element = element.parentElement;
    }
    return element;
  }
  // Keep only an actually focused element, never search for arbitrary fields.
  // Chrome retains activeElement while Live steals window focus. Some editors
  // blur on window deactivation; retain their last trusted focus in that case.
  let previousFocus = editable(field(document.activeElement)) ? field(document.activeElement) : null;
  document.addEventListener('focusin', event => {
    if (!event.isTrusted) return;
    const element = field(event.composedPath()[0]);
    previousFocus = editable(element) ? element : null;
  }, true);
  document.addEventListener('focusout', event => {
    if (!event.isTrusted) return;
    if (event.relatedTarget) previousFocus = null;
    else queueMicrotask(() => { if (document.hasFocus()) previousFocus = null; });
  }, true);
  document.addEventListener('pointerdown', event => {
    if (!event.isTrusted) return;
    // A deliberate click elsewhere supersedes old focus, even on a nonfocusable
    // element. Dynamic comment activation will then provide a real focusin.
    if (field(event.composedPath()[0]) !== previousFocus) previousFocus = null;
  }, true);
  window.addEventListener('pagehide', () => { previousFocus = null; });
  function focusedField() {
    const active = field(document.activeElement);
    // Frames and unsupported controls supersede retained focus even if blurred.
    if (active && ![document.body, document.documentElement].includes(active)) {
      return active.shadowRoot ? null : active;
    }
    return !document.hasFocus() && editable(previousFocus) ? previousFocus : null;
  }
  function append(element, text) {
    if (!editable(element)) throw Error('Target is missing, sensitive, hidden or not editable. Focus a supported text field or use Live Copy.');
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent;
    if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))) throw Error('The editor rejected text insertion. Use another field or Live copy.');
    if (!editable(element) || focusedField() !== element) throw Error('Field changed during insertion. Focus the field again or use Live Copy.');
    if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent) !== value) throw Error('The editor changed its content during beforeinput. Use Live Copy.');
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // Native setter plus input/change supports ordinary controlled inputs.
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const current = element.value;
      if (element.maxLength >= 0 && current.length + text.length > element.maxLength) throw Error('Field length limit reached; text was not inserted.');
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, current + text);
      if (document.activeElement === element) element.setSelectionRange(element.value.length, element.value.length);
    } else {
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
      const node = document.createTextNode(text); range.insertNode(node);
      if (document.activeElement === element) {
        range.setStartAfter(node); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'local-page-target' || port.sender?.id !== chrome.runtime.id) return;
    let disposed = false, output;
    const post = message => { if (!disposed) { try { port.postMessage(message); } catch { cleanup(); } } };
    function cleanup() {
      disposed = true;
      output = null;
    }
    port.onDisconnect.addListener(cleanup);
    async function command(message) {
      switch (message.action) {
        case 'describe': return { label: document.title.slice(0, 80) || 'Authorized page', frame: 'top frame' };
        case 'output': {
          output = { last: -1 }; return true;
        }
        case 'append': {
          if (!output || !Number.isSafeInteger(message.sequence) || message.sequence < 0 || typeof message.text !== 'string' || message.text.length > 100000) throw Error('Invalid or inactive output session.');
          if (message.sequence <= output.last) return { duplicate: true };
          // Mark before editing: never retry an ambiguous DOM side effect.
          output.last = message.sequence;
          const element = focusedField();
          if (!editable(element)) return { skipped: 'Focus a visible text/search input, textarea or basic contenteditable in the toolbar tab. Sensitive, hidden, disabled and frame fields are unsupported; use Live Copy.' };
          try { append(element, message.text); return { inserted: true }; }
          catch (error) { return { skipped: error.message }; }
        }
        case 'stop': output = null; return true;
        default: throw Error('Unknown page operation.');
      }
    }
    port.onMessage.addListener(message => {
      if (disposed || !Number.isSafeInteger(message.request)) return;
      void command(message).then(result => post({ request: message.request, result }), error => post({ request: message.request, error: error.message }));
    });
  });
})();
