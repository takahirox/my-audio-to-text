// Issue #38: selected from the deterministic browser benchmark documented in
// docs/evidence/reazon-38.md. Keep the pinned runtime's four-thread pool cap.
export const REAZON_NUM_THREADS = 1;
export const REAZON_RUNTIME_THREAD_CAP = 4;
export const REAZON_THREAD_COUNTS = [1, 2, 4];

export function supportedReazonThreads({ hardwareConcurrency, crossOriginIsolated, sharedMemory }) {
  const cores = Number.isInteger(hardwareConcurrency) && hardwareConcurrency > 0 ? hardwareConcurrency : 1;
  const capacity = crossOriginIsolated && sharedMemory ? Math.min(cores, REAZON_RUNTIME_THREAD_CAP) : 1;
  return REAZON_THREAD_COUNTS.filter(count => count <= capacity);
}

export function selectReazonThreads(environment, requested) {
  const supported = supportedReazonThreads(environment);
  // Explicit requests are for the automated experiment, never a page control.
  // Reject unsupported counts rather than silently benchmarking a lower count.
  if (requested !== undefined) {
    if (!supported.includes(requested)) throw new Error(`Unsupported ReazonSpeech thread count: ${requested}; supported: ${supported.join(', ')}`);
    return requested;
  }
  return supported.filter(count => count <= REAZON_NUM_THREADS).at(-1);
}
