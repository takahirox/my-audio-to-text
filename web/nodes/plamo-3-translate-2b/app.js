import { Plamo3Translate2BTranslationNode } from '../../translation-nodes.js';
import { mountTranslationPage } from '../translation-page.js';
import { plamoLanguages } from '../../plamo-policy.js';
class ConfiguredPlamo extends Plamo3Translate2BTranslationNode {
  constructor(options) {
    super(options);
    this.languages = Object.freeze(Object.fromEntries(['source', 'target'].flatMap(name => {
      const value = document.getElementById(`${name}-lang`).value;
      return value === '' ? [] : [[`${name}_lang`, value]];
    })));
  }
  start(context) { plamoLanguages(this.languages); return super.start(context); }
}
mountTranslationPage(ConfiguredPlamo, { sourceLanguage: 'source' });
