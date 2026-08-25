import AppKit
import Foundation

@MainActor
final class AppModel: ObservableObject {
    @Published var transcript = ""
    @Published var status = "Ready"
    @Published var mode: Mode = .dictation
    let recorder = AudioRecorder()
    enum Mode: String, CaseIterable, Identifiable { case dictation = "Quick Dictation", thinking = "Thinking Session"; var id: Self { self } }

    private var sessionURL: URL?
    func toggleRecording() {
        if recorder.isRecording { stop() } else { start() }
    }
    private func start() {
        do {
            let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("MyAudioToText/sessions/\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let audio = root.appendingPathComponent("audio.caf"); sessionURL = audio
            try recorder.start(to: audio); status = "Listening…"
        } catch { status = "Recording failed: \(error.localizedDescription)" }
    }
    private func stop() {
        recorder.stop(); status = "Recorded. Run local transcription from the session file."
    }
    func copyTranscript() { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(transcript, forType: .string) }
}
