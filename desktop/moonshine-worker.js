import { installMoonshineWorker } from '../web/moonshine-worker.js';
import { moonshineJapaneseManifest, optionalAsrFiles } from '../extension/optional-asr-cache.js';

installMoonshineWorker({
  japanese: true,
  async loadFiles(label) {
    return optionalAsrFiles(await moonshineJapaneseManifest(), label);
  },
});
