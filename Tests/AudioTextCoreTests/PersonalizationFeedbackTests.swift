import AudioTextCore
import CSQLite
import Foundation
import XCTest

final class PersonalizationFeedbackTests: XCTestCase {
  private var directory: URL!
  private var databaseURL: URL { directory.appendingPathComponent("sessions.sqlite3") }

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("feedback-tests-\(UUID())", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try FileManager.default.removeItem(at: directory)
  }

  func testRevisionsSurviveRestartAndPreserveSourcesAndDerivedOutput() throws {
    let session = SessionRecord(
      mode: .quickDictation, audioPath: "/recordings/audio.wav", retainAudio: true
    )
    let segments = sourceSegments(sessionID: session.id)
    var saved: [PersonalizationFeedback] = []
    do {
      let store = try SessionStore(databaseURL: databaseURL)
      try store.createSession(session)
      for segment in segments { try store.appendFinalSegment(segment) }
      try store.finishSession(id: session.id, status: .completed)
      try store.saveOutput(
        DerivedOutput(
          sessionID: session.id, kind: .polishedText, sourceDigest: "digest", body: "Polished text"
        ))
      for condition in SpeechCondition.allCases {
        saved.append(
          try store.saveFeedback(
            sessionID: session.id, correctedTranscript: "修正 \(condition.rawValue)\n次の行",
            speechCondition: condition
          ))
      }
      XCTAssertEqual(try store.segments(sessionID: session.id), segments)
    }
    let reopened = try SessionStore(databaseURL: databaseURL)
    XCTAssertEqual(try reopened.feedbackSamples(sessionID: session.id), saved)
    XCTAssertEqual(Set(saved.map(\.id)).count, 4)
    XCTAssertEqual(try reopened.segments(sessionID: session.id), segments)
    XCTAssertEqual(try reopened.outputs(sessionID: session.id).first?.body, "Polished text")
    for sample in saved {
      XCTAssertEqual(sample.schemaVersion, 1)
      XCTAssertEqual(sample.sessionID, session.id)
      XCTAssertEqual(sample.sourceSegments, segments)
      XCTAssertEqual(sample.rawTranscript, "えっと 明日\n会社")
      XCTAssertEqual(sample.cleanTranscript, "明日\n会社")
      XCTAssertEqual(sample.audioPath, session.audioPath)
      XCTAssertLessThan(abs(sample.createdAt.timeIntervalSinceNow), 60)
    }
  }

  func testExportsEverySessionAndRevisionWithRoundTrippableJSONL() throws {
    let store = try SessionStore(databaseURL: databaseURL)
    let exportURL = directory.appendingPathComponent("corpus.jsonl")
    try store.exportFeedback(to: exportURL)
    XCTAssertEqual(try Data(contentsOf: exportURL).count, 0)
    var saved: [PersonalizationFeedback] = []
    for mode in SessionMode.allCases {
      // Retention flag takes precedence over a stale path.
      let session = SessionRecord(mode: mode, audioPath: "/temporary/audio.wav", retainAudio: false)
      try store.createSession(session)
      for segment in sourceSegments(sessionID: session.id) { try store.appendFinalSegment(segment) }
      try store.finishSession(id: session.id, status: .interrupted)
      for correction in ["引用\"と改行\n次の行", ""] {
        saved.append(
          try store.saveFeedback(
            sessionID: session.id, correctedTranscript: correction, speechCondition: .unknown
          ))
      }
      XCTAssertEqual(try store.feedbackSamples(sessionID: session.id).count, 2)
    }
    // Replacing an existing export must retain the complete corpus.
    try store.exportFeedback(to: exportURL)
    let lines = try String(contentsOf: exportURL, encoding: .utf8).split(separator: "\n")
    XCTAssertEqual(lines.count, 4)
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let decoded = try lines.map {
      try decoder.decode(PersonalizationFeedback.self, from: Data($0.utf8))
    }
    XCTAssertEqual(decoded.map(\.id), saved.map(\.id))
    XCTAssertEqual(decoded.map(\.correctedTranscript), saved.map(\.correctedTranscript))
    XCTAssertEqual(decoded.map(\.sourceSegments), saved.map(\.sourceSegments))
    XCTAssertTrue(decoded.allSatisfy { $0.audioPath == nil })
    XCTAssertEqual(try store.feedbackSamples(), saved)
    XCTAssertTrue(try store.feedbackSamples(sessionID: UUID()).isEmpty)
  }

  func testRejectsUnknownActiveAndEmptySessionsWithoutPartialWrites() throws {
    let store = try SessionStore(databaseURL: databaseURL)
    XCTAssertThrowsError(
      try store.saveFeedback(
        sessionID: UUID(), correctedTranscript: "text", speechCondition: .normal
      ))
    let session = SessionRecord(mode: .thinkingSession, retainAudio: false)
    try store.createSession(session)
    for segment in sourceSegments(sessionID: session.id) { try store.appendFinalSegment(segment) }
    for status in [SessionStatus.recording, .processing] {
      try store.setSessionStatus(id: session.id, status: status)
      XCTAssertThrowsError(
        try store.saveFeedback(
          sessionID: session.id, correctedTranscript: "text", speechCondition: .quiet
        ))
    }
    let empty = SessionRecord(mode: .quickDictation, status: .completed, retainAudio: false)
    try store.createSession(empty)
    XCTAssertThrowsError(
      try store.saveFeedback(
        sessionID: empty.id, correctedTranscript: "text", speechCondition: .whisper
      ))
    XCTAssertTrue(try store.feedbackSamples().isEmpty)
    // Earlier validation errors must roll back and leave the connection usable.
    try store.finishSession(id: session.id, status: .failed)
    try store.saveFeedback(
      sessionID: session.id, correctedTranscript: "", speechCondition: .unknown)
    XCTAssertEqual(try store.feedbackSamples().count, 1)
  }

  func testMigratesVersionOneDatabaseWithoutChangingExistingTranscript() throws {
    let session = SessionRecord(mode: .thinkingSession, retainAudio: false)
    let segments = sourceSegments(sessionID: session.id)
    do {
      let store = try SessionStore(databaseURL: databaseURL)
      try store.createSession(session)
      for segment in segments { try store.appendFinalSegment(segment) }
      try store.finishSession(id: session.id, status: .completed)
    }
    // Restore the exact pre-feedback schema to exercise an existing installation upgrade.
    var database: OpaquePointer?
    XCTAssertEqual(sqlite3_open(databaseURL.path, &database), SQLITE_OK)
    defer { sqlite3_close(database) }
    XCTAssertEqual(
      sqlite3_exec(
        database,
        """
        DROP TABLE personalization_runs;
        DROP TABLE personalization_feedback;
        UPDATE schema_metadata SET value = '1' WHERE key = 'schema_version';
        """, nil, nil, nil), SQLITE_OK)
    do {
      let migrated = try SessionStore(databaseURL: databaseURL)
      XCTAssertEqual(try migrated.segments(sessionID: session.id), segments)
      try migrated.saveFeedback(
        sessionID: session.id, correctedTranscript: "明日は会社", speechCondition: .normal
      )
    }
    let reopened = try SessionStore(databaseURL: databaseURL)
    XCTAssertEqual(try reopened.feedbackSamples().count, 1)
    XCTAssertEqual(try reopened.segments(sessionID: session.id), segments)
  }

  func testFailedExportPreservesDestinationAndRemovesTemporaryFile() throws {
    let store = try SessionStore(databaseURL: databaseURL)
    let session = SessionRecord(mode: .quickDictation, retainAudio: false)
    try store.createSession(session)
    for segment in sourceSegments(sessionID: session.id) { try store.appendFinalSegment(segment) }
    try store.finishSession(id: session.id, status: .completed)
    try store.saveFeedback(
      sessionID: session.id, correctedTranscript: "correction", speechCondition: .normal
    )
    let exportURL = directory.appendingPathComponent("corpus.jsonl")
    try store.exportFeedback(to: exportURL)
    let previousExport = try Data(contentsOf: exportURL)
    var database: OpaquePointer?
    XCTAssertEqual(sqlite3_open(databaseURL.path, &database), SQLITE_OK)
    defer { sqlite3_close(database) }
    XCTAssertEqual(
      sqlite3_exec(
        database, "UPDATE personalization_feedback SET sample_json = 'invalid JSON'", nil, nil, nil
      ), SQLITE_OK)
    XCTAssertThrowsError(try store.exportFeedback(to: exportURL))
    XCTAssertEqual(try Data(contentsOf: exportURL), previousExport)
    XCTAssertFalse(
      try FileManager.default.contentsOfDirectory(atPath: directory.path)
        .contains { $0.hasPrefix(".feedback-") })
  }

  private func sourceSegments(sessionID: UUID) -> [TranscriptSegment] {
    [
      TranscriptSegment(
        sessionID: sessionID, ordinal: 0, startMilliseconds: 100, endMilliseconds: 1500,
        rawText: "えっと 明日", cleanText: "明日", confidence: 0.82, status: .final
      ),
      TranscriptSegment(
        sessionID: sessionID, ordinal: 1, startMilliseconds: 1500, endMilliseconds: 2200,
        rawText: "会社", cleanText: "会社", status: .final
      ),
    ]
  }
}
