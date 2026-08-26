import AudioTextCore
import Foundation

final class TranscriptionPipeline: @unchecked Sendable {
  private let backend: any TranscriptionBackend
  private let store: SessionStore
  private let sessionID: UUID
  private let queue = DispatchQueue(label: "my-audio-to-text.asr", qos: .userInitiated)
  private let group = DispatchGroup()
  private let lock = NSLock()
  private var partialPending = false
  private var finalErrors: [Error] = []

  var onPartial: (@Sendable (String) -> Void)?
  var onFinal: (@Sendable ([TranscriptSegment]) -> Void)?
  var onWarning: (@Sendable (Error) -> Void)?

  init(backend: any TranscriptionBackend, store: SessionStore, sessionID: UUID) {
    self.backend = backend
    self.store = store
    self.sessionID = sessionID
  }

  func enqueuePartial(_ chunk: AudioChunk) {
    lock.lock()
    guard !partialPending else {
      lock.unlock()
      try? FileManager.default.removeItem(at: chunk.url)
      return
    }
    partialPending = true
    lock.unlock()
    group.enter()
    queue.async { [self] in
      defer {
        try? FileManager.default.removeItem(at: chunk.url)
        lock.lock()
        partialPending = false
        lock.unlock()
        group.leave()
      }
      do {
        let result = try backend.transcribe(
          audioURL: chunk.url,
          sessionID: sessionID,
          baseOffsetMilliseconds: chunk.startMilliseconds,
          startingOrdinal: 0
        )
        onPartial?(result.map(\.rawText).joined(separator: " "))
      } catch {
        onWarning?(error)
      }
    }
  }

  func enqueueFinal(_ chunk: AudioChunk) {
    group.enter()
    queue.async { [self] in
      defer { group.leave() }
      do {
        let ordinal = try store.segments(sessionID: sessionID).count
        let existing = try store.segments(sessionID: sessionID)
        let proposed = try backend.transcribe(
          audioURL: chunk.url,
          sessionID: sessionID,
          baseOffsetMilliseconds: chunk.startMilliseconds,
          startingOrdinal: ordinal
        )
        var result: [TranscriptSegment] = []
        var lastClean = existing.last?.cleanText
        for segment in proposed where !segment.cleanText.isEmpty && segment.cleanText != lastClean {
          let normalized = TranscriptSegment(
            id: segment.id,
            sessionID: segment.sessionID,
            ordinal: ordinal + result.count,
            startMilliseconds: segment.startMilliseconds,
            endMilliseconds: segment.endMilliseconds,
            speaker: segment.speaker,
            rawText: segment.rawText,
            cleanText: segment.cleanText,
            confidence: segment.confidence,
            status: .final
          )
          result.append(normalized)
          lastClean = normalized.cleanText
        }
        for segment in result { try store.appendFinalSegment(segment) }
        onFinal?(result)
      } catch {
        lock.lock()
        finalErrors.append(error)
        lock.unlock()
        onWarning?(error)
      }
    }
  }

  func finish(_ completion: @escaping @Sendable ([Error]) -> Void) {
    group.notify(queue: queue) { [self] in
      lock.lock()
      let errors = finalErrors
      lock.unlock()
      completion(errors)
    }
  }
}
