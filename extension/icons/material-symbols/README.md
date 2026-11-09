# In-page voice typing icons

Copyright Google LLC. Material Symbols, licensed under Apache-2.0; see the
unmodified upstream [LICENSE](LICENSE) included in this directory.

Source: https://github.com/google/material-design-icons
Pinned revision: `10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7`.
Guide: https://developers.google.com/fonts/docs/material_symbols

The four SVG files are unmodified upstream downloads from
`symbols/web/{name}/materialsymbolsoutlined/{name}_20px.svg` at that revision:
`mic`, `stop`, `error`, and `progress_activity`. All use Outlined, optical size
20dp, weight 400, fill 0, grade 0, and the same `0 -960 960 960` viewBox.

`extension/web-voice-content.js` embeds their path data in locally constructed
inline SVGs, adding `currentColor` styling and decorative accessibility
attributes. Preparing/stopping rotate `progress_activity` with CSS, with animation
disabled for reduced motion. Tests compare the embedded paths with these originals.
There are no runtime resource requests, fonts, or web-accessible asset permissions.

The build copies the entire extension directory, including these originals,
this attribution, and the Apache-2.0 license, into the extension distribution.
