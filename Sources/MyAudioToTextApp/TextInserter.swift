import AppKit
import ApplicationServices
import Foundation

enum TextInsertionResult: Equatable {
  case pasted
  case clipboardOnly
}

enum TextInserter {
  @discardableResult
  static func insertOrCopy(_ text: String) -> TextInsertionResult {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(text, forType: .string)

    guard AXIsProcessTrusted() else { return .clipboardOnly }
    guard
      let keyDown = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: true),
      let keyUp = CGEvent(keyboardEventSource: nil, virtualKey: 9, keyDown: false)
    else { return .clipboardOnly }
    keyDown.flags = .maskCommand
    keyUp.flags = .maskCommand
    keyDown.post(tap: .cghidEventTap)
    keyUp.post(tap: .cghidEventTap)
    return .pasted
  }

  static func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
}
