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

## Thirty-minute durability run

For a release candidate, record at least 30 minutes with audio retention enabled. During a second run, terminate the process after at least ten minutes, relaunch, and confirm:

- the session appears as `INTERRUPTED`;
- committed transcript through the last completed chunk is readable;
- `audio.wav` and rolling chunks exist under the session directory;
- a synthesis failure or missing LLM model does not affect the transcript;
- peak memory remains stable enough for the target Apple Silicon machine.

Record model names, executable versions, machine/RAM, segment count, recovered end timestamp, synthesis latency, and peak memory with the release evidence. Model-quality claims are intentionally a measured release gate, not a deterministic unit-test assertion.
