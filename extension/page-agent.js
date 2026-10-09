// Injected only for the toolbar-invoked top-level document, in Chrome's ISOLATED world.
// No page-world messages, evaluated strings, HTML insertion or frame traversal.
(() => {
  if (globalThis.localTextPageAgent) return;
  globalThis.localTextPageAgent = true;
  const targets = new Map();
  const identify = element => {
    for (const [id, ref] of targets) {
      if (!ref.deref()?.isConnected) targets.delete(id);
    }
    const id = crypto.randomUUID(); targets.set(id, new WeakRef(element)); return id;
  };
  const describe = element => `${element.localName}${element.id ? ` #${element.id.slice(0, 80)}` : ''}${element.getAttribute('aria-label') ? ` · ${element.getAttribute('aria-label').slice(0, 80)}` : ''}`;
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
  function mediaError(element) {
    if (!(element instanceof HTMLMediaElement) || !element.isConnected) return 'Media disappeared. Discover again or choose Chrome tab audio.';
    if (element.mediaKeys) return 'Protected media cannot be captured. Choose Chrome tab audio where permitted.';
    if (typeof element.captureStream !== 'function') return 'Element capture is unavailable. Choose Chrome tab audio.';
    if (!element.srcObject) {
      try { if (new URL(element.currentSrc || element.src, location.href).origin !== location.origin) return 'Cross-origin media is unsupported. Choose Chrome tab audio where permitted.'; }
      catch { return 'Media source is unsupported. Choose Chrome tab audio.'; }
    }
    if (element.readyState < 2 || element.paused) return 'Play this media first, then discover again.';
    return '';
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'local-page-target' || port.sender?.id !== chrome.runtime.id) return;
    let disposed = false, output, capture;
    const post = message => { if (!disposed) { try { port.postMessage(message); } catch { cleanup(); } } };
    function cleanup() {
      disposed = true;
      capture?.stop(); capture = null; output = null;
    }
    port.onDisconnect.addListener(cleanup);
    async function command(message) {
      switch (message.action) {
        case 'describe': return { label: document.title.slice(0, 80) || 'Authorized page', frame: 'top frame' };
        case 'discover': return [...document.querySelectorAll('audio,video')].map((element, index) => ({ id: identify(element), label: `${index + 1} · ${describe(element)}`, error: mediaError(element) }));
        case 'forget': targets.delete(message.target); return true;
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
        case 'capture': {
          if (capture) throw Error('Media capture already active.');
          const element = targets.get(message.target)?.deref(), reason = mediaError(element);
          if (reason) throw Error(reason);
          let stream, context, source, processor, gain, watcher;
          const stop = () => {
            clearInterval(watcher); element.removeEventListener('encrypted', ended);
            if (processor) processor.onaudioprocess = null;
            source?.disconnect(); processor?.disconnect(); gain?.disconnect();
            stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
            if (context && context.state !== 'closed') void context.close().catch(() => {});
          };
          const ended = () => { stop(); capture = null; post({ event: 'ended', error: 'Selected media ended, changed or was removed. Stop and reselect, or use Chrome tab audio.' }); };
          try {
            stream = element.captureStream();
            const tracks = stream.getAudioTracks();
            if (!tracks.length || tracks.some(track => track.readyState !== 'live')) throw Error('No capturable audio track. Choose Chrome tab audio where permitted.');
            stream.getVideoTracks().forEach(track => track.stop());
            context = new AudioContext(); capture = { stop }; await context.resume();
            if (disposed) { stop(); throw Error('Capture canceled.'); }
            source = context.createMediaStreamSource(new MediaStream(tracks));
            // ScriptProcessor avoids loading code into the page or weakening CSP.
            processor = context.createScriptProcessor(2048, 2, 1);
            processor.onaudioprocess = ({ inputBuffer }) => {
              const mono = new Float32Array(inputBuffer.length);
              for (let channel = 0; channel < inputBuffer.numberOfChannels; channel++) {
                const samples = inputBuffer.getChannelData(channel);
                for (let i = 0; i < mono.length; i++) mono[i] += samples[i] / inputBuffer.numberOfChannels;
              }
              post({ event: 'audio', samples: Array.from(mono), rate: context.sampleRate });
            };
            gain = context.createGain(); gain.gain.value = 0;
            source.connect(processor); processor.connect(gain); gain.connect(context.destination);
            tracks.forEach(track => { track.onended = ended; }); element.addEventListener('encrypted', ended);
            const originalSource = element.currentSrc, originalObject = element.srcObject;
            watcher = setInterval(() => { if (!element.isConnected || element.mediaKeys || element.currentSrc !== originalSource || element.srcObject !== originalObject) ended(); }, 300);
            capture = { stop }; return true;
          } catch (error) { stop(); throw Error(`Element audio unavailable: ${error.message}. Use Chrome tab audio where permitted.`); }
        }
        case 'stop': capture?.stop(); capture = null; output = null; return true;
        default: throw Error('Unknown page operation.');
      }
    }
    port.onMessage.addListener(message => {
      if (disposed || !Number.isSafeInteger(message.request)) return;
      void command(message).then(result => post({ request: message.request, result }), error => post({ request: message.request, error: error.message }));
    });
  });
})();
