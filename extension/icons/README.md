# Extension icon

`icon.svg` is the original, editable master for My Audio to Text: one large white
microphone on a navy rounded square. The capsule, open cradle and short stand
form the only subject. There are no waveform bars, transcript lines, lettering
or speech-bubble tail. The pale rim keeps the tile visible on dark toolbars;
the navy background gives the white microphone strong contrast on either theme.

The artwork is designed first on a **16×16 pixel grid**: the capsule is 4×6 px,
the cradle and stand use 2 px strokes, and a 2 px gap separates the capsule's
bottom from the inside of the cradle. The glyph has 2 px clearance at the top
and bottom. Whole-pixel capsule edges and generous negative space keep its
silhouette recognizable at actual toolbar size. All larger exports use this
same simple design; no details depend on shrinking a large illustration.

Regenerate the four committed PNGs from the repository root:

```sh
npm ci
npx playwright install chromium  # once, if not already installed
node scripts/generate-extension-icons.mjs
```

The script uses the existing Playwright dependency to render the vector directly
at 16, 32, 48 and 128 px with transparency. No font, external image, or additional
graphics dependency is needed. Normal extension builds use the committed PNGs.
To check reproducibility without rewriting the files, run:

```sh
node scripts/generate-extension-icons.mjs --check
```

Use the same Playwright/Chromium version from the lockfile when regenerating or
comparing exports, since rasterization and PNG encoding can vary by browser.

Both manifest icon maps use `extension/icons/icon-<size>.png`, relative to the
**built root manifest** in `dist/chrome-extension/`. The build copies this entire
directory, including the master. These original assets are separate from the
third-party UI symbols under `material-symbols/`.

`npm test` verifies the four separate PNG files, format, exact dimensions,
decoded visual content, manifest mappings, and byte/hash integrity after
packaging. For a prepared production build, the browser check also loads the
extension, decodes every icon, and verifies the native extension-management
image before and after reload:

```sh
npm run build:extension
npm run test:extension -- tests/extension/icons.spec.js
```

See [Issue #345 validation](../../docs/evidence/extension-icon-345.md) for results
and a light/dark preview at native sizes. Human toolbar sign-off is not required.
