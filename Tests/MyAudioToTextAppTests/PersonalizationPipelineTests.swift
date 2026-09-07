import AudioTextCore
import Foundation
import XCTest

@testable import MyAudioToTextApp

final class PersonalizationPipelineTests: XCTestCase {
  @MainActor
  func testFutureTranscriptionUsesReloadedMemoryAndKeepsBaselineWhenDisabled() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "pipeline-memory-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let url = directory.appendingPathComponent("test.sqlite3")
    do {
      let store = try SessionStore(databaseURL: url)
      for _ in 0..<2 {
        let session = SessionRecord(mode: .quickDictation, retainAudio: false)
        try store.createSession(session)
        try store.appendFinalSegment(FakeASR.segment(sessionID: session.id))
        try store.finishSession(id: session.id, status: .completed)
        try store.saveFeedback(
          sessionID: session.id, correctedTranscript: "今日はGPT Solを使います", speechCondition: .normal)
      }
    }
    let store = try SessionStore(databaseURL: url)
    for enabled in [true, false] {
      let corpus = try store.feedbackSamples()
      let session = SessionRecord(mode: .quickDictation, retainAudio: false)
      try store.createSession(session)
      let memory =
        enabled ? try store.personalizationMemory(excludingSessionIDs: [session.id]) : nil
      let pipeline = TranscriptionPipeline(
        backend: FakeASR(), store: store, sessionID: session.id, memory: memory)
      pipeline.enqueueFinal(
        AudioChunk(
          url: directory.appendingPathComponent("fixture.wav"), startMilliseconds: 0,
          endMilliseconds: 1000, index: 0))
      let finished = expectation(description: "ASR and personalization finish")
      pipeline.finish { errors in
        XCTAssertTrue(errors.isEmpty)
        finished.fulfill()
      }
      await fulfillment(of: [finished], timeout: 3)
      try store.finishSession(id: session.id, status: .completed)
      let run = try XCTUnwrap(store.latestPersonalizationRun(sessionID: session.id))
      XCTAssertEqual(run.enabled, enabled)
      XCTAssertEqual(run.appliedCount, enabled ? 1 : 0)
      XCTAssertEqual(run.transcript, enabled ? "今日はGPT Solを使います" : "今日はGPTソールを使います")
      XCTAssertEqual(try store.segments(sessionID: session.id).first?.rawText, "えっと 今日はGPTソールを使います")
      XCTAssertEqual(try store.segments(sessionID: session.id).first?.cleanText, "今日はGPTソールを使います")
      XCTAssertEqual(try store.feedbackSamples(), corpus)
      let controller = AppController(store: store)
      controller.selectSession(session.id)
      XCTAssertEqual(controller.personalizedTranscript, run.transcript)
      XCTAssertEqual(controller.correctedTranscript, run.transcript)
      XCTAssertEqual(controller.cleanTranscript, "今日はGPTソールを使います")
      controller.saveFeedback()
      let saved = try XCTUnwrap(store.feedbackSamples(sessionID: session.id).last)
      XCTAssertEqual(saved.cleanTranscript, "今日はGPTソールを使います")
      XCTAssertEqual(saved.correctedTranscript, run.transcript)
    }
  }
}

private struct FakeASR: TranscriptionBackend {
  func transcribe(audioURL: URL, sessionID: UUID, baseOffsetMilliseconds: Int, startingOrdinal: Int)
    throws -> [TranscriptSegment]
  {
    [Self.segment(sessionID: sessionID)]
  }

  static func segment(sessionID: UUID) -> TranscriptSegment {
    TranscriptSegment(
      sessionID: sessionID, ordinal: 0, startMilliseconds: 0, endMilliseconds: 1000,
      rawText: "えっと 今日はGPTソールを使います", cleanText: "今日はGPTソールを使います", confidence: 0.8, status: .final)
  }
}
