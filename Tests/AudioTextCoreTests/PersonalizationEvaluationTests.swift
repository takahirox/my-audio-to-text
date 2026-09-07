import Foundation
import XCTest

@testable import AudioTextCore

final class PersonalizationEvaluationTests: XCTestCase {
  func testCharacterMetricAndUndefinedDenominators() {
    XCTAssertEqual(CharacterErrorMetric.distance("ＧＰＴ Sol。", "gpt sol"), 0)
    XCTAssertEqual(CharacterErrorMetric.distance("カ\u{3099}", "ガ"), 0)
    XCTAssertEqual(CharacterErrorMetric.distance("京都", "今日と"), 3)
    XCTAssertEqual(CharacterErrorMetric.distance("", "音声"), 2)
    XCTAssertEqual(CharacterErrorMetric.distance("音声", ""), 2)
    XCTAssertNil(AccuracyMetrics().baselineCER)
    XCTAssertNil(AccuracyMetrics().relativeErrorReduction)
    var regression = AccuracyMetrics()
    regression.add(reference: "正解", baseline: "正解", result: "誤答", applied: 1)
    XCTAssertEqual(regression.regressedSamples, 1)
    XCTAssertEqual(regression.personalizedErrors, 2)
  }

  func testReproducibleHeldOutFixtureAndSpeechConditionMetrics() throws {
    let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
    let examples = try JSONDecoder().decode(
      [PersonalizationEvaluationExample].self,
      from: Data(contentsOf: root.appendingPathComponent("docs/issue-6/evaluation-examples.json")))
    let report = try PersonalizationEvaluation.evaluate(examples: examples)
    XCTAssertEqual(report.memorySessions, 10)
    XCTAssertEqual(report.overall.samples, 18)
    XCTAssertEqual(report.ruleCount, 4)
    XCTAssertEqual(report.overall.improvedSamples, 6)
    XCTAssertEqual(report.overall.baselineErrors, 39)
    XCTAssertEqual(report.overall.personalizedErrors, 16)
    XCTAssertEqual(report.overall.regressedSamples, 0)
    XCTAssertLessThan(report.overall.personalizedErrors, report.overall.baselineErrors)
    for condition in ["normal", "quiet", "whisper"] {
      XCTAssertEqual(report.byCondition[condition]?.samples, 6)
    }
    let repeated = try PersonalizationEvaluation.evaluate(examples: examples)
    XCTAssertEqual(report.memoryDigest, repeated.memoryDigest)
    XCTAssertEqual(report.predictions.map(\.personalized), repeated.predictions.map(\.personalized))
    XCTAssertThrowsError(try PersonalizationEvaluation.evaluate(examples: examples + [examples[0]]))
  }

  func testRejectsLeakageAcrossRevisionsOfSameSession() throws {
    let id = UUID()
    let source = TranscriptSegment(
      sessionID: id, ordinal: 0, startMilliseconds: 0, endMilliseconds: 1,
      rawText: "source", cleanText: "source", status: .final)
    let first = PersonalizationFeedback(
      sessionID: id, correctedTranscript: "one",
      speechCondition: .normal, audioPath: nil, sourceSegments: [source])
    let revision = PersonalizationFeedback(
      sessionID: id, correctedTranscript: "two",
      speechCondition: .normal, audioPath: nil, sourceSegments: [source])
    XCTAssertThrowsError(
      try PersonalizationEvaluation.evaluate(memorySamples: [first], testSamples: [revision]))
    let report = try PersonalizationEvaluation.evaluate(
      memorySamples: [], testSamples: [first, revision])
    XCTAssertEqual(report.overall.samples, 1)
    XCTAssertEqual(report.predictions.first?.reference, "two")
  }
}
