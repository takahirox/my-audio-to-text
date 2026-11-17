import { test, openGraph } from './graph-fixture.js';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkTranslationPorts, checkTranslationPortRecovery, translationPortWorker } from '../fixtures/translation-ports.js';

for (const type of ['TranslateGemma4B'])
  test(`${type}: packaged direct ports isolate history and TEXT previews with one owned Worker`, async ({ graphExtension: f }) => {
    for (const file of ['translategemma-worker.js'])
      await writeFile(path.join(f.root, 'web', file), translationPortWorker);
    const live = await openGraph(f);
    await checkTranslationPorts(live, type);
  });

for (const type of ['TranslateGemma4B'])
  test(`${type}: MV3 reviewed repair keeps exact recovery bytes and reloads explicit preview routes`, async ({ graphExtension: f }) => {
    const live = await openGraph(f);
    await checkTranslationPortRecovery(live.editor, type);
  });
