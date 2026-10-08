import { hiraganaWordToPhonemes, PUNCT } from './kokoro-hepburn.js';

// Adapted from nerosui/kokoro-js-jp 8eadd00e25759e5f6d067009dd02943c17048508,
// Apache-2.0. Changed: run Open JTalk directly in the owning inference Worker,
// with local assets and no nested Worker/global client or request timeout.
// Full attribution and dictionary/HTS voice terms: licenses/kokoro-japanese.txt.
export function japaneseFrontendToPhonemes(nodes) {
  const parts = [];
  for (const node of nodes) {
    const pron = node.pron || node.read || '';
    if (/[\u30a1-\u30faー]/u.test(pron)) {
      const hira = [...pron].map(char => {
        const code = char.codePointAt(0);
        return code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 96) : char;
      }).join('');
      const phonemes = hiraganaWordToPhonemes(hira);
      if (phonemes) parts.push(phonemes);
    } else if (node.string) {
      const punctuation = [...node.string].map(char => PUNCT[char] ?? '').join('');
      if (punctuation) parts.push(punctuation);
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export async function createJapanesePhonemizer() {
  const { default: factory } = await import('./tts-assets/openjtalk-wasm-wrapper-D6E3BSJO.js');
  const mod = await factory({ locateFile: file => new URL(`./tts-assets/${file}`, import.meta.url).href });
  await mod.configure(undefined,
    new URL('./tts-assets/openjtalk-voice.htsvoice', import.meta.url).href,
    new URL('./tts-assets/open_jtalk_dic_utf_8-1.11.tar.gz', import.meta.url).href);
  return text => japaneseFrontendToPhonemes(mod.runFrontend(text));
}
