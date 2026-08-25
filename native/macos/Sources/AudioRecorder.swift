import AVFoundation
import Foundation

@MainActor
final class AudioRecorder: ObservableObject {
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0
    private let engine = AVAudioEngine()
    private var file: AVAudioFile?
    private var startedAt: Date?
    private var timer: Timer?

    func start(to url: URL) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        file = try AVAudioFile(forWriting: url, settings: format.settings)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            try? self?.file?.write(from: buffer)
        }
        engine.prepare(); try engine.start()
        startedAt = Date(); isRecording = true
        timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in if let start = self?.startedAt { self?.elapsed = Date().timeIntervalSince(start) } }
        }
    }

    func stop() {
        engine.stop(); engine.inputNode.removeTap(onBus: 0); timer?.invalidate(); timer=nil; file=nil; isRecording=false
    }
}
