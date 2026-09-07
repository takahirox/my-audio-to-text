import CSQLite
import Foundation

private let personalizationSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public enum SpeechCondition: String, Codable, CaseIterable, Identifiable, Sendable {
  case normal = "NORMAL"
  case quiet = "QUIET"
  case whisper = "WHISPER"
  case unknown = "UNKNOWN"

  public var id: String { rawValue }

  public var displayName: String {
    switch self {
    case .normal: "Normal"
    case .quiet: "Quiet"
    case .whisper: "Whisper"
    case .unknown: "Unknown"
    }
  }
}

public struct PersonalizationFeedback: Codable, Equatable, Identifiable, Sendable {
  public let id: UUID
  public let sessionID: UUID
  public let rawTranscript: String
  public let cleanTranscript: String
  public let correctedTranscript: String
  public let speechCondition: SpeechCondition
  public let createdAt: Date

  public init(
    id: UUID = UUID(),
    sessionID: UUID,
    rawTranscript: String,
    cleanTranscript: String,
    correctedTranscript: String,
    speechCondition: SpeechCondition = .unknown,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.sessionID = sessionID
    self.rawTranscript = rawTranscript
    self.cleanTranscript = cleanTranscript
    self.correctedTranscript = correctedTranscript
    self.speechCondition = speechCondition
    self.createdAt = createdAt
  }

  public var wasCorrected: Bool {
    correctedTranscript != cleanTranscript
  }
}

/// Stores user corrections separately from source transcripts.
///
/// The source transcript remains immutable. This database is intended to become the local training
/// corpus for speaker adaptation, correction mining, and evaluation.
public final class PersonalizationStore: @unchecked Sendable {
  private var database: OpaquePointer?
  private let lock = NSRecursiveLock()

  public init(databaseURL: URL) throws {
    try FileManager.default.createDirectory(
      at: databaseURL.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(databaseURL.path, &database, flags, nil) == SQLITE_OK else {
      let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
      if let database { sqlite3_close(database) }
      throw AudioTextError.persistence(message)
    }
    do {
      try execute("PRAGMA journal_mode=WAL")
      try execute("PRAGMA synchronous=FULL")
      try execute("PRAGMA busy_timeout=5000")
      try migrate()
    } catch {
      if let database { sqlite3_close(database) }
      database = nil
      throw error
    }
  }

  deinit {
    if let database { sqlite3_close(database) }
  }

  public func save(_ feedback: PersonalizationFeedback) throws {
    try withLock {
      let sql = """
        INSERT INTO personalization_feedback
            (id, session_id, raw_transcript, clean_transcript, corrected_transcript,
             speech_condition, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """
      try withStatement(sql) { statement in
        bind(feedback.id.uuidString, at: 1, to: statement)
        bind(feedback.sessionID.uuidString, at: 2, to: statement)
        bind(feedback.rawTranscript, at: 3, to: statement)
        bind(feedback.cleanTranscript, at: 4, to: statement)
        bind(feedback.correctedTranscript, at: 5, to: statement)
        bind(feedback.speechCondition.rawValue, at: 6, to: statement)
        sqlite3_bind_double(statement, 7, feedback.createdAt.timeIntervalSince1970)
        try stepDone(statement)
      }
    }
  }

  public func feedback(sessionID: UUID) throws -> [PersonalizationFeedback] {
    try withLock {
      try withStatement(
        """
        SELECT id, raw_transcript, clean_transcript, corrected_transcript,
               speech_condition, created_at
        FROM personalization_feedback
        WHERE session_id = ?
        ORDER BY created_at DESC
        """
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        var result: [PersonalizationFeedback] = []
        while sqlite3_step(statement) == SQLITE_ROW {
          guard
            let id = UUID(uuidString: text(statement, 0)),
            let condition = SpeechCondition(rawValue: text(statement, 4))
          else {
            throw AudioTextError.persistence("invalid personalization feedback row")
          }
          result.append(
            PersonalizationFeedback(
              id: id,
              sessionID: sessionID,
              rawTranscript: text(statement, 1),
              cleanTranscript: text(statement, 2),
              correctedTranscript: text(statement, 3),
              speechCondition: condition,
              createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 5))
            )
          )
        }
        return result
      }
    }
  }

  public func latestFeedback(sessionID: UUID) throws -> PersonalizationFeedback? {
    try feedback(sessionID: sessionID).first
  }

  public func allFeedback(limit: Int = 10_000) throws -> [PersonalizationFeedback] {
    try withLock {
      try withStatement(
        """
        SELECT id, session_id, raw_transcript, clean_transcript, corrected_transcript,
               speech_condition, created_at
        FROM personalization_feedback
        ORDER BY created_at ASC LIMIT ?
        """
      ) { statement in
        sqlite3_bind_int64(statement, 1, sqlite3_int64(limit))
        var result: [PersonalizationFeedback] = []
        while sqlite3_step(statement) == SQLITE_ROW {
          guard
            let id = UUID(uuidString: text(statement, 0)),
            let sessionID = UUID(uuidString: text(statement, 1)),
            let condition = SpeechCondition(rawValue: text(statement, 5))
          else {
            throw AudioTextError.persistence("invalid personalization feedback row")
          }
          result.append(
            PersonalizationFeedback(
              id: id,
              sessionID: sessionID,
              rawTranscript: text(statement, 2),
              cleanTranscript: text(statement, 3),
              correctedTranscript: text(statement, 4),
              speechCondition: condition,
              createdAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 6))
            )
          )
        }
        return result
      }
    }
  }

  private func migrate() throws {
    try execute(
      """
      CREATE TABLE IF NOT EXISTS personalization_feedback (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          raw_transcript TEXT NOT NULL,
          clean_transcript TEXT NOT NULL,
          corrected_transcript TEXT NOT NULL,
          speech_condition TEXT NOT NULL,
          created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS personalization_feedback_by_session
          ON personalization_feedback(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS personalization_feedback_by_condition
          ON personalization_feedback(speech_condition, created_at ASC);
      """
    )
  }

  private func withLock<T>(_ operation: () throws -> T) throws -> T {
    lock.lock()
    defer { lock.unlock() }
    return try operation()
  }

  private func execute(_ sql: String) throws {
    var errorPointer: UnsafeMutablePointer<CChar>?
    let result = sqlite3_exec(database, sql, nil, nil, &errorPointer)
    guard result == SQLITE_OK else {
      let message = errorPointer.map { String(cString: $0) } ?? "SQLite error \(result)"
      sqlite3_free(errorPointer)
      throw AudioTextError.persistence(message)
    }
  }

  private func withStatement<T>(
    _ sql: String,
    operation: (OpaquePointer) throws -> T
  ) throws -> T {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
      let statement
    else { throw databaseError() }
    defer { sqlite3_finalize(statement) }
    return try operation(statement)
  }

  private func stepDone(_ statement: OpaquePointer) throws {
    guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError() }
  }

  private func databaseError() -> AudioTextError {
    guard let database else { return .persistence("database is closed") }
    return .persistence(String(cString: sqlite3_errmsg(database)))
  }

  private func bind(_ value: String, at index: Int32, to statement: OpaquePointer) {
    sqlite3_bind_text(statement, index, value, -1, personalizationSQLiteTransient)
  }

  private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
    guard let pointer = sqlite3_column_text(statement, column) else { return "" }
    return String(cString: pointer)
  }
}
