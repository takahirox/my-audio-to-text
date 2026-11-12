import { test, expect } from './graph-fixture.js';

// Validate the documents users actually reach, including provenance that used to
// appear inline. A bare upstream license URL cannot supply these attributions.
const notices = {
  reazon: ['ReazonSpeech', 'epoch 35', 'Apache'],
  silero: ['Silero Team', 'MIT', 'silero-vad.txt'],
  whisper: ['OpenAI', 'ONNX conversion', 'whisper.txt'],
  zipformer: ['csukuangfj', 'icefall', 'sherpa-onnx.txt'],
  'kokoro-japanese': ['Nagoya Institute of Technology', 'MMDAgent', 'CC BY 3.0'],
  'qwen3-tts': ['Qwen Team', 'Danyal Malik', 'speech decoder', 'model-LICENSE'],
  cosyvoice3: ['FunAudioLLM', 'Danyal Malik', 'Koizumi', '4446', 'CC BY 4.0', 'cosyvoice3-LICENSE'],
  'meeting-summary-lfm2': ['Liquid AI', '$10M', 'redistribution', '01b5a0a33d22253d5ee52b367d2375eeb113b7cd'],
  'meeting-summary-qwen35': ['Qwen Team', 'ONNX Community', 'ed446636739bf426e73c5a00714fd8e010d36c21', 'Apache License'],
  'if-condition': ['Moritz Laurer', 'Microsoft', 'MIT License'],
  'parakeet-v3': ['NVIDIA', 'ysdede', 'istupakov', 'parakeet-v3-attribution.md', 'CC BY 4.0'],
  'moonshine-medium-en': ['Useful Sensors', 'Moonshine AI', 'MIT', 'moonshine-third-party.txt', 'available-models/'],
  'opus-ja-en': ['Helsinki-NLP', 'ONNX Community', '05470cd69b62aa32e3ee64ccfd41279789ee4b1e', 'creativecommons.org/licenses/by/4.0/'],
  'opus-en-ja': ['Helsinki-NLP', 'Kadonox', '225fd3c2970d899c05b4ddde2fdeda2ffdc8a69e', 'Apache License'],
  translategemma: ['Google', 'ONNX Community', 'ai.google.dev/gemma/terms', 'ai.google.dev/gemma/prohibited_use_policy', 'Redistributors'],
  supertonic3: ['Supertone Inc.', 'OpenRAIL-M', 'supertonic-model.txt'],
  kokoro: ['hexgrad', 'jf_alpha', 'af_heart', 'Apache-2.0', 'kokoro-japanese.txt', 'GPL-3.0-or-later', 'phonemizer-source.tar.gz'],
};

test('every card has one collapsed Details with working attribution, license and source destinations', async ({ graphExtension: f }) => {
  const page = await f.context.newPage();
  await page.goto(f.url.replace('recorder.html', 'model-cache.html'));
  await expect(page.locator('.model-card[data-state="Not downloaded"]')).toHaveCount(17);
  await expect(page.locator('.model-card details')).toHaveCount(17);
  await expect(page.locator('.model-card summary')).toHaveText(Array(17).fill('Details'));
  await expect(page.locator('.model-card details[open], details details')).toHaveCount(0);
  await expect(page.getByText('Attribution & notices', { exact: true })).toHaveCount(0);
  const checked = new Map();
  for (const [id, required] of Object.entries(notices)) {
    const card = page.locator(`#${id}`), details = card.locator('details');
    await expect(card.locator('li').first()).toBeHidden();
    await expect(details.locator('.model-license')).toBeHidden();
    await card.locator('summary').click();
    await expect(details.getByRole('heading', { name: 'Verified files and size' })).toBeVisible();
    await expect(details.locator('li').first()).toContainText('Missing');
    await expect(details.locator('p').first()).toContainText('0 bytes verified cached');
    const link = details.locator('.model-license a').first();
    await expect(link).toBeVisible();
    const url = await link.evaluate(a => a.href);
    if (!checked.has(url)) {
      const doc = await f.context.newPage();
      await doc.goto(url);
      checked.set(url, await doc.locator('body').innerText());
      await doc.close();
    }
    for (const text of required) expect(checked.get(url).toLowerCase(), `${id}: ${text}`).toContain(text.toLowerCase());
    await card.locator('summary').click();
  }
  const gemma = page.locator('#translategemma');
  const before = gemma.locator(':scope > .model-license');
  await expect(before).toBeVisible();
  await expect(before).toContainText('Prohibited Use Policy');
  const terms = before.getByRole('link', { name: 'Gemma Terms of Use' });
  await expect(terms).toBeVisible();
  await expect(terms).toHaveAttribute('href', 'https://ai.google.dev/gemma/terms');
  const policy = before.getByRole('link', { name: 'Prohibited Use Policy' });
  await expect(policy).toBeVisible();
  await expect(policy).toHaveAttribute('href', 'https://ai.google.dev/gemma/prohibited_use_policy');
  expect(await before.evaluate(p => !!(p.compareDocumentPosition(p.parentElement.querySelector('.actions')) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(page.locator('.model-card > .model-license')).toHaveCount(1);
  await expect(page.locator('footer')).toHaveCount(0);
  expect(f.requests).toEqual([]);
});

test('Details supports keyboard and touch, keeps focus and fits desktop and narrow cards', async ({ graphExtension: f }, info) => {
  const page = await f.context.newPage();
  await page.goto(f.url.replace('recorder.html', 'model-cache.html'));
  const card = page.locator('#kokoro'), summary = card.locator('summary'), details = card.locator('details');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await summary.focus(); await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    await expect(summary).toHaveCSS('outline-style', 'solid');
    expect((await summary.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press('Tab');
    await expect(details.locator('a').first()).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(details.getByRole('link', { name: /eSpeak NG source/ })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.screenshot({ path: info.outputPath(`details-${width}.png`) });
    await summary.focus(); await page.keyboard.press('Space');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(summary).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement.closest('details'))).toBe(false);
  }
  const touch = await f.context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await summary.scrollIntoViewIfNeeded();
  const box = await summary.boundingBox();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(details).toHaveAttribute('open', '');
  await page.reload();
  await expect(page.locator('details[open]')).toHaveCount(0);
});
