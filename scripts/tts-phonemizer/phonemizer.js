// English-only adapter for the source-built eSpeak NG module.
// SPDX-License-Identifier: GPL-3.0-or-later
import createEngine from './phonemizer-engine.mjs';

const engine = createEngine().then(module => new module.eSpeakNGWorker());

export async function phonemize(text, language = 'en-us') {
  if (!['en', 'en-us'].includes(language)) throw new Error('Unsupported English phonemizer language.');
  const worker = await engine;
  if (worker.set_voice(language) !== 0) throw new Error('eSpeak NG voice initialization failed.');
  const result = worker.synthesize_ipa(text);
  if (result.code !== 0) throw new Error('eSpeak NG phonemization failed.');
  return result.ipa.split('\n').filter(value => value.length > 0);
}
