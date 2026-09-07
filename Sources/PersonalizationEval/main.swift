import AudioTextCore
import Foundation

// Dataset mode: PersonalizationEval path/to/examples.json
// Corpus mode: PersonalizationEval --feedback memory.jsonl test.jsonl
func loadFeedback(_ path: String) throws -> [PersonalizationFeedback] {
  let decoder = JSONDecoder()
  decoder.dateDecodingStrategy = .iso8601
  return try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n").map {
    try decoder.decode(PersonalizationFeedback.self, from: Data($0.utf8))
  }
}

do {
  let args = Array(CommandLine.arguments.dropFirst())
  let report: PersonalizationEvaluationReport
  if args.count == 1 {
    let examples = try JSONDecoder().decode(
      [PersonalizationEvaluationExample].self,
      from: Data(contentsOf: URL(fileURLWithPath: args[0])))
    report = try PersonalizationEvaluation.evaluate(examples: examples)
  } else if args.count == 3, args[0] == "--feedback" {
    report = try PersonalizationEvaluation.evaluate(
      memorySamples: loadFeedback(args[1]), testSamples: loadFeedback(args[2]))
  } else {
    throw AudioTextError.invalidConfiguration(
      "usage: PersonalizationEval examples.json OR --feedback memory.jsonl test.jsonl")
  }
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
  print(String(decoding: try encoder.encode(report), as: UTF8.self))
} catch {
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
