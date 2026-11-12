#!/usr/bin/env node
// Rasterize the editable vector directly at each target size; no scaled bitmaps.
import { chromium } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';

const directory = new URL('../extension/icons/', import.meta.url);
const svg = await readFile(new URL('icon.svg', directory), 'utf8');
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const png = await page.evaluate(async ({ svg, size }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(image, 0, 0, size, size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { svg, size });
    await writeFile(new URL(`icon-${size}.png`, directory), Buffer.from(png, 'base64'));
  }
} finally {
  await browser.close();
}
