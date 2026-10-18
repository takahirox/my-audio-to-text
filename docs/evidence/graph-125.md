# Issue #125 validation

Implementation and validation performed on 2026-10-18. No post-merge-only check
is required. The implementation stage performed no push, PR, merge or GitHub
comment; publication-stage validation is recorded below.

## Real inference

`npm run prepare:if-condition-test-model` verified all five immutable files
against the committed byte/chunk hashes. `npm run build:extension` passed and
packaged the runtime with unchanged MV3 CSP/permissions. The dedicated smoke:

```sh
npm run test:if-condition-real -- --output=.cache/if-condition-real-results
```

passed **1/1** in **4.7 seconds**. It used the actual pinned XtremeDistil q8 ONNX
weights, tokenizer, packaged Transformers.js/ONNX Runtime WASM backend and owned
production Worker in a loaded Chrome extension. Only upstream audio/ASR was a
fixture, delivering strings at the ordinary final TEXT port. Save performed
asset preparation through the production cache using a loopback source for the
same checksum-pinned data; the model manifest's sizes/digests were unchanged.
There was no runtime/model replacement and no rule-based classifier in this run.
Networking was then disabled for loading and all inference. **Zero HTTP attempts
and zero observed CSP violations** were recorded. No inference Worker existed
at Save, and a second Save reused cached data without another download.

Machine: Apple M4 Max, macOS arm64, Playwright Chromium 153, cross-origin isolated.
Raw result: [graph-125-real.json](graph-125-real.json).

| Observed quantity | Result |
| --- | --- |
| Model/config/tokenizer data | 13,826,967 bytes |
| ONNX weights | 13,114,198 bytes |
| Cold session startup (integrity check + runtime/model + fixture source) | 805 ms |
| Later fresh-Worker session startups | 281–286 ms |
| First input in each Worker, end-to-end including browser-test observation | 78–87 ms |
| Later nonempty decisions, end-to-end including observation | 26–27 ms |
| Empty text (defined No policy, no inference) | 3 ms |
| Two independent conditions, eight queued inputs, Stop/drain including startup | 879 ms |

English smoke pairs were `What time does the meeting begin?` → Yes and
`The meeting begins at noon.` → No for `Is this a question?`; a delighted gift
review → Yes and an awful product review → No for positive sentiment. Leading
whitespace/newline, repeated identical strings, empty text, condition changes and
repeat sessions were preserved. Two simultaneous instances evaluated the same
queued question/statement text with independent question/animal conditions:
the question instance selected Yes/No, the animal instance selected No for every
input. Stop drained all eight jobs through both instances, and all Workers were
released. No result was emitted to the opposite branch.

These timings are observations, not guaranteed latency, isolated kernel
benchmarks or broad performance/accuracy evaluation. No multilingual quality or
small-device memory guarantee is established. Early exploratory probes observed
wrong answers to some English question forms, including `Can you help me?` under
`Does this text ask a question?`. The 0.55 score threshold is an uncalibrated
uncertainty policy, not a semantic correctness guarantee. See the
[Node documentation](../if-condition-node.md) for these constraints and the
selection rationale. Larger models were explored but are not shipped as fallback
backends.

## Deterministic and regression checks

- `npm test`: **377 passed, zero skipped**. Includes new Node FIFO/lifecycle,
  timeout/backlog, uncertainty, invalid inference, original text, repeat/empty,
  independent-instance and stale-callback checks; v9 persistence/editor/runtime
  fan-out checks; real binary logit policy and immutable asset bounds. Existing
  graph, migration, Node and packaging checks are included.
- Packaged deterministic IfCondition tests retain production graph, cache,
  Worker, input bounds and score policy. Only model/runtime inference is replaced
  by explicitly controlled fixture scores. They cover add/configure/save/reload,
  both branch wires, cache corruption, cancel/retry/reuse, no Save inference,
  empty/repeated/verbatim output, uncertainty, token overflow, inference failure,
  missing cache/backend, independent peer-path safety and Cancel during Stop
  followed by restart. These tests are not real-model accuracy evidence.
- `npm run test:extension`: **157 passed, zero failed, 12 opt-in skips** in
  **5.7 minutes**. The IfCondition real smoke is one of these default skips and
  passed separately with its opt-in flag above. The other 11 opt-in smoke checks
  were not run. Existing graph/migration, audio, Node, translation, TTS fixtures,
  capture/field-output and Models regressions passed.
- `python3 -m py_compile` passed for build and both IfCondition preparation/review
  scripts. `git diff --check` passed. The manifest reproduction script produced
  the same 13,826,967-byte asset set.

Other real ASR/TTS/browser hardware smoke suites are opt-in and were not claimed
as run for this text-processor change. The upstream fixture does not verify
microphone/tab-capture hardware or ASR accuracy. Two initial real-smoke runs were
interrupted while a fixture's overlapping canvas nodes blocked its settings
click; their partial progress was not counted as inference acceptance. The
corrected fixture and completed real smoke above provide that evidence.

## Integration before PR publication

Merged `main` at `6d6b86d849e109fe5a98ea6f87eb0085534580df` (TranslateGemma
PR #126) into the Issue #125 branch. Resolved additive conflicts in the graph
Node catalog, Models imports and session options/status handling, retaining both
IfCondition and TranslateGemma behavior. The PR diff remains limited to #125.

After `npm ci`, `npm test` passed **408/408**, with zero failures or skips, and
`git diff --check` passed. The initial unit run before dependency installation
had one failure because the optional ASR packaging test needs installed npm
sources; installation resolved it. Extension build/browser and real-model checks
were not repeated in this fresh publication worktree, which lacks the prepared
vendor/model assets. Their results above apply to the implementation revision,
not to a new run after the integration merge.
