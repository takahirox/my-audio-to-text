import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class X11Target {
  constructor(helper, onInvalid) {
    this.helper = helper;
    this.onInvalid = onInvalid;
    this.pending = new Map();
    this.sequence = 0;
  }

  connect() {
    if (this.worker) return this.worker;
    const process = spawn('/usr/bin/python3', ['-u', this.helper], { stdio: ['pipe', 'pipe', 'ignore'] });
    const worker = { process };
    this.worker = worker;
    const lines = createInterface({ input: process.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.invalid) this.onInvalid(message.invalid, message.error);
      const complete = this.pending.get(message.request);
      complete?.(message.error);
    });
    const lost = () => this.disconnect(worker, 'X11 accessibility is unavailable. Check AT-SPI and reopen the text field.');
    process.on('error', lost);
    process.on('exit', lost);
    process.stdin.on('error', lost);
    return worker;
  }

  request(action, token, text) {
    if (action === 'release' && !this.worker) return Promise.resolve();
    const worker = this.connect();
    const request = ++this.sequence;
    if (action === 'bind-shortcut' || action === 'bind-tray') worker.token = token;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.disconnect(worker, 'The accessibility service did not respond. Voice typing stopped.'), 7000);
      this.pending.set(request, error => {
        clearTimeout(timer);
        this.pending.delete(request);
        if (action === 'release' && worker.token === token) worker.token = null;
        if (error) reject(Error(error));
        else resolve();
      });
      worker.process.stdin.write(JSON.stringify({ request, action, token, text }) + '\n');
    });
  }

  disconnect(worker, error) {
    if (this.worker !== worker) return;
    this.worker = null;
    worker.process.kill();
    for (const complete of this.pending.values()) complete(error);
    if (worker.token) this.onInvalid(worker.token, error);
  }

  close() {
    if (this.worker) this.disconnect(this.worker, 'Accessibility session closed.');
  }
}
