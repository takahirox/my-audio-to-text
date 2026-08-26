import Foundation

public protocol LocalTextModel: Sendable {
  func generate(prompt: String, jsonSchema: String, maximumTokens: Int) throws -> Data
}

public struct LlamaCLIModel: LocalTextModel, Sendable {
  private let executable: URL
  private let model: URL
  private let contextTokens: Int
  private let runner: BoundedProcessRunner

  public init(configuration: AppConfiguration) throws {
    try configuration.validateLLM()
    executable = URL(fileURLWithPath: configuration.llamaExecutable)
    model = URL(fileURLWithPath: configuration.llamaModel)
    contextTokens = configuration.synthesisContextTokens
    runner = BoundedProcessRunner(maximumOutputBytes: 16 * 1_024 * 1_024)
  }

  public func generate(prompt: String, jsonSchema: String, maximumTokens: Int) throws -> Data {
    let directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("my-audio-to-text-llm-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let promptURL = directory.appendingPathComponent("prompt.txt")
    let grammarURL = directory.appendingPathComponent("json.gbnf")
    let constrainedPrompt = """
      \(prompt)

      Required JSON Schema:
      \(jsonSchema)

      Return exactly one JSON object matching that schema. Do not use Markdown fences.
      """
    try Data(constrainedPrompt.utf8).write(to: promptURL, options: .atomic)
    try Data(Self.jsonGrammar.utf8).write(to: grammarURL, options: .atomic)

    let arguments = [
      "-m", model.path,
      "-f", promptURL.path,
      "--grammar-file", grammarURL.path,
      "--no-display-prompt",
      "--no-show-timings",
      "--color", "off",
      "--single-turn",
      "--jinja",
      "--reasoning", "off",
      "--flash-attn", "on",
      "-c", String(contextTokens),
      "--temp", "0.1",
      "-n", String(maximumTokens),
      "-ngl", "99",
    ]
    let result = try runner.run(executable: executable, arguments: arguments, timeout: 1_800)
    guard result.status == 0 else {
      throw AudioTextError.processFailed(
        executable: executable.lastPathComponent,
        status: result.status,
        stderr: String(decoding: result.standardError, as: UTF8.self)
      )
    }
    return try extractJSONObject(from: result.standardOutput)
  }

  private func extractJSONObject(from data: Data) throws -> Data {
    let text = String(decoding: data, as: UTF8.self)
    guard let start = text.firstIndex(of: "{"), let end = text.lastIndex(of: "}"), start <= end
    else {
      throw AudioTextError.malformedBackendOutput("no JSON object in llama-cli output")
    }
    let candidate = Data(text[start...end].utf8)
    _ = try JSONSerialization.jsonObject(with: candidate)
    return candidate
  }

  // llama.cpp's schema-derived grammar currently attempts to consume chat-template prefixes
  // such as Qwen's thinking marker before generation. A user-provided JSON grammar avoids that
  // upstream failure; JSONDecoder and the domain evidence validator still enforce the full schema.
  private static let jsonGrammar = #"""
    root ::= object
    value ::= object | array | string | number | boolean | null
    object ::= "{" ws (string ws ":" ws value (ws "," ws string ws ":" ws value)*)? ws "}"
    array ::= "[" ws (value (ws "," ws value)*)? ws "]"
    string ::= "\"" char* "\""
    char ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\/bfnrt] | "u" [0-9a-fA-F]{4})
    number ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [+-]? [0-9]+)?
    boolean ::= "true" | "false"
    null ::= "null"
    ws ::= [ \t\n\r]*
    """#
}

public struct PolishingService: Sendable {
  private let model: any LocalTextModel
  private let maximumOutputTokens: Int

  public init(model: any LocalTextModel, maximumOutputTokens: Int = 2_048) {
    self.model = model
    self.maximumOutputTokens = maximumOutputTokens
  }

  public func polish(_ cleanTranscript: String, profile: String = "natural") throws -> String {
    guard !cleanTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AudioTextError.emptyTranscript
    }
    let prompt = """
      You rewrite a clean transcript into polished Japanese text.
      Profile: \(profile)

      Fidelity rules:
      - Preserve the speaker's intent, uncertainty, claims, and ordering.
      - Do not add facts, rationale, or decisions.
      - Do not summarize unless the requested profile explicitly says concise.
      - Return only the JSON object described below.

      Clean Transcript:
      \(cleanTranscript)
      """
    let data = try model.generate(
      prompt: prompt,
      jsonSchema: Self.polishSchema,
      maximumTokens: maximumOutputTokens
    )
    let payload = try JSONDecoder().decode(PolishPayload.self, from: data)
    guard !payload.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      throw AudioTextError.malformedBackendOutput("polished text is empty")
    }
    return payload.text
  }

  private struct PolishPayload: Decodable {
    let text: String
  }

  private static let polishSchema = """
    {
      "type": "object",
      "additionalProperties": false,
      "properties": {"text": {"type": "string"}},
      "required": ["text"]
    }
    """
}
