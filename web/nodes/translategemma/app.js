import { TranslateGemmaTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../../translation-nodes.js';
import { mountTranslationPage } from '../translation-page.js';
const direction = document.getElementById('direction');
direction.onchange = () => {
  const japanese = direction.value === 'ja-en';
  const input = document.getElementById('input');
  document.querySelector('label[for="input"]').textContent = `${japanese ? 'Japanese' : 'English'} text (up to 1,000 characters)`;
  input.lang = japanese ? 'ja' : 'en';
  if (['今日は良い天気です。', 'The weather is nice today.'].includes(input.value)) {
    input.value = japanese ? '今日は良い天気です。' : 'The weather is nice today.';
  }
  document.getElementById('output-heading').textContent = japanese ? 'English translation' : 'Japanese translation';
  document.getElementById('output').lang = japanese ? 'en' : 'ja';
  document.getElementById('output').textContent = '';
  document.getElementById('errors').textContent = '';
  document.getElementById('load-time').textContent = document.getElementById('latency').textContent = '—';
  document.getElementById('status').textContent = 'Ready to run';
};
class SelectedTranslation {
  constructor(options) {
    return new (direction.value === 'en-ja' ? EnglishToJapaneseTranslateGemmaTranslationNode : TranslateGemmaTranslationNode)(options);
  }
}
mountTranslationPage(SelectedTranslation, { sourceLanguage: 'source' });
