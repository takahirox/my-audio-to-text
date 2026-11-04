# Issue 205 post-merge verification

PR: https://github.com/takahirox/my-audio-to-text/pull/209

Reviewed head: `4af9a7e9aa79d168aeeec765992bb1b17bb11a8d`.
Merge commit: `e7003a451942d5e4ce99783fd5d96ef481e9488a`.

Verification performed on 2026-11-04. GitHub independently confirmed the PR was
merged with this head and merge commit. Current-main development-flow and review
guidelines matched the instructions read in this worktree.

## Results

- **Passed:** [Pages run 41825664856](https://github.com/takahirox/my-audio-to-text/actions/runs/41825664856), triggered by the exact merge commit, completed successfully, including build and deployment.
- **Passed:** HTTPS 200 and byte-for-byte agreement for 13 relevant published files, including the index, three translation pages, translation Workers, translation nodes, Pipeline, TextWindow, Display, text utilities and port contracts. See [hash record](translation-205-published-files.json). Pipeline, Display, translation nodes and TextWindow were also compared directly with the raw files at the actual merge commit. Local web/extension source has no differences from the reviewed remote head.
- **Passed:** `npm ci`, zero reported vulnerabilities.
- **Passed:** `ASR_BASE_URL=https://takahirox.github.io/my-audio-to-text/ TRANSLATION_CHANNEL=chrome npx playwright test tests/browser/translation.spec.js --project=chromium --workers=2 --reporter=line`: 18 passed in 41.5 seconds. Tests use actual published pages, nodes, Pipeline and native Worker adapters with controlled heavy inference. Coverage includes navigation, repeated translation, resource disposal, visible load/inference failures and retry, cancellation during loading/inference, stale output suppression, token bounds and unsupported WebGPU handling.
- **Passed:** `node docs/evidence/translation-205-published-preview.mjs > docs/evidence/translation-205-published-preview.json`: four translator variants, each checking Stop and Cancel runs, committed history, separate previews, clearing before final completion, stale-result suppression, restart, unchanged saved JSON and released Workers. See [results](translation-205-published-preview.json).
- **Passed:** `git diff --check`.

The preview check fetches shared web modules from Pages. Pages does not host the
extension UI or translation scheduler, so it supplies the reviewed extension
adapter source locally through request interception and uses controlled native
Worker replies. It does not establish an installed extension deployment or real
model inference. The published-page suite likewise controls the model runtime;
its TranslateGemma GPU availability is simulated in the real Worker.

Earlier unit/browser/MV3/build evidence is retained in the [merge handoff](translation-205-merge.md),
[continuation](translation-205-continuation.md) and [original results](translation-205.json).
Those suites and the full asset-backed extension build were not repeated here.
The original real TranslateGemma WebGPU smoke was skipped; real-model inference
remains unverified. No model/runtime pins, implementation, graph settings,
provider settings, port 8765 or unrelated Projects were changed.

Required post-merge deployment and controlled translation/lifecycle checks are
complete. The Issue outcome is recorded on GitHub and closure references PR #209.

GitHub outcome: [verification comment](https://github.com/takahirox/my-audio-to-text/issues/205#issuecomment-6630126142)
was posted, Issue #205 was closed as completed, and the PR's pending post-merge
section was updated with the results and limitations. A final Issue read confirmed
closed state. No implementation publication or additional merge was performed.
