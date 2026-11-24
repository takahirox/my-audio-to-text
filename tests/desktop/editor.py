"""Independent GTK editor with normal, protected and length-limited fields."""
import json
from pathlib import Path
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib, GObject

state = Path(sys.argv[1])
window = Gtk.Window(title="Voice typing test editor")
window.set_default_size(420, 230)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8)
a, b = Gtk.TextView(), Gtk.TextView()
constrained = Gtk.TextView()
constrained_text = constrained.get_buffer()
constrained_text.set_text("left|right")
constrained_text.place_cursor(constrained_text.get_iter_at_offset(5))
constrained_edits = 0


def limit_buffer(buffer, position, text, _length):
    available = max(12 - buffer.get_char_count(), 0)
    if len(text) > available:
        GObject.signal_stop_emission_by_name(buffer, "insert-text")
        if available:
            buffer.insert(position, text[:available])


def count_buffer_edit(_buffer):
    global constrained_edits
    constrained_edits += 1


constrained_text.connect("insert-text", limit_buffer)
constrained_text.connect("changed", count_buffer_edit)

password = Gtk.Entry(visibility=False, text="secret")
limited = Gtk.Entry(text="xy", max_length=4)
tagged = Gtk.TextView()
tagged_text = tagged.get_buffer()
tagged_text.set_text("open locked tail")
locked = tagged_text.create_tag("locked", editable=False)
tagged_text.apply_tag(locked, tagged_text.get_iter_at_offset(5), tagged_text.get_iter_at_offset(11))
tagged_text.place_cursor(tagged_text.get_iter_at_offset(7))
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
tagged.set_size_request(-1, 35)
box.pack_start(tagged, True, True, 0)
constrained.set_size_request(-1, 35)
box.pack_start(constrained, True, True, 0)
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
    controls = [a, b, password, limited, tagged, constrained]
    value = {"values": values, "focus": controls.index(focused) if focused in controls else -1,
             "limitedEdits": limited_edits, "tagged": tagged_text.get_text(*tagged_text.get_bounds(), True),
             "constrained": constrained_text.get_text(*constrained_text.get_bounds(), True),
             "constrainedCaret": constrained_text.get_iter_at_mark(constrained_text.get_insert()).get_offset(),
             "constrainedEdits": constrained_edits}
    temp = state.with_suffix(".tmp")
    try:
        temp.write_text(json.dumps(value))
        temp.replace(state)
    except FileNotFoundError:
        return False
    return True

GLib.timeout_add(60, report)
Gtk.main()
