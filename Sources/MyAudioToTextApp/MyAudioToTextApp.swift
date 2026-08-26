import AudioTextCore
import SwiftUI

@main
struct MyAudioToTextApp: App {
  @StateObject private var controller = AppController()

  var body: some Scene {
    MenuBarExtra(
      "My Audio to Text",
      systemImage: controller.isRecording ? "waveform.circle.fill" : "waveform.circle"
    ) {
      Button(controller.isRecording ? "Stop Recording" : "Quick Dictation (⌥Space)") {
        controller.toggleQuickDictation()
      }
      .keyboardShortcut(.space, modifiers: .option)

      Button("Start Thinking Session") {
        controller.startRecording(mode: .thinkingSession)
      }
      .disabled(controller.isRecording || controller.isProcessing)

      Divider()
      Text(controller.message)
      SettingsLink { Text("Settings…") }
      Button("Quit") { NSApplication.shared.terminate(nil) }
    }

    WindowGroup("My Audio to Text") {
      MainWindow()
        .environmentObject(controller)
        .frame(minWidth: 960, minHeight: 620)
    }
    .defaultSize(width: 1_150, height: 760)

    Settings {
      SettingsView()
        .environmentObject(controller)
        .frame(width: 620, height: 430)
    }
  }
}
