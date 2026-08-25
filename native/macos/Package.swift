// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "AudioToTextMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AudioToTextMac", targets: ["AudioToTextMac"])],
    targets: [.executableTarget(name: "AudioToTextMac", path: "Sources")]
)
