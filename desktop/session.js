// The main process authorizes focused TEXT delivery from Start through the Stop drain.
export class DesktopSession {
  constructor({ target, run, onChange, onDisplay, onFloatingDisplay }) {
    Object.assign(this, { target, run, onChange, onDisplay, onFloatingDisplay });
    this.state = { phase: 'idle', error: '', microphone: false };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async start(plan) {
    if (this.current) return;
    const session = { id: crypto.randomUUID(), plan, queue: Promise.resolve(), admitted: false, displays: new Map(), floatingText: '', status: new Map() };
    this.current = session;
    this.update({ phase: 'preparing', error: '', microphone: false, displays: plan.displays, actions: plan.actions, id: session.id });
    try {
      if (plan.focused) await this.target.request('authorize', session.id);
      if (this.current !== session || this.state.phase !== 'preparing') return;
      session.admitted = true;
      await this.run('start', session.id, plan.graph);
      if (this.current === session && this.state.phase === 'preparing') {
        this.update({ phase: 'running' });
      }
    } catch (error) { await this.cancel(error.message, session.id); }
  }

  toggle() {
    if (this.state.phase === 'preparing') return this.cancel();
    if (this.state.phase === 'running') return this.stop();
  }

  async stop() {
    const session = this.current;
    if (!session || this.state.phase !== 'running') return;
    session.floatingText = '';
    this.update({ phase: 'stopping' });
    try {
      await this.run('stop', session.id);
      await session.queue;
      if (this.current === session && this.state.phase === 'stopping') await this.finish(session, 'stopping');
    } catch (error) { await this.cancel(error.message, session.id); }
  }

  async cancel(error = '', id = this.current?.id) {
    const session = this.current;
    if (!session || session.id !== id || this.state.phase === 'canceling') return session?.canceling;
    const started = session.admitted;
    session.admitted = false;
    session.floatingText = '';
    // Restore the last committed snapshot before publishing cancellation.
    // Cleanup and ordinary deliveries from the canceled runtime stay closed.
    for (const { node, port, committed, provisional } of session.displays.values()) {
      if (provisional) this.onDisplay({ node, port, item: committed });
    }
    this.update({ phase: 'canceling', error });
    return session.canceling = (async () => {
      // Release authorization before waiting for renderer cleanup. A response
      // from an already dispatched OS mutation is never retried.
      const results = await Promise.allSettled([
        this.release(session),
        session.plan.focused ? session.queue : undefined,
        started ? this.run('cancel', session.id) : undefined,
      ]);
      await this.finish(session, 'canceling', error || results.find(result => result.status === 'rejected')?.reason?.message || '');
    })();
  }

  release(session) {
    return session.release ??= session.plan.focused ? this.target.request('release', session.id) : Promise.resolve();
  }

  async finish(session, phase, error = '') {
    session.admitted = false;
    await this.release(session).catch(failure => { error ||= failure.message; });
    if (this.current !== session || this.state.phase !== phase) return;
    this.current = null;
    this.update({ phase: 'idle', error, microphone: false, actions: [], id: null });
  }

  insert(id, text) {
    const session = this.current;
    const allowed = () => session && this.current === session && session.admitted && session.id === id && session.plan.focused;
    if (!allowed()) return Promise.reject(Error('The voice typing session is no longer authorized.'));
    if (typeof text !== 'string' || text.length > 32768 || text.includes('\0') || !text.isWellFormed()) {
      return Promise.reject(Error('Focused output requires well-formed TEXT of up to 32,768 characters.'));
    }
    const pending = session.queue.then(() => {
      if (!allowed()) throw Error('The voice typing session is no longer authorized.');
      if (text) return this.target.request('insert', id, text);
    });
    session.queue = pending.catch(error => { void this.cancel(error.message, id); });
    return pending;
  }

  captureState(id, microphone, error) {
    const session = this.current;
    if (!session || session.id !== id || !session.plan.microphone) return;
    const patch = { microphone, ...(session.admitted && error && { error }) };
    if (microphone !== this.state.microphone || patch.error) this.update(patch);
  }

  display(id, node, port, item, provisional) {
    const session = this.current;
    if (session?.id === id && session.admitted && session.plan.displays.some(display => display.id === node)) {
      const key = JSON.stringify([node, port]);
      const committed = provisional ? session.displays.get(key)?.committed ?? [] : item;
      session.displays.set(key, { node, port, committed, provisional });
      this.onDisplay({ node, port, item });
    }
  }

  floatingDisplay(id, text) {
    const session = this.current;
    if (!session?.admitted || session.id !== id || this.state.phase === 'stopping'
        || typeof text !== 'string' || text === session.floatingText) return;
    session.floatingText = text;
    this.onFloatingDisplay(text);
  }
}
