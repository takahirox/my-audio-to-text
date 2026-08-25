import SwiftUI

@main
struct AudioToTextMacApp: App {
    @StateObject private var model = AppModel()
    var body: some Scene {
        MenuBarExtra("Audio to Text", systemImage: model.recorder.isRecording ? "waveform.circle.fill" : "waveform.circle") {
            Button(model.recorder.isRecording ? "Stop Recording" : "Start Recording") { model.toggleRecording() }
            Divider()
            Button("Open") { NSApp.activate(ignoringOtherApps: true) }
            Button("Quit") { NSApp.terminate(nil) }
        }
        Window("Audio to Text", id: "main") {
            VStack(alignment: .leading, spacing: 16) {
                Picker("Mode", selection: $model.mode) { ForEach(AppModel.Mode.allCases) { Text($0.rawValue).tag($0) } }.pickerStyle(.segmented)
                HStack { Circle().frame(width: 10, height: 10).opacity(model.recorder.isRecording ? 1 : 0.25); Text(model.status); Spacer(); Text(model.recorder.elapsed.formatted(.number.precision(.fractionLength(1)))) }
                TextEditor(text: $model.transcript).font(.body.monospaced()).frame(minHeight: 280)
                HStack { Button(model.recorder.isRecording ? "Stop" : "Record") { model.toggleRecording() }.keyboardShortcut(.space, modifiers: [.option]); Button("Copy") { model.copyTranscript() }.disabled(model.transcript.isEmpty) }
            }.padding(20).frame(minWidth: 620, minHeight: 420)
        }
    }
}
