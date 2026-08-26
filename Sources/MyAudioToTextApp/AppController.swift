import AudioTextCore
import Foundation
import SwiftUI

@MainActor
final class AppController: ObservableObject {
  @Published var configuration = AppConfiguration()
  @Published private(set) var sessions: [SessionRecord] = []
  @Published var selectedSessionID: UUID?
  @Published private(set) var rawTranscript = ""
  @Published private(set) var cleanTranscript = ""
  @Published private(set) var partialTranscript = ""
  @Published private(set) var displayedOutput = ""
  @Published private(set) var synthesis: StructuredSessionModel?
  @Published private(set) var isRecording = false
  @Published private(set) var isProcessing = false
  @Published private(set) var activeMode: SessionMode?
  @Published var message = "Ready"
  @Published var errorMessage: String?

  private var store: SessionStore?
  private var supportDirectory: URL?
  private var configurationURL: URL?
  private var capture: AudioCaptureService?
  private var pipeline: TranscriptionPipeline?
  private var timeline = TranscriptTimeline()
  private var activeSession: SessionRecord?
  private var hotKey: GlobalHotKey?

  init() {
    do {
      let support = try ApplicationPaths.supportDirectory()
      supportDirectory = support
      let configURL = support.appendingPathComponent("config.json")
      configurationURL = configURL
      if FileManager.default.fileExists(atPath: configURL.path) {
        configuration = try AppConfiguration.load(from: configURL)
      } else {
        try configuration.save(to: configURL)
      }
      store = try SessionStore(databaseURL: support.appendingPathComponent("sessions.sqlite3"))
      refreshSessions()
    } catch {
      errorMessage = error.localizedDescription
    }
    hotKey = GlobalHotKey { [weak self] in
      Task { @MainActor in self?.toggleQuickDictation() }
    }
  }

  func saveConfiguration() {
    do {
      guard let configurationURL else { return }
      try configuration.save(to: configurationURL)
      message = "Settings saved"
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func toggleQuickDictation() {
    if isRecording {
      stopRecording()
    } else {
      startRecording(mode: .quickDictation)
    }
  }

  func startRecording(mode: SessionMode) {
    guard !isRecording, !isProcessing else { return }
    errorMessage = nil
    Task {
      do {
        guard let store, let supportDirectory else {
          throw AudioTextError.persistence("application storage is unavailable")
        }
        let backend = try WhisperCLIBackend(configuration: configuration)
        let sessionID = UUID()
        let durableRoot = supportDirectory.appendingPathComponent("Recordings", isDirectory: true)
        let root =
          configuration.retainAudio
          ? durableRoot.appendingPathComponent(sessionID.uuidString, isDirectory: true)
          : FileManager.default.temporaryDirectory
            .appendingPathComponent("my-audio-to-text-\(sessionID.uuidString)", isDirectory: true)
        let session = SessionRecord(
          id: sessionID,
          mode: mode,
          audioPath: configuration.retainAudio
            ? root.appendingPathComponent("audio.wav").path : nil,
          retainAudio: configuration.retainAudio
        )
        try store.createSession(session)
        let pipeline = TranscriptionPipeline(
          backend: backend,
          store: store,
          sessionID: sessionID
        )
        pipeline.onPartial = { [weak self] value in
          Task { @MainActor in self?.partialTranscript = value }
        }
        pipeline.onFinal = { [weak self] segments in
          Task { @MainActor in self?.acceptCommitted(segments) }
        }
        pipeline.onWarning = { [weak self] error in
          Task { @MainActor in self?.errorMessage = error.localizedDescription }
        }
        let capture = AudioCaptureService()
        try await capture.start(
          directory: root,
          chunkSeconds: configuration.chunkSeconds,
          partialIntervalSeconds: configuration.partialIntervalSeconds,
          onPartial: { pipeline.enqueuePartial($0) },
          onFinal: { pipeline.enqueueFinal($0) },
          onError: { [weak self] error in
            Task { @MainActor in self?.errorMessage = error.localizedDescription }
          }
        )
        self.timeline = TranscriptTimeline()
        self.rawTranscript = ""
        self.cleanTranscript = ""
        self.partialTranscript = ""
        self.displayedOutput = ""
        self.synthesis = nil
        self.activeSession = session
        self.selectedSessionID = session.id
        self.activeMode = mode
        self.pipeline = pipeline
        self.capture = capture
        self.isRecording = true
        self.message = mode == .quickDictation ? "Listening…" : "Thinking Session recording…"
        refreshSessions()
      } catch {
        errorMessage = error.localizedDescription
        message = "Could not start recording"
      }
    }
  }

  func stopRecording() {
    guard isRecording, let session = activeSession, let pipeline, let store else { return }
    isRecording = false
    isProcessing = true
    message = "Finishing transcription…"
    capture?.stop()
    capture = nil
    try? store.setSessionStatus(id: session.id, status: .processing)
    pipeline.finish { [weak self] errors in
      Task { @MainActor in self?.finish(session: session, transcriptionErrors: errors) }
    }
  }

  func selectSession(_ id: UUID?) {
    guard !isRecording, let id, let store else { return }
    do {
      let segments = try store.segments(sessionID: id)
      rawTranscript = segments.map(\.rawText).joined(separator: "\n")
      cleanTranscript = segments.map(\.cleanText).filter { !$0.isEmpty }.joined(separator: "\n")
      partialTranscript = ""
      synthesis = try store.latestSynthesis(sessionID: id)
      displayedOutput = try store.outputs(sessionID: id).first?.body ?? cleanTranscript
      selectedSessionID = id
      message = "Loaded session"
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func polish() {
    guard let selectedSessionID, !cleanTranscript.isEmpty else { return }
    isProcessing = true
    message = "Polishing locally…"
    let configuration = configuration
    let clean = cleanTranscript
    Task.detached { [weak self] in
      do {
        let model = try LlamaCLIModel(configuration: configuration)
        let result = try PolishingService(
          model: model,
          maximumOutputTokens: configuration.synthesisOutputTokens
        ).polish(clean)
        await self?.storeOutput(
          sessionID: selectedSessionID,
          kind: .polishedText,
          source: clean,
          body: result
        )
      } catch {
        await self?.completeProcessing(error: error)
      }
    }
  }

  func synthesizeCurrent() {
    guard let selectedSessionID, let store else { return }
    isProcessing = true
    message = "Running FULL synthesis locally…"
    let configuration = configuration
    Task.detached { [weak self] in
      do {
        let segments = try store.segments(sessionID: selectedSessionID)
        let model = try LlamaCLIModel(configuration: configuration)
        let result = try FullSynthesisService(
          model: model,
          contextTokens: configuration.synthesisContextTokens,
          outputTokens: configuration.synthesisOutputTokens
        ).synthesize(segments: segments)
        let source = segments.map(\.cleanText).joined(separator: "\n")
        let digest = TranscriptDigest.sha256(source)
        try store.saveSynthesis(
          sessionID: selectedSessionID,
          sourceDigest: digest,
          model: result
        )
        let markdown = OutputRenderer.detailedMarkdown(result)
        try store.saveOutput(
          DerivedOutput(
            sessionID: selectedSessionID,
            kind: .detailedMarkdown,
            sourceDigest: digest,
            body: markdown
          )
        )
        try store.saveOutput(
          DerivedOutput(
            sessionID: selectedSessionID,
            kind: .synthesisJSON,
            sourceDigest: digest,
            body: try OutputRenderer.json(result)
          )
        )
        await self?.showSynthesis(result, markdown: markdown)
      } catch {
        await self?.completeProcessing(error: error)
      }
    }
  }

  func showDetailedNotes() {
    guard let synthesis else { return }
    displayedOutput = OutputRenderer.detailedMarkdown(synthesis)
  }

  func showActionList() {
    guard let synthesis else { return }
    displayedOutput = OutputRenderer.actionList(synthesis)
  }

  func showSynthesisJSON() {
    guard let synthesis else { return }
    displayedOutput = (try? OutputRenderer.json(synthesis)) ?? ""
  }

  func copyDisplayedOutput() {
    TextInserter.copy(displayedOutput.isEmpty ? cleanTranscript : displayedOutput)
    message = "Copied to clipboard"
  }

  private func acceptCommitted(_ segments: [TranscriptSegment]) {
    do {
      for segment in segments { try timeline.apply(.final(segment)) }
      rawTranscript = timeline.rawTranscript
      cleanTranscript = timeline.cleanTranscript
      partialTranscript = ""
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func finish(session: SessionRecord, transcriptionErrors: [Error]) {
    guard let store else { return }
    do {
      let segments = try store.segments(sessionID: session.id)
      rawTranscript = segments.map(\.rawText).joined(separator: "\n")
      cleanTranscript = segments.map(\.cleanText).filter { !$0.isEmpty }.joined(separator: "\n")
      let digest = TranscriptDigest.sha256(cleanTranscript)
      if !cleanTranscript.isEmpty {
        try store.saveOutput(
          DerivedOutput(
            sessionID: session.id,
            kind: .cleanTranscript,
            sourceDigest: digest,
            body: cleanTranscript
          )
        )
      }
      let terminalStatus: SessionStatus = transcriptionErrors.isEmpty ? .completed : .failed
      try store.finishSession(id: session.id, status: terminalStatus)
      isProcessing = false
      activeMode = nil
      activeSession = nil
      pipeline = nil
      partialTranscript = ""
      displayedOutput = cleanTranscript
      refreshSessions()

      if !session.retainAudio,
        let parent = captureTemporaryDirectory(for: session.id)
      {
        try? FileManager.default.removeItem(at: parent)
      }
      if let firstError = transcriptionErrors.first {
        errorMessage = firstError.localizedDescription
        message = "Recording preserved; transcription needs attention"
        return
      }
      if session.mode == .quickDictation {
        let result = TextInserter.insertOrCopy(cleanTranscript)
        message = result == .pasted ? "Inserted into the focused app" : "Copied to clipboard"
      } else {
        message = "Transcript complete; ready for FULL synthesis"
        if !configuration.llamaModel.isEmpty { synthesizeCurrent() }
      }
    } catch {
      completeProcessing(error: error)
    }
  }

  private func captureTemporaryDirectory(for sessionID: UUID) -> URL? {
    FileManager.default.temporaryDirectory
      .appendingPathComponent("my-audio-to-text-\(sessionID.uuidString)", isDirectory: true)
  }

  private func refreshSessions() {
    do {
      sessions = try store?.sessions() ?? []
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func storeOutput(
    sessionID: UUID,
    kind: DerivedOutputKind,
    source: String,
    body: String
  ) {
    do {
      try store?.saveOutput(
        DerivedOutput(
          sessionID: sessionID,
          kind: kind,
          sourceDigest: TranscriptDigest.sha256(source),
          body: body
        )
      )
      displayedOutput = body
      isProcessing = false
      message = "Output generated"
    } catch {
      completeProcessing(error: error)
    }
  }

  private func showSynthesis(_ result: StructuredSessionModel, markdown: String) {
    synthesis = result
    displayedOutput = markdown
    isProcessing = false
    message = "Synthesis complete"
  }

  private func completeProcessing(error: Error) {
    isProcessing = false
    errorMessage = error.localizedDescription
    message = "Processing failed; source transcript is unchanged"
  }
}
