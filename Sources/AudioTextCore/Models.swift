import Foundation

public enum SessionMode: String, Codable, CaseIterable, Sendable {
  case quickDictation = "QUICK_DICTATION"
  case thinkingSession = "THINKING_SESSION"
}

public enum SessionStatus: String, Codable, Sendable {
  case recording = "RECORDING"
  case processing = "PROCESSING"
  case completed = "COMPLETED"
  case interrupted = "INTERRUPTED"
  case failed = "FAILED"
}

public enum Speaker: String, Codable, CaseIterable, Sendable {
  case user = "USER"
  case ai = "AI"
  case other = "OTHER"
}

public enum SegmentStatus: String, Codable, Sendable {
  case partial = "PARTIAL"
  case final = "FINAL"
}

public struct SessionRecord: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let mode: SessionMode
  public let startedAt: Date
  public var endedAt: Date?
  public var status: SessionStatus
  public let audioPath: String?
  public let retainAudio: Bool

  public init(
    id: UUID = UUID(),
    mode: SessionMode,
    startedAt: Date = Date(),
    endedAt: Date? = nil,
    status: SessionStatus = .recording,
    audioPath: String? = nil,
    retainAudio: Bool
  ) {
    self.id = id
    self.mode = mode
    self.startedAt = startedAt
    self.endedAt = endedAt
    self.status = status
    self.audioPath = audioPath
    self.retainAudio = retainAudio
  }
}

public struct TranscriptSegment: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let sessionID: UUID
  public let ordinal: Int
  public let startMilliseconds: Int
  public let endMilliseconds: Int
  public let speaker: Speaker
  public let rawText: String
  public let cleanText: String
  public let confidence: Double?
  public let status: SegmentStatus

  public init(
    id: UUID = UUID(),
    sessionID: UUID,
    ordinal: Int,
    startMilliseconds: Int,
    endMilliseconds: Int,
    speaker: Speaker = .user,
    rawText: String,
    cleanText: String,
    confidence: Double? = nil,
    status: SegmentStatus
  ) {
    self.id = id
    self.sessionID = sessionID
    self.ordinal = ordinal
    self.startMilliseconds = startMilliseconds
    self.endMilliseconds = endMilliseconds
    self.speaker = speaker
    self.rawText = rawText
    self.cleanText = cleanText
    self.confidence = confidence
    self.status = status
  }
}

public enum ASREvent: Equatable, Sendable {
  case partial(text: String, startMilliseconds: Int, endMilliseconds: Int)
  case final(TranscriptSegment)
}

public struct TranscriptTimeline: Equatable, Sendable {
  public private(set) var committed: [TranscriptSegment] = []
  public private(set) var partialText: String?

  public init() {}

  public mutating func apply(_ event: ASREvent) throws {
    switch event {
    case .partial(let text, _, _):
      partialText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    case .final(let segment):
      guard segment.status == .final else { throw AudioTextError.invalidFinalSegment }
      if let existing = committed.first(where: { $0.id == segment.id }) {
        guard existing == segment else { throw AudioTextError.conflictingSegmentID(segment.id) }
        partialText = nil
        return
      }
      guard segment.ordinal == committed.count else {
        throw AudioTextError.nonContiguousOrdinal(
          expected: committed.count,
          actual: segment.ordinal
        )
      }
      committed.append(segment)
      partialText = nil
    }
  }

  public var rawTranscript: String {
    committed.map(\.rawText).joined(separator: "\n")
  }

  public var cleanTranscript: String {
    committed.map(\.cleanText).filter { !$0.isEmpty }.joined(separator: "\n")
  }
}

public struct EvidenceItem: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let text: String
  public let evidenceSegmentIDs: [UUID]

  public init(id: UUID = UUID(), text: String, evidenceSegmentIDs: [UUID]) {
    self.id = id
    self.text = text
    self.evidenceSegmentIDs = evidenceSegmentIDs
  }
}

public struct DecisionItem: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let text: String
  public let rationale: String?
  public let evidenceSegmentIDs: [UUID]

  public init(
    id: UUID = UUID(),
    text: String,
    rationale: String? = nil,
    evidenceSegmentIDs: [UUID]
  ) {
    self.id = id
    self.text = text
    self.rationale = rationale
    self.evidenceSegmentIDs = evidenceSegmentIDs
  }
}

public struct RevisionItem: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let before: String
  public let after: String
  public let reason: String?
  public let evidenceSegmentIDs: [UUID]

  public init(
    id: UUID = UUID(),
    before: String,
    after: String,
    reason: String? = nil,
    evidenceSegmentIDs: [UUID]
  ) {
    self.id = id
    self.before = before
    self.after = after
    self.reason = reason
    self.evidenceSegmentIDs = evidenceSegmentIDs
  }
}

public struct StructuredSessionModel: Codable, Equatable, Sendable {
  public let title: String
  public let summary: String
  public let topics: [EvidenceItem]
  public let ideas: [EvidenceItem]
  public let decisions: [DecisionItem]
  public let openQuestions: [EvidenceItem]
  public let actionItems: [EvidenceItem]
  public let revisions: [RevisionItem]
  public let examples: [EvidenceItem]
  public let otherNotablePoints: [EvidenceItem]

  enum CodingKeys: String, CodingKey {
    case title, summary, topics, ideas, decisions, revisions, examples
    case openQuestions = "open_questions"
    case actionItems = "action_items"
    case otherNotablePoints = "other_notable_points"
  }

  public init(
    title: String,
    summary: String,
    topics: [EvidenceItem] = [],
    ideas: [EvidenceItem] = [],
    decisions: [DecisionItem] = [],
    openQuestions: [EvidenceItem] = [],
    actionItems: [EvidenceItem] = [],
    revisions: [RevisionItem] = [],
    examples: [EvidenceItem] = [],
    otherNotablePoints: [EvidenceItem] = []
  ) {
    self.title = title
    self.summary = summary
    self.topics = topics
    self.ideas = ideas
    self.decisions = decisions
    self.openQuestions = openQuestions
    self.actionItems = actionItems
    self.revisions = revisions
    self.examples = examples
    self.otherNotablePoints = otherNotablePoints
  }
}

public enum DerivedOutputKind: String, Codable, CaseIterable, Sendable {
  case cleanTranscript = "CLEAN_TRANSCRIPT"
  case polishedText = "POLISHED_TEXT"
  case synthesisJSON = "SYNTHESIS_JSON"
  case detailedMarkdown = "DETAILED_MARKDOWN"
  case actionList = "ACTION_LIST"
}

public struct DerivedOutput: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let sessionID: UUID
  public let kind: DerivedOutputKind
  public let sourceDigest: String
  public let body: String
  public let createdAt: Date

  public init(
    id: UUID = UUID(),
    sessionID: UUID,
    kind: DerivedOutputKind,
    sourceDigest: String,
    body: String,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.sessionID = sessionID
    self.kind = kind
    self.sourceDigest = sourceDigest
    self.body = body
    self.createdAt = createdAt
  }
}
