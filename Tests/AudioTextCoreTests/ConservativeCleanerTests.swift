import AudioTextCore
import XCTest

final class ConservativeCleanerTests: XCTestCase {
  private let cleaner = ConservativeCleaner()

  func testRemovesOnlyExplicitStandaloneFillers() {
    XCTAssertEqual(cleaner.clean("えっと 今日は 進めます"), "今日は 進めます")
    XCTAssertEqual(cleaner.clean("えー、今日は進めます"), "今日は進めます")
  }

  func testPreservesContextSensitiveWordsAndUncertainty() {
    XCTAssertEqual(cleaner.clean("まあ これは多分よいと思う"), "まあ これは多分よいと思う")
    XCTAssertEqual(cleaner.clean("あの案は採用しない"), "あの案は採用しない")
  }

  func testRemovesOnlyAdjacentExactDuplication() {
    XCTAssertEqual(cleaner.clean("実装 実装 を進める"), "実装 を進める")
    XCTAssertEqual(cleaner.clean("案A\n案A\n案B"), "案A\n案B")
  }
}
