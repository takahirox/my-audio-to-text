import AudioTextCore
import Foundation
import XCTest

final class ConfigurationTests: XCTestCase {
  func testLegacyConfigurationDefaultsOffAndPersonalizationRoundTrips() throws {
    let legacy = try JSONEncoder().encode(AppConfiguration())
    XCTAssertFalse(
      try JSONDecoder().decode(AppConfiguration.self, from: legacy).personalizationEnabled)
    var enabled = AppConfiguration()
    enabled.personalizationEnabled = true
    let data = try JSONEncoder().encode(enabled)
    XCTAssertTrue(
      try JSONDecoder().decode(AppConfiguration.self, from: data).personalizationEnabled)
    enabled.personalizationEnabled = false
    XCTAssertEqual(enabled, AppConfiguration())
  }
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
