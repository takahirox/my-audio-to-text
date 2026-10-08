# Extension model-asset cache (#67)

Build/load the extension as described in [the extension guide](chrome-extension.md).
Open **Extension options** from Chrome's extension menu, or **Details → Extension
options** in `chrome://extensions`. The standalone **Model asset cache** page
does not start tab capture, initialize ASR or translation, or change the toolbar
transcription workflow.

The current demo offers only project-owned `config.json` (46 bytes) and
`weights.bin` (16,384 bytes), **16,430 bytes total**, plus browser storage overhead.
These are packaged deterministic fixtures, not a usable model. Preparation reads
them locally on explicit request; nothing is downloaded on installation or page
opening. No raw text/audio, account token or inference request is sent anywhere.

## Lifecycle and scope

- **Not downloaded** means at least one required file is absent or invalid.
  Each file is shown as Cached or Missing; a partial set is never Ready.
- **Prepare cache / retry** checks existing files, fetches only missing/invalid
  files, shows **Downloading** with byte progress, and reports **Ready** after
  every required file has passed size and hash validation and its write completed.
- **Error** reports network, integrity, quota or storage access failures. Retry
  preserves valid completed files. An interrupted file is fetched from its start;
  there is no HTTP Range/resumable download protocol.
- **Cancel download** or closing/reloading the page interrupts preparation. No
  background worker continues a multi-GB download. Chrome may finish an already
  completed write during teardown; the next inspection validates stored bytes.
- **Check cache** revalidates all files; **Delete cached assets** removes only
  this pinned asset set, leaving other models/revisions intact. Another open
  options page can refresh with Check cache after deletion or eviction.

Cache Storage belongs to this **extension origin and Chrome profile**, separate
from the published Node Playground's website origin. Closing pages or restarting
Chrome normally leaves stored assets available. Keeping the same extension ID
and profile is necessary for reuse; moving an unpacked extension can change its
ID. Incognito/other profiles and other extensions do not share this cache.
Browser eviction, disk pressure, clearing data or uninstalling can remove assets.
Recheck before relying on offline availability; there is no permanent-retention
promise. Offline asset availability also does not establish that future inference
has its required packaged runtime, device capability or memory.

**Request persistent storage** detects `navigator.storage.persisted()` and
`persist()` support and reports the actual granted, denied, unsupported or
unavailable result. It is an optional durability improvement, not a guarantee
against eviction or user deletion. No `unlimitedStorage` permission is added.
See [Chrome extension storage scope and persistence](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
and the [StorageManager API](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist).

## Reusable asset description and API

`extension/model-asset-cache.js` exports `defineAssetSet`, `ModelAssetCache` and
`storagePersistence`. This is a concrete storage service with explicit manifest
and dependency arguments; it introduces no Pipeline routing or global manager.

`defineAssetSet({ id, revision, files })` requires an immutable 40- or 64-character
lowercase hex revision and unique relative file paths. Each required file declares
`{ path, bytes, sha256Chunks }`. The hash list contains one lowercase SHA-256
digest for each consecutive **1 MiB** block, including the final shorter block.
For files smaller than 1 MiB this is the normal full-file SHA-256. Byte sizes and
hashes must come from reviewed, trusted checkpoint assets; do not compute them
from a just-downloaded untrusted response and then treat that as validation.
The returned manifest, files and hash arrays are frozen.

For example, an integration can combine the existing immutable
`web/translation-models.js` ID/revision with a reviewed list of required files:

```js
const manifest = defineAssetSet({ id, revision, files });
const assets = new ModelAssetCache(manifest);
const status = await assets.inspect();
const result = await assets.prepare({ onChange: render, signal });
await assets.remove();
```

The methods return `{ state, files, cachedBytes, downloadedBytes, totalBytes,
error }`. `prepare` emits snapshots through `onChange`; callers may supply an
AbortSignal. `inspect` and `remove` report storage failures as Error snapshots.
Web Locks serialize preparation, checks and deletion for the same manifest
across extension pages; an instance queue serializes its own callers as well.

The single cache is **`transformers-cache`**, matching the pinned Transformers.js
browser cache. Production keys are canonical
`https://huggingface.co/<id>/resolve/<revision>/<path>` URLs, including both model
identity and immutable revision. Future extension translation consumers should
reuse these same keys/cache, not create another weight store. The website's
same-named cache remains a separate origin's storage.

The optional `origin` changes the canonical key origin. `files[].sourceURL`
can override the fetched data source for packaged/local fixtures. The demo uses
`https://extension-model-assets.invalid/.../resolve/<content revision>/...` keys
and `chrome-extension://.../cache-demo/...` sources. The synthetic host is never
contacted: [Cache.put accepts only HTTP(S) keys](https://developer.mozilla.org/en-US/docs/Web/API/Cache/put).
Tests override only source URLs with a loopback fixture server. There is no URL
entry field, runtime manifest loader or remote executable code in the UI.

Downloads are sequential and stream once through a backpressured validator into
`Cache.put`. No response clone/tee or whole-file `arrayBuffer`/`blob` is used by
the service. Hashing uses the browser's SHA-256 with at most a 1 MiB hash buffer
plus incoming chunks and native digest copies, independent of total model size.
The cache implementation still controls its own memory/disk overhead. Readiness
streams and validates the cached body too, catching same-length corruption and
partial entries even when response headers claim the expected size. This trades
disk reads/hash work for correctness; rechecking a multi-GB set will take time.
Failed writes clean up the active file; complete earlier files remain reusable.
Cache API errors are surfaced instead of claiming a successful uncached download.

## Optional large models and terms

The options page remains the #67 fixture demo. The recorder now offers real
OPUS-MT preparation and optional inference through #69; see
[the extension guide](chrome-extension.md#optional-opus-mt-japanese--english-69).
It uses a complete reviewed immutable manifest and a deliberate download action.
TranslateGemma remains outside the extension, and model weights are not bundled.
Keep the pinned IDs, revisions and required files from
[translation nodes](translation-nodes.md); do not use floating `main` URLs.
Remote asset hosts must meet browser CORS/COEP rules under the current MV3 CSP.
The loopback test server sends CORS and CORP headers; it requires no
production host permission or CSP change. Real OPUS delivery and inference are
recorded separately in the #69 evidence;
fixture tests alone do not verify them.

OPUS-MT is approximately **239 MB**, with **CC BY 4.0** attribution to
Helsinki-NLP/OPUS-MT and ONNX Community. TranslateGemma 4B's selected ONNX assets
are approximately **3.112 GB**, subject to Google's
[Gemma Terms of Use](https://ai.google.dev/gemma/terms) and
[Prohibited Use Policy](https://ai.google.dev/gemma/prohibited_use_policy).
Public conversion URLs do not remove upstream terms or grant redistribution
rights. The extension accepts no agreements on a user's behalf, collects no
Hugging Face tokens and redistributes no Gemma weights. See the translation guide
for exact asset sizes and upstream attribution/terms links.

Large downloads use bandwidth and comparable cache space, plus temporary browser
write overhead; decoding later needs additional CPU/GPU memory. Storage estimates
and available disk space cannot guarantee a write will succeed. Quota/network
failures may require freeing disk space or deleting cached models before retry.
There is no default multi-GB download or large-model CI smoke for this issue.

## Automated validation

```sh
npm ci
npm run prepare:assets
npm run prepare:translation-assets # existing Web browser suite prerequisites
npm run build:extension
npm test
npm run test:browser
npm run test:extension
```

Unit tests cover first preparation/progress, all-files readiness, recreation,
partial/interrupted retries, byte/hash corruption, cache eviction/deletion,
quota/network/storage errors, cancellation, immutable keys and persistence
support/results. A multi-block fixture forbids whole-response reads in the
service and measures the maximum native hash input at 1 MiB.

The extension tests load the packaged MV3 extension in isolated Chrome-for-Testing
profiles under its actual CSP. Small deterministic loopback assets exercise
stream progress, offline reuse, interrupted page closure, corruption, eviction,
deletion, failures and concurrent-page Web Locks. Quota exhaustion uses explicit
fault injection into the real Cache API instead of filling the host disk.
Another test uses the unmodified package and its local fixtures and checks that
no capture/inference workers or remote requests start. Page recreation and a
full Chrome context/profile restart retain validated assets without refetching.
This verifies persistence in that test profile across that restart, not
guaranteed long-term retention on every device.

See [Issue #67 validation evidence](evidence/extension-model-cache-67.md).
No post-merge human acceptance gate is required. Optional follow-up work can
measure real device persistence and multi-GB performance separately.
