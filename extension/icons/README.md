# Extension icon

`icon.svg` is the original, editable master for My Audio to Text: a mint audio
waveform flows into white transcript lines on a navy speech tile. The pale rim
keeps its silhouette visible on dark browser themes. The short, rounded strokes
and generous gaps are designed on a 16 px grid for toolbar legibility.

Regenerate the four committed PNGs from the repository root:

```sh
npm ci
npx playwright install chromium  # once, if not already installed
node scripts/generate-extension-icons.mjs
```

The script uses the existing Playwright dependency to render the vector directly
at 16, 32, 48 and 128 px with transparency. No font, external image, or additional
graphics dependency is needed. Normal extension builds use the committed PNGs.

Both manifest icon maps use `extension/icons/icon-<size>.png`, relative to the
**built root manifest** in `dist/chrome-extension/`. The build copies this entire
directory, including the master. These original assets are separate from the
third-party UI symbols under `material-symbols/`.

After rebuilding, reload the unpacked extension in `chrome://extensions` and pin
**My Audio to Text** to inspect its toolbar icon. Check all four PNGs at their
native sizes on light and dark backgrounds when changing the artwork.
