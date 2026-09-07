# V1 Acceptance Guide

## Automated offline gate

Run:

```bash
./scripts/verify.sh
```

This builds both debug and release configurations without network access and verifies:

- conservative Japanese/English filler removal without deleting context-sensitive terms;
- replacement of unstable partial output and idempotent final commits;
- rejection of partial persistence, ordinal gaps, invalid timestamps, and unknown evidence;
- per-segment SQLite durability and interrupted-session recovery;
- feedback revision persistence across restarts, source immutability, version 1 database migration, speech conditions, retained-audio references, and complete JSONL export;
- context-matched correction memory, independent-session support, conflict/ambiguity abstention, version 2 database migration, audited personalized runs, and enabled/disabled ASR pipeline behavior;
- reproducible baseline/personalized CER evaluation with per-condition results and session-overlap rejection;
- real-audio manifest/audio integrity, session/prompt/PCM leakage checks, Raw/Clean separation, explicit incomplete runs, adapted-result import, and nested group learning curves through the real Swift ASR bridge with a generated non-speech fixture;
- parsing the current whisper.cpp full JSON shape, offsets, confidence, and empty segments;
- FULL synthesis behavior, revisions, context overflow refusal, and evidence validation;
- regeneration of Markdown, JSON, and action outputs from one source model.

## Local model smoke test

1. Build and open the app with `./scripts/build-app.sh`.
2. Configure a multilingual whisper.cpp model and dictate Japanese for at least one minute.
3. Confirm italic partial text changes in place while Raw Transcript grows only after final chunks.
4. Stop with a text editor focused. Confirm paste, or confirm the exact Clean Transcript is on the clipboard when Accessibility is unavailable.
5. Start a Thinking Session, express a tentative idea, change it later, state a decision, and state an open question.
6. Stop and run FULL synthesis with a local instruct model. Confirm the revision retains both positions and the tentative idea is not labeled as a decision.
7. Switch among Raw, Clean, detailed notes, actions, and JSON; confirm the source levels remain unchanged.

## Personalization smoke test

1. Finish a transcription and open **Corrections**. Confirm the editor starts with Clean Transcript.
2. Correct an error, choose a speech condition, and save. Confirm Raw, Clean, and existing outputs remain unchanged.
3. Save another revision, switch sessions, then return and select an earlier saved correction.
4. Quit and relaunch. Select the session and confirm the latest saved correction and condition load.
5. Export all corrections and confirm one JSON object per line, including both revisions and source segment metadata.
6. Repeat with audio retention off; exported samples must omit audio paths. With retention on, the referenced session recording must exist.
7. While transcription finishes, confirm session switching and correction saving are disabled.

## Correction-memory smoke test

1. Save the same recognition correction in two separate sessions, preserving the transcript's line breaks and surrounding context.
2. Enable **Settings → Personalization → Use correction memory for new recordings** and save settings.
3. Record another utterance with the same mistaken term and context. Confirm **Personalized** shows the correction and its evidence count; **Clean Transcript** still shows the baseline.
4. Confirm Quick Dictation inserts the personalized result, and Copy copies the currently selected tab.
5. Save feedback on the new session, restart, and verify the personalized run and original Raw/Clean data reload separately.
6. Disable personalization and repeat. The new run must show the baseline; older runs remain unchanged.
7. Try an unrelated use of the same text and a context with ambiguous/conflicting corrections. Confirm no unsupported replacement occurs.

## Thirty-minute durability run

For a release candidate, record at least 30 minutes with audio retention enabled. During a second run, terminate the process after at least ten minutes, relaunch, and confirm:

- the session appears as `INTERRUPTED`;
- committed transcript through the last completed chunk is readable;
- `audio.wav` and rolling chunks exist under the session directory;
- a synthesis failure or missing LLM model does not affect the transcript;
- peak memory remains stable enough for the target Apple Silicon machine.

Record model names, executable versions, machine/RAM, segment count, recovered end timestamp, synthesis latency, and peak memory with the release evidence. Model-quality claims are intentionally a measured release gate, not a deterministic unit-test assertion.
