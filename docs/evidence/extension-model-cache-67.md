# Issue #67 validation evidence

Validated 2026-10-08 on macOS 26.6.2, Node.js 24.12.0, Python 3.13.13,
Playwright 1.63.0 and Chrome-for-Testing **153.0.8010.12**. All extension tests
used newly created isolated profiles and the packaged MV3 manifest/CSP.

| Check | Result |
| --- | --- |
| `npm ci` | Passed; no vulnerabilities reported |
| `npm run prepare:assets` | Passed; existing pinned ReazonSpeech ja-en/Silero package staged |
| `npm run prepare:translation-assets` | Passed; existing pinned Web runtime staged, no translation weights downloaded |
| `npm run build:extension` | Passed; ASR package retained, translation runtime excluded |
| `npm test` | **129 passed**, including 17 model-cache unit tests and packaging checks |
| `npm run test:browser` | **136 passed**, 10 expected opt-in smoke/benchmark skips; Chromium and WebKit |
| `npm run test:extension` | **27 passed**; 19 existing transcription tests plus 8 cache tests |
| Final focused cache extension run | **8 passed** after refining lock identity/error handling and eviction snapshots |

The real extension cache lifecycle tests used a loopback server with two
deterministic files totaling **16,430 bytes**. The test copy overrides only the
manifest's data source URLs; permission/CSP entries, scripts, immutable keys,
sizes and SHA-256 chunk digests remain those of the package. An additional test
loads the unmodified package with its packaged data sources.

Observed acceptance evidence:

- Opening the cache options page makes no model-asset requests until Prepare.
  Downloading includes intermediate byte progress; Ready requires both valid
  cached files, and the UI distinguishes Cached from Missing.
- Closing and recreating the extension page detects Ready; preparation performs
  no repeated requests. Closing the complete Chrome context and relaunching with
  the **same isolated profile and extension ID** also detects Ready without
  asset requests. Preparation still reuses the complete cache when offline.
- Closing a page during the second streamed file retains only the validated
  first file. Reopening detects Not downloaded; retry requests only the missing
  second file. Explicit cancellation follows the same retry path.
- Wrong-size downloads, same-length hash corruption, interrupted streams,
  network failures and injected quota failures report Error and permit retry.
  A corrupt cached body is removed on inspection despite a plausible size.
- Evicting a file produces Not downloaded with correct per-file status. Unit
  tests also evict during preparation and verify Error with missing files.
  Deletion reclaims the selected set and preserves unrelated cache entries.
- Concurrent extension pages share an origin Web Lock and fetch each required
  file once. Lock keys include origin, model and revision independently of file
  ordering; lock failures produce Error snapshots.
- A fixture spanning multiple 1 MiB hash blocks verifies stream boundary handling
  and a maximum native digest input of **1 MiB**. Service code never calls a
  whole-response `arrayBuffer`/`blob` or tees/clones a downloaded model body.
- The unmodified packaged options page sends only extension-local requests,
  starts no capture/ASR/translation workers, and reports the browser's actual
  persistent-storage grant/denial. Unit tests cover unsupported/exception cases.
- Existing native toolbar tab capture, repeat/retarget/teardown and real pinned
  ReazonSpeech/Silero initialization all pass under MV3 CSP. No host/storage
  permissions or CSP changes were added; only a separate `options_ui` was added.

Quota exhaustion is deliberately fault-injected into `Cache.put`; the tests do
not fill the device's disk. Profile reuse across this tested restart establishes
test-profile persistence, **not guaranteed permanent retention**. No OPUS-MT or
TranslateGemma weights, multi-GB model smoke, remote inference, real-device
long-term retention or multi-GB performance test was performed. Those are
outside this cache-foundation issue, with no required post-merge human gate.
