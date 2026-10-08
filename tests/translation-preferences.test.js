import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readTranslationPreferences, writeTranslationPreferences, translationLanguages } from '../extension/translation-preferences.js';

test('exclusive direction defaults safely, persists independently from enablement, and tolerates unavailable storage', () => {
  let saved = null;
  const storage = { getItem: () => saved, setItem: (key, value) => { saved = value; } };
  assert.deepEqual(readTranslationPreferences(storage), { enabled: false, direction: 'ja-en' });
  for (const direction of ['en-ja', 'ja-en']) for (const enabled of [true, false]) {
    writeTranslationPreferences(storage, { direction, enabled });
    assert.deepEqual(readTranslationPreferences(storage), { enabled, direction });
  }
  saved = '{"enabled":true,"direction":"unknown"}';
  assert.deepEqual(readTranslationPreferences(storage), { enabled: true, direction: 'ja-en' });
  saved = 'corrupt';
  assert.deepEqual(readTranslationPreferences(storage), { enabled: false, direction: 'ja-en' });
  const unavailable = { getItem() { throw Error('denied'); }, setItem() { throw Error('full'); } };
  assert.deepEqual(readTranslationPreferences(unavailable), { enabled: false, direction: 'ja-en' });
  assert.doesNotThrow(() => writeTranslationPreferences(unavailable, { enabled: true, direction: 'en-ja' }));
  assert.equal(translationLanguages('en-ja').sourceCode, 'en'); assert.equal(translationLanguages('en-ja').targetCode, 'ja');
});
