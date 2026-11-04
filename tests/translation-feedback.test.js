import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translationFeedback } from './fixtures/translation-feedback.js';
import { EnglishToJapaneseOpusMtTranslationNode, EnglishToJapaneseTranslateGemmaTranslationNode } from '../web/translation-nodes.js';
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const TranslationNode of [EnglishToJapaneseTranslateGemmaTranslationNode, EnglishToJapaneseOpusMtTranslationNode]) {
  test(`${TranslationNode.name}: delayed output followed by another window has no sampled lifetime/reachability errors`, async t => {
    const f = await translationFeedback({ TranslationNode }); t.after(() => f.pipeline.dispose());
    await f.send('A'); await tick();
    assert.equal(f.hold.value, 'S1');
    f.complete(0); await tick();
    await f.send('B'); await tick();
    assert.deepEqual(f.pipeline.errors.map(e => e.message), []);
    assert.deepEqual(f.outputs.map(o => o.values), [{ source: 'S1', text: 'T1', error: '' }]);
    f.complete(1); await f.pipeline.stop();
    assert.equal(f.outputs[0].values.source, f.accepted[0]);
  });
  for (const reverse of [false, true]) test(`${TranslationNode.name}: A/B/C feedback finishes while T1 is still running (${reverse})`, async t => {
    const f = await translationFeedback({ TranslationNode, reverse }); t.after(() => f.pipeline.dispose());
    for (const text of ['A', 'B', 'C']) { await f.send(text); await tick(); }
    assert.deepEqual(f.summaries, ['/A', 'S1/B', 'S2/C']);
    assert.equal(f.hold.value, 'S3'); assert.equal(f.requests.length, 1);
    let stopped = false; const stopping = f.pipeline.stop().then(() => { stopped = true; });
    await tick(); assert.equal(stopped, false);
    for (let i = 0; i < 3; i++) { f.complete(i); await tick(); }
    await stopping;
    assert.deepEqual(f.outputs.map(o => o.values), [1, 2, 3].map(i => ({ source: 'S' + i, text: 'T' + i, error: '' })));
    assert.deepEqual(f.outputs.map(o => o.values.source), f.accepted);
    assert.deepEqual(f.pipeline.errors, []);
  });
}

for (const TranslationNode of [EnglishToJapaneseTranslateGemmaTranslationNode, EnglishToJapaneseOpusMtTranslationNode]) {
  for (const failure of ['model', 'inference']) test(`${TranslationNode.name}: ${failure} failure is visible per job without corrupting feedback`, async t => {
    const f = await translationFeedback({ TranslationNode, failLoad: failure === 'model', failTranslate: failure === 'inference' });
    t.after(() => f.pipeline.dispose());
    for (const text of ['A', 'B', 'C']) { await f.send(text); await tick(); }
    if (failure === 'inference') { f.complete(0); await tick(); }
    await f.pipeline.stop();
    assert.equal(f.hold.value, 'S3'); assert.deepEqual(f.summaries, ['/A', 'S1/B', 'S2/C']);
    assert.deepEqual(f.outputs.map(o => o.values.source), ['S1', 'S2', 'S3']);
    assert.ok(f.outputs.every(o => o.values.error && !Object.hasOwn(o.values, 'text')));
    assert.deepEqual(f.pipeline.errors, []); assert.ok(f.states.some(s => /Translation unavailable/.test(s)));
    assert.ok(f.workers.every(w => w.released));
    assert.equal(f.pipeline.entries.get('translator').work.size, 0);
  });
  for (const mode of ['cancel', 'dispose']) test(`${TranslationNode.name}: ${mode} suppresses active/queued results and permits fresh graph`, async t => {
    const f = await translationFeedback({ TranslationNode }); t.after(() => f.pipeline.dispose());
    await f.send('A'); await tick(); await f.send('B'); await tick();
    assert.equal(f.hold.value, 'S2');
    await f.pipeline[mode](); f.complete(0, 'late'); await tick();
    assert.deepEqual(f.outputs, []); assert.ok(f.workers.every(w => w.released));
    assert.equal(f.pipeline.entries.get('translator').work.size, 0);
    const next = await translationFeedback({ TranslationNode }); t.after(() => next.pipeline.dispose());
    await next.send('C'); await tick(); assert.deepEqual(next.summaries, ['/C']);
    f.complete(0, 'old graph'); next.complete(0, 'fresh'); await next.pipeline.stop();
    assert.equal(next.outputs[0].values.text, 'fresh'); assert.deepEqual(next.pipeline.errors, []);
  });
  for (const bound of ['count', 'chars']) test(`${TranslationNode.name}: ${bound} overload fails translation visibly while feedback continues`, async t => {
    const summaryResult = count => bound === 'chars' && count > 1 ? 'x'.repeat(2000) : 'S' + count;
    const f = await translationFeedback({ TranslationNode, summaryResult }); t.after(() => f.pipeline.dispose());
    const count = bound === 'count' ? 35 : 19;
    for (let i = 0; i < count; i++) { await f.send(String(i)); await tick(); }
    assert.equal(f.summaries.length, count);
    assert.equal(f.hold.value, summaryResult(count));
    assert.equal(f.pipeline.entries.get('formatter').failed, false);
    assert.equal(f.pipeline.errors.length, 1); assert.match(f.pipeline.errors[0].message, /Translation backlog limit exceeded/);
    f.complete(0, 'late'); await tick(); assert.deepEqual(f.outputs, []);
    await assert.rejects(f.pipeline.stop(), /Translation backlog/);
    assert.equal(f.pipeline.entries.get('translator').work.size, 0);
  });
}

for (const TranslationNode of [EnglishToJapaneseTranslateGemmaTranslationNode, EnglishToJapaneseOpusMtTranslationNode]) {
  test(`${TranslationNode.name}: sampled preview branch replaces pending work and keeps committed priority and families`, async t => {
    const f = await translationFeedback({ TranslationNode, preview: true }); t.after(() => f.pipeline.dispose());
    for (const text of ['A', 'B', 'C']) { await f.send(text); await tick(); }
    assert.equal(f.hold.value, 'S3'); assert.equal(f.requests.length, 1);
    assert.equal(f.scheduler.preview.source, 'S3');
    assert.equal(f.pipeline.entries.get('translator').work.size, 2, 'replaced pending preview releases ownership');
    f.commit('committed'); await tick();
    assert.deepEqual(f.outputs.map(o => o.values), [{ provisionalSource: '', provisionalText: '', provisionalError: '' }]);
    f.complete(0, 'obsolete'); await tick(); assert.equal(f.requests[1].text, 'committed');
    await f.send('D'); await tick(); assert.equal(f.hold.value, 'S4');
    f.complete(1, 'final'); await tick(); assert.equal(f.requests[2].text, 'S4');
    f.complete(2, 'preview'); await tick();
    assert.deepEqual(f.outputs.slice(1).map(o => o.values), [
      { source: 'committed', text: 'final', error: '' },
      { provisionalSource: 'S4', provisionalText: 'preview', provisionalError: '' },
    ]);
    assert.deepEqual(f.outputs.map(o => o.provisional), [true, false, true]);
    await f.pipeline.stop(); assert.deepEqual(f.pipeline.errors, []);
    assert.equal(f.pipeline.entries.get('translator').work.size, 0);
  });
}

for (const TranslationNode of [EnglishToJapaneseTranslateGemmaTranslationNode, EnglishToJapaneseOpusMtTranslationNode]) {
  test(`${TranslationNode.name}: translation on a feedback path retains completion until Hold stores the result`, async t => {
    const f = await translationFeedback({ TranslationNode, translatedFeedback: true }); t.after(() => f.pipeline.dispose());
    await f.send('A'); await f.send('B'); await tick();
    assert.deepEqual(f.summaries, ['/A']); assert.equal(f.hold.value, '');
    f.complete(0); await tick(); assert.deepEqual(f.summaries, ['/A', 'T1/B']);
    f.complete(1); await f.pipeline.stop();
    assert.equal(f.hold.value, 'T2'); assert.deepEqual(f.pipeline.errors, []);
  });
  test(`${TranslationNode.name}: Cancel interrupts a Stop waiting for accepted translation`, async t => {
    const f = await translationFeedback({ TranslationNode }); t.after(() => f.pipeline.dispose());
    await f.send('A'); await tick(); const stopping = f.pipeline.stop(); await tick();
    await f.pipeline.cancel(); await stopping; f.complete(0, 'late'); await tick();
    assert.deepEqual(f.outputs, []); assert.deepEqual(f.pipeline.errors, []);
    assert.ok(f.workers.every(w => w.released)); assert.equal(f.pipeline.entries.get('translator').work.size, 0);
  });
}
