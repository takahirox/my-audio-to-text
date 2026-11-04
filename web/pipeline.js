import { compatiblePorts, snapshotPortValue, ITEM, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST } from './port-contracts.js';
export const MAX_SAMPLED_PENDING = 32;
export const MAX_SAMPLED_CHARS = 32768;
export const SAMPLED_TIMEOUT_MS = 240000;
export { portContract } from './port-contracts.js';

/**
 * Nodes declare inputs/outputs as { portName: contract }. Optional async hooks:
 * start(context), receive(port, value, context), stop(context), cancel(context), dispose().
 * context provides emit(port, value), emitOutputs(values, { provisional }), fail(error), and an AbortSignal.
 * Optional receiveInputs(values, context) receives one emission mapped to input names.
 * Optional inputQueueLimits { deliveries, chars } bounds active + queued deliveries before retention.
 * Delivery contexts include opaque delivery/cause identity; cancel hooks emit cleanup snapshots.
 * receive context.defer() owns queued async work separately from input admission;
 * emit through work.context and call work.complete() after its last output.
 */
export class Pipeline {
  constructor({ nodes, connections = [], onError = () => {} }) {
    this.state = 'idle';
    this.onError = onError;
    this.errors = [];
    this.turns = new Set();
    this.entries = new Map(Object.entries(nodes).map(([id, node]) => [id, {
      id, node, inputs: { ...node.inputs }, outputs: { ...node.outputs },
      provisionalOutputs: new Set(node.provisionalOutputs || []),
      outputGroups: (node.outputGroups || [Object.keys(node.outputs || {})]).map(ports => [...ports]),
      sampledOutputs: new Set(node.sampledOutputs || []), samples: [], pendingCount: 0, pendingChars: 0,
      dependents: new Set(), routes: new Map(), queue: Promise.resolve(), controller: new AbortController(), work: new Set(),
      active: false, closed: false, failed: false,
    }]));
    if (!this.entries.size) throw new Error('A pipeline needs at least one node.');
    if (new Set([...this.entries.values()].map(e => e.node)).size !== this.entries.size) {
      throw new Error('A node instance can occur only once in a pipeline.');
    }
    for (const entry of this.entries.values()) for (const port of entry.sampledOutputs) {
      if (!Object.hasOwn(entry.outputs, port) || typeof entry.node.readOutput !== 'function') throw Error('Sampled outputs need a declared port and readOutput().');
    }
    const indegree = new Map([...this.entries.keys()].map(id => [id, 0]));
    const edges = new Map([...this.entries.keys()].map(id => [id, []]));
    const seen = new Set(), incoming = new Set();
    for (const { from: [source, output], to: [target, input] } of connections) {
      const a = this.entries.get(source), b = this.entries.get(target);
      if (!a || !b) throw new Error(`Unknown connection node: ${!a ? source : target}`);
      if (!Object.hasOwn(a.outputs, output)) throw new Error(`Unknown output port: ${source}.${output}`);
      if (!Object.hasOwn(b.inputs, input)) throw new Error(`Unknown input port: ${target}.${input}`);
      if (!compatiblePorts(a.outputs[output], b.inputs[input])) {
        throw new Error(`Incompatible port contracts: ${source}.${output} → ${target}.${input}`);
      }
      if (typeof b.node.receive !== 'function' && typeof b.node.receiveInputs !== 'function') throw new Error(`Input node ${target} needs receive() or receiveInputs().`);
      const key = JSON.stringify([source, output, target, input]);
      if (seen.has(key)) throw new Error('Duplicate connection.');
      seen.add(key);
      const destination = JSON.stringify([target, input]);
      if (incoming.has(destination)) throw new Error(`Only one connection allowed to ${target}.${input}`);
      incoming.add(destination);
      a.dependents.add(b);
      if (!a.routes.has(output)) a.routes.set(output, []);
      if (a.sampledOutputs.has(output)) {
        b.samples.push({ entry: a, output, input });
      } else {
        a.routes.get(output).push({ entry: b, port: input });
        edges.get(source).push(target);
        indegree.set(target, indegree.get(target) + 1);
      }
    }
    const ready = [...indegree.keys()].filter(id => indegree.get(id) === 0);
    this.order = [];
    for (let i = 0; i < ready.length; i++) {
      const id = ready[i]; this.order.push(this.entries.get(id));
      for (const target of edges.get(id)) {
        indegree.set(target, indegree.get(target) - 1);
        if (!indegree.get(target)) ready.push(target);
      }
    }
    if (this.order.length !== this.entries.size) throw new Error('Pipeline connections must be acyclic.');
    for (const entry of this.order) {
      const reachable = new Set();
      const visit = current => {
        if (reachable.has(current)) return;
        reachable.add(current);
        for (const routes of current.routes.values()) for (const route of routes) visit(route.entry);
      };
      visit(entry);
      entry.reachable = reachable;
      entry.feedback = new Set(entry.samples.map(sample => sample.entry).filter(source => reachable.has(source)));
      entry.context = Object.freeze({
        signal: entry.controller.signal,
        connectedInputs: Object.freeze(connections.filter(route => route.to[0] === entry.id).map(route => route.to[1])),
        emit: (port, value) => this.emit(entry, port, value),
        emitOutputs: (values, options) => this.emitOutputs(entry, values, true, undefined, false, options?.provisional === true),
        fail: error => this.fail(entry, error),
      });
    }
  }
  fail(entry, cause) {
    if (entry.failed || entry.closed || ['canceling', 'disposed'].includes(this.state)) return;
    const error = new Error(`Node ${entry.id}: ${cause?.message || cause}`, { cause });
    entry.failed = true; entry.controller.abort(error);
    for (const turn of this.turns) if (turn.entries.has(entry)) {
      turn.error ||= error; turn.controller.abort(error);
    }
    this.errors.push(error);
    // Observer failures cannot break delivery to another branch.
    try { this.onError(error, entry.id); } catch { /* errors remain available */ }
  }
  emit(entry, port, value, cause, cleanup = false, provisional = false, turn) { this.emitOutputs(entry, { [port]: value }, false, cause, cleanup, provisional, turn); }
  emitOutputs(entry, values, grouped = true, cause, cleanup = false, provisional = false, turn) {
    if (turn?.closed) {
      if (!entry.controller.signal.aborted) this.fail(entry, Error('Sampled work emitted after its receive promise completed.'));
      return;
    }
    if (turn?.error || turn?.signal.aborted) return;
    if (!entry.active || entry.closed || entry.failed || this.state === 'disposed' || (this.state === 'canceling' && !cleanup)) return;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      this.fail(entry, new TypeError('emitOutputs needs a named output map.')); return;
    }
    // Snapshot and validate the entire group before enqueueing any branch.
    let outputs = Object.entries(values);
    for (const [port] of outputs) if (!Object.hasOwn(entry.outputs, port) || entry.sampledOutputs.has(port)) {
      this.fail(entry, new Error(`Unknown output port: ${entry.id}.${port}`)); return;
    }
    try {
      outputs = outputs.map(([port, value]) => {
        const contract = entry.outputs[port];
        const portable = [ITEM, KEYED_PAIRED_TEXT, KEYED_PAIRED_TEXT_LIST].includes(contract) ||
          (entry.routes.get(port) || []).some(route => route.entry.inputs[route.port] === ITEM);
        return [port, portable ? snapshotPortValue(contract, value) : value];
      });
    } catch (error) { this.fail(entry, error); return; }
    // Omitted siblings clear within the emitted family only. A producer can
    // declare independent atomic families sharing the same TEXT consumers.
    const groupOutputs = new Set(entry.outputGroups.filter(ports => outputs.some(([port]) => ports.includes(port))).flat());
    const deliveries = new Map();
    for (const [port, value] of outputs) {
      for (const { entry: target, port: input } of entry.routes.get(port) || []) {
        if (!deliveries.has(target)) deliveries.set(target, {});
        Object.defineProperty(deliveries.get(target), input, { value, enumerable: true });
      }
    }
    const delivery = Object.freeze({});
    for (const [target, inputs] of deliveries) {
      // Delivery-local provenance, never payload metadata or cross-branch matching.
      const groupInputs = grouped ? Object.freeze([...new Set([...entry.routes].filter(([port]) => groupOutputs.has(port)).flatMap(([, routes]) => routes)
        .filter(route => route.entry === target).map(route => route.port))]) : undefined;
      // A forwarding emission gets a fresh identity with its incoming event as
      // cause. Async processors retain this context with their accepted work.
      // No Node types, output names or payload equality participate in identity.
      // Producers can mark unfinished results without changing primitive ports.
      // Retaining a receive context also retains this flag across async forwarding.
      // A simultaneous final/preview-clear group can route unfinished outputs
      // to one consumer and committed outputs to another. Preserve that meaning
      // without splitting the atomic delivery or interpreting port names.
      const unfinished = provisional || outputs.filter(([port]) => (entry.routes.get(port) || []).some(route => route.entry === target))
        .every(([port]) => entry.provisionalOutputs.has(port));
      this.enqueue(target, inputs, { groupInputs, delivery, cause, provisional: unfinished, cleanup }, turn);
    }
  }
  enqueue(target, inputs, event, parent) {
    // Only paths capable of storing this turn's feedback belong to its FIFO.
    // Independent branches retain delivery provenance, but own their lifecycle.
    const independent = parent?.required.size && ![...parent.required].some(state => target.reachable.has(state));
    if (independent) parent = undefined;
    if (target.failed || target.closed) {
      if (parent) parent.error ||= Error(`Sampled work cannot reach ${target.id}.`);
      return;
    }
    const sampled = target.samples.length > 0 && !event.cleanup;
    const limits = event.cleanup ? undefined : target.node.inputQueueLimits;
    const bounded = sampled || !!limits;
    const maxPending = Math.min(sampled ? MAX_SAMPLED_PENDING : Infinity, limits?.deliveries ?? Infinity);
    const maxChars = Math.min(sampled ? MAX_SAMPLED_CHARS : Infinity, limits?.chars ?? Infinity);
    const chars = Object.values(inputs).reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
    if (bounded && (target.pendingCount >= maxPending || target.pendingChars + chars > maxChars)) {
      const error = Error(`${sampled ? 'Sampled input' : 'Input'} backlog exceeded ${maxPending} deliveries or ${maxChars.toLocaleString('en-US')} characters; branch stopped, queued work canceled. Start a fresh session at a lower input rate.`);
      if (parent) parent.error ||= error;
      this.fail(target, error); return;
    }
    if (bounded) { target.pendingCount++; target.pendingChars += chars; }
    if (parent) { parent.pending++; parent.entries.add(target); }
    target.queue = target.queue.then(async () => {
      let turn = parent, owned;
      const live = () => target.active && !target.closed && !target.failed && this.state !== 'disposed' && (this.state !== 'canceling' || event.cleanup);
      try {
        if (!live() || parent?.error) {
          if (parent) parent.error ||= Error(`Sampled work canceled at ${target.id}.`);
          return;
        }
        let values = { ...inputs };
        if (sampled) {
          owned = turn = this.newTurn(target, parent);
          // Apply already queued independent state writes before reading, even
          // when the producer listed its consumer edge before its state edge.
          for (const sample of target.samples) await this.wait(target, sample.entry.queue, turn.signal);
          target.controller.signal.throwIfAborted();
          for (const sample of target.samples) {
            if (sample.entry.failed) throw Error(`Held state ${sample.entry.id} failed.`);
            values[sample.input] = snapshotPortValue(sample.entry.outputs[sample.output], sample.entry.node.readOutput(sample.output));
          }
        }
        let receiving = true;
        const emissions = {
          emit: (port, value) => this.emit(target, port, value, event.delivery, event.cleanup, event.provisional, turn),
          emitOutputs: (outputs, options) => this.emitOutputs(target, outputs, true, event.delivery, event.cleanup, event.provisional || options?.provisional === true, turn),
        };
        const emit = callback => {
          if (!live()) return;
          if (independent && !receiving) { this.fail(target, Error('Async branch emitted after its receive promise completed; use context.defer().')); return; }
          callback();
        };
        const context = Object.freeze({ ...target.context,
          groupInputs: event.groupInputs, delivery: event.delivery, cause: event.cause, provisional: event.provisional,
          signal: event.cleanup ? this.cleanupController.signal : target.controller.signal,
          fail: error => { if (turn) turn.error ||= error; this.fail(target, error); },
          emit: (port, value) => emit(() => emissions.emit(port, value)),
          emitOutputs: (outputs, options) => emit(() => emissions.emitOutputs(outputs, options)),
          defer: () => {
            if (!receiving || !live() || turn?.closed || turn?.signal.aborted) throw Error('Async work must be owned during a live receive hook.');
            return this.defer(target, { ...context, ...emissions }, turn);
          },
        });
        Object.freeze(values);
        const receive = async () => {
          if (typeof target.node.receiveInputs === 'function') await target.node.receiveInputs(values, context);
          else for (const [input, value] of Object.entries(values)) {
            if (!live()) return;
            await target.node.receive(input, value, context);
          }
        };
        try { await (event.cleanup ? receive() : this.wait(target, receive(), turn?.signal)); }
        finally { receiving = false; }
        if (turn && !target.failed) turn.writes.add(target);
      } catch (error) {
        if (turn) turn.error ||= error;
        this.fail(target, error);
      } finally {
        if (owned) {
          this.releaseTurn(owned);
          try { await this.wait(target, owned.done, owned.signal); }
          catch (error) { owned.error ||= error; }
          owned.closed = true; clearTimeout(owned.timer); this.turns.delete(owned);
          if (parent) for (const entry of owned.writes) parent.writes.add(entry);
          if (owned.error) {
            if (parent) parent.error ||= owned.error;
            this.fail(target, owned.error);
          }
        }
        if (bounded) { target.pendingCount--; target.pendingChars -= chars; }
        if (parent) this.releaseTurn(parent);
      }
    }).catch(error => this.fail(target, error));
  }
  defer(entry, context, turn) {
    // An owned emitter keeps provenance and cancellation, without serializing
    // input admission. On a feedback path it also retains that turn's obligation.
    let closed = false, resolve;
    const work = { done: new Promise(done => { resolve = done; }) };
    if (turn) turn.pending++;
    const complete = () => {
      if (closed) return;
      closed = true; entry.work.delete(work);
      entry.controller.signal.removeEventListener('abort', complete);
      if (turn) this.releaseTurn(turn);
      resolve();
    };
    const emit = callback => {
      if (entry.controller.signal.aborted) return;
      if (closed) { this.fail(entry, Error('Async work emitted after completion.')); return; }
      callback();
    };
    work.complete = complete;
    work.context = Object.freeze({ ...context, defer: undefined,
      emit: (port, value) => emit(() => context.emit(port, value)),
      emitOutputs: (values, options) => emit(() => context.emitOutputs(values, options)),
    });
    entry.work.add(work);
    entry.controller.signal.addEventListener('abort', complete, { once: true });
    return Object.freeze(work);
  }
  newTurn(owner, parent) {
    const turn = { owner, pending: 1, entries: new Set([owner]), writes: new Set(), controller: new AbortController() };
    turn.required = new Set([...owner.feedback, ...(parent?.required || [])]);
    turn.signal = parent ? AbortSignal.any([turn.controller.signal, parent.signal]) : turn.controller.signal;
    turn.done = new Promise(resolve => { turn.resolve = resolve; });
    turn.timer = setTimeout(() => {
      turn.error ||= Error('Sampled update timed out; branch stopped. Cancel or Start a fresh session.');
      this.fail(owner, turn.error); turn.resolve();
    }, SAMPLED_TIMEOUT_MS);
    this.turns.add(turn);
    return turn;
  }
  releaseTurn(turn) {
    if (--turn.pending) return;
    for (const state of turn.owner.feedback) if (!turn.writes.has(state)) {
      turn.error ||= Error(`Sampled update completed without storing feedback in ${state.id}. Async receive hooks must await their work and emit through their delivery context.`);
    }
    turn.resolve();
  }
  async wait(entry, work, extraSignal) {
    const signal = extraSignal ? AbortSignal.any([entry.controller.signal, extraSignal]) : entry.controller.signal;
    if (signal.aborted) {
      // Work may already be scheduled; still observe its eventual rejection.
      void Promise.resolve(work).catch(() => {});
      throw signal.reason;
    }
    let abort;
    const canceled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([work, canceled]); }
    finally { signal.removeEventListener('abort', abort); }
  }
  start() {
    if (this.state !== 'idle') return Promise.reject(new Error('Start requires a fresh pipeline.'));
    this.state = 'starting';
    return this.starting = this.startNodes();
  }
  async startNodes() {
    try {
      // Consumers are ready before producers can emit, including inside start.
      for (const entry of [...this.order].reverse()) {
        if (['canceling', 'disposed'].includes(this.state)) throw new DOMException('Pipeline disposed.', 'AbortError');
        const reachesOutput = (current, visited = new Set()) => {
          if (current.failed || visited.has(current)) return false;
          visited.add(current);
          return !Object.keys(current.outputs).length || [...current.dependents].some(target => reachesOutput(target, visited));
        };
        if (this.errors.length && !reachesOutput(entry)) continue;
        entry.active = true;
        try {
          await this.wait(entry, Promise.resolve().then(() => {
            entry.controller.signal.throwIfAborted();
            return entry.node.start?.(entry.context);
          }));
        } catch (error) { this.fail(entry, error); }
      }
      if (['canceling', 'disposed'].includes(this.state)) throw new DOMException('Pipeline disposed.', 'AbortError');
      // A failed startup Node cannot invalidate an independent complete path.
      const viable = new Set();
      for (const entry of this.order) {
        const sources = [...this.entries.values()].filter(source => [...source.routes.values()].flat().some(route => route.entry === entry));
        if (!entry.failed && (!sources.length || sources.some(source => viable.has(source.id)))) viable.add(entry.id);
      }
      if (this.errors.length && !this.order.some(entry => viable.has(entry.id) && !Object.keys(entry.outputs).length && this.order.some(source => [...source.routes.values()].flat().some(route => route.entry === entry)))) {
        throw this.errors[0] || Error('No viable output path after startup.');
      }
      this.state = 'running';
    } catch (error) {
      if (!['canceling', 'disposed'].includes(this.state)) {
        // Startup failure has no viable graph; release even partially started nodes.
        await this.dispose();
      }
      throw error;
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    if (this.state === 'disposed' || this.state === 'stopped') return Promise.resolve();
    if (!['starting', 'running'].includes(this.state)) return Promise.reject(new Error('Pipeline is not started.'));
    return this.stopping = this.stopNodes();
  }
  async stopNodes() {
    if (this.state === 'starting') await this.starting;
    if (['canceling', 'disposed'].includes(this.state)) return;
    this.state = 'stopping';
    await this.drain(this.order.map(entry => entry.id));
    if (['canceling', 'disposed'].includes(this.state)) return;
    this.state = 'stopped';
    if (this.errors.length) throw new AggregateError(this.errors, `Pipeline failed while draining: ${this.errors.map(error => error.message).join(' ')}`);
  }
  // Drain a selected set in topological order, preserving shared live consumers.
  // The caller must ensure no live producer still routes to these Nodes.
  async drain(nodeIds) {
    const ids = new Set(nodeIds);
    for (const entry of this.order.filter(entry => ids.has(entry.id) && !entry.closed)) {
      if (['canceling', 'disposed'].includes(this.state)) return;
      try {
        if (!entry.failed) {
          await this.wait(entry, entry.queue);
          await this.wait(entry, Promise.resolve().then(() => {
            entry.controller.signal.throwIfAborted();
            return entry.node.stop?.(entry.context);
          }));
          await this.wait(entry, Promise.all([...entry.work].map(work => work.done)));
        }
      } catch (error) {
        if (['canceling', 'disposed'].includes(this.state)) return;
        this.fail(entry, error);
      }
      // stop() promises must include all background output from this node.
      entry.closed = true;
    }
  }
  // Abort pending work first. Node-owned cancellation snapshots then follow
  // ordinary routes, including stateless transformations and independent sinks.
  cancel() {
    if (this.canceling) return this.canceling;
    if (this.state === 'disposed') return this.dispose();
    this.state = 'canceling';
    this.cleanupController = new AbortController();
    for (const turn of this.turns) { turn.closed = true; turn.controller.abort(); clearTimeout(turn.timer); turn.resolve(); }
    for (const entry of this.order) { entry.controller.abort(); entry.queue = Promise.resolve(); }
    return this.canceling = this.cancelNodes();
  }
  async cancelNodes() {
    for (const entry of this.order) {
      // Only cleanup deliveries remain in these fresh queues. Let upstream
      // snapshots pass through each consumer before its cancel hook closes it.
      await entry.queue;
      if (this.state === 'disposed') return this.dispose();
      if (!entry.active || entry.closed || entry.failed) continue;
      const context = Object.freeze({ ...entry.context, signal: this.cleanupController.signal,
        emit: (port, value) => this.emit(entry, port, value, undefined, true),
        emitOutputs: (values, options) => this.emitOutputs(entry, values, true, undefined, true, options?.provisional === true),
      });
      try { await entry.node.cancel?.(context); } catch (error) { this.fail(entry, error); }
    }
    await this.dispose();
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.state = 'disposed';
    this.cleanupController?.abort();
    for (const turn of this.turns) { turn.closed = true; turn.controller.abort(); clearTimeout(turn.timer); turn.resolve(); }
    this.turns.clear();
    // Invalidate every emitter and queued input before starting async cleanup.
    for (const entry of this.order) { entry.closed = true; entry.controller.abort(); }
    return this.disposing = Promise.allSettled(this.order.map(entry => {
      try { return entry.node.dispose?.(); } catch (error) { return Promise.reject(error); }
    })).then(results => {
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
      if (errors.length) throw new AggregateError(errors, 'Pipeline disposal failed.');
    });
  }
}
