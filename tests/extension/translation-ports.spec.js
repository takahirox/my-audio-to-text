import { test, openGraph } from './graph-fixture.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkTranslationPorts, checkTranslationPortRecovery, translationPortWorker } from '../fixtures/translation-ports.js';

for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn'])
  test(`${type}: packaged direct ports isolate history and paired previews with one owned Worker`, async ({ graphExtension: f }) => {
    for (const file of ['translategemma-worker.js', 'opus-mt-worker.js', 'opus-mt-en-ja-worker.js'])
      await writeFile(path.join(f.root, 'web', file), translationPortWorker);
    const live = await openGraph(f);
    await checkTranslationPorts(live, type);
  });

for (const type of ['TranslateGemmaEnJa', 'TranslateGemmaJaEn', 'OpusMtEnJa', 'OpusMtJaEn'])
  test(`${type}: MV3 reviewed repair keeps exact recovery bytes and reloads explicit preview routes`, async ({ graphExtension: f }) => {
    const live = await openGraph(f);
    await checkTranslationPortRecovery(live.editor, type);
  });
