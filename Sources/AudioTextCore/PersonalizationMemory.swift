import Foundation

public struct CorrectionEvidence: Codable, Equatable, Sendable {
  public let feedbackID: UUID
  public let sessionID: UUID
  public let segmentID: UUID
  public let createdAt: Date
  public let speechCondition: SpeechCondition
  public let rawText: String
  public let baselineText: String
  public let correctedText: String
}

public struct CorrectionRule: Codable, Equatable, Identifiable, Sendable {
  public let id: String
  public let source: String
  public let replacement: String
  public let leftContext: String
  public let rightContext: String
  public let requiresStart: Bool
  public let requiresEnd: Bool
  public let evidence: [CorrectionEvidence]

  public var sessionCount: Int { Set(evidence.map(\.sessionID)).count }
  public var lastSeen: Date { evidence.map(\.createdAt).max() ?? .distantPast }

  // Character offsets, not UTF-8 offsets. Matching is literal and case-sensitive.
  func matches(in text: String) -> [Range<Int>] {
    let input = Array(text)
    let pattern = Array(leftContext + source + rightContext)
    guard !pattern.isEmpty, input.count >= pattern.count else { return [] }
    return (0...(input.count - pattern.count)).compactMap { start in
      let end = start + pattern.count
      guard !requiresStart || start == 0, !requiresEnd || end == input.count,
        input[start..<end].elementsEqual(pattern)
      else { return nil }
      let offset = start + leftContext.count
      return offset..<(offset + source.count)
    }
  }
}

public struct PersonalizedSegment: Codable, Equatable, Sendable {
  public let segmentID: UUID
  public let baseline: String
  public let text: String
  public let appliedRule: CorrectionRule?
  public let reason: String
}

/// Rebuilt from the append-only corpus; only the latest revision per session votes.
/// Algorithm v1 intentionally abstains on ambiguous alignment, conflicts, and multiple matches.
public struct PersonalizationMemory: Sendable {
  public let rules: [CorrectionRule]
  public let digest: String

  public init(samples: [PersonalizationFeedback], excludingSessionIDs: Set<UUID> = []) {
    var latest: [UUID: PersonalizationFeedback] = [:]
    for sample in samples where !excludingSessionIDs.contains(sample.sessionID) {
      latest[sample.sessionID] = sample
    }
    let pairs = latest.values.flatMap(Self.alignedPairs).sorted {
      $0.segmentID.uuidString < $1.segmentID.uuidString
    }
    var candidates: [String: CorrectionRule] = [:]
    for pair in pairs {
      guard let rule = Self.mine(pair) else { continue }
      candidates[rule.id] = rule
    }
    rules = candidates.values.compactMap { candidate in
      var support: [CorrectionEvidence] = []
      for pair in pairs {
        let matches = candidate.matches(in: pair.baselineText)
        guard !matches.isEmpty else { continue }
        // Contrary examples (including an explicit unchanged correction) veto a rule.
        guard matches.count == 1,
          Self.replacing(pair.baselineText, range: matches[0], with: candidate.replacement)
            == pair.correctedText
        else { return nil }
        support.append(pair)
      }
      guard Set(support.map(\.sessionID)).count >= 2 else { return nil }
      return CorrectionRule(
        id: candidate.id, source: candidate.source, replacement: candidate.replacement,
        leftContext: candidate.leftContext, rightContext: candidate.rightContext,
        requiresStart: candidate.requiresStart, requiresEnd: candidate.requiresEnd,
        evidence: support
      )
    }.sorted { $0.id < $1.id }
    digest = TranscriptDigest.sha256(
      (["context-memory-v1"]
        + rules.flatMap { [$0.id] + $0.evidence.map { $0.feedbackID.uuidString } })
        .joined(separator: "\n"))
  }

  public func apply(to segment: TranscriptSegment, enabled: Bool = true) -> PersonalizedSegment {
    let baseline = segment.cleanText
    func unchanged(_ reason: String) -> PersonalizedSegment {
      PersonalizedSegment(
        segmentID: segment.id, baseline: baseline, text: baseline, appliedRule: nil, reason: reason)
    }
    guard enabled else { return unchanged("disabled") }
    guard segment.status == .final, segment.speaker == .user else {
      return unchanged("not_final_user_speech")
    }
    guard baseline.count <= 512 else { return unchanged("segment_too_long") }
    var matches: [(CorrectionRule, Range<Int>)] = []
    for rule in rules {
      // A session must never personalize itself, even when a caller supplies an unfiltered memory.
      guard !rule.evidence.contains(where: { $0.sessionID == segment.sessionID }) else { continue }
      for range in rule.matches(in: baseline) { matches.append((rule, range)) }
    }
    guard !matches.isEmpty else { return unchanged("no_supported_context") }
    guard matches.count == 1 else { return unchanged("ambiguous_matches") }
    let (rule, range) = matches[0]
    return PersonalizedSegment(
      segmentID: segment.id, baseline: baseline,
      text: Self.replacing(baseline, range: range, with: rule.replacement), appliedRule: rule,
      reason: "matching_context_and_independent_sessions"
    )
  }

  private static func alignedPairs(_ sample: PersonalizationFeedback) -> [CorrectionEvidence] {
    let segments = sample.sourceSegments.filter { !$0.cleanText.isEmpty }
    let corrections = sample.correctedTranscript.components(separatedBy: "\n")
    // The editor starts with one line per segment. If those boundaries change, abstain.
    guard segments.count == corrections.count else { return [] }
    return zip(segments, corrections).compactMap { segment, corrected in
      guard segment.speaker == .user, segment.status == .final,
        segment.sessionID == sample.sessionID, !segment.cleanText.contains("\n"),
        segment.cleanText.count <= 512, corrected.count <= 512
      else { return nil }
      return CorrectionEvidence(
        feedbackID: sample.id, sessionID: sample.sessionID, segmentID: segment.id,
        createdAt: sample.createdAt, speechCondition: sample.speechCondition,
        rawText: segment.rawText, baselineText: segment.cleanText, correctedText: corrected
      )
    }
  }

  private static func mine(_ pair: CorrectionEvidence) -> CorrectionRule? {
    let before = Array(pair.baselineText)
    let after = Array(pair.correctedText)
    guard before != after, normalized(pair.baselineText) != normalized(pair.correctedText) else {
      return nil
    }
    var prefix = 0
    while prefix < min(before.count, after.count), before[prefix] == after[prefix] { prefix += 1 }
    var suffix = 0
    while suffix < min(before.count, after.count) - prefix,
      before[before.count - suffix - 1] == after[after.count - suffix - 1]
    { suffix += 1 }
    let source = String(before[prefix..<(before.count - suffix)])
    let replacement = String(after[prefix..<(after.count - suffix)])
    // Short substitutions only. Never learn deletions, insertions, or broad rewrites.
    guard (2...32).contains(source.count), (1...32).contains(replacement.count),
      !normalized(source).isEmpty, !normalized(replacement).isEmpty,
      prefix + suffix >= 4
    else { return nil }
    let left = String(before[max(0, prefix - 4)..<prefix])
    let right = String(
      before[(before.count - suffix)..<min(before.count, before.count - suffix + 4)])
    let start = prefix <= 4
    let end = suffix <= 4
    let key = [source, replacement, left, right, String(start), String(end)]
    let id = TranscriptDigest.sha256(key.map { "\($0.utf8.count):\($0)" }.joined())
    return CorrectionRule(
      id: id, source: source, replacement: replacement, leftContext: left, rightContext: right,
      requiresStart: start, requiresEnd: end, evidence: [pair]
    )
  }

  private static func normalized(_ text: String) -> String {
    text.folding(
      options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")
    )
    .precomposedStringWithCanonicalMapping
    .unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined()
  }

  private static func replacing(_ text: String, range: Range<Int>, with replacement: String)
    -> String
  {
    var characters = Array(text)
    characters.replaceSubrange(range, with: Array(replacement))
    return String(characters)
  }
}

public struct PersonalizationRun: Codable, Equatable, Identifiable, Sendable {
  public let schemaVersion: Int
  public let id: UUID
  public let sessionID: UUID
  public let createdAt: Date
  public let enabled: Bool
  public let memoryDigest: String
  public let sourceDigest: String
  public let segments: [PersonalizedSegment]
  public var transcript: String {
    segments.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n")
  }
  public var appliedCount: Int { segments.filter { $0.appliedRule != nil }.count }

  init(sessionID: UUID, source: [TranscriptSegment], memory: PersonalizationMemory?) {
    let isEnabled = memory != nil
    schemaVersion = 1
    id = UUID()
    self.sessionID = sessionID
    createdAt = Date()
    enabled = isEnabled
    let memory = memory ?? PersonalizationMemory(samples: [])
    memoryDigest = memory.digest
    sourceDigest = TranscriptDigest.sha256(source.map(\.cleanText).joined(separator: "\n"))
    segments = source.map { memory.apply(to: $0, enabled: isEnabled) }
  }
}
