// Asset storage only: no inference, Pipeline routing or background model manager.
// Canonical pinned URLs share the extension-origin cache with translation Workers.
export const MODEL_CACHE_NAME = 'transformers-cache';
export const HASH_CHUNK_BYTES = 1024 * 1024;

const safePath = value => typeof value === 'string' && value.split('/').every(
  part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..');

export function defineAssetSet({ id, revision, files, origin = 'https://huggingface.co' }) {
  const base = new URL(origin);
  if (!safePath(id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)
      || base.origin !== origin || base.protocol !== 'https:'
      || !Array.isArray(files) || !files.length) throw new TypeError('Invalid immutable asset set.');
  const paths = new Set();
  const assets = files.map(file => {
    if (!safePath(file.path) || paths.has(file.path) || !Number.isSafeInteger(file.bytes)
        || file.bytes <= 0 || !Array.isArray(file.sha256Chunks)
        || file.sha256Chunks.length !== Math.ceil(file.bytes / HASH_CHUNK_BYTES)
        || file.sha256Chunks.some(hash => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new TypeError('Each required file needs a unique path, byte size and 1 MiB chunk SHA-256 hashes.');
    }
    paths.add(file.path);
    const url = `${origin}/${id}/resolve/${revision}/${file.path}`;
    const sourceURL = file.sourceURL || url;
    const source = new URL(sourceURL);
    if (source.username || source.password || source.hash
        || !(['https:', 'chrome-extension:'].includes(source.protocol)
          || (source.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname)))) {
      throw new TypeError('Asset source must use HTTPS, packaged extension data or a loopback fixture.');
    }
    return Object.freeze({ path: file.path, bytes: file.bytes, url, sourceURL,
      sha256Chunks: Object.freeze([...file.sha256Chunks]) });
  });
  const bytes = assets.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(bytes)) throw new TypeError('Asset set size is too large.');
  return Object.freeze({ id, revision, bytes, files: Object.freeze(assets) });
}

// One bounded hash buffer; one backpressured stream into Cache.put, never a tee
// or whole-model arrayBuffer/blob. Chunk hashes also catch same-length corruption.
function validatedBody(response, file, onBytes = () => {}, signal) {
  if (response.status !== 200 || !response.body) throw new Error(`Invalid response for ${file.path}.`);
  let bytes = 0, used = 0, index = 0;
  const buffer = new Uint8Array(Math.min(HASH_CHUNK_BYTES, file.bytes));
  const verify = async () => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer.subarray(0, used)));
    const hex = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('');
    if (hex !== file.sha256Chunks[index++]) throw new Error(`Corrupt asset: ${file.path}.`);
    used = 0;
  };
  return response.body.pipeThrough(new TransformStream({
    async transform(chunk, controller) {
      signal?.throwIfAborted();
      bytes += chunk.byteLength;
      if (bytes > file.bytes) throw new Error(`Incorrect size: ${file.path}.`);
      for (let offset = 0; offset < chunk.byteLength;) {
        const length = Math.min(buffer.length - used, chunk.byteLength - offset);
        buffer.set(chunk.subarray(offset, offset + length), used);
        used += length; offset += length;
        if (used === buffer.length) await verify();
      }
      onBytes(bytes);
      controller.enqueue(chunk);
    },
    async flush() {
      signal?.throwIfAborted();
      if (bytes !== file.bytes) throw new Error(`Incomplete asset: ${file.path}.`);
      if (used) await verify();
    },
  }));
}

// A Worker owns its leases until termination, including lazy runtime reads.
// Web Locks releases them if it crashes/cancels. Deletion acquires every file
// before touching any, so overlapping voice/dependency sets cannot be torn down.
const workerLeases = new Map();
const useKey = file => `model-use:${file.url}`;
async function retainFiles(manifest, locks) {
  if (!locks || typeof WorkerGlobalScope === 'undefined' || !(globalThis instanceof WorkerGlobalScope)) return;
  for (const file of [...manifest.files].sort((a, b) => a.url.localeCompare(b.url))) {
    const key = useKey(file);
    if (!workerLeases.has(key)) workerLeases.set(key, new Promise((resolve, reject) => {
      void locks.request(key, { mode: 'shared' }, () => {
        resolve(); return new Promise(() => {});
      }).catch(reject);
    }));
    await workerLeases.get(key);
  }
}

export class ModelAssetCache {
  constructor(manifest, { cacheStorage = globalThis.caches, fetchAsset = globalThis.fetch?.bind(globalThis),
    locks = globalThis.navigator?.locks, storage = globalThis.navigator?.storage,
    persistenceSession = globalThis.chrome?.storage?.session } = {}) {
    this.manifest = manifest;
    this.cacheStorage = cacheStorage;
    this.fetchAsset = fetchAsset;
    this.locks = locks;
    this.storage = storage;
    this.persistenceSession = persistenceSession;
    this.queue = Promise.resolve();
  }

  // Web Locks coordinate multiple extension windows. The instance queue also
  // serializes callers in environments without Web Locks (e.g. unit fixtures).
  async exclusive(action, signal) {
    const { id, revision, files } = this.manifest;
    const run = () => this.locks ? this.locks.request(
      `model-assets:${new URL(files[0].url).origin}:${id}:${revision}`, { signal }, action) : action();
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  snapshot(files, state, downloadedBytes, error = '') {
    const cachedBytes = files.reduce((sum, file, i) => sum + (file.cached ? this.manifest.files[i].bytes : 0), 0);
    return { state: state || (files.every(file => file.cached) ? 'Ready' : 'Not downloaded'),
      files: files.map(file => ({ ...file })), cachedBytes,
      downloadedBytes: downloadedBytes ?? cachedBytes, totalBytes: this.manifest.bytes, error };
  }

  async scan(cache, signal) {
    const files = [];
    for (const file of this.manifest.files) {
      signal?.throwIfAborted();
      const response = await cache.match(file.url);
      let cached = false;
      if (response) {
        try {
          await validatedBody(response, file, undefined, signal).pipeTo(new WritableStream());
          cached = true;
        } catch (error) {
          signal?.throwIfAborted();
          // A partial, opaque, wrong-size or wrong-hash response cannot be Ready.
          await cache.delete(file.url);
        }
      }
      files.push({ path: file.path, cached });
    }
    return files;
  }

  async inspect({ signal, retain = false } = {}) {
    if (retain) await retainFiles(this.manifest, this.locks);
    return this.exclusive(async () => {
      const cache = await this.cacheStorage.open(MODEL_CACHE_NAME);
      return this.snapshot(await this.scan(cache, signal));
    }, signal).catch(error => this.failure(error));
  }

  failure(error, files = this.manifest.files.map(file => ({ path: file.path, cached: false }))) {
    const message = error.name === 'QuotaExceededError'
      ? 'Storage quota exceeded. Delete cached assets or free disk space, then retry.'
      : `${error.message || error} Retry preparation to download missing assets.`;
    return this.snapshot(files, 'Error', undefined, message);
  }

  async prepare({ onChange = () => {}, signal } = {}) {
    try {
      return await this.exclusive(async () => {
        let files, activeFile;
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
          signal?.throwIfAborted();
          const cache = await this.cacheStorage.open(MODEL_CACHE_NAME);
          files = await this.scan(cache, controller.signal);
          onChange(this.snapshot(files, 'Downloading'));
          for (let i = 0; i < files.length; i++) {
            if (files[i].cached) continue;
            controller.signal.throwIfAborted();
            await requestStoragePersistence(this.storage, { locks: this.locks, session: this.persistenceSession });
            controller.signal.throwIfAborted();
            activeFile = this.manifest.files[i];
            const completeBytes = this.snapshot(files).cachedBytes;
            const response = await this.fetchAsset(activeFile.sourceURL, {
              signal: controller.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
            });
            const body = validatedBody(response, activeFile, bytes => {
              onChange(this.snapshot(files, 'Downloading', completeBytes + bytes));
            }, controller.signal);
            await cache.put(activeFile.url, new Response(body, { status: 200,
              headers: { 'Content-Length': String(activeFile.bytes),
                'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream' } }));
            controller.signal.throwIfAborted();
            files[i].cached = true; activeFile = undefined;
            onChange(this.snapshot(files, 'Downloading'));
          }
          // Reopen: an evicted cache handle must not be mistaken for stored data.
          const stored = await this.cacheStorage.open(MODEL_CACHE_NAME);
          files = await this.scan(stored, controller.signal);
          const result = this.snapshot(files);
          if (result.state !== 'Ready') throw new Error('Cached assets were evicted during preparation.');
          onChange(result); return result;
        } catch (error) {
          controller.abort();
          if (activeFile) {
            // Even a non-atomic injected/failed writer must leave no partial entry.
            try { await (await this.cacheStorage.open(MODEL_CACHE_NAME)).delete(activeFile.url); } catch {}
          }
          const result = this.failure(error, files);
          onChange(result); return result;
        } finally { signal?.removeEventListener('abort', abort); }
      }, signal);
    } catch (error) {
      const result = this.failure(error); onChange(result); return result;
    }
  }

  remove() {
    const files = [...this.manifest.files].sort((a, b) => a.url.localeCompare(b.url));
    const unused = (index, action) => !this.locks || index === files.length ? action()
      : this.locks.request(useKey(files[index]), { ifAvailable: true }, lock => {
        if (!lock) throw Error('Assets are in use by an inference session. Close its Live tab or cancel the session, then retry deletion.');
        return unused(index + 1, action);
      });
    return this.exclusive(() => unused(0, async () => {
      const cache = await this.cacheStorage.open(MODEL_CACHE_NAME);
      for (const file of this.manifest.files) await cache.delete(file.url);
      return this.snapshot(await this.scan(cache));
    })).catch(error => this.failure(error));
  }
}

export async function storagePersistence(storage = globalThis.navigator?.storage, request = false) {
  try {
    if (!storage?.persisted) return 'unsupported';
    if (await storage.persisted()) return 'granted';
    if (request && !storage.persist) return 'unsupported';
    return request ? (await storage.persist() ? 'granted' : 'denied') : 'not granted';
  } catch { return 'unavailable'; }
}

const persistenceRequests = new WeakMap();
const PERSISTENCE_SESSION_KEY = 'model-storage-persistence-attempted';

// Start only when a missing asset is about to be fetched. A shared promise covers
// models in this realm; an origin-wide lock and extension session marker also
// cover other pages and page recreation, including after a denial. The marker is
// written before the request so closing the requesting page cannot cause spam.
export function requestStoragePersistence(storage = globalThis.navigator?.storage,
  { locks = globalThis.navigator?.locks, session = globalThis.chrome?.storage?.session } = {}) {
  if (!storage || !['object', 'function'].includes(typeof storage)) return Promise.resolve('unsupported');
  if (!persistenceRequests.has(storage)) {
    const attempt = async () => {
      try {
        if ((await session?.get(PERSISTENCE_SESSION_KEY))?.[PERSISTENCE_SESSION_KEY]) return 'attempted';
        await session?.set({ [PERSISTENCE_SESSION_KEY]: true });
      } catch { /* Session coordination is optional; still try the storage API. */ }
      return storagePersistence(storage, true);
    };
    const pending = Promise.resolve().then(() => locks
      ? locks.request('model-storage-persistence', attempt) : attempt()).catch(() => 'unavailable');
    persistenceRequests.set(storage, pending);
  }
  return persistenceRequests.get(storage);
}
