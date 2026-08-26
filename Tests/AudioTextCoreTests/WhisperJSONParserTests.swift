import XCTest

@testable import AudioTextCore

final class WhisperJSONParserTests: XCTestCase {
  func testParsesCurrentWhisperCPPFullJSONAndKeepsOrdinalsContiguous() throws {
    let data = Data(
      """
      {
        "result":{"language":"ja"},
        "transcription":[
          {"text":"  ","offsets":{"from":0,"to":100},"tokens":[]},
          {"text":" えっと 方針です ","offsets":{"from":100,"to":900},
           "tokens":[{"p":0.8},{"p":0.6}]}
        ]
      }
      """.utf8
    )
    let sessionID = UUID()
    let segments = try WhisperJSONParser.parse(
      data: data,
      sessionID: sessionID,
      baseOffsetMilliseconds: 2_000,
      startingOrdinal: 4
    )
    XCTAssertEqual(segments.count, 1)
    XCTAssertEqual(segments[0].ordinal, 4)
    XCTAssertEqual(segments[0].startMilliseconds, 2_100)
    XCTAssertEqual(segments[0].endMilliseconds, 2_900)
    XCTAssertEqual(segments[0].cleanText, "方針です")
    XCTAssertEqual(segments[0].confidence!, 0.7, accuracy: 0.0001)
  }

  func testRejectsMissingTranscriptionArray() {
    XCTAssertThrowsError(
      try WhisperJSONParser.parse(
        data: Data("{}".utf8),
        sessionID: UUID(),
        baseOffsetMilliseconds: 0,
        startingOrdinal: 0
      )
    )
  }
}
