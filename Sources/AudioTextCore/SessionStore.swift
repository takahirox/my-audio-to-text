import CSQLite
import CryptoKit
import Foundation

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public final class SessionStore: @unchecked Sendable {
  private var database: OpaquePointer?
  private let lock = NSRecursiveLock()
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

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
      try execute("PRAGMA foreign_keys=ON")
      try execute("PRAGMA busy_timeout=5000")
      try migrate()
      try recoverInterruptedSessions()
    } catch {
      if let database { sqlite3_close(database) }
      database = nil
      throw error
    }
  }

  deinit {
    if let database { sqlite3_close(database) }
  }

  public func createSession(_ session: SessionRecord) throws {
    try withLock {
      let sql = """
        INSERT INTO sessions
            (id, mode, started_at, ended_at, status, audio_path, retain_audio)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """
      try withStatement(sql) { statement in
        bind(session.id.uuidString, at: 1, to: statement)
        bind(session.mode.rawValue, at: 2, to: statement)
        bind(session.startedAt.timeIntervalSince1970, at: 3, to: statement)
        bind(session.endedAt?.timeIntervalSince1970, at: 4, to: statement)
        bind(session.status.rawValue, at: 5, to: statement)
        bind(session.audioPath, at: 6, to: statement)
        bind(session.retainAudio, at: 7, to: statement)
        try stepDone(statement)
      }
    }
  }

  public func appendFinalSegment(_ segment: TranscriptSegment) throws {
    guard segment.status == .final else { throw AudioTextError.invalidFinalSegment }
    guard segment.startMilliseconds >= 0, segment.endMilliseconds >= segment.startMilliseconds
    else {
      throw AudioTextError.invalidTimeRange
    }
    try transaction {
      let expected = try nextOrdinal(sessionID: segment.sessionID)
      guard segment.ordinal == expected else {
        throw AudioTextError.nonContiguousOrdinal(expected: expected, actual: segment.ordinal)
      }
      let sql = """
        INSERT INTO transcript_segments
            (id, session_id, ordinal, start_ms, end_ms, speaker, raw_text,
             clean_text, confidence, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """
      try withStatement(sql) { statement in
        bind(segment.id.uuidString, at: 1, to: statement)
        bind(segment.sessionID.uuidString, at: 2, to: statement)
        bind(segment.ordinal, at: 3, to: statement)
        bind(segment.startMilliseconds, at: 4, to: statement)
        bind(segment.endMilliseconds, at: 5, to: statement)
        bind(segment.speaker.rawValue, at: 6, to: statement)
        bind(segment.rawText, at: 7, to: statement)
        bind(segment.cleanText, at: 8, to: statement)
        bind(segment.confidence, at: 9, to: statement)
        bind(segment.status.rawValue, at: 10, to: statement)
        bind(Date().timeIntervalSince1970, at: 11, to: statement)
        try stepDone(statement)
      }
    }
  }

  public func finishSession(id: UUID, status: SessionStatus, endedAt: Date = Date()) throws {
    try withLock {
      try withStatement("UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?") {
        statement in
        bind(status.rawValue, at: 1, to: statement)
        bind(endedAt.timeIntervalSince1970, at: 2, to: statement)
        bind(id.uuidString, at: 3, to: statement)
        try stepDone(statement)
        guard sqlite3_changes(database) == 1 else {
          throw AudioTextError.persistence("unknown session \(id)")
        }
      }
    }
  }

  public func setSessionStatus(id: UUID, status: SessionStatus) throws {
    try withLock {
      try withStatement("UPDATE sessions SET status = ? WHERE id = ?") { statement in
        bind(status.rawValue, at: 1, to: statement)
        bind(id.uuidString, at: 2, to: statement)
        try stepDone(statement)
        guard sqlite3_changes(database) == 1 else {
          throw AudioTextError.persistence("unknown session \(id)")
        }
      }
    }
  }

  public func sessions(limit: Int = 100) throws -> [SessionRecord] {
    try withLock {
      try withStatement(
        """
        SELECT id, mode, started_at, ended_at, status, audio_path, retain_audio
        FROM sessions ORDER BY started_at DESC LIMIT ?
        """
      ) { statement in
        bind(limit, at: 1, to: statement)
        var result: [SessionRecord] = []
        while sqlite3_step(statement) == SQLITE_ROW {
          guard
            let id = UUID(uuidString: text(statement, 0)),
            let mode = SessionMode(rawValue: text(statement, 1)),
            let status = SessionStatus(rawValue: text(statement, 4))
          else { throw AudioTextError.persistence("invalid session row") }
          result.append(
            SessionRecord(
              id: id,
              mode: mode,
              startedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
              endedAt: optionalDate(statement, 3),
              status: status,
              audioPath: optionalText(statement, 5),
              retainAudio: sqlite3_column_int(statement, 6) != 0
            )
          )
        }
        return result
      }
    }
  }

  public func segments(sessionID: UUID) throws -> [TranscriptSegment] {
    try withLock {
      try withStatement(
        """
        SELECT id, ordinal, start_ms, end_ms, speaker, raw_text, clean_text,
               confidence, status
        FROM transcript_segments WHERE session_id = ? ORDER BY ordinal ASC
        """
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        var result: [TranscriptSegment] = []
        while sqlite3_step(statement) == SQLITE_ROW {
          guard
            let id = UUID(uuidString: text(statement, 0)),
            let speaker = Speaker(rawValue: text(statement, 4)),
            let status = SegmentStatus(rawValue: text(statement, 8))
          else { throw AudioTextError.persistence("invalid transcript row") }
          let confidence =
            sqlite3_column_type(statement, 7) == SQLITE_NULL
            ? nil : sqlite3_column_double(statement, 7)
          result.append(
            TranscriptSegment(
              id: id,
              sessionID: sessionID,
              ordinal: Int(sqlite3_column_int64(statement, 1)),
              startMilliseconds: Int(sqlite3_column_int64(statement, 2)),
              endMilliseconds: Int(sqlite3_column_int64(statement, 3)),
              speaker: speaker,
              rawText: text(statement, 5),
              cleanText: text(statement, 6),
              confidence: confidence,
              status: status
            )
          )
        }
        return result
      }
    }
  }

  public func saveSynthesis(
    sessionID: UUID,
    sourceDigest: String,
    model: StructuredSessionModel
  ) throws {
    let data = try encoder.encode(model)
    guard let json = String(data: data, encoding: .utf8) else {
      throw AudioTextError.persistence("failed to encode synthesis")
    }
    try withLock {
      try withStatement(
        """
        INSERT INTO syntheses (id, session_id, source_digest, model_json, created_at)
        VALUES (?, ?, ?, ?, ?)
        """
      ) { statement in
        bind(UUID().uuidString, at: 1, to: statement)
        bind(sessionID.uuidString, at: 2, to: statement)
        bind(sourceDigest, at: 3, to: statement)
        bind(json, at: 4, to: statement)
        bind(Date().timeIntervalSince1970, at: 5, to: statement)
        try stepDone(statement)
      }
    }
  }

  public func latestSynthesis(sessionID: UUID) throws -> StructuredSessionModel? {
    try withLock {
      try withStatement(
        """
        SELECT model_json FROM syntheses WHERE session_id = ?
        ORDER BY created_at DESC LIMIT 1
        """
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return try decoder.decode(
          StructuredSessionModel.self,
          from: Data(text(statement, 0).utf8)
        )
      }
    }
  }

  public func saveOutput(_ output: DerivedOutput) throws {
    try withLock {
      try withStatement(
        """
        INSERT INTO derived_outputs
            (id, session_id, kind, source_digest, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        """
      ) { statement in
        bind(output.id.uuidString, at: 1, to: statement)
        bind(output.sessionID.uuidString, at: 2, to: statement)
        bind(output.kind.rawValue, at: 3, to: statement)
        bind(output.sourceDigest, at: 4, to: statement)
        bind(output.body, at: 5, to: statement)
        bind(output.createdAt.timeIntervalSince1970, at: 6, to: statement)
        try stepDone(statement)
      }
    }
  }

  public func outputs(sessionID: UUID) throws -> [DerivedOutput] {
    try withLock {
      try withStatement(
        """
        SELECT id, kind, source_digest, body, created_at FROM derived_outputs
        WHERE session_id = ? ORDER BY created_at DESC
        """
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        var result: [DerivedOutput] = []
        while sqlite3_step(statement) == SQLITE_ROW {
          guard
            let id = UUID(uuidString: text(statement, 0)),
            let kind = DerivedOutputKind(rawValue: text(statement, 1))
          else { throw AudioTextError.persistence("invalid output row") }
          result.append(
            DerivedOutput(
              id: id,
              sessionID: sessionID,
              kind: kind,
              sourceDigest: text(statement, 2),
              body: text(statement, 3),
              createdAt: Date(
                timeIntervalSince1970: sqlite3_column_double(statement, 4)
              )
            )
          )
        }
        return result
      }
    }
  }

  /// Snapshots persisted ASR data in the same transaction as the appended correction.
  /// Empty corrections are valid (for example, to label an ASR hallucination).
  @discardableResult
  public func saveFeedback(
    sessionID: UUID,
    correctedTranscript: String,
    speechCondition: SpeechCondition
  ) throws -> PersonalizationFeedback {
    try transaction {
      let audioPath: String? = try withStatement(
        "SELECT status, audio_path, retain_audio FROM sessions WHERE id = ?"
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        guard sqlite3_step(statement) == SQLITE_ROW else {
          throw AudioTextError.persistence("unknown feedback session")
        }
        guard let status = SessionStatus(rawValue: text(statement, 0)),
          status != .recording, status != .processing
        else { throw AudioTextError.persistence("finish transcription before saving feedback") }
        return sqlite3_column_int(statement, 2) != 0 ? optionalText(statement, 1) : nil
      }
      let source = try segments(sessionID: sessionID)
      guard !source.isEmpty else {
        throw AudioTextError.persistence("feedback requires a committed transcript")
      }
      let feedback = PersonalizationFeedback(
        sessionID: sessionID,
        correctedTranscript: correctedTranscript,
        speechCondition: speechCondition,
        audioPath: audioPath,
        sourceSegments: source
      )
      let json = String(decoding: try encoder.encode(feedback), as: UTF8.self)
      try withStatement(
        "INSERT INTO personalization_feedback (id, session_id, sample_json) VALUES (?, ?, ?)"
      ) { statement in
        bind(feedback.id.uuidString, at: 1, to: statement)
        bind(sessionID.uuidString, at: 2, to: statement)
        bind(json, at: 3, to: statement)
        try stepDone(statement)
      }
      return feedback
    }
  }

  /// Returns every revision in insertion order, optionally restricted to one session.
  public func feedbackSamples(sessionID: UUID? = nil) throws -> [PersonalizationFeedback] {
    try withLock {
      var result: [PersonalizationFeedback] = []
      try enumerateFeedback(sessionID: sessionID) { result.append($0) }
      return result
    }
  }

  /// Streams the complete local corpus as UTF-8 JSONL; dates use ISO 8601 UTC.
  /// Audio paths are references only; this does not copy or upload recordings.
  public func exportFeedback(to url: URL) throws {
    let temporary = url.deletingLastPathComponent()
      .appendingPathComponent(".feedback-\(UUID().uuidString).jsonl")
    guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else {
      throw AudioTextError.persistence("could not create feedback export")
    }
    defer { try? FileManager.default.removeItem(at: temporary) }
    let handle = try FileHandle(forWritingTo: temporary)
    defer { try? handle.close() }
    let exportEncoder = JSONEncoder()
    exportEncoder.dateEncodingStrategy = .iso8601
    exportEncoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    try withLock {
      try enumerateFeedback { sample in
        var line = try exportEncoder.encode(sample)
        line.append(0x0A)
        try handle.write(contentsOf: line)
      }
    }
    try handle.synchronize()
    try handle.close()
    if FileManager.default.fileExists(atPath: url.path) {
      _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
    } else {
      try FileManager.default.moveItem(at: temporary, to: url)
    }
  }

  private func enumerateFeedback(
    sessionID: UUID? = nil,
    _ visit: (PersonalizationFeedback) throws -> Void
  ) throws {
    let filter = sessionID == nil ? "" : " WHERE session_id = ?"
    try withStatement(
      "SELECT sample_json FROM personalization_feedback" + filter + " ORDER BY sequence ASC"
    ) { statement in
      if let sessionID { bind(sessionID.uuidString, at: 1, to: statement) }
      while true {
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
          try visit(
            decoder.decode(PersonalizationFeedback.self, from: Data(text(statement, 0).utf8)))
        case SQLITE_DONE: return
        default: throw databaseError()
        }
      }
    }
  }

  public func personalizationMemory(excludingSessionIDs: Set<UUID> = []) throws
    -> PersonalizationMemory
  {
    PersonalizationMemory(samples: try feedbackSamples(), excludingSessionIDs: excludingSessionIDs)
  }

  /// Called after all final ASR segments commit. Baseline/source tables are never updated.
  @discardableResult
  public func savePersonalizationRun(
    sessionID: UUID, memory: PersonalizationMemory?
  ) throws -> PersonalizationRun {
    try transaction {
      let run = PersonalizationRun(
        sessionID: sessionID, source: try segments(sessionID: sessionID), memory: memory)
      let json = String(decoding: try encoder.encode(run), as: UTF8.self)
      try withStatement(
        "INSERT INTO personalization_runs (id, session_id, run_json) VALUES (?, ?, ?)"
      ) { statement in
        bind(run.id.uuidString, at: 1, to: statement)
        bind(sessionID.uuidString, at: 2, to: statement)
        bind(json, at: 3, to: statement)
        try stepDone(statement)
      }
      return run
    }
  }

  public func latestPersonalizationRun(sessionID: UUID) throws -> PersonalizationRun? {
    try withLock {
      try withStatement(
        "SELECT run_json FROM personalization_runs WHERE session_id = ? ORDER BY sequence DESC LIMIT 1"
      ) { statement in
        bind(sessionID.uuidString, at: 1, to: statement)
        switch sqlite3_step(statement) {
        case SQLITE_ROW:
          return try decoder.decode(PersonalizationRun.self, from: Data(text(statement, 0).utf8))
        case SQLITE_DONE: return nil
        default: throw databaseError()
        }
      }
    }
  }

  private func migrate() throws {
    try execute(
      """
      CREATE TABLE IF NOT EXISTS schema_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_metadata (key, value) VALUES ('schema_version', '1');
      CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          mode TEXT NOT NULL,
          started_at REAL NOT NULL,
          ended_at REAL,
          status TEXT NOT NULL,
          audio_path TEXT,
          retain_audio INTEGER NOT NULL CHECK (retain_audio IN (0, 1))
      );
      CREATE TABLE IF NOT EXISTS transcript_segments (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
          end_ms INTEGER NOT NULL CHECK (end_ms >= start_ms),
          speaker TEXT NOT NULL,
          raw_text TEXT NOT NULL,
          clean_text TEXT NOT NULL,
          confidence REAL,
          status TEXT NOT NULL CHECK (status = 'FINAL'),
          created_at REAL NOT NULL,
          UNIQUE(session_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS syntheses (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          source_digest TEXT NOT NULL,
          model_json TEXT NOT NULL,
          created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS derived_outputs (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          source_digest TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS segments_by_session
          ON transcript_segments(session_id, ordinal);
      CREATE INDEX IF NOT EXISTS outputs_by_session
          ON derived_outputs(session_id, created_at DESC);
      """
    )
    let version: String = try withStatement(
      "SELECT value FROM schema_metadata WHERE key = 'schema_version'"
    ) { statement in
      guard sqlite3_step(statement) == SQLITE_ROW else {
        throw AudioTextError.persistence("missing schema version")
      }
      return text(statement, 0)
    }
    guard ["1", "2", "3"].contains(version) else {
      throw AudioTextError.persistence("unsupported schema version \(version)")
    }
    if version == "1" {
      try transaction {
        try execute(
          """
          CREATE TABLE personalization_feedback (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL REFERENCES sessions(id),
              sample_json TEXT NOT NULL
          );
          CREATE INDEX feedback_by_session ON personalization_feedback(session_id, sequence);
          UPDATE schema_metadata SET value = '2' WHERE key = 'schema_version';
          """
        )
      }
    }
    if version != "3" {
      try transaction {
        try execute(
          """
          CREATE TABLE IF NOT EXISTS personalization_runs (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              id TEXT NOT NULL UNIQUE,
              session_id TEXT NOT NULL REFERENCES sessions(id),
              run_json TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS personalization_runs_by_session
              ON personalization_runs(session_id, sequence);
          UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version';
          """
        )
      }
    }
  }

  private func recoverInterruptedSessions() throws {
    try execute(
      "UPDATE sessions SET status = 'INTERRUPTED', ended_at = strftime('%s','now') "
        + "WHERE status IN ('RECORDING', 'PROCESSING')"
    )
  }

  private func nextOrdinal(sessionID: UUID) throws -> Int {
    try withStatement(
      "SELECT COALESCE(MAX(ordinal) + 1, 0) FROM transcript_segments WHERE session_id = ?"
    ) { statement in
      bind(sessionID.uuidString, at: 1, to: statement)
      guard sqlite3_step(statement) == SQLITE_ROW else {
        throw AudioTextError.persistence("could not read next transcript ordinal")
      }
      return Int(sqlite3_column_int64(statement, 0))
    }
  }

  private func transaction<T>(_ operation: () throws -> T) throws -> T {
    try withLock {
      try execute("BEGIN IMMEDIATE")
      do {
        let result = try operation()
        try execute("COMMIT")
        return result
      } catch {
        try? execute("ROLLBACK")
        throw error
      }
    }
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
    sqlite3_bind_text(statement, index, value, -1, sqliteTransient)
  }

  private func bind(_ value: String?, at index: Int32, to statement: OpaquePointer) {
    if let value {
      bind(value, at: index, to: statement)
    } else {
      sqlite3_bind_null(statement, index)
    }
  }

  private func bind(_ value: Double, at index: Int32, to statement: OpaquePointer) {
    sqlite3_bind_double(statement, index, value)
  }

  private func bind(_ value: Double?, at index: Int32, to statement: OpaquePointer) {
    if let value {
      bind(value, at: index, to: statement)
    } else {
      sqlite3_bind_null(statement, index)
    }
  }

  private func bind(_ value: Int, at index: Int32, to statement: OpaquePointer) {
    sqlite3_bind_int64(statement, index, sqlite3_int64(value))
  }

  private func bind(_ value: Bool, at index: Int32, to statement: OpaquePointer) {
    sqlite3_bind_int(statement, index, value ? 1 : 0)
  }

  private func text(_ statement: OpaquePointer, _ column: Int32) -> String {
    guard let pointer = sqlite3_column_text(statement, column) else { return "" }
    return String(cString: pointer)
  }

  private func optionalText(_ statement: OpaquePointer, _ column: Int32) -> String? {
    sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : text(statement, column)
  }

  private func optionalDate(_ statement: OpaquePointer, _ column: Int32) -> Date? {
    sqlite3_column_type(statement, column) == SQLITE_NULL
      ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, column))
  }
}

public enum TranscriptDigest {
  public static func sha256(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
