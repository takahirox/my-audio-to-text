import { englishToJapaneseOpusMtManifest } from './opus-mt-en-ja-manifest.js';
import { verifiedOpusCache, cacheOnlyOpusRuntime } from './opus-mt-cache.js';

export function verifiedEnglishToJapaneseOpusCache(signal) {
  return verifiedOpusCache(signal, englishToJapaneseOpusMtManifest);
}
export function cacheOnlyEnglishToJapaneseOpusRuntime(env) {
  return cacheOnlyOpusRuntime(env, englishToJapaneseOpusMtManifest);
}
