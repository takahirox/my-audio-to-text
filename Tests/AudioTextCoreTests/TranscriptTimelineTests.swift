import AudioTextCore
import XCTest

final class TranscriptTimelineTests: XCTestCase {
  func testPartialReplacesUnstableTailAndFinalCommitsOnce() throws {
    let sessionID = UUID()
    let segment = TranscriptSegment(
      sessionID: sessionID,
      ordinal: 0,
      startMilliseconds: 0,
      endMilliseconds: 1_000,
      rawText: "確定した文",
      cleanText: "確定した文",
      status: .final
    )
    var timeline = TranscriptTimeline()
    try timeline.apply(.partial(text: "不安", startMilliseconds: 0, endMilliseconds: 500))
    try timeline.apply(.partial(text: "不安定な末尾", startMilliseconds: 0, endMilliseconds: 800))
    XCTAssertEqual(timeline.partialText, "不安定な末尾")
    XCTAssertTrue(timeline.committed.isEmpty)

    try timeline.apply(.final(segment))
    try timeline.apply(.final(segment))
    XCTAssertNil(timeline.partialText)
    XCTAssertEqual(timeline.committed, [segment])
  }

  func testRejectsOrdinalGap() {
    var timeline = TranscriptTimeline()
    let segment = TranscriptSegment(
      sessionID: UUID(),
      ordinal: 1,
      startMilliseconds: 0,
      endMilliseconds: 1,
      rawText: "gap",
      cleanText: "gap",
      status: .final
    )
    XCTAssertThrowsError(try timeline.apply(.final(segment)))
  }
}
