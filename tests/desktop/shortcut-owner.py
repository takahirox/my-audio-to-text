"""Hold an independent X11 shortcut grab until the test closes stdin."""
import sys

from Xlib import X, XK, display, error

session = display.Display()
root = session.screen().root
key = session.keysym_to_keycode(XK.string_to_keysym(sys.argv[1] if len(sys.argv) > 1 else "F10"))
failed = error.CatchError()
root.grab_key(key, X.ControlMask | X.Mod1Mask | X.ShiftMask, False,
              X.GrabModeAsync, X.GrabModeAsync, onerror=failed)
session.sync()
if failed.get_error():
    raise SystemExit("Could not reserve test shortcut")
print("ready", flush=True)
sys.stdin.read()
