// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "my-audio-to-text",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "AudioTextCore", targets: ["AudioTextCore"]),
    .executable(name: "MyAudioToText", targets: ["MyAudioToTextApp"]),
    .executable(name: "PersonalizationEval", targets: ["PersonalizationEval"]),
  ],
  targets: [
    .systemLibrary(name: "CSQLite"),
    .target(name: "AudioTextCore", dependencies: ["CSQLite"]),
    .executableTarget(name: "PersonalizationEval", dependencies: ["AudioTextCore"]),
    .executableTarget(
      name: "MyAudioToTextApp",
      dependencies: ["AudioTextCore"],
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("AVFoundation"),
        .linkedFramework("Carbon"),
      ]
    ),
    .testTarget(name: "AudioTextCoreTests", dependencies: ["AudioTextCore"]),
    .testTarget(
      name: "MyAudioToTextAppTests", dependencies: ["MyAudioToTextApp", "AudioTextCore"]
    ),
  ],
  swiftLanguageModes: [.v5]
)
