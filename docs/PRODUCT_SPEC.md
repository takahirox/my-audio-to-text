# Product Specification and Goals

## 1. Product definition

`my-audio-to-text` is a local-first speech input and thought-structuring system.

A user should be able to speak naturally instead of composing polished text in their head. The system captures the speech, transcribes it in realtime, preserves the original textual record, removes speech-only noise conservatively, and—only when requested—turns it into clearer writing or a structured representation of a longer train of thought.

The product is therefore broader than a transcription app. Its long-term role is a **speech-to-usable-thought/text input layer**.

## 2. Four information levels

### Level 1 — Raw Transcript

Realtime ASR output representing what was spoken as faithfully as practical. It is preserved as source evidence.

### Level 2 — Clean Transcript

A directly usable transcript that removes only speech artifacts such as fillers, meaningless false starts, and obvious ASR repetition.

It must not summarize, reorder ideas, add facts, resolve uncertainty, or change the speaker's position.

### Level 3 — Polished Text

An optional transformation of Clean Transcript into readable writing while preserving intent. Profiles may later include natural, concise, business, email, chat, blog, technical writing, and LLM prompt generation.

### Level 4 — Synthesis

A whole-session analysis for long-form thinking. Rather than merely rewriting sentences, it identifies the structure of the user's thinking: themes, ideas, decisions, questions, changes of mind, actions, examples, and important reasoning.

All four levels remain independently accessible. Transformations are non-destructive.

## 3. V1 primary use cases

### Quick Dictation

The user invokes a global shortcut, speaks for seconds or minutes, sees realtime transcription, stops speaking, and receives Clean Transcript. The text can be copied or inserted into the currently focused application. Polishing is optional.

This should work as a general-purpose voice input layer for browsers, LLM prompts, email, chat, editors, notes, and other text-entry applications.

### Thinking Session

The user starts a dedicated session and speaks freely for a long period—30 minutes is a representative target. They may jump between topics, repeat themselves, contradict an earlier idea, discover a new idea, abandon a proposal, or reach a conclusion later.

During the session the priority is capturing thought without interruption, not constantly showing AI-generated interpretation.

After the user ends the session, the complete Clean Transcript is analyzed and converted into a Structured Session Model.

## 4. Thinking Session outputs

At minimum the user should be able to obtain:

- Overview / summary
- Topics
- Ideas
- Decisions
- Open questions
- Action items
- Revisions / changes of mind
- Detailed notes

Later output profiles may include proposals, blog drafts, thought-process timelines, LLM prompts, and custom formats. Multiple outputs should be regenerable from the same source session.

## 5. Structured Session Model

The intermediate representation should contain at least:

```json
{
  "title": "",
  "summary": "",
  "topics": [],
  "ideas": [],
  "decisions": [],
  "open_questions": [],
  "action_items": [],
  "revisions": [],
  "examples": [],
  "other_notable_points": []
}
```

Substantive items should carry evidence segment IDs. Decisions may include rationale when the rationale was actually expressed. Revisions should preserve both the earlier and later position rather than rewriting history.

## 6. Synthesis policy

V1 starts with the simplest viable strategy: **FULL synthesis**.

When the complete Clean Transcript fits comfortably within the selected model's context and resource budget, send the whole transcript to the LLM at once. This gives the model direct access to the entire progression of thought and avoids premature complexity.

Do not implement CHUNKED or INCREMENTAL synthesis merely because sessions are long. Introduce them only when measurements demonstrate a context, latency, memory, or quality problem.

The system should make this strategy replaceable in the future.

## 7. Synthesis fidelity rules

The system must not:

- invent facts absent from the transcript;
- turn uncertainty into certainty;
- classify a tentative idea as a decision without evidence;
- ignore a later retraction or revision;
- invent rationale that the speaker did not provide;
- attribute AI-generated ideas to the user in future dialogue sessions.

Important synthesized items should be traceable to source transcript segments. Invalid evidence references should be treated as an error rather than silently accepted.

## 8. Local-first requirement

After required models are installed, the primary workflow should be capable of operating without network access:

- microphone recording
- speech recognition
- transcript storage
- cleaning
- optional polishing
- Thinking Session synthesis

Cloud LLM backends may be supported later as an explicit user choice, not as a hidden requirement.

## 9. V1 platform

V1 targets **Apple Silicon macOS**.

The application should normally live unobtrusively (for example as a menu-bar application) while Quick Dictation is available globally. Thinking Session may use a dedicated window.

OS-specific behavior should be separated from portable domain logic so Windows and mobile implementations remain possible later.

## 10. Audio and durability

V1 begins with microphone input. System-audio capture is not required.

Audio retention should be configurable. At minimum support:

- keep recorded audio;
- do not retain audio after processing.

Transcript is retained independently of the audio retention choice.

Long sessions must be persisted incrementally. A crash near the end of a 30-minute session must not destroy the earlier transcript. Recording and transcript persistence take priority over all AI processing.

## 11. Realtime ASR behavior

The UI and internal model must distinguish unstable partial ASR output from committed final segments. Partial revisions must replace the unstable tail rather than create duplicate transcript content.

The user should see useful realtime feedback without sacrificing the integrity of the committed transcript.

## 12. Cross-application output

Quick Dictation should attempt to place resulting text into the user's current text field. The intended fallback order is:

1. focused-field / accessibility-based insertion where reliable;
2. clipboard plus paste automation;
3. clipboard-only output.

Failure to insert into a particular application must never lose the generated text.

## 13. Future AI wall-bouncing dialogue

A later version may let the user have a voice conversation with an AI and synthesize the resulting session.

The data model should therefore be speaker-aware from the beginning (`USER`, future `AI`, `OTHER`). Future synthesis must be able to distinguish:

- ideas originally introduced by the user;
- suggestions introduced by the AI;
- ideas the user develops in response to AI questioning;
- AI suggestions explicitly adopted by the user;
- AI suggestions rejected by the user.

This is not required for V1 UX.

## 14. V1 acceptance criteria

V1 is successful when it can:

- run on Apple Silicon macOS;
- start microphone dictation from a global shortcut;
- show realtime Japanese transcription;
- distinguish partial and final ASR output;
- persist final Raw Transcript segments incrementally;
- generate a conservative Clean Transcript;
- expose Clean Transcript as an independent result;
- optionally generate intent-preserving Polished Text locally;
- copy text and attempt focused-app insertion with safe fallback;
- run a Thinking Session for at least 30 minutes without losing earlier committed transcript if later processing fails;
- send the complete Clean Transcript to a local LLM using FULL synthesis when context permits;
- generate title, summary, topics, ideas, decisions, open questions, action items, revisions, examples, and notable points;
- associate important synthesized items with valid source transcript segment IDs;
- regenerate multiple outputs from the same session;
- operate the core workflow offline after local models are installed;
- recover most of a long session after an application crash.

## 15. Evaluation plan

Representative Japanese Thinking Sessions of approximately 30 minutes should be evaluated for:

1. recall of important ideas;
2. distinction between tentative ideas and decisions;
3. detection of changed or retracted positions;
4. preservation of uncertainty;
5. unsupported claims / hallucinations;
6. evidence-reference validity;
7. synthesis latency;
8. peak memory and practical performance across representative Apple Silicon machines.

Only introduce a more complicated synthesis strategy when these measurements justify it.

## 16. V1 non-goals

The following are intentionally outside V1 scope:

- Windows client
- iOS client
- Android client
- Web client
- system-audio capture
- dedicated Zoom / Teams integrations
- AI voice dialogue
- advanced speaker diarization
- realtime Semantic Chunk maintenance
- Incremental Session Memory
- cloud sync
- collaboration
- account system

## 17. Product and engineering priority

The guiding priority is:

**Correctness > Data preservation > User trust > Simplicity > Performance > Feature count**

The system should prefer a simple approach that can be measured over speculative complexity. AI output that sounds polished but misrepresents the user's speech is a failure.

## 18. Long-term goal

The user should not have to formulate perfect written language before interacting with a computer.

They should be able to think out loud naturally. The system should preserve that thought, remove only the noise when requested, and transform it into the level of structure required for the next task—without losing provenance or silently changing meaning.
