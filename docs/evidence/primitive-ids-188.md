# Issue #188 validation

Removed the producer/output-family connection restrictions added by #187 from
current graph validation and execution selection, and removed grouped-only
runtime errors from the scheduler, standalone translators, paired formatter and
keyed DOM history. The original #186 change was reviewed for other primitive
producer checks; no new allowlists or connection modes remain. Legacy migration
validation predating #187 is unchanged.

The [input rules](../keyed-dom-history.md#independent-primitive-inputs-188) specify
ID-first, payload-first, missing IDs, ID changes, duplicate/empty payloads and
optional atomic delivery. Translators snapshot the current ID or its absence per
job; ID-only changes never replay accepted text. DOM consumers buffer only
unidentified payloads and never reassign already-emitted payloads on ID changes.
Finite numeric keys include negatives, decimals and values outside the safe
integer range, without coercion. Numeric Map equality and slot precedence remain
local to history.

Validation:

- `npm test`: **879 passed**. Includes exhaustive same-contract routes into the
  affected Nodes; independent Number connections for all four graph translators,
  paired formatter and all history slots; saved graph round trips; unavailable
  optional ID producers; buffered payload ownership; independent slot state;
  atomic property order; missing atomic metadata; queued/running ID snapshots;
  empty and repeated payloads; errors; existing continuous/interleaved ASR rows;
  delayed lower-precedence branches; no blank finalization gap; Stop/Cancel and
  fresh Start. Existing ID-less paired formatter tests remain passing.
- Chromium `tests/browser/keyed-dom.spec.js`: **4 passed**, including explicit
  ID-first and payload-first Number/TEXT/DOM delivery with module Worker results,
  plus existing immediate/held translation cases.
- Chromium `dom-display`, `text-display`, `translation-ports`: **16 passed**,
  covering native DOM, independent paired text, preview routing and saved graph
  compatibility/recovery.
- MV3 `tests/extension/keyed-dom.spec.js`: **3 passed**, including the saved graph
  with independent Number IDs, all three history slots, negative/fractional
  keys, later ID changes, empty text, Stop and reload. Existing queued ASR,
  Cancel/restart and unfinished translation branch scenarios remain passing.
- `git diff --check`: passed.

Browser tests used installed Chrome for Testing **156.0.8078.4**, exposed to
Playwright 1.63 through a worktree-local ignored cache mapping. The pinned browser
revision was unavailable and its installer waited on a shared cache lock; the
worktree's waiting installer was stopped. Global browser caches were unchanged.
WebKit was unavailable and was not run.

MV3 used a fixture-only package assembled from production `extension/` files and
the builder's `SHARED_FILES`; existing fixtures supply deterministic inference
Workers. Native MV3 pages and actual module Worker boundaries ran. `npm test`
also validates the production builder using pinned asset fixtures.

`npm run build:extension` stops at `Missing local models. Run npm run
prepare:assets first.` Prepared model assets are absent, so the full model-bearing
package and real inference smokes were not run. No model, prompt or inference
implementation changed. No push, PR, merge or GitHub comment was performed.
