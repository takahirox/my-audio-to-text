// Runs in the extension's offscreen DOM. Only PCM/capture resources are shared.
export class TabCaptureCoordinator {
  constructor(createSource, send, { maxInFlight = 8 } = {}) {
    this.createSource = createSource; this.send = send; this.maxInFlight = maxInFlight;
    this.tabs = new Map(); this.subscribers = new Map();
  }
  async subscribe(id, tabId) {
    if (this.subscribers.has(id)) return;
    const subscriber = { id, tabId, sequence: 0, acknowledged: 0 };
    this.subscribers.set(id, subscriber);
    try {
      let entry = this.tabs.get(tabId);
      // Never overlap a pending media grant or teardown of an older generation.
      while (entry?.closing) {
        await entry.closing;
        if (this.subscribers.get(id) !== subscriber) return;
        entry = this.tabs.get(tabId);
      }
      if (!entry) {
        entry = { tabId, listeners: new Set() };
        this.tabs.set(tabId, entry);
        entry.source = this.createSource(tabId, (audio, timing) => this.audio(entry, audio, timing),
          () => this.fail(entry, 'Tab audio ended. Invoke the toolbar on the source tab and Start again.'));
        entry.starting = Promise.resolve().then(() => entry.source.start());
        void entry.starting.catch(error => this.fail(entry, `Tab capture failed: ${error.message}. Invoke the toolbar on the source tab and Start again.`));
      }
      subscriber.entry = entry; subscriber.since = entry.source.context?.currentTime;
      entry.listeners.add(subscriber);
      // Membership precedes startup. Accept PCM before ready to preserve the
      // first worklet block; late joiners receive no earlier blocks.
      await entry.starting;
      if (this.subscribers.get(id) === subscriber && !subscriber.stopping) this.send(id, { type: 'ready' });
    } catch (error) {
      if (this.subscribers.get(id) === subscriber) this.finish(subscriber, error.message);
    }
  }
  audio(entry, audio, timing) {
    for (const subscriber of [...entry.listeners]) {
      if (subscriber.discard) continue;
      // Discard/trim pre-subscription samples even when an earlier worklet
      // block is still in transit or partly buffered at the instant of joining.
      const offset = Number.isFinite(subscriber.since) && Number.isFinite(timing?.capturedAt)
        ? Math.max(0, Math.ceil((subscriber.since - timing.capturedAt) * 16000 - 1e-7)) : 0;
      if (offset >= audio.length) continue;
      if (subscriber.sequence - subscriber.acknowledged >= this.maxInFlight) {
        // Fail only this consumer. Never drop speech silently or queue forever.
        this.finish(subscriber, 'Tab audio consumer is too slow. Stop this graph and Start again.');
        continue;
      }
      this.send(subscriber.id, { type: 'pcm', sequence: subscriber.sequence++, pcm: Array.from(audio.subarray(offset)) });
    }
  }
  acknowledge(id, sequence) {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    if (sequence !== subscriber.acknowledged || sequence >= subscriber.sequence) {
      this.finish(subscriber, 'Invalid tab audio acknowledgment. Start again.'); return;
    }
    subscriber.acknowledged++;
  }
  finish(subscriber, error = '') {
    if (this.subscribers.get(subscriber.id) !== subscriber) return;
    this.subscribers.delete(subscriber.id);
    subscriber.entry?.listeners.delete(subscriber);
    this.send(subscriber.id, { type: 'ended', error });
    const entry = subscriber.entry;
    if (entry && !entry.listeners.size && !entry.closing) void this.close(entry, false).catch(() => {});
  }
  close(entry, flush) {
    return entry.closing ??= Promise.resolve().then(async () => {
      try {
        await entry.source.stop(flush);
        // BrowserAudioSource releases media granted after cancellation, too.
        await entry.starting.catch(() => {});
      } finally {
        if (this.tabs.get(entry.tabId) === entry) this.tabs.delete(entry.tabId);
      }
    });
  }
  async unsubscribe(id, flush = true) {
    const subscriber = this.subscribers.get(id);
    if (!subscriber) return;
    subscriber.stopping = true; subscriber.discard ||= !flush;
    const entry = subscriber.entry;
    if (!entry) { this.finish(subscriber); return; }
    if (entry.listeners.size === 1) {
      try {
        if (!flush && entry.closing) await entry.source.stop(false);
        await this.close(entry, flush);
      } catch (error) { this.finish(subscriber, `Tab capture teardown failed: ${error.message}`); return; }
    }
    this.finish(subscriber);
  }
  fail(entry, error) {
    for (const subscriber of [...entry.listeners]) this.finish(subscriber, error);
    void this.close(entry, false).catch(() => {});
  }
  endTab(tabId, error) { const entry = this.tabs.get(tabId); if (entry) this.fail(entry, error); }
  dispose() {
    for (const entry of this.tabs.values()) this.fail(entry, 'Tab capture host disconnected. Invoke the toolbar and Start again.');
  }
}
