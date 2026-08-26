import Foundation

public struct AppConfiguration: Codable, Equatable, Sendable {
  public var whisperExecutable: String
  public var whisperModel: String
  public var llamaExecutable: String
  public var llamaModel: String
  public var language: String
  public var retainAudio: Bool
  public var chunkSeconds: Double
  public var partialIntervalSeconds: Double
  public var synthesisContextTokens: Int
  public var synthesisOutputTokens: Int

  public init(
    whisperExecutable: String = "/opt/homebrew/bin/whisper-cli",
    whisperModel: String = "",
    llamaExecutable: String = "/opt/homebrew/bin/llama-cli",
    llamaModel: String = "",
    language: String = "ja",
    retainAudio: Bool = true,
    chunkSeconds: Double = 8,
    partialIntervalSeconds: Double = 2,
    synthesisContextTokens: Int = 16_384,
    synthesisOutputTokens: Int = 2_048
  ) {
    self.whisperExecutable = whisperExecutable
    self.whisperModel = whisperModel
    self.llamaExecutable = llamaExecutable
    self.llamaModel = llamaModel
    self.language = language
    self.retainAudio = retainAudio
    self.chunkSeconds = chunkSeconds
    self.partialIntervalSeconds = partialIntervalSeconds
    self.synthesisContextTokens = synthesisContextTokens
    self.synthesisOutputTokens = synthesisOutputTokens
  }

  public static func load(from url: URL) throws -> AppConfiguration {
    let data = try Data(contentsOf: url)
    return try JSONDecoder().decode(AppConfiguration.self, from: data)
  }

  public func save(to url: URL) throws {
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    try encoder.encode(self).write(to: url, options: .atomic)
  }

  public func validateASR() throws {
    guard !language.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AudioTextError.invalidConfiguration("ASR language must not be empty")
    }
    guard (2...60).contains(chunkSeconds) else {
      throw AudioTextError.invalidConfiguration("final chunk duration must be 2–60 seconds")
    }
    guard partialIntervalSeconds >= 0.5, partialIntervalSeconds < chunkSeconds else {
      throw AudioTextError.invalidConfiguration(
        "partial interval must be at least 0.5 seconds and shorter than the final chunk"
      )
    }
    guard FileManager.default.isExecutableFile(atPath: whisperExecutable) else {
      throw AudioTextError.executableNotConfigured("whisper.cpp")
    }
    guard FileManager.default.fileExists(atPath: whisperModel) else {
      throw AudioTextError.modelNotConfigured("Whisper")
    }
  }

  public func validateLLM() throws {
    guard synthesisOutputTokens > 0,
      synthesisContextTokens >= 1_024,
      synthesisContextTokens > synthesisOutputTokens
    else {
      throw AudioTextError.invalidConfiguration(
        "LLM context must be at least 1024 tokens and larger than the output reservation"
      )
    }
    guard FileManager.default.isExecutableFile(atPath: llamaExecutable) else {
      throw AudioTextError.executableNotConfigured("llama.cpp")
    }
    guard FileManager.default.fileExists(atPath: llamaModel) else {
      throw AudioTextError.modelNotConfigured("LLM")
    }
  }
}

public enum ApplicationPaths {
  public static func supportDirectory(fileManager: FileManager = .default) throws -> URL {
    let root = try fileManager.url(
      for: .applicationSupportDirectory,
      in: .userDomainMask,
      appropriateFor: nil,
      create: true
    )
    let directory = root.appendingPathComponent("MyAudioToText", isDirectory: true)
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }
}
