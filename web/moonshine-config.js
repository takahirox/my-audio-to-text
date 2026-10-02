// Dated releases from the upstream catalog at 234f60faa0eb388b01cdf7e60aca232af37aefda.
// Pin named files instead of depending on the runtime's embedded catalog.
export const moonshineModels = {
  ja: { name: 'Japanese Small Streaming', release: 'quantized_26_08_23', directory: 'small-streaming-ja' },
  en: { name: 'English Small Streaming', release: 'quantized_26_08_21', directory: 'small-streaming-en' },
};
export function moonshineFiles(language) {
  const model = moonshineModels[language];
  if (!model) throw new Error(`Unsupported Moonshine language: ${language}`);
  const base = `https://download.moonshine.ai/model/${model.directory}/${model.release}`;
  return Object.fromEntries(['adapter.ort', 'cross_kv.ort', 'decoder_kv.ort', 'encoder.ort',
    'frontend.model.ort', 'frontend.weights.ort', 'streaming_config.json', 'tokenizer.bin']
    .map((file) => [file, `${base}/${file}`]));
}
