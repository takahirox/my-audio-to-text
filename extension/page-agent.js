// Injected only for the toolbar-invoked top-level document, in Chrome's ISOLATED world.
// No page-world messages, evaluated strings, HTML insertion or frame traversal.
(() => {
  if (globalThis.localTextPageAgent) return;
  globalThis.localTextPageAgent = true;
  const { editable, field, active, Delivery } = LocalTextInsertion;
  // Keep only an actually focused element, never search for arbitrary fields.
  // Chrome retains activeElement while Live steals window focus. Some editors
  // blur on window deactivation; retain their last trusted focus in that case.
  let previousFocus = editable(active()) ? active() : null;
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
    const element = active();
    // Frames and unsupported controls supersede retained focus even if blurred.
    if (element && ![document.body, document.documentElement].includes(element)) {
      return element;
    }
    return !document.hasFocus() && editable(previousFocus) ? previousFocus : null;
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'local-page-target' || port.sender?.id !== chrome.runtime.id) return;
    let disposed = false, output, recovery;
    const post = message => { if (!disposed) { try { port.postMessage(message); } catch { cleanup(); } } };
    function cleanup() {
      disposed = true;
      output?.delivery?.dispose(); output = null; recovery?.remove(); recovery = null;
    }
    port.onDisconnect.addListener(cleanup);
    async function command(message) {
      switch (message.action) {
        case 'describe': return { label: document.title.slice(0, 80) || 'Authorized page', frame: 'top frame' };
        case 'output': {
          output?.delivery?.dispose(); recovery?.remove(); recovery = null;
          output = { last: -1 }; return true;
        }
        case 'append': {
          if (!output || !Number.isSafeInteger(message.sequence) || message.sequence < 0 || typeof message.text !== 'string' || message.text.length > 100000) throw Error('Invalid or inactive output session.');
          if (message.sequence <= output.last) return { duplicate: true };
          // Mark before editing: never retry an ambiguous DOM side effect.
          output.last = message.sequence;
          const element = focusedField();
          if (output.delivery && !output.delivery.pending.length && element !== output.delivery.owner.element && editable(element)) {
            output.delivery.dispose(); output.delivery = null;
          }
          if (!output.delivery) {
            if (!editable(element)) return { outcome: 'not-inserted', skipped: 'Focus a visible writable field in the toolbar tab. Sensitive, hidden, disabled and frame fields are unsupported; use Live Copy.' };
            const owner = output;
            output.delivery = new Delivery(element, () => !disposed && output === owner && focusedField() === element,
              delivery => {
                if (!delivery.pending.length) { recovery?.remove(); recovery = null; return; }
                recovery ||= LocalTextInsertion.recoveryView(delivery, () => element);
                recovery.update();
              }, { allowInactiveNative: true, appendNative: true, changeEvent: true });
          }
          // Bind this output to its first verified target. Focus changes never
          // redirect an existing session or replay its retained text elsewhere.
          return output.delivery.append(message.sequence, message.text);
        }
        case 'stop': output?.delivery?.dispose(); output = null; recovery?.remove(); recovery = null; return true;
        default: throw Error('Unknown page operation.');
      }
    }
    let chain = Promise.resolve();
    port.onMessage.addListener(message => {
      if (disposed || !Number.isSafeInteger(message.request)) return;
      chain = chain.then(() => command(message)).then(result => post({ request: message.request, result }), error => post({ request: message.request, error: error.message }));
    });
  });
})();
