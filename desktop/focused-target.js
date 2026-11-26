import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const timeoutError = 'The accessibility service did not respond. Voice typing stopped.';

export class FocusedTarget {
  constructor(command, args, { onFailure, onShortcut, onLost }) {
    Object.assign(this, { command, args, onFailure, onShortcut, onLost });
    this.pending = new Map();
    this.sequence = 0;
  }

  connect() {
    if (this.worker) return this.worker;
    const process = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    const worker = { process };
    this.worker = worker;
    const lines = createInterface({ input: process.stdout });
    lines.on('line', line => {
      if (this.worker !== worker) return;
      const message = JSON.parse(line);
      if (message.failed) this.onFailure(message.failed, message.error);
      if (message.shortcut) this.onShortcut(message.shortcut, message.context);
      const complete = this.pending.get(message.request);
      complete?.(message);
    });
    const lost = () => this.disconnect(worker, 'The desktop accessibility service stopped. Try starting voice typing again.');
    process.on('error', lost);
    process.on('exit', lost);
    process.stdin.on('error', lost);
    return worker;
  }

  request(action, token, text) {
    if (action === 'release' && (!this.worker || this.closing)) return Promise.resolve();
    if (this.closing) return Promise.reject(Error('Accessibility session closed.'));
    if (this.draining) return Promise.reject(Error(timeoutError));
    const worker = this.connect();
    const request = ++this.sequence;
    if (action === 'authorize') worker.token = token;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(worker, timeoutError, process.platform === 'darwin'), 7000);
      this.pending.set(request, ({ error, waiting }) => {
        if (waiting) {
          timer.refresh();
          return;
        }
        clearTimeout(timer);
        this.pending.delete(request);
        if (action === 'release' && worker.token === token) worker.token = null;
        if (error) reject(Error(error));
        else resolve();
      });
      worker.process.stdin.write(JSON.stringify({ request, action, token, text }) + '\n');
    });
  }

  disconnect(worker, error, graceful = false) {
    if (this.worker !== worker) return;
    this.worker = null;
    if (graceful) this.drain(worker);
    else if (!this.closing) worker.process.kill();
    for (const complete of this.pending.values()) complete({ error });
    if (worker.token) this.onFailure(worker.token, error);
    this.onLost(error);
  }

  close() {
    if (this.worker) this.disconnect(this.worker, 'Accessibility session closed.');
  }

  async closeGracefully() {
    this.closing = true;
    await (this.worker ? this.drain(this.worker) : this.draining);
  }

  drain(worker) {
    if (!this.draining) {
      // EOF revokes dispatch on the native reader thread. Wait for cleanup
      // before allowing a replacement helper to start a clipboard transaction.
      const child = worker.process;
      this.draining = new Promise(resolve => child.once('close', resolve))
        .finally(() => { this.draining = null; });
      child.stdin.end();
    }
    return this.draining;
  }
}
