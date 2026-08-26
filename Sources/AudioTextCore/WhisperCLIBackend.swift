import Foundation

public protocol TranscriptionBackend: Sendable {
  func transcribe(
    audioURL: URL,
    sessionID: UUID,
    baseOffsetMilliseconds: Int,
    startingOrdinal: Int
  ) throws -> [TranscriptSegment]
}

public struct WhisperCLIBackend: TranscriptionBackend, Sendable {
  private let executable: URL
  private let model: URL
  private let language: String
  private let cleaner: ConservativeCleaner
  private let runner: BoundedProcessRunner

  public init(configuration: AppConfiguration) throws {
    try configuration.validateASR()
    executable = URL(fileURLWithPath: configuration.whisperExecutable)
    model = URL(fileURLWithPath: configuration.whisperModel)
    language = configuration.language
    cleaner = ConservativeCleaner()
    runner = BoundedProcessRunner()
  }

  public func transcribe(
    audioURL: URL,
    sessionID: UUID,
    baseOffsetMilliseconds: Int,
    startingOrdinal: Int
  ) throws -> [TranscriptSegment] {
    let outputRoot = FileManager.default.temporaryDirectory
      .appendingPathComponent("my-audio-to-text-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: outputRoot.appendingPathExtension("json")) }
    let arguments = [
      "-m", model.path,
      "-f", audioURL.path,
      "-l", language,
      "-ojf",
      "-of", outputRoot.path,
      "-np",
      "--suppress-nst",
    ]
    let result = try runner.run(executable: executable, arguments: arguments, timeout: 600)
    guard result.status == 0 else {
      throw AudioTextError.processFailed(
        executable: executable.lastPathComponent,
        status: result.status,
        stderr: String(decoding: result.standardError, as: UTF8.self)
      )
    }
    let jsonURL = outputRoot.appendingPathExtension("json")
    return try WhisperJSONParser.parse(
      data: Data(contentsOf: jsonURL),
      sessionID: sessionID,
      baseOffsetMilliseconds: baseOffsetMilliseconds,
      startingOrdinal: startingOrdinal,
      cleaner: cleaner
    )
  }
}

enum WhisperJSONParser {
  static func parse(
    data: Data,
    sessionID: UUID,
    baseOffsetMilliseconds: Int,
    startingOrdinal: Int,
    cleaner: ConservativeCleaner = ConservativeCleaner()
  ) throws -> [TranscriptSegment] {
    guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      let transcription = root["transcription"] as? [[String: Any]]
    else { throw AudioTextError.malformedBackendOutput("missing transcription array") }

    var result: [TranscriptSegment] = []
    for item in transcription {
      guard let raw = item["text"] as? String else {
        throw AudioTextError.malformedBackendOutput("segment is missing text")
      }
      let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      let offsets = item["offsets"] as? [String: Any]
      let from = integer(offsets?["from"]) ?? 0
      let to = integer(offsets?["to"]) ?? from
      let probabilities = (item["tokens"] as? [[String: Any]])?
        .compactMap { numeric($0["p"]) }
      let confidence = probabilities.flatMap { values in
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
      }
      result.append(
        TranscriptSegment(
          sessionID: sessionID,
          ordinal: startingOrdinal + result.count,
          startMilliseconds: baseOffsetMilliseconds + from,
          endMilliseconds: baseOffsetMilliseconds + max(from, to),
          rawText: text,
          cleanText: cleaner.clean(text),
          confidence: confidence,
          status: .final
        ))
    }
    return result
  }

  private static func integer(_ value: Any?) -> Int? {
    if let value = value as? Int { return value }
    if let value = value as? NSNumber { return value.intValue }
    return nil
  }

  private static func numeric(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    return nil
  }
}
