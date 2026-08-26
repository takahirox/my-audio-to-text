import AudioTextCore
import Foundation
import XCTest

final class SessionStoreTests: XCTestCase {
  func testPersistsFinalSegmentsAndIndependentOutputs() throws {
    let fixture = try StoreFixture()
    defer { fixture.cleanup() }
    let store = try SessionStore(databaseURL: fixture.databaseURL)
    let session = SessionRecord(mode: .thinkingSession, retainAudio: true)
    try store.createSession(session)
    let segment = TranscriptSegment(
      sessionID: session.id,
      ordinal: 0,
      startMilliseconds: 10,
      endMilliseconds: 20,
      rawText: "えっと 方針を決める",
      cleanText: "方針を決める",
      status: .final
    )
    try store.appendFinalSegment(segment)
    try store.saveOutput(
      DerivedOutput(
        sessionID: session.id,
        kind: .cleanTranscript,
        sourceDigest: TranscriptDigest.sha256(segment.cleanText),
        body: segment.cleanText
      )
    )

    XCTAssertEqual(try store.segments(sessionID: session.id), [segment])
    XCTAssertEqual(try store.outputs(sessionID: session.id).first?.body, "方針を決める")
  }

  func testRejectsPartialPersistenceAndOrdinalGaps() throws {
    let fixture = try StoreFixture()
    defer { fixture.cleanup() }
    let store = try SessionStore(databaseURL: fixture.databaseURL)
    let session = SessionRecord(mode: .quickDictation, retainAudio: false)
    try store.createSession(session)
    let partial = TranscriptSegment(
      sessionID: session.id,
      ordinal: 0,
      startMilliseconds: 0,
      endMilliseconds: 10,
      rawText: "partial",
      cleanText: "partial",
      status: .partial
    )
    XCTAssertThrowsError(try store.appendFinalSegment(partial))

    let gap = TranscriptSegment(
      sessionID: session.id,
      ordinal: 1,
      startMilliseconds: 0,
      endMilliseconds: 10,
      rawText: "gap",
      cleanText: "gap",
      status: .final
    )
    XCTAssertThrowsError(try store.appendFinalSegment(gap))
  }

  func testRecoversRecordingSessionAsInterrupted() throws {
    let fixture = try StoreFixture()
    defer { fixture.cleanup() }
    let session = SessionRecord(mode: .thinkingSession, retainAudio: true)
    do {
      let store = try SessionStore(databaseURL: fixture.databaseURL)
      try store.createSession(session)
    }
    let reopened = try SessionStore(databaseURL: fixture.databaseURL)
    XCTAssertEqual(try reopened.sessions().first?.status, .interrupted)
  }
}

private struct StoreFixture {
  let directory: URL
  let databaseURL: URL

  init() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("my-audio-to-text-tests-\(UUID())", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    databaseURL = directory.appendingPathComponent("test.sqlite3")
  }

  func cleanup() {
    try? FileManager.default.removeItem(at: directory)
  }
}
