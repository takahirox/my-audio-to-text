import Foundation

public struct FullSynthesisService: Sendable {
  private let model: any LocalTextModel
  private let contextTokens: Int
  private let outputTokens: Int

  public init(model: any LocalTextModel, contextTokens: Int, outputTokens: Int = 2_048) {
    self.model = model
    self.contextTokens = contextTokens
    self.outputTokens = outputTokens
  }

  public func synthesize(segments: [TranscriptSegment]) throws -> StructuredSessionModel {
    guard !segments.isEmpty else { throw AudioTextError.emptyTranscript }
    let transcript = segments.map {
      "[\($0.id.uuidString)] (\($0.speaker.rawValue)) \($0.cleanText)"
    }.joined(separator: "\n")
    let prompt = Self.prompt(transcript: transcript)
    let estimatedTokens = Self.estimateTokens(prompt + Self.synthesisSchema)
    let safeInputLimit = max(0, Int(Double(contextTokens) * 0.8) - outputTokens)
    guard estimatedTokens <= safeInputLimit else {
      throw AudioTextError.contextLimitExceeded(
        estimatedTokens: estimatedTokens,
        safeLimit: safeInputLimit
      )
    }
    let data = try model.generate(
      prompt: prompt,
      jsonSchema: Self.synthesisSchema,
      maximumTokens: outputTokens
    )
    let payload: SynthesisPayload
    do {
      payload = try JSONDecoder().decode(SynthesisPayload.self, from: data)
    } catch {
      throw AudioTextError.malformedBackendOutput(error.localizedDescription)
    }
    let structured = try payload.structuredModel()
    try EvidenceValidator.validate(structured, against: segments)
    return structured
  }

  public static func estimateTokens(_ text: String) -> Int {
    max(1, Int(ceil(Double(text.utf8.count) / 3.0)))
  }

  private static func prompt(transcript: String) -> String {
    """
    Analyze the complete Japanese thinking session below in one pass (FULL synthesis).
    Return the exact JSON shape required by the schema.

    Fidelity rules:
    - Use only facts and reasoning present in the transcript.
    - Preserve uncertainty. Never turn a tentative idea into a decision.
    - Preserve both an earlier and a later position as a revision.
    - Do not invent rationale.
    - Keep ideas, decisions, questions, actions, revisions, and examples distinct.
    - Write the title, summary, and every descriptive text field in Japanese.
    - Every array item must cite one or more exact evidence_segment_ids shown in brackets.
    - A revision must cite every segment needed to establish both its before and after positions.
    - Attribute USER, AI, and OTHER statements to their actual speaker.
    - Use an empty array when no supported item exists.

    Complete Clean Transcript:
    \(transcript)
    """
  }

  static let synthesisSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "topics": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
        "ideas": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
        "decisions": {"type": "array", "items": {"$ref": "#/$defs/decision"}},
        "open_questions": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
        "action_items": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
        "revisions": {"type": "array", "items": {"$ref": "#/$defs/revision"}},
        "examples": {"type": "array", "items": {"$ref": "#/$defs/evidence"}},
        "other_notable_points": {"type": "array", "items": {"$ref": "#/$defs/evidence"}}
      },
      "required": [
        "title", "summary", "topics", "ideas", "decisions", "open_questions",
        "action_items", "revisions", "examples", "other_notable_points"
      ],
      "$defs": {
        "evidence": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "text": {"type": "string"},
            "evidence_segment_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}
          },
          "required": ["text", "evidence_segment_ids"]
        },
        "decision": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "text": {"type": "string"},
            "rationale": {"type": ["string", "null"]},
            "evidence_segment_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}
          },
          "required": ["text", "rationale", "evidence_segment_ids"]
        },
        "revision": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "before": {"type": "string"}, "after": {"type": "string"},
            "reason": {"type": ["string", "null"]},
            "evidence_segment_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}
          },
          "required": ["before", "after", "reason", "evidence_segment_ids"]
        }
      }
    }
    """
}

public enum EvidenceValidator {
  public static func validate(
    _ model: StructuredSessionModel,
    against segments: [TranscriptSegment]
  ) throws {
    let valid = Set(segments.map(\.id))
    let evidenceGroups: [(String, [UUID])] =
      model.topics.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.ideas.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.decisions.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.openQuestions.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.actionItems.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.revisions.map { ("\($0.before) → \($0.after)", $0.evidenceSegmentIDs) }
      + model.examples.map { ($0.text, $0.evidenceSegmentIDs) }
      + model.otherNotablePoints.map { ($0.text, $0.evidenceSegmentIDs) }
    for (label, references) in evidenceGroups {
      guard !references.isEmpty else { throw AudioTextError.missingEvidence(label) }
      for reference in references where !valid.contains(reference) {
        throw AudioTextError.invalidEvidenceReference(reference)
      }
    }
  }
}

private struct SynthesisPayload: Decodable {
  let title: String
  let summary: String
  let topics: [EvidencePayload]
  let ideas: [EvidencePayload]
  let decisions: [DecisionPayload]
  let openQuestions: [EvidencePayload]
  let actionItems: [EvidencePayload]
  let revisions: [RevisionPayload]
  let examples: [EvidencePayload]
  let otherNotablePoints: [EvidencePayload]

  enum CodingKeys: String, CodingKey {
    case title, summary, topics, ideas, decisions, revisions, examples
    case openQuestions = "open_questions"
    case actionItems = "action_items"
    case otherNotablePoints = "other_notable_points"
  }

  func structuredModel() throws -> StructuredSessionModel {
    try StructuredSessionModel(
      title: title,
      summary: summary,
      topics: topics.map { try $0.model() },
      ideas: ideas.map { try $0.model() },
      decisions: decisions.map { try $0.model() },
      openQuestions: openQuestions.map { try $0.model() },
      actionItems: actionItems.map { try $0.model() },
      revisions: revisions.map { try $0.model() },
      examples: examples.map { try $0.model() },
      otherNotablePoints: otherNotablePoints.map { try $0.model() }
    )
  }
}

private struct EvidencePayload: Decodable {
  let text: String
  let evidenceSegmentIDs: [String]

  enum CodingKeys: String, CodingKey {
    case text
    case evidenceSegmentIDs = "evidence_segment_ids"
  }

  func model() throws -> EvidenceItem {
    EvidenceItem(text: text, evidenceSegmentIDs: try evidenceSegmentIDs.map(parseUUID))
  }
}

private struct DecisionPayload: Decodable {
  let text: String
  let rationale: String?
  let evidenceSegmentIDs: [String]

  enum CodingKeys: String, CodingKey {
    case text, rationale
    case evidenceSegmentIDs = "evidence_segment_ids"
  }

  func model() throws -> DecisionItem {
    DecisionItem(
      text: text,
      rationale: rationale,
      evidenceSegmentIDs: try evidenceSegmentIDs.map(parseUUID)
    )
  }
}

private struct RevisionPayload: Decodable {
  let before: String
  let after: String
  let reason: String?
  let evidenceSegmentIDs: [String]

  enum CodingKeys: String, CodingKey {
    case before, after, reason
    case evidenceSegmentIDs = "evidence_segment_ids"
  }

  func model() throws -> RevisionItem {
    RevisionItem(
      before: before,
      after: after,
      reason: reason,
      evidenceSegmentIDs: try evidenceSegmentIDs.map(parseUUID)
    )
  }
}

private func parseUUID(_ value: String) throws -> UUID {
  guard let id = UUID(uuidString: value) else {
    throw AudioTextError.malformedBackendOutput("invalid evidence UUID: \(value)")
  }
  return id
}
