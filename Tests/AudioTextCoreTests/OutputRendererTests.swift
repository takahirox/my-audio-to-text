import AudioTextCore
import XCTest

final class OutputRendererTests: XCTestCase {
  func testRegeneratesMultipleOutputsFromOneStructuredModel() throws {
    let evidence = UUID()
    let model = StructuredSessionModel(
      title: "Session",
      summary: "Summary",
      decisions: [
        DecisionItem(text: "Ship", rationale: "Tests pass", evidenceSegmentIDs: [evidence])
      ],
      actionItems: [EvidenceItem(text: "Publish", evidenceSegmentIDs: [evidence])]
    )
    XCTAssertTrue(OutputRenderer.detailedMarkdown(model).contains("## Decisions"))
    XCTAssertEqual(OutputRenderer.actionList(model), "1. Publish")
    XCTAssertTrue(try OutputRenderer.json(model).contains("action_items"))
  }
}
