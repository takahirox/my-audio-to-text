"""Independent GTK editor with normal, protected and length-limited fields."""
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
limited = Gtk.Entry(text="xy", max_length=4)
limited_edits = 0


def count_edit(_entry):
    global limited_edits
    limited_edits += 1


limited.connect("changed", count_edit)
for control in [a, b]:
    control.set_size_request(-1, 55)
    buffer = control.get_buffer()
    buffer.set_text("left|right" if control is a else "")
    buffer.place_cursor(buffer.get_iter_at_offset(5 if control is a else 0))
    box.pack_start(control, True, True, 0)
box.pack_start(password, False, False, 0)
box.pack_start(limited, False, False, 0)
window.add(box)
window.connect("destroy", Gtk.main_quit)
window.show_all()
a.grab_focus()

def report():
    values = []
    for control in [a, b]:
        buffer = control.get_buffer()
        values.append(buffer.get_text(*buffer.get_bounds(), True))
    values.extend([password.get_text(), limited.get_text()])
    focused = window.get_focus()
    controls = [a, b, password, limited]
    value = {"values": values, "focus": controls.index(focused) if focused in controls else -1,
             "limitedEdits": limited_edits}
    temp = state.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(value))
        temp.replace(state)
    except FileNotFoundError:
        return False
    return True

GLib.timeout_add(60, report)
Gtk.main()
