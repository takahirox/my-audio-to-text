import CSQLite
import Foundation
import XCTest

@testable import AudioTextCore

final class PersonalizationMemoryTests: XCTestCase {
  private let baseline = "今日はGPTソールを使います"
  private let corrected = "今日はGPT Solを使います"

  func testRequiresIndependentSessionsAndCarriesContextAndProvenance() {
    let first = sample(condition: .normal)
    let second = sample(condition: .whisper)
    XCTAssertTrue(PersonalizationMemory(samples: [first]).rules.isEmpty)
    let duplicateRevision = sample(sessionID: first.sessionID)
    XCTAssertTrue(PersonalizationMemory(samples: [first, duplicateRevision]).rules.isEmpty)
    let memory = PersonalizationMemory(samples: [first, second])
    XCTAssertEqual(memory.rules.count, 1)
    XCTAssertEqual(memory.rules.first?.sessionCount, 2)
    XCTAssertEqual(Set(memory.rules[0].evidence.map(\.speechCondition)), [.normal, .whisper])
    XCTAssertEqual(Set(memory.rules[0].evidence.map(\.feedbackID)), [first.id, second.id])
    XCTAssertEqual(memory.rules[0].evidence.first?.rawText, "えっと " + baseline)
    let result = memory.apply(to: segment("今夜はGPTソールを使いますよ"))
    XCTAssertEqual(result.text, "今夜はGPT Solを使いますよ")
    XCTAssertEqual(result.appliedRule?.id, memory.rules[0].id)
    XCTAssertEqual(result.reason, "matching_context_and_independent_sessions")
    XCTAssertEqual(memory.digest, PersonalizationMemory(samples: [second, first]).digest)
  }

  func testConflictingAndUnchangedFeedbackVetoAndLatestRevisionWins() {
    let first = sample()
    let second = sample()
    let unchanged = sample(reference: baseline)
    XCTAssertTrue(PersonalizationMemory(samples: [first, second, unchanged]).rules.isEmpty)
    let conflicting = sample(reference: "今日はGPT Soulを使います")
    XCTAssertTrue(PersonalizationMemory(samples: [first, second, conflicting]).rules.isEmpty)
    let retracted = sample(sessionID: first.sessionID, reference: baseline)
    XCTAssertTrue(PersonalizationMemory(samples: [first, second, retracted]).rules.isEmpty)
    let restored = sample(sessionID: first.sessionID)
    XCTAssertEqual(
      PersonalizationMemory(samples: [first, second, retracted, restored]).rules.count, 1)
  }

  func testAbstainsOnDifferentContextsAmbiguityDisabledAndSelfPersonalization() {
    let first = sample()
    let second = sample()
    let memory = PersonalizationMemory(samples: [first, second])
    for text in ["今日は靴のソールを使います", "昨日はGPTソールについて話します", corrected] {
      XCTAssertEqual(memory.apply(to: segment(text)).text, text)
    }
    let repeated = baseline + "、" + baseline
    XCTAssertEqual(memory.apply(to: segment(repeated)).reason, "ambiguous_matches")
    XCTAssertEqual(memory.apply(to: segment(baseline), enabled: false).text, baseline)
    XCTAssertEqual(memory.apply(to: first.sourceSegments[0]).text, baseline)
    XCTAssertTrue(
      PersonalizationMemory(samples: [first, second], excludingSessionIDs: [first.sessionID]).rules
        .isEmpty)
    XCTAssertEqual(
      memory.apply(to: segment(String(repeating: "長", count: 513))).reason, "segment_too_long")
  }

  func testDoesNotMineFormattingInsertionsDeletionsSingleCharactersOrBrokenAlignment() {
    for (before, after) in [
      ("今日はGPT Solを使います", "今日はＧＰＴ Ｓｏｌを使います。"),
      (baseline, ""), (baseline, baseline + "便利"), ("音声忍識を使う", "音声認識を使う"),
      (baseline, corrected + "\n追加の行"),
    ] {
      let samples = (0..<2).map { _ in sample(source: before, reference: after) }
      XCTAssertTrue(PersonalizationMemory(samples: samples).rules.isEmpty, before)
    }
  }

  func testBoundaryAnchorsAndNoCascadingRewrites() {
    let memory = PersonalizationMemory(
      samples: (0..<2).map { _ in
        sample(source: "それはオープン英愛のモデルです", reference: "それはOpenAIのモデルです")
      })
    XCTAssertEqual(memory.rules.count, 1)
    let differentStart = "たとえばそれはオープン英愛のモデルです"
    XCTAssertEqual(memory.apply(to: segment(differentStart)).text, differentStart)
    let first = (0..<2).map { _ in sample() }
    let next = (0..<2).map { _ in sample(source: corrected, reference: "今日はGPT Futureを使います") }
    let combined = PersonalizationMemory(samples: first + next)
    // Contrary evidence may veto the first rule; in all cases no replacement may cascade.
    XCTAssertNotEqual(combined.apply(to: segment(baseline)).text, "今日はGPT Futureを使います")
  }

  func testMemoryAndAuditedRunsReloadWhileAllSourcesRemainUnchanged() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "memory-tests-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("test.sqlite3")
    let future = SessionRecord(mode: .quickDictation, retainAudio: false)
    let synthesis = StructuredSessionModel(title: "Existing synthesis", summary: "Original summary")
    var expected: PersonalizationRun!
    var feedback: [PersonalizationFeedback] = []
    var digest = ""
    do {
      let store = try SessionStore(databaseURL: url)
      for _ in 0..<2 {
        let session = SessionRecord(mode: .quickDictation, retainAudio: false)
        try store.createSession(session)
        try store.appendFinalSegment(segment(baseline, sessionID: session.id))
        try store.finishSession(id: session.id, status: .completed)
        try store.saveFeedback(
          sessionID: session.id, correctedTranscript: corrected, speechCondition: .quiet)
      }
      feedback = try store.feedbackSamples()
      let memory = try store.personalizationMemory()
      digest = memory.digest
      try store.createSession(future)
      let source = segment(baseline, sessionID: future.id)
      try store.appendFinalSegment(source)
      try store.saveSynthesis(sessionID: future.id, sourceDigest: "source", model: synthesis)
      try store.saveOutput(
        DerivedOutput(
          sessionID: future.id, kind: .polishedText, sourceDigest: "source",
          body: "Existing polished output"))
      expected = try store.savePersonalizationRun(sessionID: future.id, memory: memory)
      XCTAssertEqual(expected.transcript, corrected)
      XCTAssertEqual(try store.segments(sessionID: future.id), [source])
      XCTAssertEqual(try store.feedbackSamples(), feedback)
      XCTAssertEqual(
        try store.outputs(sessionID: future.id).first?.body, "Existing polished output")
    }
    let reopened = try SessionStore(databaseURL: url)
    XCTAssertEqual(try reopened.personalizationMemory().digest, digest)
    XCTAssertEqual(try reopened.latestPersonalizationRun(sessionID: future.id), expected)
    XCTAssertEqual(try reopened.feedbackSamples(), feedback)
    XCTAssertEqual(try reopened.latestSynthesis(sessionID: future.id), synthesis)
    let disabled = try reopened.savePersonalizationRun(sessionID: future.id, memory: nil)
    XCTAssertFalse(disabled.enabled)
    XCTAssertEqual(disabled.transcript, baseline)
    XCTAssertEqual(disabled.segments.first?.reason, "disabled")
    XCTAssertEqual(expected.transcript, corrected)
    XCTAssertThrowsError(try reopened.savePersonalizationRun(sessionID: UUID(), memory: nil))
  }

  func testMigratesVersionTwoWithoutChangingFeedback() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "memory-upgrade-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("test.sqlite3")
    let session = SessionRecord(mode: .quickDictation, retainAudio: false)
    var saved: PersonalizationFeedback!
    do {
      let store = try SessionStore(databaseURL: url)
      try store.createSession(session)
      try store.appendFinalSegment(segment(baseline, sessionID: session.id))
      try store.finishSession(id: session.id, status: .completed)
      saved = try store.saveFeedback(
        sessionID: session.id, correctedTranscript: corrected, speechCondition: .normal)
    }
    var database: OpaquePointer?
    XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
    XCTAssertEqual(
      sqlite3_exec(
        database,
        "DROP TABLE personalization_runs; UPDATE schema_metadata SET value = '2' WHERE key = 'schema_version';",
        nil, nil, nil), SQLITE_OK)
    sqlite3_close(database)
    let store = try SessionStore(databaseURL: url)
    XCTAssertEqual(try store.feedbackSamples(), [saved])
    try store.savePersonalizationRun(sessionID: session.id, memory: nil)
    XCTAssertEqual(try store.latestPersonalizationRun(sessionID: session.id)?.transcript, baseline)
  }

  private func sample(
    sessionID: UUID = UUID(), source: String? = nil, reference: String? = nil,
    condition: SpeechCondition = .unknown
  ) -> PersonalizationFeedback {
    PersonalizationFeedback(
      sessionID: sessionID, correctedTranscript: reference ?? corrected,
      speechCondition: condition, audioPath: nil,
      sourceSegments: [segment(source ?? baseline, sessionID: sessionID)])
  }

  private func segment(_ text: String, sessionID: UUID = UUID()) -> TranscriptSegment {
    TranscriptSegment(
      sessionID: sessionID, ordinal: 0, startMilliseconds: 0, endMilliseconds: 1000,
      rawText: "えっと " + text, cleanText: text, confidence: 0.8, status: .final)
  }
}
