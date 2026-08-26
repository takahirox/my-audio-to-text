import Foundation

public struct ProcessResult: Equatable, Sendable {
  public let status: Int32
  public let standardOutput: Data
  public let standardError: Data
}

public struct BoundedProcessRunner: Sendable {
  public let maximumOutputBytes: Int

  public init(maximumOutputBytes: Int = 8 * 1_024 * 1_024) {
    self.maximumOutputBytes = maximumOutputBytes
  }

  public func run(
    executable: URL,
    arguments: [String],
    timeout: TimeInterval
  ) throws -> ProcessResult {
    let process = Process()
    process.executableURL = executable
    process.arguments = arguments
    process.environment = [
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
      "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
      "LANG": "en_US.UTF-8",
    ]

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe

    let output = LockedBuffer(limit: maximumOutputBytes)
    let errors = LockedBuffer(limit: maximumOutputBytes)
    let readers = DispatchGroup()
    readers.enter()
    outputPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        readers.leave()
      } else {
        output.append(data)
      }
    }
    readers.enter()
    errorPipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      if data.isEmpty {
        handle.readabilityHandler = nil
        readers.leave()
      } else {
        errors.append(data)
      }
    }

    let finished = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in finished.signal() }
    do {
      try process.run()
    } catch {
      outputPipe.fileHandleForReading.readabilityHandler = nil
      errorPipe.fileHandleForReading.readabilityHandler = nil
      throw error
    }

    if finished.wait(timeout: .now() + timeout) == .timedOut {
      process.terminate()
      if finished.wait(timeout: .now() + 3) == .timedOut {
        kill(process.processIdentifier, SIGKILL)
        _ = finished.wait(timeout: .now() + 2)
      }
      _ = readers.wait(timeout: .now() + 2)
      throw AudioTextError.processTimedOut(executable.lastPathComponent)
    }
    _ = readers.wait(timeout: .now() + 5)
    return ProcessResult(
      status: process.terminationStatus,
      standardOutput: output.value,
      standardError: errors.value
    )
  }
}

private final class LockedBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()
  private let limit: Int

  init(limit: Int) {
    self.limit = limit
  }

  func append(_ newData: Data) {
    lock.lock()
    defer { lock.unlock() }
    guard data.count < limit else { return }
    data.append(newData.prefix(limit - data.count))
  }

  var value: Data {
    lock.lock()
    defer { lock.unlock() }
    return data
  }
}
