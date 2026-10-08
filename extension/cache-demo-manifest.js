import { defineAssetSet } from './model-asset-cache.js';

// Tiny project-owned data, not executable code or translation weights.
// Synthetic HTTPS keys are necessary because Cache.put rejects extension URLs.
export const CACHE_DEMO = defineAssetSet({
  id: 'local-extension/cache-demo',
  revision: 'e6bb51afef04c7fdb2aad1c5f8f043e73b73b049ca1d3148dd52bcd814440657',
  origin: 'https://extension-model-assets.invalid',
  files: [
    { path: 'config.json', bytes: 46,
      sha256Chunks: ['f6d4ee96be8c07c5236df4c7dc8d1b9be8dac34adad74d09c2e9216b19d251fc'] },
    { path: 'weights.bin', bytes: 16384,
      sha256Chunks: ['a1f259d4365ed4320c377ce26f5c8c56dcdc9a89e7b641bfd8eabfbbeac86654'] },
  ].map(file => ({
    ...file, sourceURL: new URL(`./cache-demo/${file.path}`, import.meta.url).href,
  })),
});
