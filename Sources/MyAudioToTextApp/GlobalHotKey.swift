import Carbon
import Foundation

final class GlobalHotKey {
  private var hotKeyRef: EventHotKeyRef?
  private var handlerRef: EventHandlerRef?
  private let action: () -> Void

  init(action: @escaping () -> Void) {
    self.action = action
    install()
  }

  deinit {
    if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
    if let handlerRef { RemoveEventHandler(handlerRef) }
  }

  private func install() {
    var eventType = EventTypeSpec(
      eventClass: OSType(kEventClassKeyboard),
      eventKind: UInt32(kEventHotKeyPressed)
    )
    InstallEventHandler(
      GetApplicationEventTarget(),
      { _, _, userData in
        guard let userData else { return noErr }
        Unmanaged<GlobalHotKey>.fromOpaque(userData).takeUnretainedValue().action()
        return noErr
      },
      1,
      &eventType,
      Unmanaged.passUnretained(self).toOpaque(),
      &handlerRef
    )
    let identifier = EventHotKeyID(signature: 0x4D_41_54_54, id: 1)  // MATT
    RegisterEventHotKey(
      UInt32(kVK_Space),
      UInt32(optionKey),
      identifier,
      GetApplicationEventTarget(),
      0,
      &hotKeyRef
    )
  }
}
