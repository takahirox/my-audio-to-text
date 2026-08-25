# V1 Specification

## Acceptance criteria

- Runs on Apple Silicon macOS.
- Starts microphone dictation from a global shortcut.
- Displays unstable realtime ASR separately from committed transcript.
- Persists final raw transcript segments incrementally.
- Produces a conservative clean transcript without semantic rewriting.
- Exposes clean text independently for copy/use.
- Can optionally produce polished text through a local LLM backend.
- Attempts focused-app insertion with clipboard fallback.
- Supports a Thinking Session of at least 30 minutes without losing prior committed transcript if later processing fails.
- Sends the complete clean transcript to the LLM for V1 FULL synthesis when context capacity permits.
- Produces title, summary, topics, ideas, decisions, open questions, action items, revisions, examples, and notable points.
- Important synthesis items reference source transcript segment IDs.
- Core workflow works offline after models are installed.

## Synthesis quality tests

Evaluate representative 30-minute Japanese sessions for:

1. recall of important ideas;
2. distinction between idea and decision;
3. detection of changed/retracted positions;
4. preservation of uncertainty;
5. unsupported claims/hallucinations;
6. evidence-reference validity;
7. runtime and peak memory on representative Apple Silicon hardware.

Only introduce a chunked synthesis strategy if FULL fails measured quality or resource targets.

## Recovery rule

Audio persistence and final transcript persistence have higher scheduling priority than cleaning, rewriting, or synthesis. LLM latency must never stop recording.
