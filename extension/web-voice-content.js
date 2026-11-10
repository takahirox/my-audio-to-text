// ISOLATED world, top HTTP(S) document only. No inference, page-world bridge,
// field discovery, persistent transcripts, or automatic capture.
(() => {
  if (globalThis.localWebVoice) { globalThis.localWebVoice(); return; }
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  // Google Material Symbols Outlined, 20dp, wght 400 / FILL 0 / GRAD 0.
  // Inlined local SVG paths; source revision and Apache-2.0: icons/material-symbols/.
  const iconPaths = {
    mic: 'M480-384q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm0-240Zm-36 480v-99q-98.8-13.1-163.4-87.05Q216-404 216-504h72q0 79.68 56.23 135.84 56.22 56.16 136 56.16Q560-312 616-368.16q56-56.16 56-135.84h72q0 100-64.6 173.95Q614.8-256.1 516-243v99h-72Zm36-312q20.4 0 34.2-13.8Q528-483.6 528-504v-240q0-20.4-13.8-34.2Q500.4-792 480-792q-20.4 0-34.2 13.8Q432-764.4 432-744v240q0 20.4 13.8 34.2Q459.6-456 480-456Z',
    stop: 'M336-624v288-288Zm-72 360v-432h432v432H264Zm72-72h288v-288H336v288Z',
    error: 'M479.79-288q15.21 0 25.71-10.29t10.5-25.5q0-15.21-10.29-25.71t-25.5-10.5q-15.21 0-25.71 10.29t-10.5 25.5q0 15.21 10.29 25.71t25.5 10.5ZM444-432h72v-240h-72v240Zm36.28 336Q401-96 331-126t-122.5-82.5Q156-261 126-330.96t-30-149.5Q96-560 126-629.5q30-69.5 82.5-122T330.96-834q69.96-30 149.5-30t149.04 30q69.5 30 122 82.5T834-629.28q30 69.73 30 149Q864-401 834-331t-82.5 122.5Q699-156 629.28-126q-69.73 30-149 30Zm-.28-72q130 0 221-91t91-221q0-130-91-221t-221-91q-130 0-221 91t-91 221q0 130 91 221t221 91Zm0-312Z',
    progress_activity: 'M480-96q-78.72 0-148.8-30.24-70.08-30.24-122.4-82.56-52.32-52.32-82.56-122.4Q96-401.28 96-480q0-79.68 30.22-149.28 30.21-69.6 82.49-121.92 52.28-52.32 122.3-82.56Q401.04-864 479.69-864 496-864 506-854t10 25.51q0 15.51-10 26T480-792q-129.67 0-220.84 90.5Q168-611 168-480.5T259.16-259q91.17 91 220.84 91 131 0 221.5-91.16Q792-350.33 792-480q0-16 10.49-26t26-10Q844-516 854-506q10 10 10 26.31 0 78.65-30.24 148.68-30.24 70.02-82.56 122.3-52.32 52.28-121.92 82.49Q559.68-96 480-96Z',
  };
  const controlSize = 36, gap = 6, viewportInset = 4;
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
  let listeners, menu, menuCaret, choices = [], defaultId = null, selectionPending = false;
  function send(message) { try { control?.postMessage(message); } catch { disable(); } }
  function stateUI(next, error = '') {
    state = next;
    if (session) closeMenu();
    host?.setAttribute('data-voice-state', next);
    if (!button) return;
    const labels = { idle: 'Start voice typing', preparing: 'Preparing… Click to cancel', recording: 'Recording · Stop voice typing', stopping: 'Stopping…', error: 'Voice typing error · Retry' };
    const icon = { idle: 'mic', preparing: 'progress_activity', recording: 'stop', stopping: 'progress_activity', error: 'error' }[next];
    // Build SVG in the isolated world; no HTML parsing, font or resource requests.
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 -960 960 960');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.dataset.icon = icon;
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', iconPaths[icon]); svg.append(path); button.replaceChildren(svg);
    button.setAttribute('aria-label', labels[next]); button.setAttribute('aria-description', 'Right-click or press Shift+F10 to choose the default voice graph.'); button.title = error || labels[next]; host.title = error || labels[next]; button.disabled = next === 'stopping' || selectionPending;
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
    const rect = target.getBoundingClientRect(), viewport = window.visualViewport;
    const bounds = { left: (viewport?.offsetLeft || 0) + viewportInset, top: (viewport?.offsetTop || 0) + viewportInset,
      right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - viewportInset,
      bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - viewportInset };
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const box = (x, y, width = controlSize, height = controlSize) => ({ left: x, top: y, right: x + width, bottom: y + height });
    // Test the painted page at a small grid of points. Ignore only the overlay
    // and the field's containers; adjacent inputs, labels and buttons count as
    // obstacles. Prefer exterior positions to protect content and native controls.
    const obstruction = candidate => {
      let hits = 0;
      for (const x of [candidate.left + 1, (candidate.left + candidate.right) / 2, candidate.right - 1]) {
        for (const y of [candidate.top + 1, (candidate.top + candidate.bottom) / 2, candidate.bottom - 1]) {
          if (document.elementsFromPoint(x, y).some(element => element !== host && !element.contains(target))) hits++;
        }
      }
      return hits;
    };
    const x = clamp(rect.right - controlSize, bounds.left, bounds.right - controlSize);
    const y = clamp((rect.top + rect.bottom - controlSize) / 2, bounds.top, bounds.bottom - controlSize);
    // Try a tight attachment first. If a crowded row has no free adjacent
    // space, expand a few button widths rather than covering another control.
    const candidates = [gap, gap + controlSize + gap, gap + 2 * (controlSize + gap)].flatMap(distance => [
      box(rect.right + distance, y), box(rect.left - distance - controlSize, y),
      box(x, rect.top - distance - controlSize), box(x, rect.bottom + distance),
      box(clamp(rect.left, bounds.left, bounds.right - controlSize), rect.top - distance - controlSize),
      box(clamp(rect.left, bounds.left, bounds.right - controlSize), rect.bottom + distance),
    ]).map(candidate => box(clamp(candidate.left, bounds.left, bounds.right - controlSize), clamp(candidate.top, bounds.top, bounds.bottom - controlSize)));
    // Retain a visible stop control if a dense page or an offscreen recording
    // target leaves no unobstructed placement. Score each candidate only once.
    const score = candidate => (overlaps(candidate, rect) ? 100 : 0) + obstruction(candidate);
    const choose = (options, evaluate) => {
      let best = options[0], minimum = Infinity;
      for (const candidate of options) {
        const cost = evaluate(candidate);
        if (cost < minimum) { best = candidate; minimum = cost; }
        if (cost === 0) break;
      }
      return best;
    };
    const anchor = choose(candidates, score);
    host.style.setProperty('left', `${anchor.left}px`, 'important'); host.style.setProperty('top', `${anchor.top}px`, 'important');
    const scheme = getComputedStyle(target).colorScheme;
    host.dataset.theme = scheme === 'dark' || (scheme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    host.style.setProperty('visibility', !session && (rect.bottom < bounds.top || rect.top > bounds.bottom || rect.right < bounds.left || rect.left > bounds.right) ? 'hidden' : 'visible', 'important');
    // Status is a separate, non-interactive bubble. Clamp it independently so
    // long errors cannot escape the viewport or enlarge the circular hit target.
    status.style.maxWidth = `${Math.max(1, Math.min(260, bounds.right - bounds.left))}px`;
    if (status.textContent) {
      const { width, height } = status.getBoundingClientRect();
      const statusX = clamp(anchor.right - width, bounds.left, bounds.right - width);
      const options = [box(statusX, anchor.bottom + gap, width, height), box(statusX, anchor.top - gap - height, width, height),
        box(anchor.right + gap, anchor.top, width, height), box(anchor.left - gap - width, anchor.top, width, height)]
        .map(candidate => box(clamp(candidate.left, bounds.left, bounds.right - width), clamp(candidate.top, bounds.top, bounds.bottom - height), width, height));
      const statusScore = candidate => score(candidate) + (overlaps(candidate, anchor) ? 100 : 0);
      const label = choose(options, statusScore);
      status.style.left = `${label.left - anchor.left}px`; status.style.top = `${label.top - anchor.top}px`;
    }
  }
  function removeWidget() { closeMenu(); host?.remove(); host = button = status = null; if (!session) target = null; }
  function saveCaret(owner) {
    if (native(owner.element)) { owner.start = owner.element.selectionStart; owner.end = owner.element.selectionEnd; owner.direction = owner.element.selectionDirection; }
    else {
      const selection = getSelection();
      if (!selection?.rangeCount || !owner.element.contains(selection.anchorNode) || !owner.element.contains(selection.focusNode)) throw Error('Select a caret in this basic editable field first.');
      owner.range = selection.getRangeAt(0).cloneRange();
    }
    owner.expected = value(owner.element);
  }
  function closeMenu(restore = false) {
    if (!menu) return;
    menu.remove(); menu = null; button?.setAttribute('aria-expanded', 'false'); button?.removeAttribute('aria-controls');
    if (restore && menuCaret && editable(menuCaret.element)) {
      const owner = menuCaret;
      owner.element.focus({ preventScroll: true });
      if (value(owner.element) === owner.expected) {
        if (native(owner.element)) owner.element.setSelectionRange(owner.start, owner.end, owner.direction);
        else { const selection = getSelection(); selection.removeAllRanges(); selection.addRange(owner.range); }
      }
    }
    menuCaret = null;
  }
  function openMenu(event) {
    if (!event.isTrusted || !enabled) return;
    event.preventDefault(); event.stopPropagation();
    if (selectionPending || session || ['preparing', 'recording', 'stopping'].includes(state) || !choices.length) return;
    if (menu) { closeMenu(true); return; }
    try { menuCaret = { element: target }; saveCaret(menuCaret); }
    catch (error) { stateUI('error', error.message); return; }
    stateUI('idle'); // The open menu replaces the choose-a-graph prompt.
    menu = document.createElement('div'); menu.className = 'graph-menu'; menu.id = 'voice-graph-menu'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Default voice graph');
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-controls', menu.id);
    for (const choice of choices) {
      const item = document.createElement('button'); item.type = 'button'; item.textContent = choice.name;
      item.setAttribute('role', 'menuitemradio'); item.setAttribute('aria-checked', String(choice.id === defaultId));
      item.tabIndex = -1;
      item.addEventListener('pointerdown', event => { if (event.isTrusted) event.preventDefault(); });
      item.addEventListener('click', event => {
        if (!event.isTrusted || session) return;
        selectionPending = true;
        send({ type: 'select-graph', id: choice.id }); closeMenu(true);
        stateUI('idle', 'Saving default graph…');
      });
      menu.append(item);
    }
    menu.addEventListener('keydown', event => {
      if (!event.isTrusted) return;
      const items = [...menu.children], index = items.indexOf(menu.getRootNode().activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); }
      else if (event.key === 'Tab') { closeMenu(); button.focus(); }
    });
    button.getRootNode().append(menu);
    const rect = host.getBoundingClientRect();
    menu.style.minWidth = `${Math.max(1, Math.min(180, innerWidth - 8))}px`;
    menu.style.maxWidth = `${Math.max(1, innerWidth - 8)}px`;
    menu.style.maxHeight = `${Math.max(1, innerHeight - 8)}px`;
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - size.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(rect.bottom + 6, innerHeight - size.height - 4))}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.firstChild).focus({ preventScroll: true });
  }
  function abort(error) {
    if (session?.cancelRequested) return;
    if (session) {
      session.cancelRequested = true;
      send({ type: 'cancel', error });
      try { session.connection?.disconnect(); } catch { /* Context may have been revoked. */ }
    }
    // Keep ownership until the runtime acknowledges track/Worker cleanup.
    stateUI('error', error);
  }
  function widget(element) {
    target = element;
    if (!host) {
      host = document.createElement('div'); host.setAttribute('data-local-web-voice', '');
      host.style.cssText = `all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;direction:ltr!important;width:${controlSize}px!important;height:${controlSize}px!important;`;
      const shadow = host.attachShadow({ mode: 'closed' }), style = document.createElement('style');
      style.textContent = `
        :host([hidden]){display:none!important}
        button,span{box-sizing:border-box;color-scheme:light;font-family:system-ui,sans-serif;
          background:#fff;color:#253041;box-shadow:0 2px 6px #0003}
        button{appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;
          width:${controlSize}px;height:${controlSize}px;border:1px solid #98a2b3;border-radius:50%;padding:0;margin:0;
          font-size:14px;line-height:1;cursor:pointer;vertical-align:top;touch-action:manipulation}
        svg{display:block;flex:none;width:20px;height:20px;fill:currentColor;pointer-events:none}
        button:hover:not(:disabled){background:#edf1f7;border-color:#475467}
        button:focus-visible{outline:3px solid #4263eb;outline-offset:2px}
        button[data-state="recording"]{background:#fee4e2;color:#b42318;border-color:#b42318}
        button[data-state="recording"]:hover{background:#fecdca}
        button[data-state="error"]{color:#b42318;border-color:#b42318}
        button:disabled{cursor:wait;opacity:.65}
        button[data-state="preparing"] svg,button[data-state="stopping"] svg{animation:voice-spin 1s linear infinite}
        @keyframes voice-spin{to{transform:rotate(360deg)}}
        @media(prefers-reduced-motion:reduce){button svg{animation:none!important}}
        span{position:absolute;width:max-content;max-width:260px;padding:3px 6px;border:1px solid #98a2b3;
          border-radius:4px;font-size:12px;line-height:1.4;overflow-wrap:anywhere;pointer-events:none}
        span:empty{display:none}
        :host([data-theme="dark"]) button,:host([data-theme="dark"]) span{color-scheme:dark;background:#202833;color:#f2f4f7;border-color:#98a2b3}
        :host([data-theme="dark"]) button:hover:not(:disabled){background:#344054}
        :host([data-theme="dark"]) button[data-state="recording"]{background:#601b16;color:#ffdad6;border-color:#fda29b}
        :host([data-theme="dark"]) button[data-state="recording"]:hover{background:#7a271a}
        :host([data-theme="dark"]) button[data-state="error"]{color:#fda29b;border-color:#fda29b}
        @media(forced-colors:active){
          button,span,:host([data-theme]) button,:host([data-theme]) span{background:Canvas;color:CanvasText;border-color:ButtonText;box-shadow:none}
          button[data-state="recording"],:host([data-theme]) button[data-state="recording"]{background:Highlight;color:HighlightText;border-color:Highlight}
          button:focus-visible{outline-color:Highlight}
        }
      `;
      style.textContent += `
        .graph-menu{position:fixed;box-sizing:border-box;min-width:180px;width:max-content;max-width:300px;
          padding:4px;border:1px solid #98a2b3;border-radius:6px;background:#fff;box-shadow:0 3px 12px #0004;
          overflow:auto;color-scheme:light;font-family:system-ui,sans-serif}
        .graph-menu button{display:flex;justify-content:flex-start;width:100%;height:auto;min-height:32px;
          padding:7px 10px;border:0;border-radius:3px;box-shadow:none;font-size:13px;line-height:1.4;text-align:left;overflow-wrap:anywhere}
        .graph-menu button::before{content:'✓';visibility:hidden;flex:none;width:18px}
        .graph-menu button[aria-checked="true"]::before{visibility:visible}
        .graph-menu button:focus{outline:2px solid #4263eb;outline-offset:-2px;background:#edf1f7}
        :host([data-theme="dark"]) .graph-menu{background:#202833;color-scheme:dark}
        :host([data-theme="dark"]) .graph-menu button:focus{background:#344054}
        @media(forced-colors:active){.graph-menu{background:Canvas;border-color:ButtonText}}
      `;
      button = document.createElement('button'); button.type = 'button';
      button.setAttribute('aria-keyshortcuts', 'Shift+F10 Alt+ArrowDown'); button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
      button.addEventListener('contextmenu', openMenu);
      button.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey || event.key === 'ArrowDown' && event.altKey) openMenu(event);
      });
      status = document.createElement('span'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      // Pointer activation leaves the page selection intact. Keyboard activation
      // uses the same saved field and never redirects to the widget or new focus.
      button.addEventListener('pointerdown', event => { if (event.isTrusted) event.preventDefault(); });
      button.addEventListener('click', event => {
        if (!event.isTrusted || !enabled || selectionPending) return;
        closeMenu(true);
        if (session) {
          if (session.cancelRequested || state === 'error') return;
          if (state === 'preparing') { session.cancelRequested = true; stateUI('stopping'); send({ type: 'cancel', error: 'Preparation canceled. Click the mic to retry.' }); }
          else { stateUI('stopping'); send({ type: 'stop' }); }
          return;
        }
        if (!defaultId) { stateUI('error', 'Right-click the mic (or press Shift+F10) to choose a voice graph first.'); return; }
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
    if (!choices.length) { removeWidget(); return; }
    const element = field(document.activeElement);
    if (element === host) return;
    if (editable(element)) widget(element); else removeWidget();
  }
  function disable() {
    enabled = false; disposed = true; choices = []; defaultId = null; selectionPending = false;
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
    const connection = control = chrome.runtime.connect({ name: 'web-voice-control' });
    connection.onDisconnect.addListener(() => { if (control === connection) disable(); });
    connection.onMessage.addListener(message => {
      if (control !== connection) return;
      if (message.type === 'disabled') { disable(); return; }
      if (message.type === 'enabled') {
        enabled = true; focus();
        observer = new MutationObserver(() => position());
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden', 'type', 'contenteditable', 'autocomplete', 'name', 'aria-disabled', 'aria-readonly'] });
        // Layout, zoom and transforms can change without DOM mutation.
        let ticks = 0;
        timer = setInterval(() => { position(); if (++ticks % 20 === 0) send({ type: 'heartbeat' }); }, 1000);
      }
      if (message.type === 'graphs') {
        const changed = JSON.stringify(choices) !== JSON.stringify(message.graphs) || defaultId !== message.defaultId;
        choices = message.graphs; defaultId = message.defaultId;
        if (changed) { closeMenu(true); if (!session) focus(); }
      }
      if (message.type === 'selection-saved' || message.type === 'selection-error') {
        selectionPending = false;
        if (!session) stateUI(message.error ? 'error' : 'idle', message.error || '');
      }
      if (message.type === 'state' && session) stateUI(message.state, message.error);
      if (message.type === 'ended') {
        if (!session) return;
        session?.connection?.disconnect(); session = null;
        // Only active sessions stay bound to the original field. Reconcile
        // focus before offering another start, including hiding idle controls
        // when focus moved away from supported editors.
        if (!choices.length) removeWidget();
        else if (!message.error) focus();
        stateUI(message.error ? 'error' : 'idle', message.error || '');
        // Preserve actionable errors until next focus or explicit retry.
      }
    });
  }
  globalThis.localWebVoice = connect;
  function listen() {
    listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    document.addEventListener('pointerdown', event => { if (menu && event.target !== host) closeMenu(); }, options);
    document.addEventListener('focusin', focus, options);
    document.addEventListener('focusout', () => queueMicrotask(focus), options);
    for (const event of ['scroll', 'resize']) window.addEventListener(event, () => { closeMenu(); position(); }, options);
    window.addEventListener('blur', event => { if (event.target === window) closeMenu(); }, options);
    visualViewport?.addEventListener('resize', () => { closeMenu(); position(); }, options);
    visualViewport?.addEventListener('scroll', () => { closeMenu(); position(); }, options);
    document.addEventListener('selectionchange', () => {
      if (!inserting && session && document.activeElement === session.element) try { saveCaret(session); } catch { /* A later insertion validates the saved range. */ }
    }, options);
    document.addEventListener('input', event => {
      if (!inserting && event.isTrusted && session?.element === event.target) saveCaret(session);
    }, options);
  }
  window.addEventListener('pagehide', () => { send({ type: 'cancel' }); disable(); listeners.abort(); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    // Cached documents retain this script, but never retain a recording. A new
    // control connection rechecks current consent and website permission.
    listen(); connect();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes['web-voice-typing-v1'] && !(changes['web-voice-typing-v1'].newValue?.version === 1 && changes['web-voice-typing-v1'].newValue.enabled === true)) disable();
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== 'web-voice-output') return;
    if (port.sender?.id !== chrome.runtime.id || port.sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL('extension/background.js')) { port.disconnect(); return; }
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
        if (!enabled || session !== owner || owner.cancelRequested || message.capability !== owner.capability || !editable(owner.element)) throw Error('Stale, unauthorized or removed voice target.');
        if (message.action === 'output') { reply(true); return; }
        if (message.action !== 'append' || !Number.isSafeInteger(message.sequence) || message.sequence < 0 || typeof message.text !== 'string' || message.text.length > 100000) throw Error('Invalid voice output message.');
        if (message.sequence <= owner.last) { reply({ duplicate: true }); return; }
        owner.last = message.sequence; // Never retry even an ambiguous edit.
        if (value(owner.element) !== owner.expected) throw Error('Field changed outside normal editing. Stop and select the insertion point again.');
        const element = owner.element, text = message.text;
        inserting = true;
        try {
          if (!element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }))) throw Error('The editor rejected insertion. Use another field.');
          if (!enabled || session !== owner || owner.cancelRequested || !editable(element) || value(element) !== owner.expected) throw Error('Field changed during insertion.');
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
  listen(); connect();
})();
