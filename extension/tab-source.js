// A Live window owns a subscription, never a native tab capture or playback.
export class ExtensionTab {
  constructor(tabId, onAudio, onEnded, { connect = () => chrome.runtime.connect({ name: 'live-tab-audio' }),
    url = globalThis.location?.href } = {}) {
    this.tabId = tabId; this.onAudio = onAudio; this.onEnded = onEnded;
    this.connect = connect; this.url = url;
  }
  start() {
    if (this.canceled) return Promise.reject(new DOMException('Capture canceled', 'AbortError'));
    return this.starting ??= new Promise((resolve, reject) => {
      this.rejectStart = reject;
      const params = new URL(this.url).searchParams;
      const port = this.port = this.connect();
      this.timer = setTimeout(() => this.failure('Tab capture did not respond. Invoke the toolbar on the source tab and Start again.'), 20000);
      port.onMessage.addListener(message => {
        if (this.finished) return;
        if (message.type === 'acquire') {
          // COOP/COEP puts Live/offscreen in the same isolated renderer, while
          // the service worker can be in another process. Mint the one-use ID
          // here; the offscreen DOM remains the sole native capture owner.
          void Promise.resolve().then(() => {
            if (this.canceled) throw new DOMException('Capture canceled', 'AbortError');
            if (!globalThis.chrome?.tabCapture?.getMediaStreamId) throw Error('Tab capture is unavailable. Use desktop Chrome 116 or later.');
            return chrome.tabCapture.getMediaStreamId({ targetTabId: this.tabId });
          }).then(
            streamId => { if (!this.finished) this.send({ type: 'stream-id', request: message.request, streamId }); },
            error => { if (!this.finished) this.send({ type: 'stream-id', request: message.request, error: error.message }); });
          return;
        }
        if (message.type === 'ready') { clearTimeout(this.timer); resolve(); }
        if (message.type === 'pcm' && !this.discard) {
          if (message.sequence !== (this.sequence || 0) || !Array.isArray(message.pcm) || message.pcm.length > 2048) {
            this.failure('Invalid tab audio stream. Start again.'); return;
          }
          this.sequence = message.sequence + 1;
          try {
            this.onAudio(Float32Array.from(message.pcm));
            this.send({ type: 'ack', sequence: message.sequence });
          } catch (error) { this.failure(error.message); }
        }
        if (message.type === 'ended') {
          if (message.error) this.failure(message.error);
          else this.finish();
        }
      });
      port.onDisconnect.addListener(() => {
        void globalThis.chrome?.runtime?.lastError;
        if (!this.finished) this.failure('Tab capture connection lost. Invoke the toolbar on the source tab and Start again.');
      });
      this.send({ type: 'subscribe', tabId: this.tabId, session: params.get('session') });
    });
  }
  send(message) {
    try { this.port.postMessage(message); }
    catch { this.failure('Tab capture connection lost. Invoke the toolbar and Start again.'); }
  }
  failure(message) {
    if (this.finished) return;
    this.error = Error(message); this.rejectStart?.(this.error);
    try { if (!this.canceled) this.onEnded?.(this.error); }
    finally { this.finish(); }
  }
  finish() {
    if (this.finished) return;
    this.finished = true; clearTimeout(this.timer);
    this.rejectStart?.(this.error || new DOMException('Capture canceled', 'AbortError'));
    this.resolveStop?.(); this.port?.disconnect();
  }
  stop(flush = true) {
    this.canceled = true; this.discard ||= !flush;
    if (this.finished || !this.port) { this.finish(); return Promise.resolve(); }
    if (!this.stopping) {
      this.stopping = new Promise(resolve => { this.resolveStop = resolve; });
      this.rejectStart?.(new DOMException('Capture canceled', 'AbortError'));
      clearTimeout(this.timer); this.timer = setTimeout(() => this.finish(), 5000);
      this.send({ type: 'unsubscribe', flush });
    } else if (!flush) this.send({ type: 'unsubscribe', flush: false });
    return this.stopping;
  }
}
