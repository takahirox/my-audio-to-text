import AudioTextCore
import SwiftUI

private enum TranscriptLevel: String, CaseIterable, Identifiable {
  case raw = "Raw Transcript"
  case clean = "Clean Transcript"
  case output = "Polished / Synthesis"

  var id: String { rawValue }
}

struct MainWindow: View {
  @EnvironmentObject private var controller: AppController
  @State private var level: TranscriptLevel = .clean

  var body: some View {
    NavigationSplitView {
      List(
        selection: Binding(
          get: { controller.selectedSessionID },
          set: { controller.selectSession($0) }
        )
      ) {
        Section("Sessions") {
          ForEach(controller.sessions) { session in
            VStack(alignment: .leading, spacing: 3) {
              Text(session.mode == .quickDictation ? "Quick Dictation" : "Thinking Session")
                .font(.headline)
              Text(session.startedAt.formatted(date: .abbreviated, time: .shortened))
                .font(.caption)
                .foregroundStyle(.secondary)
              Text(session.status.rawValue.replacingOccurrences(of: "_", with: " "))
                .font(.caption2)
                .foregroundStyle(statusColor(session.status))
            }
            .tag(session.id)
          }
        }
      }
      .navigationTitle("History")
    } detail: {
      VStack(spacing: 0) {
        controls
        Divider()
        transcript
        Divider()
        status
      }
      .navigationTitle("My Audio to Text")
    }
    .alert(
      "Processing Error",
      isPresented: Binding(
        get: { controller.errorMessage != nil },
        set: { if !$0 { controller.errorMessage = nil } }
      )
    ) {
      Button("OK") { controller.errorMessage = nil }
    } message: {
      Text(controller.errorMessage ?? "Unknown error")
    }
  }

  private var controls: some View {
    HStack(spacing: 12) {
      Button {
        controller.isRecording
          ? controller.stopRecording()
          : controller.startRecording(mode: .quickDictation)
      } label: {
        Label(
          controller.isRecording ? "Stop" : "Quick Dictation",
          systemImage: controller.isRecording ? "stop.circle.fill" : "mic.circle.fill"
        )
      }
      .buttonStyle(.borderedProminent)

      Button("Thinking Session", systemImage: "brain.head.profile") {
        controller.startRecording(mode: .thinkingSession)
      }
      .disabled(controller.isRecording || controller.isProcessing)

      Spacer()

      Button("Polish") { controller.polish() }
        .disabled(controller.cleanTranscript.isEmpty || controller.isProcessing)
      Button("Synthesize") { controller.synthesizeCurrent() }
        .disabled(controller.cleanTranscript.isEmpty || controller.isProcessing)
      Menu("Outputs") {
        Button("Detailed Notes") { controller.showDetailedNotes() }
        Button("Action List") { controller.showActionList() }
        Button("Structured JSON") { controller.showSynthesisJSON() }
      }
      .disabled(controller.synthesis == nil)
      Button("Copy", systemImage: "doc.on.doc") { controller.copyDisplayedOutput() }
        .disabled(controller.cleanTranscript.isEmpty && controller.displayedOutput.isEmpty)
    }
    .padding()
  }

  private var transcript: some View {
    VStack(alignment: .leading, spacing: 10) {
      Picker("Information level", selection: $level) {
        ForEach(TranscriptLevel.allCases) { Text($0.rawValue).tag($0) }
      }
      .pickerStyle(.segmented)

      ScrollView {
        Text(visibleText.isEmpty ? placeholder : visibleText)
          .foregroundStyle(visibleText.isEmpty ? .secondary : .primary)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .topLeading)
          .padding(4)
      }

      if !controller.partialTranscript.isEmpty {
        HStack(alignment: .top) {
          ProgressView().controlSize(.small)
          Text(controller.partialTranscript)
            .foregroundStyle(.secondary)
            .italic()
        }
        .accessibilityLabel("Unstable partial transcript")
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var status: some View {
    HStack {
      if controller.isProcessing { ProgressView().controlSize(.small) }
      Circle()
        .fill(controller.isRecording ? Color.red : Color.secondary)
        .frame(width: 8, height: 8)
      Text(controller.message).font(.footnote)
      Spacer()
      if controller.isRecording { Text("PARTIAL results are not yet committed").font(.caption) }
    }
    .padding(.horizontal)
    .padding(.vertical, 9)
  }

  private var visibleText: String {
    switch level {
    case .raw: controller.rawTranscript
    case .clean: controller.cleanTranscript
    case .output: controller.displayedOutput
    }
  }

  private var placeholder: String {
    switch level {
    case .raw: "Raw ASR segments will appear here."
    case .clean: "Conservatively cleaned transcript will appear here."
    case .output: "Polished text and synthesis outputs never overwrite source transcripts."
    }
  }

  private func statusColor(_ status: SessionStatus) -> Color {
    switch status {
    case .completed: .green
    case .recording, .processing: .blue
    case .interrupted: .orange
    case .failed: .red
    }
  }
}

struct SettingsView: View {
  @EnvironmentObject private var controller: AppController

  var body: some View {
    Form {
      Section("Local ASR — whisper.cpp") {
        TextField("whisper-cli executable", text: $controller.configuration.whisperExecutable)
        TextField("GGML model", text: $controller.configuration.whisperModel)
        TextField("Language", text: $controller.configuration.language)
      }
      Section("Local LLM — llama.cpp") {
        TextField("llama-cli executable", text: $controller.configuration.llamaExecutable)
        TextField("GGUF model", text: $controller.configuration.llamaModel)
        LabeledContent("Context tokens") {
          TextField(
            "Context", value: $controller.configuration.synthesisContextTokens, format: .number
          )
          .frame(width: 100)
        }
      }
      Section("Recording") {
        Toggle("Keep recorded audio", isOn: $controller.configuration.retainAudio)
        LabeledContent("Final chunk seconds") {
          TextField("Seconds", value: $controller.configuration.chunkSeconds, format: .number)
            .frame(width: 80)
        }
        Text(
          "Final transcript segments are persisted continuously whether or not audio is retained."
        )
        .font(.caption)
        .foregroundStyle(.secondary)
      }
      HStack {
        Spacer()
        Button("Save") { controller.saveConfiguration() }
          .buttonStyle(.borderedProminent)
      }
    }
    .formStyle(.grouped)
    .padding()
  }
}
