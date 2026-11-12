import { appendFile } from 'node:fs/promises';
import path from 'node:path';

// Inject storage faults where Cache.put now runs, retaining the real worker,
// streaming verification and cache. This protocol exists only in fixture copies.
export async function installAssetQuotaFixture(root) {
  await appendFile(path.join(root, 'extension/model-asset-worker.js'), `
    let quotaPath = null;
    let offline = false;
    const fetchAsset = self.fetch.bind(self);
    self.fetch = (...args) => offline ? Promise.reject(new TypeError('Failed to fetch')) : fetchAsset(...args);
    const put = Cache.prototype.put;
    Cache.prototype.put = async function(key, response) {
      if (quotaPath !== null && String(key).endsWith(quotaPath)) {
        await response.body.cancel();
        throw new DOMException('Fixture disk full', 'QuotaExceededError');
      }
      return put.call(this, key, response);
    };
    self.addEventListener('connect', ({ ports: [port] }) => {
      port.addEventListener('message', ({ data }) => {
        if (data.type === 'fixture-quota') quotaPath = data.path;
        else if (data.type === 'fixture-offline') offline = data.offline;
        else return;
        port.postMessage({ type: 'fixture-set' }); port.close();
      });
    });
  `);
}

export async function setAssetQuota(page, suffix = null) {
  await setWorkerFault(page, { type: 'fixture-quota', path: suffix });
}

// Playwright's context.setOffline does not cover SharedWorker network targets.
export async function setAssetOffline(page, offline) {
  await setWorkerFault(page, { type: 'fixture-offline', offline });
}

async function setWorkerFault(page, message) {
  await page.evaluate(message => new Promise(resolve => {
    const worker = new SharedWorker(new URL('./model-asset-worker.js', location.href), { type: 'module', name: 'model-assets' });
    worker.port.onmessage = () => { worker.port.close(); resolve(); };
    worker.port.postMessage(message);
  }), message);
}
