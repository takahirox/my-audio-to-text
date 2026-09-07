import Foundation

public enum SpeechCondition: String, Codable, CaseIterable, Sendable {
  case normal, quiet, whisper, unknown
}

/// An immutable, session-level correction, separate from polished/synthesized output.
/// Keep all revisions of a session in the same evaluation partition to avoid leakage.
public struct PersonalizationFeedback: Codable, Equatable, Identifiable, Sendable {
  public let schemaVersion: Int
  public let id: UUID
  public let sessionID: UUID
  public let createdAt: Date
  public let rawTranscript: String
  public let cleanTranscript: String
  public let correctedTranscript: String
  public let speechCondition: SpeechCondition
  public let audioPath: String?
  public let sourceSegments: [TranscriptSegment]

  init(
    sessionID: UUID,
    correctedTranscript: String,
    speechCondition: SpeechCondition,
    audioPath: String?,
    sourceSegments: [TranscriptSegment]
  ) {
    schemaVersion = 1
    id = UUID()
    self.sessionID = sessionID
    createdAt = Date()
    rawTranscript = sourceSegments.map(\.rawText).joined(separator: "\n")
    cleanTranscript = sourceSegments.map(\.cleanText).filter { !$0.isEmpty }.joined(separator: "\n")
    self.correctedTranscript = correctedTranscript
    self.speechCondition = speechCondition
    self.audioPath = audioPath
    self.sourceSegments = sourceSegments
  }
}
