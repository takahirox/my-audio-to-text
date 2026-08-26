import AudioTextCore
import Foundation
import XCTest

final class SynthesisTests: XCTestCase {
  func testFullSynthesisValidatesEvidenceAndPreservesRevision() throws {
    let first = segment(ordinal: 0, text: "最初は案Aにする")
    let second = segment(ordinal: 1, text: "後で案Bに変えると決めた")
    let json = """
      {
        "title":"設計判断",
        "summary":"案Aから案Bへ変更した。",
        "topics":[{"text":"設計案","evidence_segment_ids":["\(first.id)"]}],
        "ideas":[],
        "decisions":[{"text":"案Bを採用する","rationale":null,"evidence_segment_ids":["\(second.id)"]}],
        "open_questions":[],
        "action_items":[],
        "revisions":[{"before":"案A","after":"案B","reason":null,"evidence_segment_ids":["\(first.id)","\(second.id)"]}],
        "examples":[],
        "other_notable_points":[]
      }
      """
    let service = FullSynthesisService(
      model: FakeModel(data: Data(json.utf8)),
      contextTokens: 16_384
    )
    let result = try service.synthesize(segments: [first, second])
    XCTAssertEqual(result.decisions.first?.text, "案Bを採用する")
    XCTAssertEqual(result.revisions.first?.before, "案A")
    XCTAssertEqual(result.revisions.first?.after, "案B")
  }

  func testRejectsUnknownEvidenceReference() {
    let source = segment(ordinal: 0, text: "記録")
    let json = """
      {"title":"x","summary":"x","topics":[],"ideas":[{"text":"unsupported","evidence_segment_ids":["\(UUID())"]}],"decisions":[],"open_questions":[],"action_items":[],"revisions":[],"examples":[],"other_notable_points":[]}
      """
    let service = FullSynthesisService(
      model: FakeModel(data: Data(json.utf8)),
      contextTokens: 16_384
    )
    XCTAssertThrowsError(try service.synthesize(segments: [source])) { error in
      guard case AudioTextError.invalidEvidenceReference = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
  }

  func testRefusesChunkingWhenFullTranscriptExceedsContext() {
    let source = segment(ordinal: 0, text: String(repeating: "長い発話", count: 1_000))
    let service = FullSynthesisService(
      model: FakeModel(data: Data("{}".utf8)),
      contextTokens: 256,
      outputTokens: 64
    )
    XCTAssertThrowsError(try service.synthesize(segments: [source])) { error in
      guard case AudioTextError.contextLimitExceeded = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
  }

  private func segment(ordinal: Int, text: String) -> TranscriptSegment {
    TranscriptSegment(
      sessionID: Self.sessionID,
      ordinal: ordinal,
      startMilliseconds: ordinal * 1_000,
      endMilliseconds: (ordinal + 1) * 1_000,
      rawText: text,
      cleanText: text,
      status: .final
    )
  }

  private static let sessionID = UUID()
}

private struct FakeModel: LocalTextModel {
  let data: Data

  func generate(prompt _: String, jsonSchema _: String, maximumTokens _: Int) throws -> Data {
    data
  }
}
