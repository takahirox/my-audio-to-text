import Foundation

public enum AudioTextError: LocalizedError, Equatable {
  case invalidFinalSegment
  case conflictingSegmentID(UUID)
  case nonContiguousOrdinal(expected: Int, actual: Int)
  case invalidTimeRange
  case emptyTranscript
  case contextLimitExceeded(estimatedTokens: Int, safeLimit: Int)
  case invalidEvidenceReference(UUID)
  case missingEvidence(String)
  case executableNotConfigured(String)
  case modelNotConfigured(String)
  case processFailed(executable: String, status: Int32, stderr: String)
  case processTimedOut(String)
  case malformedBackendOutput(String)
  case invalidConfiguration(String)
  case persistence(String)

  public var errorDescription: String? {
    switch self {
    case .invalidFinalSegment:
      "Only FINAL transcript segments can be committed."
    case .conflictingSegmentID(let id):
      "Segment ID \(id) was reused with different content."
    case .nonContiguousOrdinal(let expected, let actual):
      "Expected transcript ordinal \(expected), received \(actual)."
    case .invalidTimeRange:
      "Transcript segment has an invalid time range."
    case .emptyTranscript:
      "The transcript is empty."
    case .contextLimitExceeded(let estimated, let limit):
      "FULL synthesis needs about \(estimated) tokens; safe limit is \(limit)."
    case .invalidEvidenceReference(let id):
      "Synthesis references unknown transcript segment \(id)."
    case .missingEvidence(let item):
      "Synthesis item has no evidence: \(item)"
    case .executableNotConfigured(let name):
      "\(name) executable is not configured."
    case .modelNotConfigured(let name):
      "\(name) model is not configured."
    case .processFailed(let executable, let status, let stderr):
      "\(executable) failed with status \(status): \(stderr)"
    case .processTimedOut(let executable):
      "\(executable) timed out."
    case .malformedBackendOutput(let reason):
      "Local backend returned malformed output: \(reason)"
    case .invalidConfiguration(let reason):
      "Invalid configuration: \(reason)"
    case .persistence(let message):
      "Persistence failure: \(message)"
    }
  }
}
