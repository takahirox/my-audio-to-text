import AudioTextCore
import Foundation

struct MemoryRequest: Decodable {
  let training: [PersonalizationFeedback]
  let segments: [TranscriptSegment]
}
struct MemoryResponse: Encodable {
  let memoryDigest: String
  let ruleCount: Int
  let segments: [PersonalizedSegment]
}

// Recognition receives audio and settings only, never held-out references or the app's live corpus.
do {
  let args = Array(CommandLine.arguments.dropFirst())
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  let output: Data
  if args.count == 4, args[0] == "transcribe", let sessionID = UUID(uuidString: args[3]) {
    var config = try AppConfiguration.load(from: URL(fileURLWithPath: args[1]))
    config.personalizationEnabled = false
    let backend = try WhisperCLIBackend(configuration: config)
    output = try encoder.encode(
      backend.transcribe(
        audioURL: URL(fileURLWithPath: args[2]), sessionID: sessionID,
        baseOffsetMilliseconds: 0, startingOrdinal: 0))
  } else if args.count == 2, args[0] == "personalize" {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let request = try decoder.decode(
      MemoryRequest.self,
      from: Data(contentsOf: URL(fileURLWithPath: args[1])))
    let trainingIDs = Set(request.training.map(\.sessionID))
    guard trainingIDs.isDisjoint(with: Set(request.segments.map(\.sessionID))) else {
      throw AudioTextError.invalidConfiguration("training and evaluation sessions overlap")
    }
    let memory = PersonalizationMemory(samples: request.training)
    output = try encoder.encode(
      MemoryResponse(
        memoryDigest: memory.digest, ruleCount: memory.rules.count,
        segments: request.segments.map { memory.apply(to: $0) }))
  } else {
    throw AudioTextError.invalidConfiguration(
      "usage: AudioBenchmarkBridge transcribe config.json audio.wav session-uuid | personalize request.json"
    )
  }
  print(String(decoding: output, as: UTF8.self))
} catch {
  // The harness records the failure category; backend stderr may contain private transcript text.
  FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
  exit(1)
}
