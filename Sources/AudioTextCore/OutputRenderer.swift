import Foundation

public enum OutputRenderer {
  public static func detailedMarkdown(_ model: StructuredSessionModel) -> String {
    var sections = ["# \(model.title)", "", model.summary]
    append("Topics", items: model.topics.map(\.text), to: &sections)
    append("Ideas", items: model.ideas.map(\.text), to: &sections)
    append(
      "Decisions",
      items: model.decisions.map { decision in
        decision.rationale.map { "\(decision.text) — \($0)" } ?? decision.text
      },
      to: &sections
    )
    append("Open Questions", items: model.openQuestions.map(\.text), to: &sections)
    append("Action Items", items: model.actionItems.map(\.text), to: &sections)
    append(
      "Revisions",
      items: model.revisions.map { revision in
        let change = "\(revision.before) → \(revision.after)"
        return revision.reason.map { "\(change) — \($0)" } ?? change
      },
      to: &sections
    )
    append("Examples", items: model.examples.map(\.text), to: &sections)
    append("Other Notable Points", items: model.otherNotablePoints.map(\.text), to: &sections)
    return sections.joined(separator: "\n")
  }

  public static func actionList(_ model: StructuredSessionModel) -> String {
    model.actionItems.enumerated().map { "\($0.offset + 1). \($0.element.text)" }
      .joined(separator: "\n")
  }

  public static func json(_ model: StructuredSessionModel) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(model), as: UTF8.self)
  }

  private static func append(_ heading: String, items: [String], to sections: inout [String]) {
    guard !items.isEmpty else { return }
    sections.append(contentsOf: ["", "## \(heading)"])
    sections.append(contentsOf: items.map { "- \($0)" })
  }
}
