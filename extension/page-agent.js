// Injected only after an explicit page-target action, in Chrome's ISOLATED world.
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
  const sensitive = /password|passcode|payment|credit|cc-|card.?number|cvc|cvv|security|one.?time|otp|verification|social.?security|ssn|bank|routing|account.?number/i;
  function editable(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.ownerDocument !== document) return false;
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
    return element.isContentEditable && element.getAttribute('contenteditable') !== 'false' && !element.closest('[role="textbox"][aria-readonly="true"]');
  }
  function field(element) {
    if (element?.isContentEditable) {
      while (element.parentElement?.isContentEditable) element = element.parentElement;
    }
    return element;
  }
  function append(element, text) {
    if (!editable(element)) throw Error('Target is missing, sensitive, hidden or not editable. Stop and reselect a supported text field.');
    const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : element.textContent;
    const inserted = (value && !/\s$/.test(value) ? ' ' : '') + text;
    if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: inserted }))) throw Error('The editor rejected text insertion. Use another field or Live copy.');
    if (!editable(element)) throw Error('Field changed during insertion. Stop and reselect.');
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      // Native setter plus input/change supports ordinary controlled inputs.
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const current = element.value;
      if (element.maxLength >= 0 && current.length + inserted.length > element.maxLength) throw Error('Field length limit reached; text was not inserted.');
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, current + inserted);
      if (document.activeElement === element) element.setSelectionRange(element.value.length, element.value.length);
    } else {
      const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
      const node = document.createTextNode(inserted); range.insertNode(node);
      if (document.activeElement === element) {
        range.setStartAfter(node); range.collapse(true); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      }
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: inserted }));
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
    let disposed = false, output, capture, cancelPicker;
    const post = message => { if (!disposed) { try { port.postMessage(message); } catch { cleanup(); } } };
    function cleanup() {
      disposed = true; cancelPicker?.(); cancelPicker = null;
      capture?.stop(); capture = null; output = null;
    }
    port.onDisconnect.addListener(cleanup);
    async function command(message) {
      switch (message.action) {
        case 'describe': return { label: document.title.slice(0, 80) || 'Authorized page', frame: 'top frame' };
        case 'discover': return [...document.querySelectorAll('audio,video')].map((element, index) => ({ id: identify(element), label: `${index + 1} · ${describe(element)}`, error: mediaError(element) }));
        case 'forget': targets.delete(message.target); return true;
        case 'pick': {
          cancelPicker?.();
          return new Promise((resolve, reject) => {
            const hint = document.createElement('div'); hint.textContent = 'Local transcription: click an editable field to select it. Escape cancels.';
            Object.assign(hint.style, { position: 'fixed', top: '0', left: '0', zIndex: '2147483647', padding: '12px', background: '#142233', color: 'white', pointerEvents: 'none' });
            document.documentElement.append(hint);
            const done = () => { document.removeEventListener('click', click, true); document.removeEventListener('keydown', key, true); hint.remove(); clearTimeout(timer); cancelPicker = null; };
            const click = event => {
              event.preventDefault(); event.stopImmediatePropagation();
              if (!event.isTrusted) return;
              const element = field(event.target);
              if (!editable(element)) { hint.textContent = 'Unsupported or sensitive field. Choose a visible text input, textarea or basic contenteditable; Escape cancels.'; return; }
              done(); resolve({ id: identify(element), label: describe(element) });
            };
            const key = event => { if (event.key === 'Escape') { event.preventDefault(); done(); reject(Error('Field picker canceled.')); } };
            const timer = setTimeout(() => { done(); reject(Error('Field picker expired. Pick again.')); }, 60000);
            cancelPicker = () => { done(); reject(Error('Field picker canceled.')); };
            document.addEventListener('click', click, true); document.addEventListener('keydown', key, true);
          });
        }
        case 'output': {
          const element = message.target && targets.get(message.target)?.deref();
          if (message.mode === 'selected' && !editable(element)) throw Error('Selected field disappeared or became unsupported. Stop and pick again.');
          if (!['selected', 'focused'].includes(message.mode)) throw Error('Invalid output mode.');
          output = { mode: message.mode, element, seen: new Set(), last: -1 }; return true;
        }
        case 'append': {
          if (!output || !Number.isSafeInteger(message.sequence) || message.sequence < 0 || typeof message.key !== 'string' || typeof message.text !== 'string' || message.text.length > 100000) throw Error('Invalid or inactive output session.');
          if (output.seen.has(message.key) || message.sequence <= output.last) return { duplicate: true };
          // Mark before editing: never retry an ambiguous DOM side effect.
          output.seen.add(message.key); output.last = message.sequence;
          append(output.mode === 'selected' ? output.element : field(document.activeElement), message.text); return { inserted: true };
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
        case 'stop': capture?.stop(); capture = null; output = null; cancelPicker?.(); return true;
        default: throw Error('Unknown page operation.');
      }
    }
    port.onMessage.addListener(message => {
      if (disposed || !Number.isSafeInteger(message.request)) return;
      void command(message).then(result => post({ request: message.request, result }), error => post({ request: message.request, error: error.message }));
    });
  });
})();
