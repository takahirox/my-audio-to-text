import AudioTextCore
import XCTest

final class ConfigurationTests: XCTestCase {
  func testRejectsUnsafeCaptureIntervalsBeforeCheckingExecutables() {
    var configuration = AppConfiguration()
    configuration.chunkSeconds = 0
    XCTAssertThrowsError(try configuration.validateASR()) { error in
      guard case AudioTextError.invalidConfiguration = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
  }

  func testRejectsOutputReservationLargerThanContext() {
    var configuration = AppConfiguration()
    configuration.synthesisContextTokens = 1_024
    configuration.synthesisOutputTokens = 2_048
    XCTAssertThrowsError(try configuration.validateLLM()) { error in
      guard case AudioTextError.invalidConfiguration = error else {
        return XCTFail("Unexpected error: \(error)")
      }
    }
  }
}
