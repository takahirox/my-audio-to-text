// The main process owns target authorization from Start through the final drain.
export class DesktopSession {
  constructor({ target, run, onChange, onDisplay }) {
    Object.assign(this, { target, run, onChange, onDisplay });
    this.state = { phase: 'idle', error: '', microphone: false };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async start(plan) {
    if (this.current) return;
    const session = { id: crypto.randomUUID(), plan, queue: Promise.resolve(), admitted: false };
    this.current = session;
    this.update({ phase: 'preparing', error: '', microphone: false, displays: plan.displays });
    try {
      if (plan.focused) await this.target.request('bind', session.id);
      if (this.current !== session || this.state.phase !== 'preparing') return;
      session.admitted = true;
      await this.run('start', session.id, plan.graph);
      if (this.current === session && this.state.phase === 'preparing') {
        this.update({ phase: 'running', microphone: plan.microphone });
      }
    } catch (error) { await this.cancel(error.message, session.id); }
  }

  toggle(start) {
    if (!this.current) return start();
    if (this.state.phase === 'preparing') return this.cancel();
    if (this.state.phase === 'running') return this.stop();
  }

  async stop() {
    const session = this.current;
    if (!session || this.state.phase !== 'running') return;
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
    session.admitted = false;
    this.update({ phase: 'canceling', microphone: false, error });
    return session.canceling = (async () => {
      // Release authorization before waiting for renderer cleanup. A response
      // from an already dispatched OS mutation is never retried.
      const results = await Promise.allSettled([
        this.release(session),
        session.plan.focused ? session.queue : undefined,
        this.run('cancel', session.id),
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
    this.update({ phase: 'idle', error, microphone: false });
  }

  insert(id, text) {
    const session = this.current;
    const allowed = () => session && this.current === session && session.admitted && session.id === id && session.plan.focused;
    if (!allowed()) return Promise.reject(Error('The voice typing target is no longer authorized.'));
    if (typeof text !== 'string' || text.length > 32768 || text.includes('\0') || !text.isWellFormed()) {
      return Promise.reject(Error('Focused output requires well-formed TEXT of up to 32,768 characters.'));
    }
    const pending = session.queue.then(() => {
      if (!allowed()) throw Error('The voice typing target is no longer authorized.');
      if (text) return this.target.request('insert', id, text);
    });
    session.queue = pending.catch(error => { void this.cancel(error.message, id); });
    return pending;
  }

  captureEnded(id) {
    if (this.current?.id !== id) return;
    this.update({ microphone: false });
  }

  display(id, node, port, item) {
    const session = this.current;
    if (session?.id === id && session.admitted && session.plan.displays.some(display => display.id === node)) {
      this.onDisplay({ node, port, item });
    }
  }
}
