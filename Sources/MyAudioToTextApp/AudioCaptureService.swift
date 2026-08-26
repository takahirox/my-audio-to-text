import AVFoundation
import Foundation

struct AudioChunk: Sendable {
  let url: URL
  let startMilliseconds: Int
  let endMilliseconds: Int
  let index: Int
}

enum AudioCaptureFailure: LocalizedError {
  case microphonePermissionDenied
  case invalidInputFormat
  case conversionFailed(String)

  var errorDescription: String? {
    switch self {
    case .microphonePermissionDenied:
      "Microphone access is required. Enable it in System Settings > Privacy & Security."
    case .invalidInputFormat:
      "The selected microphone does not provide a usable audio format."
    case .conversionFailed(let message):
      "Audio conversion failed: \(message)"
    }
  }
}

final class AudioCaptureService: @unchecked Sendable {
  private let engine = AVAudioEngine()
  private let captureQueue = DispatchQueue(label: "my-audio-to-text.audio-capture")
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16_000,
    channels: 1,
    interleaved: false
  )!

  private var continuousFile: AVAudioFile?
  private var chunkFile: AVAudioFile?
  private var directory: URL?
  private var chunkIndex = 0
  private var totalFrames: AVAudioFramePosition = 0
  private var chunkStartFrame: AVAudioFramePosition = 0
  private var lastPartialFrame: AVAudioFramePosition = 0
  private var chunkFrames: [Float] = []
  private var chunkSeconds: Double = 8
  private var partialIntervalSeconds: Double = 2
  private var onPartial: (@Sendable (AudioChunk) -> Void)?
  private var onFinal: (@Sendable (AudioChunk) -> Void)?
  private var onError: (@Sendable (Error) -> Void)?

  var continuousAudioURL: URL? {
    captureQueue.sync { directory?.appendingPathComponent("audio.wav") }
  }

  func start(
    directory: URL,
    chunkSeconds: Double,
    partialIntervalSeconds: Double,
    onPartial: @escaping @Sendable (AudioChunk) -> Void,
    onFinal: @escaping @Sendable (AudioChunk) -> Void,
    onError: @escaping @Sendable (Error) -> Void
  ) async throws {
    guard await requestMicrophoneAccess() else {
      throw AudioCaptureFailure.microphonePermissionDenied
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    self.directory = directory
    self.chunkSeconds = chunkSeconds
    self.partialIntervalSeconds = partialIntervalSeconds
    self.onPartial = onPartial
    self.onFinal = onFinal
    self.onError = onError
    chunkIndex = 0
    totalFrames = 0
    chunkStartFrame = 0
    lastPartialFrame = 0
    chunkFrames = []

    continuousFile = try makeAudioFile(at: directory.appendingPathComponent("audio.wav"))
    chunkFile = try makeAudioFile(at: chunkURL(index: 0))

    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
      throw AudioCaptureFailure.invalidInputFormat
    }
    input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { [weak self] buffer, _ in
      guard let self, let copied = Self.copy(buffer) else { return }
      self.captureQueue.async { self.consume(copied) }
    }
    engine.prepare()
    try engine.start()
  }

  func stop() {
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    captureQueue.sync {
      finalizeChunkIfNeeded()
      continuousFile = nil
      chunkFile = nil
    }
  }

  private func consume(_ input: AVAudioPCMBuffer) {
    do {
      let converted = try convert(input)
      guard converted.frameLength > 0 else { return }
      try continuousFile?.write(from: converted)
      try chunkFile?.write(from: converted)
      if let channel = converted.floatChannelData?[0] {
        chunkFrames.append(
          contentsOf: UnsafeBufferPointer(
            start: channel,
            count: Int(converted.frameLength)
          ))
      }
      totalFrames += AVAudioFramePosition(converted.frameLength)
      let partialFrames = AVAudioFramePosition(partialIntervalSeconds * targetFormat.sampleRate)
      if totalFrames - lastPartialFrame >= partialFrames {
        lastPartialFrame = totalFrames
        emitPartialSnapshot()
      }
      let finalFrames = AVAudioFramePosition(chunkSeconds * targetFormat.sampleRate)
      if totalFrames - chunkStartFrame >= finalFrames {
        finalizeChunkIfNeeded()
        startNextChunk()
      }
    } catch {
      onError?(error)
    }
  }

  private func emitPartialSnapshot() {
    guard !chunkFrames.isEmpty, let directory else { return }
    let url = directory.appendingPathComponent("partial-\(chunkIndex)-\(totalFrames).wav")
    do {
      try write(samples: chunkFrames, to: url)
      onPartial?(
        AudioChunk(
          url: url,
          startMilliseconds: milliseconds(chunkStartFrame),
          endMilliseconds: milliseconds(totalFrames),
          index: chunkIndex
        )
      )
    } catch {
      onError?(error)
    }
  }

  private func finalizeChunkIfNeeded() {
    guard totalFrames > chunkStartFrame else { return }
    chunkFile = nil
    onFinal?(
      AudioChunk(
        url: chunkURL(index: chunkIndex),
        startMilliseconds: milliseconds(chunkStartFrame),
        endMilliseconds: milliseconds(totalFrames),
        index: chunkIndex
      )
    )
  }

  private func startNextChunk() {
    chunkIndex += 1
    chunkStartFrame = totalFrames
    lastPartialFrame = totalFrames
    chunkFrames = []
    do {
      chunkFile = try makeAudioFile(at: chunkURL(index: chunkIndex))
    } catch {
      onError?(error)
    }
  }

  private func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
    guard let converter = AVAudioConverter(from: input.format, to: targetFormat) else {
      throw AudioCaptureFailure.conversionFailed("unsupported format")
    }
    let ratio = targetFormat.sampleRate / input.format.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      throw AudioCaptureFailure.conversionFailed("could not allocate output buffer")
    }
    var supplied = false
    var conversionError: NSError?
    let status = converter.convert(to: output, error: &conversionError) { _, state in
      if supplied {
        state.pointee = .endOfStream
        return nil
      }
      supplied = true
      state.pointee = .haveData
      return input
    }
    if status == .error {
      throw AudioCaptureFailure.conversionFailed(
        conversionError?.localizedDescription ?? "unknown converter error"
      )
    }
    return output
  }

  private func write(samples: [Float], to url: URL) throws {
    let file = try makeAudioFile(at: url)
    guard
      let buffer = AVAudioPCMBuffer(
        pcmFormat: targetFormat,
        frameCapacity: AVAudioFrameCount(samples.count)
      ), let channel = buffer.floatChannelData?[0]
    else { throw AudioCaptureFailure.conversionFailed("could not allocate snapshot") }
    buffer.frameLength = AVAudioFrameCount(samples.count)
    samples.withUnsafeBufferPointer { source in
      channel.update(from: source.baseAddress!, count: samples.count)
    }
    try file.write(from: buffer)
  }

  private func makeAudioFile(at url: URL) throws -> AVAudioFile {
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: targetFormat.sampleRate,
      AVNumberOfChannelsKey: targetFormat.channelCount,
      AVLinearPCMBitDepthKey: 16,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
      AVLinearPCMIsNonInterleaved: false,
    ]
    return try AVAudioFile(
      forWriting: url,
      settings: settings,
      commonFormat: .pcmFormatFloat32,
      interleaved: false
    )
  }

  private func chunkURL(index: Int) -> URL {
    directory!.appendingPathComponent(String(format: "chunk-%05d.wav", index))
  }

  private func milliseconds(_ frames: AVAudioFramePosition) -> Int {
    Int((Double(frames) / targetFormat.sampleRate) * 1_000)
  }

  private func requestMicrophoneAccess() async -> Bool {
    if #available(macOS 14.0, *) {
      return await AVAudioApplication.requestRecordPermission()
    }
    return false
  }

  private static func copy(_ source: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard
      let copy = AVAudioPCMBuffer(
        pcmFormat: source.format,
        frameCapacity: source.frameLength
      )
    else { return nil }
    copy.frameLength = source.frameLength
    let bytesPerFrame = Int(source.format.streamDescription.pointee.mBytesPerFrame)
    let buffers = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    let sourceBuffers = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
    for index in 0..<min(buffers.count, sourceBuffers.count) {
      guard let destination = buffers[index].mData, let origin = sourceBuffers[index].mData else {
        continue
      }
      memcpy(destination, origin, Int(source.frameLength) * bytesPerFrame)
    }
    return copy
  }
}
