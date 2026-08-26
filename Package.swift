// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "my-audio-to-text",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "AudioTextCore", targets: ["AudioTextCore"]),
    .executable(name: "MyAudioToText", targets: ["MyAudioToTextApp"]),
  ],
  targets: [
    .systemLibrary(name: "CSQLite"),
    .target(name: "AudioTextCore", dependencies: ["CSQLite"]),
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
  ],
  swiftLanguageModes: [.v5]
)
