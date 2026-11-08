// A prepared graph already owns Workers/GPU. Hold the lease until its document
// disposes it, including idle Live preparation. Never preempt another owner.
export function acquireRuntimeLease() {
  return new Promise((resolve, reject) => {
    navigator.locks.request('extension-inference-owner', { ifAvailable: true }, async lock => {
      if (!lock) { reject(Error('Runtime busy. Close the Live or Web voice typing window before starting another session.')); return; }
      await new Promise(release => resolve(release));
    }).catch(reject);
  });
}
