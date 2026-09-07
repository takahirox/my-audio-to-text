import AudioTextCore
import Foundation
import XCTest

@testable import MyAudioToTextApp

final class FeedbackControllerTests: XCTestCase {
  @MainActor
  func testCorrectSaveSwitchAndReloadWithoutChangingSourceOrOutput() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "feedback-ui-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let databaseURL = directory.appendingPathComponent("sessions.sqlite3")
    let first: UUID
    let second: UUID
    do {
      let store = try SessionStore(databaseURL: databaseURL)
      first = try createSession(in: store, text: "First raw")
      second = try createSession(in: store, text: "Second raw")
      let controller = AppController(store: store)
      controller.selectSession(first)
      XCTAssertTrue(controller.canSaveFeedback)
      XCTAssertEqual(controller.correctedTranscript, "First raw clean")
      XCTAssertEqual(controller.speechCondition, .unknown)
      controller.correctedTranscript = "First corrected"
      controller.speechCondition = .whisper
      controller.saveFeedback()
      controller.correctedTranscript = "First unsaved revision"
      controller.selectSession(second)
      XCTAssertEqual(controller.correctedTranscript, "Second raw clean")
      XCTAssertEqual(controller.speechCondition, .unknown)
      controller.correctedTranscript = "Second corrected"
      controller.speechCondition = .quiet
      controller.saveFeedback()
      controller.selectSession(first)
      XCTAssertEqual(controller.correctedTranscript, "First unsaved revision")
      XCTAssertEqual(controller.speechCondition, .whisper)
      XCTAssertEqual(controller.rawTranscript, "First raw")
      XCTAssertEqual(controller.cleanTranscript, "First raw clean")
      XCTAssertEqual(controller.displayedOutput, "First raw clean")
      XCTAssertEqual(controller.feedbackSamples.count, 1)
      XCTAssertNil(controller.errorMessage)
    }
    let reopened = try SessionStore(databaseURL: databaseURL)
    let controller = AppController(store: reopened)
    controller.selectSession(first)
    XCTAssertEqual(controller.correctedTranscript, "First corrected")
    XCTAssertEqual(controller.speechCondition, .whisper)
    controller.correctedTranscript = ""
    controller.saveFeedback()
    XCTAssertEqual(controller.feedbackSamples.count, 2)
    controller.useFeedback(controller.feedbackSamples[0])
    XCTAssertEqual(controller.correctedTranscript, "First corrected")
    controller.selectSession(second)
    XCTAssertEqual(controller.correctedTranscript, "Second corrected")
    XCTAssertEqual(controller.speechCondition, .quiet)
    // A revision from another session cannot replace the current draft.
    controller.useFeedback(try XCTUnwrap(reopened.feedbackSamples(sessionID: first).first))
    XCTAssertEqual(controller.correctedTranscript, "Second corrected")
    XCTAssertEqual(try reopened.feedbackSamples().count, 3)
  }

  @MainActor
  func testCannotSaveWithoutSourceOrSwitchDuringRecordingStartup() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
      "feedback-ui-\(UUID())")
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try SessionStore(databaseURL: directory.appendingPathComponent("sessions.sqlite3"))
    let first = try createSession(in: store, text: "First")
    let second = try createSession(in: store, text: "Second")
    let controller = AppController(store: store)
    XCTAssertFalse(controller.canSaveFeedback)
    controller.saveFeedback()
    XCTAssertTrue(try store.feedbackSamples().isEmpty)
    controller.selectSession(first)
    controller.correctedTranscript = "Draft"
    let settled = expectation(description: "Recording startup reports failure")
    let observation = controller.$isProcessing.dropFirst().filter { !$0 }.prefix(1).sink { _ in
      settled.fulfill()
    }
    defer { observation.cancel() }
    controller.startRecording(mode: .quickDictation)
    XCTAssertTrue(controller.isProcessing)
    XCTAssertFalse(controller.canSaveFeedback)
    controller.selectSession(second)
    XCTAssertEqual(controller.selectedSessionID, first)
    controller.saveFeedback()
    XCTAssertTrue(try store.feedbackSamples().isEmpty)
    // Injected controllers have no capture directory: startup safely fails before audio access.
    await fulfillment(of: [settled], timeout: 2)
    XCTAssertFalse(controller.isProcessing)
    XCTAssertEqual(controller.correctedTranscript, "Draft")
  }

  private func createSession(in store: SessionStore, text: String) throws -> UUID {
    let session = SessionRecord(mode: .quickDictation, retainAudio: false)
    try store.createSession(session)
    try store.appendFinalSegment(
      TranscriptSegment(
        sessionID: session.id, ordinal: 0, startMilliseconds: 0, endMilliseconds: 1000,
        rawText: text, cleanText: text + " clean", status: .final
      ))
    try store.finishSession(id: session.id, status: .completed)
    return session.id
  }
}
