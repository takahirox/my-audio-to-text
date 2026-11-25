import AppKit
import ApplicationServices
import AudioToolbox
import AVFoundation
import Carbon

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func require(_ status: OSStatus, _ message: String) {
    if status != noErr { fail("\(message) (\(status))") }
}

let systemAudio = AudioObjectID(kAudioObjectSystemObject)
var inputProperty = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
)

func defaultInput() -> AudioDeviceID {
    var device = AudioDeviceID()
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    require(AudioObjectGetPropertyData(systemAudio, &inputProperty, 0, nil, &size, &device),
            "Cannot read the default audio input")
    return device
}

func setInput(_ device: AudioDeviceID) {
    var selected = device
    require(AudioObjectSetPropertyData(systemAudio, &inputProperty, 0, nil,
                                       UInt32(MemoryLayout<AudioDeviceID>.size), &selected),
            "Cannot set the default audio input")
}

func blackHole() -> AudioDeviceID {
    var devicesProperty = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var size: UInt32 = 0
    require(AudioObjectGetPropertyDataSize(systemAudio, &devicesProperty, 0, nil, &size),
            "Cannot enumerate audio devices")
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    require(AudioObjectGetPropertyData(systemAudio, &devicesProperty, 0, nil, &size, &devices),
            "Cannot read audio devices")
    var nameProperty = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    for device in devices {
        var name: Unmanaged<CFString>?
        var length = UInt32(MemoryLayout.size(ofValue: name))
        if AudioObjectGetPropertyData(device, &nameProperty, 0, nil, &length, &name) == noErr,
           name?.takeRetainedValue() as String? == "BlackHole 2ch" {
            return device
        }
    }
    fail("BlackHole 2ch is unavailable")
}

func play(_ path: String) throws {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    guard let output = engine.outputNode.audioUnit else { fail("Cannot open audio output") }
    var device = blackHole()
    require(AudioUnitSetProperty(output, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global,
                                 0, &device, UInt32(MemoryLayout<AudioDeviceID>.size)),
            "Cannot route fixture audio to BlackHole")
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
    let done = DispatchSemaphore(value: 0)
    player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in done.signal() }
    try engine.start()
    player.play()
    if done.wait(timeout: .now() + 20) != .success { fail("Audio fixture playback timed out") }
    player.stop()
    engine.stop()
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success { return value }
    return nil
}

func editorApp() -> AXUIElement {
    guard let front = NSWorkspace.shared.frontmostApplication, front.bundleIdentifier == "com.apple.TextEdit"
    else { fail("An independent TextEdit document must be focused") }
    return AXUIElementCreateApplication(front.processIdentifier)
}

func editor() -> AXUIElement {
    guard let field = attribute(editorApp(), kAXFocusedUIElementAttribute),
          CFGetTypeID(field) == AXUIElementGetTypeID() else { fail("An independent TextEdit document must be focused") }
    return field as! AXUIElement
}

func keyEvents(_ key: Int, _ flags: CGEventFlags, _ keys: [Bool]) {
    guard CGPreflightPostEventAccess() else { fail("The test driver has no macOS keyboard event permission") }
    for down in keys {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(key), keyDown: down)
        else { fail("Cannot construct the keyboard event") }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        usleep(60_000)
    }
}

func shortcut(_ keys: [Bool]) {
    keyEvents(kVK_ANSI_D, [.maskControl, .maskAlternate, .maskCommand], keys)
}

func trayItem(_ pid: pid_t, _ label: String) {
    let app = AXUIElementCreateApplication(pid)
    guard let extras = attribute(app, "AXExtrasMenuBar"), CFGetTypeID(extras) == AXUIElementGetTypeID(),
          let items = attribute(extras as! AXUIElement, kAXChildrenAttribute) as? [AXUIElement],
          items.count == 1, let item = items.first
    else { fail("Cannot locate the packaged app's native menu-bar item") }
    guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success
    else { fail("Cannot open the packaged app's native menu") }
    for _ in 0..<30 {
        if let menus = attribute(item, kAXChildrenAttribute) as? [AXUIElement],
           let menu = menus.first(where: { attribute($0, kAXRoleAttribute) as? String == "AXMenu" }),
           let actions = attribute(menu, kAXChildrenAttribute) as? [AXUIElement],
           let action = actions.first(where: { attribute($0, kAXTitleAttribute) as? String == label }) {
            guard AXUIElementPerformAction(action, kAXPressAction as CFString) == .success
            else { fail("Cannot select the native menu item: \(label)") }
            return
        }
        usleep(100_000)
    }
    fail("The native menu did not expose its item: \(label)")
}

let args = CommandLine.arguments
switch args[1] {
case "permissions":
    print("{\"accessibility\":\(AXIsProcessTrusted()),\"keyboard\":\(CGPreflightPostEventAccess())}")
case "frontmost":
    print(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "")
case "textedit-pids":
    print(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.TextEdit")
        .map { String($0.processIdentifier) }.joined(separator: " "))
case "front-pid":
    print(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0)
case "shortcut":
    shortcut([true, false])
case "shortcut-down":
    shortcut([true])
case "shortcut-up":
    shortcut([false])
case "editor-new":
    _ = editorApp()
    keyEvents(kVK_ANSI_N, .maskCommand, [true, false])
case "editor-window":
    guard let window = attribute(editorApp(), kAXFocusedWindowAttribute),
          CFGetTypeID(window) == AXUIElementGetTypeID(),
          let title = attribute(window as! AXUIElement, kAXTitleAttribute) as? String
    else { fail("Cannot read the focused TextEdit window title") }
    print(title)
case "editor-raise":
    guard let windows = attribute(editorApp(), kAXWindowsAttribute) as? [AXUIElement],
          let window = windows.first(where: { attribute($0, kAXTitleAttribute) as? String == args[2] }),
          AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
    else { fail("Cannot raise the requested TextEdit window") }
case "activate":
    guard NSRunningApplication(processIdentifier: pid_t(args[2])!)?.activate() == true
    else { fail("Cannot activate the requested test application") }
case "tray":
    trayItem(pid_t(args[2])!, args[3])
case "text":
    guard let value = attribute(editor(), kAXValueAttribute) as? String else { fail("Cannot read TextEdit text") }
    // JSON preserves leading/trailing whitespace, including a document's final newline.
    print(String(decoding: try JSONEncoder().encode(value), as: UTF8.self))
case "caret":
    var range = CFRange(location: Int(args[2])!, length: 0)
    guard let selection = AXValueCreate(.cfRange, &range),
          AXUIElementSetAttributeValue(editor(), kAXSelectedTextRangeAttribute as CFString, selection) == .success
    else { fail("Cannot place the TextEdit caret") }
case "input":
    print(defaultInput())
case "set-input":
    setInput(AudioDeviceID(args[2])!)
case "blackhole":
    print(blackHole())
case "play":
    try play(args[2])
default:
    fail("Unknown macOS fixture command")
}
