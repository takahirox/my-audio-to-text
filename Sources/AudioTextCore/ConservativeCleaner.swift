import Foundation

public struct ConservativeCleaner: Sendable {
  private let standaloneFillers: Set<String> = [
    "えー", "えーと", "えっと", "あー", "あのー", "うーん", "um", "uh", "erm",
  ]

  public init() {}

  public func clean(_ raw: String) -> String {
    let normalized =
      raw
      .replacingOccurrences(of: "\r\n", with: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return "" }

    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    return
      lines
      .map(cleanLine)
      .filter { !$0.isEmpty }
      .reduce(into: [String]()) { result, line in
        if result.last != line { result.append(line) }
      }
      .joined(separator: "\n")
  }

  private func cleanLine(_ line: Substring) -> String {
    let tokens = line.split(whereSeparator: { $0.isWhitespace })
    if tokens.count > 1 {
      return
        tokens
        .map(String.init)
        .filter { !standaloneFillers.contains($0.lowercased()) }
        .reduce(into: [String]()) { result, token in
          if result.last != token { result.append(token) }
        }
        .joined(separator: " ")
    }

    var value = String(line).trimmingCharacters(in: .whitespaces)
    for filler in standaloneFillers where filler.contains(where: { !$0.isASCII }) {
      value = value.replacingOccurrences(
        of: "^(?:\(NSRegularExpression.escapedPattern(for: filler)))[、,。．]?\\s*",
        with: "",
        options: .regularExpression
      )
    }
    return value.trimmingCharacters(in: .whitespaces)
  }
}
