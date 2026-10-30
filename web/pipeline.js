// A contract is a shared identity, not a schema or a payload wrapper.
export const portContract = name => Object.freeze({ name });

/**
 * Nodes declare inputs/outputs as { portName: contract }. Optional async hooks:
 * start(context), receive(port, value, context), stop(context), cancel(context), dispose().
 * context provides emit(port, value), emitOutputs(values, { provisional }), fail(error), and an AbortSignal.
 * Optional receiveInputs(values, context) receives one emission mapped to input names.
 * Delivery contexts include opaque delivery/cause identity; cancel hooks emit cleanup snapshots.
 */
export class Pipeline {
  constructor({ nodes, connections = [], onError = () => {} }) {
    this.state = 'idle';
    this.onError = onError;
    this.errors = [];
    this.entries = new Map(Object.entries(nodes).map(([id, node]) => [id, {
      id, node, inputs: { ...node.inputs }, outputs: { ...node.outputs },
      routes: new Map(), queue: Promise.resolve(), controller: new AbortController(),
      active: false, closed: false, failed: false,
    }]));
    if (!this.entries.size) throw new Error('A pipeline needs at least one node.');
    if (new Set([...this.entries.values()].map(e => e.node)).size !== this.entries.size) {
      throw new Error('A node instance can occur only once in a pipeline.');
    }
    const indegree = new Map([...this.entries.keys()].map(id => [id, 0]));
    const edges = new Map([...this.entries.keys()].map(id => [id, []]));
    const seen = new Set(), incoming = new Set();
    for (const { from: [source, output], to: [target, input] } of connections) {
      const a = this.entries.get(source), b = this.entries.get(target);
      if (!a || !b) throw new Error(`Unknown connection node: ${!a ? source : target}`);
      if (!Object.hasOwn(a.outputs, output)) throw new Error(`Unknown output port: ${source}.${output}`);
      if (!Object.hasOwn(b.inputs, input)) throw new Error(`Unknown input port: ${target}.${input}`);
      if (!a.outputs[output] || a.outputs[output] !== b.inputs[input]) {
        throw new Error(`Incompatible port contracts: ${source}.${output} → ${target}.${input}`);
      }
      if (typeof b.node.receive !== 'function' && typeof b.node.receiveInputs !== 'function') throw new Error(`Input node ${target} needs receive() or receiveInputs().`);
      const key = JSON.stringify([source, output, target, input]);
      if (seen.has(key)) throw new Error('Duplicate connection.');
      seen.add(key);
      const destination = JSON.stringify([target, input]);
      if (incoming.has(destination)) throw new Error(`Only one connection allowed to ${target}.${input}`);
      incoming.add(destination);
      if (!a.routes.has(output)) a.routes.set(output, []);
      a.routes.get(output).push({ entry: b, port: input });
      edges.get(source).push(target);
      indegree.set(target, indegree.get(target) + 1);
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
    this.errors.push(error);
    // Observer failures cannot break delivery to another branch.
    try { this.onError(error, entry.id); } catch { /* errors remain available */ }
  }
  emit(entry, port, value, cause, cleanup = false, provisional = false) { this.emitOutputs(entry, { [port]: value }, false, cause, cleanup, provisional); }
  emitOutputs(entry, values, grouped = true, cause, cleanup = false, provisional = false) {
    if (!entry.active || entry.closed || entry.failed || this.state === 'disposed' || (this.state === 'canceling' && !cleanup)) return;
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      this.fail(entry, new TypeError('emitOutputs needs a named output map.')); return;
    }
    // Snapshot and validate the entire group before enqueueing any branch.
    const outputs = Object.entries(values);
    for (const [port] of outputs) if (!Object.hasOwn(entry.outputs, port)) {
      this.fail(entry, new Error(`Unknown output port: ${entry.id}.${port}`)); return;
    }
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
      const groupInputs = grouped ? Object.freeze([...new Set([...entry.routes.values()].flat()
        .filter(route => route.entry === target).map(route => route.port))]) : undefined;
      // A forwarding emission gets a fresh identity with its incoming event as
      // cause. Async processors retain this context with their accepted work.
      // No Node types, output names or payload equality participate in identity.
      // Producers can mark unfinished results without changing primitive ports.
      // Retaining a receive context also retains this flag across async forwarding.
      const context = Object.freeze({ ...target.context, groupInputs, delivery, cause, provisional,
        ...(cleanup ? { signal: this.cleanupController.signal } : {}),
        emit: (port, value) => this.emit(target, port, value, delivery, cleanup, provisional),
        emitOutputs: (values, options) => this.emitOutputs(target, values, true, delivery, cleanup, provisional || options?.provisional === true),
      });
      Object.freeze(inputs);
      // One queue item per target: no interleaving while an async hook runs.
      target.queue = target.queue.then(async () => {
        const live = () => target.active && !target.closed && !target.failed && this.state !== 'disposed' && (this.state !== 'canceling' || cleanup);
        if (!live()) return;
        if (typeof target.node.receiveInputs === 'function') {
          await target.node.receiveInputs(inputs, context);
        } else for (const [input, value] of Object.entries(inputs)) {
          if (!live()) return;
          await target.node.receive(input, value, context);
        }
      }).catch(error => this.fail(target, error));
    }
  }
  async wait(entry, work) {
    const signal = entry.controller.signal;
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
        const reachesOutput = current => !current.failed && (!Object.keys(current.outputs).length ||
          [...current.routes.values()].flat().some(route => reachesOutput(route.entry)));
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
    for (const entry of this.order) { entry.controller.abort(); entry.queue = Promise.resolve(); }
    return this.canceling = (async () => {
      // Drain upstream cleanup before closing each downstream processor. This
      // lets ordinary multi-hop snapshots reach sinks before their cancel hook.
      for (const entry of this.order) {
        await entry.queue;
        if (!entry.active || entry.closed || entry.failed) continue;
        const context = Object.freeze({ ...entry.context, signal: this.cleanupController.signal,
          emit: (port, value) => this.emit(entry, port, value, undefined, true),
          emitOutputs: (values, options) => this.emitOutputs(entry, values, true, undefined, true, options?.provisional === true),
        });
        try { await entry.node.cancel?.(context); } catch (error) { this.fail(entry, error); }
      }
      await this.dispose();
    })();
  }
  dispose() {
    if (this.disposing) return this.disposing;
    this.state = 'disposed';
    this.cleanupController?.abort();
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
