import Foundation

public struct PersonalizationEvaluationExample: Codable, Sendable {
  public let sessionID: UUID
  public let split: String
  public let condition: SpeechCondition
  public let baseline: String
  public let reference: String
}

public struct AccuracyMetrics: Encodable, Sendable {
  public var samples = 0
  public var referenceCharacters = 0
  public var baselineErrors = 0
  public var personalizedErrors = 0
  public var improvedSamples = 0
  public var regressedSamples = 0
  public var appliedCorrections = 0
  public var baselineCER: Double? {
    referenceCharacters == 0 ? nil : Double(baselineErrors) / Double(referenceCharacters)
  }
  public var personalizedCER: Double? {
    referenceCharacters == 0 ? nil : Double(personalizedErrors) / Double(referenceCharacters)
  }
  public var relativeErrorReduction: Double? {
    baselineErrors == 0 ? nil : Double(baselineErrors - personalizedErrors) / Double(baselineErrors)
  }

  enum CodingKeys: String, CodingKey {
    case samples, referenceCharacters, baselineErrors, personalizedErrors, improvedSamples
    case regressedSamples, appliedCorrections, baselineCER, personalizedCER, relativeErrorReduction
  }

  public func encode(to encoder: Encoder) throws {
    var values = encoder.container(keyedBy: CodingKeys.self)
    try values.encode(samples, forKey: .samples)
    try values.encode(referenceCharacters, forKey: .referenceCharacters)
    try values.encode(baselineErrors, forKey: .baselineErrors)
    try values.encode(personalizedErrors, forKey: .personalizedErrors)
    try values.encode(improvedSamples, forKey: .improvedSamples)
    try values.encode(regressedSamples, forKey: .regressedSamples)
    try values.encode(appliedCorrections, forKey: .appliedCorrections)
    try values.encodeIfPresent(baselineCER, forKey: .baselineCER)
    try values.encodeIfPresent(personalizedCER, forKey: .personalizedCER)
    try values.encodeIfPresent(relativeErrorReduction, forKey: .relativeErrorReduction)
  }

  mutating func add(reference: String, baseline: String, result: String, applied: Int) {
    samples += 1
    referenceCharacters += CharacterErrorMetric.characters(reference).count
    let before = CharacterErrorMetric.distance(baseline, reference)
    let after = CharacterErrorMetric.distance(result, reference)
    baselineErrors += before
    personalizedErrors += after
    improvedSamples += after < before ? 1 : 0
    regressedSamples += after > before ? 1 : 0
    appliedCorrections += applied
  }
}

/// Japanese-appropriate CER: width/case folded alphanumeric grapheme clusters.
/// Whitespace and punctuation are excluded so formatting alone cannot count as an improvement.
public enum CharacterErrorMetric {
  public static func characters(_ text: String) -> [Character] {
    Array(
      text.folding(
        options: [.caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX")
      )
      .precomposedStringWithCanonicalMapping
      .unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) }.map(String.init).joined())
  }

  public static func distance(_ hypothesis: String, _ reference: String) -> Int {
    let hypothesis = characters(hypothesis)
    let reference = characters(reference)
    var previous = Array(0...reference.count)
    for (i, character) in hypothesis.enumerated() {
      var current = [i + 1] + Array(repeating: 0, count: reference.count)
      for (j, expected) in reference.enumerated() {
        current[j + 1] = min(
          current[j] + 1, previous[j + 1] + 1,
          previous[j] + (character == expected ? 0 : 1))
      }
      previous = current
    }
    return previous[reference.count]
  }
}

public struct EvaluationPrediction: Codable, Sendable {
  public let sessionID: UUID
  public let condition: SpeechCondition
  public let baseline: String
  public let reference: String
  public let personalized: String
  public let appliedRuleIDs: [String]
}

public struct PersonalizationEvaluationReport: Encodable, Sendable {
  public let memorySessions: Int
  public let ruleCount: Int
  public let memoryDigest: String
  public let overall: AccuracyMetrics
  public let byCondition: [String: AccuracyMetrics]
  public let predictions: [EvaluationPrediction]
  public let memoryBuildMilliseconds: Double
  public let applicationMillisecondsPerSample: Double
}

public enum PersonalizationEvaluation {
  /// Every example is an independent session. Explicit assignments make the benchmark reproducible.
  public static func evaluate(examples: [PersonalizationEvaluationExample]) throws
    -> PersonalizationEvaluationReport
  {
    guard Set(examples.map(\.sessionID)).count == examples.count,
      examples.allSatisfy({ ["memory", "test"].contains($0.split) }),
      examples.contains(where: { $0.split == "memory" }),
      examples.contains(where: { $0.split == "test" })
    else {
      throw AudioTextError.invalidConfiguration(
        "evaluation requires unique sessions and disjoint memory/test splits")
    }
    func feedback(_ example: PersonalizationEvaluationExample) -> PersonalizationFeedback {
      PersonalizationFeedback(
        id: example.sessionID, createdAt: Date(timeIntervalSince1970: 0),
        sessionID: example.sessionID, correctedTranscript: example.reference,
        speechCondition: example.condition, audioPath: nil,
        sourceSegments: [
          TranscriptSegment(
            id: example.sessionID, sessionID: example.sessionID, ordinal: 0,
            startMilliseconds: 0, endMilliseconds: 0,
            rawText: example.baseline, cleanText: example.baseline, status: .final
          )
        ])
    }
    return try evaluate(
      memorySamples: examples.filter { $0.split == "memory" }.map(feedback),
      testSamples: examples.filter { $0.split == "test" }.map(feedback))
  }

  /// Also accepts real exported feedback. All revisions of one session belong to one split.
  public static func evaluate(
    memorySamples: [PersonalizationFeedback], testSamples: [PersonalizationFeedback]
  ) throws -> PersonalizationEvaluationReport {
    let memoryIDs = Set(memorySamples.map(\.sessionID))
    let testIDs = Set(testSamples.map(\.sessionID))
    guard memoryIDs.isDisjoint(with: testIDs), !testSamples.isEmpty else {
      throw AudioTextError.invalidConfiguration("evaluation sessions overlap or test set is empty")
    }
    let start = ProcessInfo.processInfo.systemUptime
    let memory = PersonalizationMemory(samples: memorySamples)
    let buildTime = (ProcessInfo.processInfo.systemUptime - start) * 1000
    var latest: [UUID: PersonalizationFeedback] = [:]
    for sample in testSamples { latest[sample.sessionID] = sample }
    var overall = AccuracyMetrics()
    var byCondition: [String: AccuracyMetrics] = [:]
    var predictions: [EvaluationPrediction] = []
    var applicationTime: Double = 0
    for sample in latest.values.sorted(by: { $0.sessionID.uuidString < $1.sessionID.uuidString }) {
      let start = ProcessInfo.processInfo.systemUptime
      let segments = sample.sourceSegments.map { memory.apply(to: $0) }
      applicationTime += (ProcessInfo.processInfo.systemUptime - start) * 1000
      let text = segments.map(\.text).filter { !$0.isEmpty }.joined(separator: "\n")
      let applied = segments.compactMap { $0.appliedRule?.id }
      overall.add(
        reference: sample.correctedTranscript, baseline: sample.cleanTranscript, result: text,
        applied: applied.count)
      byCondition[sample.speechCondition.rawValue, default: AccuracyMetrics()].add(
        reference: sample.correctedTranscript, baseline: sample.cleanTranscript, result: text,
        applied: applied.count)
      predictions.append(
        EvaluationPrediction(
          sessionID: sample.sessionID, condition: sample.speechCondition,
          baseline: sample.cleanTranscript,
          reference: sample.correctedTranscript, personalized: text, appliedRuleIDs: applied))
    }
    return PersonalizationEvaluationReport(
      memorySessions: memoryIDs.count, ruleCount: memory.rules.count, memoryDigest: memory.digest,
      overall: overall, byCondition: byCondition, predictions: predictions,
      memoryBuildMilliseconds: buildTime,
      applicationMillisecondsPerSample: applicationTime / Double(latest.count))
  }
}
