"""Independent GTK editor with a normal, alternate and protected field."""
import json
from pathlib import Path
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

state = Path(sys.argv[1])
window = Gtk.Window(title="Voice typing test editor")
window.set_default_size(420, 230)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
a, b = Gtk.TextView(), Gtk.TextView()
password = Gtk.Entry(visibility=False, text="secret")
for control in [a, b]:
    control.set_size_request(-1, 55)
    buffer = control.get_buffer()
    buffer.set_text("left|right" if control is a else "")
    buffer.place_cursor(buffer.get_iter_at_offset(5 if control is a else 0))
    box.pack_start(control, True, True, 0)
box.pack_start(password, False, False, 0)
window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all()
a.grab_focus()

def report():
    values = []
    for control in [a, b]:
        buffer = control.get_buffer()
        values.append(buffer.get_text(*buffer.get_bounds(), True))
    values.append(password.get_text())
    focused = window.get_focus()
    value = {"values": values, "focus": [a, b, password].index(focused) if focused in [a, b, password] else -1}
    temp = state.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(value))
        temp.replace(state)
    except FileNotFoundError:
        return False
    return True

GLib.timeout_add(60, report)
Gtk.main()
