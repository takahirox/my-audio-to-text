import AudioTextCore
import Foundation
import XCTest

final class LongSessionRecoveryTests: XCTestCase {
  func testRepresentativeThirtyMinuteTimelineSurvivesInterruptedReopen() throws {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("my-audio-long-test-\(UUID())", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let databaseURL = directory.appendingPathComponent("session.sqlite3")
    let session = SessionRecord(mode: .thinkingSession, retainAudio: true)

    do {
      let store = try SessionStore(databaseURL: databaseURL)
      try store.createSession(session)
      // 225 final chunks × 8 seconds represents a 30-minute recording.
      for ordinal in 0..<225 {
        try store.appendFinalSegment(
          TranscriptSegment(
            sessionID: session.id,
            ordinal: ordinal,
            startMilliseconds: ordinal * 8_000,
            endMilliseconds: (ordinal + 1) * 8_000,
            rawText: "segment \(ordinal)",
            cleanText: "segment \(ordinal)",
            status: .final
          )
        )
      }
    }

    let reopened = try SessionStore(databaseURL: databaseURL)
    let recovered = try reopened.segments(sessionID: session.id)
    XCTAssertEqual(recovered.count, 225)
    XCTAssertEqual(recovered.last?.endMilliseconds, 30 * 60 * 1_000)
    XCTAssertEqual(try reopened.sessions().first?.status, .interrupted)
  }
}
