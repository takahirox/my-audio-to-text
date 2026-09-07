import Foundation
import Testing
@testable import AudioTextCore

@Test func personalizationFeedbackRoundTripsLocally() throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("personalization-store-test-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }

  let store = try PersonalizationStore(databaseURL: root.appendingPathComponent("feedback.sqlite3"))
  let sessionID = UUID()
  let feedback = PersonalizationFeedback(
    sessionID: sessionID,
    rawTranscript: "今日はクエンについて話します",
    cleanTranscript: "今日はクエンについて話します",
    correctedTranscript: "今日はQwenについて話します",
    speechCondition: .whisper
  )

  try store.save(feedback)

  let saved = try #require(store.latestFeedback(sessionID: sessionID))
  #expect(saved.id == feedback.id)
  #expect(saved.rawTranscript == feedback.rawTranscript)
  #expect(saved.correctedTranscript == "今日はQwenについて話します")
  #expect(saved.speechCondition == .whisper)
  #expect(saved.wasCorrected)
}

@Test func personalizationStoreKeepsMultipleCorrections() throws {
  let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("personalization-store-test-\(UUID().uuidString)", isDirectory: true)
  defer { try? FileManager.default.removeItem(at: root) }

  let store = try PersonalizationStore(databaseURL: root.appendingPathComponent("feedback.sqlite3"))
  let sessionID = UUID()

  try store.save(
    PersonalizationFeedback(
      sessionID: sessionID,
      rawTranscript: "GPTソール",
      cleanTranscript: "GPTソール",
      correctedTranscript: "GPT Sol",
      speechCondition: .quiet,
      createdAt: Date(timeIntervalSince1970: 1)
    )
  )
  try store.save(
    PersonalizationFeedback(
      sessionID: sessionID,
      rawTranscript: "ローカルLLM",
      cleanTranscript: "ローカルLLM",
      correctedTranscript: "Local LLM",
      speechCondition: .normal,
      createdAt: Date(timeIntervalSince1970: 2)
    )
  )

  let feedback = try store.feedback(sessionID: sessionID)
  #expect(feedback.count == 2)
  #expect(feedback[0].correctedTranscript == "Local LLM")
  #expect(feedback[1].correctedTranscript == "GPT Sol")
  #expect(try store.allFeedback().count == 2)
}
