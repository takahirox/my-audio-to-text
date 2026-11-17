import { TranslateGemmaTranslationNode } from '../../translation-nodes.js';
import { mountTranslationPage } from '../translation-page.js';

// The same loaded production Node handles every language pair. Each request
// snapshots these ordinary TEXT values before inference; Cancel releases it.
mountTranslationPage(TranslateGemmaTranslationNode, {
  sourceLanguage: 'source', persistent: true,
  translationOptions: () => ({
    getTranslationLanguages: () => Object.freeze(Object.fromEntries(['source', 'target'].flatMap(name => {
      const value = document.getElementById(`${name}-lang`).value;
      return value === '' ? [] : [[`${name}_lang`, value]];
    }))),
    getTranslationContext: () => document.getElementById('context').value,
  }),
});
