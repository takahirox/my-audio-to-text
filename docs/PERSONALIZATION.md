# Personalization feedback

After finishing Quick Dictation or a Thinking Session, open **Corrections**. Review the Raw and Clean tabs, edit the corrected transcript, select `normal`, `quiet`, `whisper`, or `unknown`, and click **Save correction**. Choose the condition that describes the recording; use `unknown` for mixed or uncertain conditions. Empty corrections are allowed to label an ASR hallucination.

Every save appends a revision. The latest saved correction loads when selecting a session after restarting; **Saved corrections** also loads earlier revisions into the editor. Unsaved drafts survive switching sessions during the current app run, but must be saved before quitting. Interrupted or failed sessions with committed segments can also receive feedback; recording/processing sessions cannot.

Feedback is local to this installation in `sessions.sqlite3`, in a dedicated `personalization_feedback` table. Schema version 2 adds this table transactionally when opening an existing version 1 database; version 3 adds separate personalization run audits. Raw/Clean segments, synthesis, and polished output remain unchanged. Saving does not train a model. When [correction memory](issue-6/README.md) is enabled, saved feedback can influence subsequent recordings.

## Corpus and export

**Export all corrections…** writes the entire corpus, including earlier revisions and sessions outside the visible history, to UTF-8 JSONL. It streams samples in insertion order and replaces the destination only after writing successfully. Each line contains:

- `schemaVersion` (currently `1`), unique sample `id`, source `sessionID`, and `createdAt` (ISO 8601 UTC in exports);
- `rawTranscript`, `cleanTranscript`, and `correctedTranscript`;
- `speechCondition`;
- `audioPath`, when audio retention was enabled for the source session (otherwise absent);
- `sourceSegments`: the original IDs, ordinals, raw/clean text, millisecond offsets into session audio, speaker, status, and optional segment confidence already retained by ASR.

The audio reference points to the existing recording; export does not copy audio. Moving a corpus to another machine requires separately relocating retained audio and resolving paths. Without retained audio, corrections can support text-based experiments but cannot provide acoustic training samples. Existing sessions keep their original retention policy when the current setting changes.

The public `AudioTextCore` API also provides:

```swift
let store = try SessionStore(databaseURL: databaseURL)
let samples = try store.feedbackSamples() // every session and revision
let history = try store.feedbackSamples(sessionID: sessionID)
try store.exportFeedback(to: exportURL)
```

For future evaluation, group by `sessionID` before assigning train/validation/test partitions so revisions of the same recording never leak across splits. Select a revision policy explicitly (for example, the last saved revision per session); appending a correction does not create an independent acoustic sample. This milestone collects whole-session labels, not corrected token alignments. No split or training run is performed automatically.
