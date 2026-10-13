import { test, expect } from '@playwright/test';

test('ASR final TEXT → correction → translation fans out directly and drains equal-string utterances in order', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { Pipeline } = await import('/pipeline.js');
    const { SpeechToTextNode, MONO_16KHZ_PCM } = await import('/transcription-nodes.js');
    const { SpeechTranscriptCorrectionNode } = await import('/correction-nodes.js');
    const { OpusMtTranslationNode, TextOutputNode, TEXT } = await import('/translation-nodes.js');
    const workers = [], urls = [];
    const workerFactory = url => {
      const blob = URL.createObjectURL(new Blob([`
        self.onmessage=({data})=>{
          if(data.type==='load')postMessage({type:'ready',id:data.id});
          if(data.type==='vad-stop')postMessage({type:'vad-stopped',session:data.session});
          if(data.type==='drain')postMessage({type:'drained',id:data.id});
          if(data.type==='translate')setTimeout(()=>postMessage({type:'result',id:data.id,texts:['Translated '+data.text]}),10);
        };`], { type: 'text/javascript' }));
      urls.push(blob);
      const worker = new Worker(blob), terminate = worker.terminate.bind(worker);
      worker.terminate = () => { worker.released = true; terminate(); };
      workers.push(worker); return worker;
    };
    const speech = new SpeechToTextNode({ workerFactory: path => workerFactory(new URL(path, location.href)) });
    const original = [], a = [], b = [];
    const source = { outputs: { audio: MONO_16KHZ_PCM } };
    const translation = new OpusMtTranslationNode({ workerFactory });
    const graph = new Pipeline({ nodes: {
      source, speech, correction: new SpeechTranscriptCorrectionNode({ enabled: false }), translation,
      original: new TextOutputNode(text => original.push(text)),
      a: new TextOutputNode(text => a.push(text)), b: new TextOutputNode(text => b.push(text)),
    }, connections: [
      { from: ['source', 'audio'], to: ['speech', 'audio'] },
      { from: ['speech', 'final'], to: ['correction', 'text'] },
      { from: ['speech', 'final'], to: ['original', 'text'] },
      { from: ['correction', 'text'], to: ['translation', 'text'] },
      ...['a', 'b'].map(id => ({ from: ['translation', 'text'], to: [id, 'text'] })),
    ] });
    await graph.start();
    speech.receiveEvent({ type: 'partial', id: 0, text: 'provisional' });
    for (const [id, text] of [[0, 'same'], [0, 'duplicate'], [1, 'same'], [2, 'last']]) speech.receiveEvent({ type: 'final', id, text });
    await graph.stop(); await graph.dispose(); urls.forEach(url => URL.revokeObjectURL(url));
    let invalid;
    try { new Pipeline({ nodes: { source: { outputs: { text: TEXT } }, speech: new SpeechToTextNode() }, connections: [{ from: ['source', 'text'], to: ['speech', 'audio'] }] }); }
    catch (error) { invalid = error.message; }
    return { original, a, b, released: workers.every(w => w.released), invalid, primitive: speech.outputs.final === TEXT && speech.outputs.provisional === TEXT };
  });
  expect(result).toEqual({ original: ['same', 'same', 'last'], a: ['Translated same', 'Translated same', 'Translated last'], b: ['Translated same', 'Translated same', 'Translated last'], released: true, invalid: 'Incompatible port contracts: source.text → speech.audio', primitive: true });
});
