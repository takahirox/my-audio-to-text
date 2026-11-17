# PLaMo 3 Translate 2B browser evidence (#385)

Measured November 17, 2026 on an Apple M4 Max Mac with 64 GiB RAM. This is actual
official 2B Q4_K_M inference, not a deterministic runtime fixture. The pinned model,
hash, capabilities and exact outputs are in [the measurement record](plamo-385.json).
These short samples establish operation, not general translation quality.

## Standalone Chrome

Chrome **157.0.8103.52**, CPU WASM, single thread, JSPI, localhost, no isolation
headers. The production Playground, Node, Worker, PFML3 policy and verified cache
ran unchanged. The 1.81 GB official model downloaded through the browser from the
pinned Hugging Face revision, exercising redirects, CORS and streamed chunk hashes.
Fresh download plus initialization took **155,076 ms**, first inference **5,377 ms**.
Subsequent fresh Workers reused cached bytes without remote requests.

| Input / accepted language config | Exact generated output | Cached initialization | Inference / drain |
| --- | --- | ---: | ---: |
| 会議は来週の月曜日に変更されました。 / source omitted, target omitted | The meeting has been rescheduled for next Monday. | 5,282 ms | 5,469 ms |
| The weather is nice today. / en → ja | 今日はいい天気だ。 | 5,031 ms | 4,644 ms |
| Please open the project dashboard. / auto → ja | プロジェクトダッシュボードを開いてください。 | 4,943 ms | 4,186 ms |

The repeat smoke canceled after actual inference became ready, verified via CDP
that both dedicated Workers disappeared, then retried successfully from cache.
No page errors occurred. Network assertions passed: GET-only asset traffic,
no input strings in URLs/bodies, no remote assets during cached repeats.

An initial incognito-profile attempt failed with Cache.put's “Unexpected internal
error” before inference; it is not counted as a successful run. The dedicated
disk-backed Chrome test profile successfully downloaded, verified and reused the
file (10 GiB initial reported quota). Browser storage mode/device availability
remain practical limits; the application surfaces the failure and permits retry.

## Packaged extension

Chromium **153**, real unpacked `dist/chrome-extension`, existing MV3 CSP
`script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'`, COOP/COEP isolation.
The production graph builder, Text.value language connections, scheduler, cache-only
Worker and packaged static WASM child all ran with actual weights. The test changes
only the manifest's download `sourceURL` to a loopback **static asset** server,
serving the same official GGUF; every production hash and canonical cache key stays
unchanged. There is no inference server, native helper, model substitution or cloud
AI call. The standalone test above independently verifies actual WAN/CORS delivery.

Final cache verification/preparation: **1,999 ms**; Worker/model initialization:
**4,855 ms**. One Worker translated the same three samples with accepted configs
auto/en, en/ja, auto/ja. Outputs were identical to the table above; inference times
were **6,734 ms**, **5,446 ms**, **4,960 ms** respectively. Stop drained accepted
work; dispose released ownership. State messages were only loading/ready, and
there were no configuration, model or page errors. Concurrent UI tests were running
on this machine, so these measurements are not isolated performance benchmarks.

## Automated checks

- Full Node unit suite: **976 passing**, including language snapshots, real graph constant ports,
  grouped omissions/IDs, preview jobs, invalid-code recovery and cancellation.
- Four PLaMo native browser Worker/cache tests pass with deterministic tiny assets:
  both directions, no eager download, repeat, invalid configuration, cancel during
  load/inference, pagehide, corrupt bytes, retry and cache-only eviction.
- Existing OPUS-MT/TranslateGemma and standalone model tests pass on Chromium.
- PLaMo palette/search/sparkles/ports/inspector, save/reload, license links and
  production extension Worker/cache tests pass. Existing translation-port and
  TranslateGemma extension tests pass.
- Official asset review compared the upstream LFS SHA-256, all 1 MiB hashes,
  retained PFML3 template and both full license files successfully.
- Extension build verified 227 packaged files and **zero model weights**.

The broader selected extension run had 33 passing tests and four failures. The
Models layout failure was an old 13-card expectation; updating the count for the
new card made that test pass. The other three failures were reproduced unchanged
against upstream checkpoint `d0890f2`: `graph.spec.js`'s fresh-install test expects
the old “assets missing” diagnostic where Live now reports preparation's
“Invalid response for config.json”, and both Supertonic3/Kokoro visual tests expect
that old text in `#tts-status` although preparation fails before TTS startup.
Those three pre-existing assertions are retained; no unrelated production behavior
was changed to accommodate them. The PLaMo, model inspection/persistence/details,
translation-port and TranslateGemma suites passed. The full extension suite was
not exhaustively run, and no OPUS/PLaMo/TranslateGemma quality comparison is claimed.

Commands and reproduction are documented in [the implementation guide](../plamo-translation.md).
