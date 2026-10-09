import { QWEN3_CORRECTION } from './correction-policy.js';
export const CORRECTION_CACHE = `qwen3-correction-${QWEN3_CORRECTION.revision}`;
// Only this concrete processor's immutable model assets enter this cache.
export function correctionCache(storage, progress) {
  let unavailable = false;
  const allowed = request => {
    const url = typeof request === 'string' ? request : request.url;
    return url?.startsWith(`https://huggingface.co/${QWEN3_CORRECTION.id}/resolve/${QWEN3_CORRECTION.revision}/`);
  };
  const warn = error => {
    if (!unavailable) progress({ status: 'cache-warning', message: `Model cache unavailable: ${error.message || error}. This run can continue, but a later run may download again.` });
    unavailable = true;
  };
  return {
    async match(request) {
      if (!allowed(request) || unavailable) return undefined;
      try { return await (await storage.open(CORRECTION_CACHE)).match(request); }
      catch (error) { warn(error); return undefined; }
    },
    async put(request, response) {
      if (!allowed(request) || unavailable) return;
      try { await (await storage.open(CORRECTION_CACHE)).put(request, response); }
      catch (error) { warn(error); }
    },
  };
}
