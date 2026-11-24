"""Own the AT-SPI object authorized by the user. JSON lines are private pipes."""
import json
import os
import sys
import time

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib
from Xlib import X, Xatom, display, error


class TargetError(Exception):
    pass


NO_TARGET = "Focus an editable plain-text field in another application and try again."
LOST_TARGET = "Voice typing stopped because the authorized text field lost focus, changed, or closed."
UNEDITABLE_CARET = "Place the caret in an editable plain-text region and try again."


def send(value):
    print(json.dumps(value), flush=True)


def children(node):
    return (node.get_child_at_index(index) for index in range(node.get_child_count()))


def same_node(a, b):
    # libatspi interns accessibility proxies by unique D-Bus name/object path.
    return a is not None and b is not None and a == b


class Focus:
    def __init__(self):
        self.x = display.Display()
        self.root = self.x.screen().root
        self.active_atom = self.x.intern_atom("_NET_ACTIVE_WINDOW")
        self.pid_atom = self.x.intern_atom("_NET_WM_PID")
        self.window_type_atom = self.x.intern_atom("_NET_WM_WINDOW_TYPE")
        self.popup_atom = self.x.intern_atom("_NET_WM_WINDOW_TYPE_POPUP_MENU")
        self.root.change_attributes(event_mask=X.PropertyChangeMask | X.SubstructureNotifyMask)
        self.x.flush()
        self.bound = None
        self.watched = None
        self.focused = None
        self.grabbed = False
        self.shortcut_target = None
        self.tray_target = None
        self.tray_window = None
        self.tray_deadline = 0
        self.binding = None
        self.input = b""

    def window(self, verify_focus=True):
        active = self.root.get_full_property(self.active_atom, Xatom.WINDOW)
        if active is None or len(active.value) != 1 or active.value[0] == 0:
            raise TargetError(NO_TARGET)
        xid = int(active.value[0])
        window = self.x.create_resource_object("window", xid)
        pid = window.get_full_property(self.pid_atom, Xatom.CARDINAL)
        if pid is None or len(pid.value) != 1 or pid.value[0] == os.getppid():
            raise TargetError(NO_TARGET)
        if not verify_focus:
            return xid, int(pid.value[0])
        focused = self.x.get_input_focus().focus
        # Editors can use an input child window of their EWMH toplevel.
        while hasattr(focused, "id") and focused.id not in (xid, self.root.id):
            focused = focused.query_tree().parent
        if not hasattr(focused, "id") or focused.id != xid:
            raise TargetError(NO_TARGET)
        return xid, int(pid.value[0])

    @staticmethod
    def editable(node):
        states = node.get_state_set()
        required = (Atspi.StateType.FOCUSED, Atspi.StateType.EDITABLE, Atspi.StateType.ENABLED,
                    Atspi.StateType.SENSITIVE, Atspi.StateType.SHOWING)
        if node.get_role() not in (Atspi.Role.ENTRY, Atspi.Role.TEXT):
            raise TargetError(NO_TARGET)
        if not all(states.contains(state) for state in required) or any(
                states.contains(state) for state in (Atspi.StateType.DEFUNCT, Atspi.StateType.READ_ONLY)):
            raise TargetError(NO_TARGET)
        if not {"EditableText", "Text"}.issubset(node.get_interfaces()):
            raise TargetError(NO_TARGET)
        return states

    @staticmethod
    def caret(node):
        offset = node.get_caret_offset()
        count = node.get_character_count()
        if offset < 0 or offset > count or node.get_n_selections():
            raise TargetError("Place a caret with no text selected in the authorized field.")
        toolkit = node.get_toolkit_name()
        if toolkit == "gtk":
            # GtkTextView exposes GtkTextTag editability through AT-SPI. Check
            # the runs on both sides, since an insertion can meet a tag boundary.
            neighbors = [index for index in (offset - 1, offset) if 0 <= index < count]
            default = node.get_default_attributes().get("editable")
            if default != "true":
                raise TargetError(UNEDITABLE_CARET)
            for index in neighbors:
                attributes, start, end = node.get_attribute_run(index, False)
                if not start <= index < end or attributes.get("editable", default) != "true":
                    raise TargetError(UNEDITABLE_CARET)
        elif toolkit == "Gecko":
            # Ordinary HTML text controls do not have individually editable runs.
            # Focus events can leave an empty object-attribute cache.
            attributes = node.get_attributes_as_array()
            if not attributes:
                node.clear_cache()
                attributes = node.get_attributes_as_array()
            if not {"tag:input", "tag:textarea"}.intersection(attributes):
                raise TargetError(UNEDITABLE_CARET)
        else:
            raise TargetError(UNEDITABLE_CARET)
        return offset

    def locate(self, window):
        frames = []
        for app in children(Atspi.get_desktop(0)):
            if app is not None and app.get_process_id() == window[1]:
                frames.extend(frame for frame in children(app) if frame is not None
                              and frame.get_state_set().contains(Atspi.StateType.ACTIVE))
        if len(frames) != 1:
            raise TargetError(NO_TARGET)
        pending = frames[:]
        focused = None
        # Bound discovery on large trees. Descend through document containers,
        # but never choose an ambiguous or protected focused object.
        for _ in range(4096):
            if not pending:
                break
            node = pending.pop()
            states = node.get_state_set()
            if states.contains(Atspi.StateType.FOCUSED):
                self.editable(node)
                if focused is not None:
                    raise TargetError(NO_TARGET)
                focused = node
                continue
            if states.contains(Atspi.StateType.SHOWING):
                pending.extend(child for child in reversed(list(children(node))) if child is not None)
        if focused is None or pending or self.window() != window:
            raise TargetError(NO_TARGET)
        return frames[0], focused

    def watch_window(self):
        try:
            window = self.window(verify_focus=False)
        except (TargetError, error.XError):
            window = None
        if window == self.watched:
            return
        if self.watched:
            self.x.create_resource_object("window", self.watched[0]).change_attributes(
                event_mask=0, onerror=error.CatchError())
        self.watched = window
        self.focused = None
        self.grabbed = False
        self.shortcut_target = None
        self.tray_target = None
        if window:
            self.x.create_resource_object("window", window[0]).change_attributes(
                event_mask=X.FocusChangeMask | X.StructureNotifyMask, onerror=error.CatchError())
            GLib.timeout_add(50, self.seed_focus, window)
        self.x.flush()

    def seed_focus(self, window):
        # Some toolkits restore a field on window activation without sending
        # another AT-SPI focus event. Seed only before a shortcut grab.
        if self.watched is not window or self.focused is not None or self.grabbed:
            return False
        try:
            if self.window() == window:
                _, focused = self.locate(window)
                self.x_event()
                if self.watched is window and self.focused is None and not self.grabbed:
                    self.focused = focused
        except (TargetError, GLib.Error, error.XError):
            pass
        return False

    def bind(self, token, expected):
        window = self.window()
        frame, focused = self.locate(window)
        if window != expected[0] or not same_node(focused, expected[1]):
            raise TargetError(LOST_TARGET)
        states = self.editable(focused)
        if not states.contains(Atspi.StateType.MULTI_LINE) and focused.get_toolkit_name() == "gtk":
            # GTK entries can truncate without exposing their capacity in AT-SPI.
            raise TargetError("Use a GTK plain-text editor view. GTK entries may limit text length.")
        self.caret(focused)
        self.bound = (token, window, frame, focused)

    def bind_after_grab(self, token, action, reply):
        now = time.monotonic()
        if action == "bind-tray":
            target, self.tray_target = self.tray_target, None
            if target is None or (self.tray_window is None and now > self.tray_deadline):
                raise TargetError(LOST_TARGET)
        else:
            target, self.shortcut_target = self.shortcut_target, None
            if target is None or now - target[2] > 1:
                raise TargetError(NO_TARGET)
        if self.watched != target[0]:
            raise TargetError(NO_TARGET)
        self.binding = (token, target)
        deadline = now + 1

        def settle():
            self.x_event()
            try:
                if self.binding != (token, target) or self.watched != target[0]:
                    raise TargetError(LOST_TARGET)
                if self.grabbed or not same_node(self.focused, target[1]):
                    if time.monotonic() < deadline:
                        return True
                    raise TargetError(LOST_TARGET)
                self.bind(token, target)
            except TargetError as failure:
                reply["error"] = str(failure)
            except (GLib.Error, error.XError):
                reply["error"] = LOST_TARGET
            if self.binding == (token, target):
                self.binding = None
            send(reply)
            return False

        GLib.timeout_add(75, settle)

    def current(self, token):
        if self.bound is None or self.bound[0] != token:
            raise TargetError(LOST_TARGET)
        _, window, frame, node = self.bound
        try:
            if self.window() == window and frame.get_state_set().contains(Atspi.StateType.ACTIVE):
                return node, self.editable(node)
        except (TargetError, GLib.Error, error.XError) as failure:
            raise TargetError(LOST_TARGET) from failure
        raise TargetError(LOST_TARGET)

    def insert(self, token, text):
        node, states = self.current(token)
        if not states.contains(Atspi.StateType.MULTI_LINE) and ("\n" in text or "\r" in text):
            raise TargetError("Use a multiline field for text containing line breaks.")
        offset = self.caret(node)
        before = node.get_character_count()
        prefix = node.get_text(0, offset)
        suffix = node.get_text(offset, before)
        expected = text
        if node.get_toolkit_name() == "Gecko":
            # Gecko's ATK text pads non-BMP characters to preserve UTF-16 offsets.
            expected = "".join(character + ("\ufeff" if ord(character) > 0xFFFF else "") for character in text)
        self.current(token)
        if self.caret(node) != offset:
            raise TargetError(LOST_TARGET)
        acknowledged = node.insert_text(offset, text, len(text.encode("utf-8")))
        # A browser can acknowledge AT-SPI before its content process commits
        # the edit. Wait for the effect, never retry the mutation itself.
        deadline = time.monotonic() + 0.65
        while True:
            self.current(token)
            count = node.get_character_count()
            end = offset + count - before
            if end > offset:
                inserted = node.get_text(offset, end)
                if inserted == expected:
                    break
                if inserted and expected.startswith(inserted) and node.get_text(0, -1) == prefix + inserted + suffix:
                    self.restore_partial(token, node, offset, end, prefix + inserted + suffix, prefix + suffix)
                    raise TargetError("The field could not fit the entire text. Voice typing stopped.")
            if time.monotonic() >= deadline:
                raise TargetError("The field did not preserve the inserted text exactly. Voice typing stopped.")
            if not acknowledged and end == offset:
                raise TargetError("The authorized field rejected text insertion.")
            time.sleep(0.02)
        self.current(token)
        if node.get_caret_offset() != end and not node.set_caret_offset(end):
            raise TargetError("The field could not advance its caret. Voice typing stopped.")

    def restore_partial(self, token, node, offset, end, partial, original):
        # Firefox can silently truncate maxlength inputs. Remove only the
        # isolated inserted prefix, after checking the entire field again.
        self.current(token)
        if node.get_text(0, -1) != partial or not node.delete_text(offset, end):
            raise TargetError("The field changed before the incomplete insertion could be restored.")
        deadline = time.monotonic() + 0.65
        while node.get_text(0, -1) != original:
            if time.monotonic() >= deadline:
                raise TargetError("The field did not restore its original text.")
            time.sleep(0.02)
        self.current(token)
        if node.get_caret_offset() != offset:
            node.set_caret_offset(offset)

    def release(self, token):
        if self.binding and token == self.binding[0]:
            self.binding = None
        if self.bound and token == self.bound[0]:
            self.bound = None

    def invalidate(self):
        if self.bound:
            token = self.bound[0]
            self.release(token)
            send({"invalid": token, "error": LOST_TARGET})

    def check(self):
        if self.bound and not self.grabbed:
            try:
                self.current(self.bound[0])
            except Exception:
                self.invalidate()
        return True

    def focus_event(self, event):
        self.x_event()
        node = event.source
        if self.watched and node.get_process_id() == self.watched[1]:
            if event.detail1:
                target = self.binding[1] if self.binding else self.tray_target or self.shortcut_target
                if (self.focused is None and target and node.get_role() == Atspi.Role.PANEL
                        and node.get_toolkit_name() == "Gecko"):
                    # Firefox reports browser chrome focus before restoring the
                    # original control. The panel itself cannot authorize Start.
                    return
                self.focused = node
                if self.shortcut_target and not same_node(node, self.shortcut_target[1]):
                    self.shortcut_target = None
                if self.tray_target and not same_node(node, self.tray_target[1]):
                    self.tray_target = None
                if self.binding and not same_node(node, self.binding[1][1]):
                    self.binding = None
            elif not self.grabbed and same_node(node, self.focused):
                self.focused = None
        if not self.bound:
            return
        token, window, _, bound_node = self.bound
        if event.detail1:
            if not same_node(node, bound_node) and node.get_process_id() == window[1]:
                self.invalidate()
        elif same_node(node, bound_node):
            # A global accelerator's passive keyboard grab also emits a
            # transient unfocus/focus pair for an unchanged GTK control.
            def settled():
                if self.bound and token == self.bound[0]:
                    self.check()
                return False
            GLib.timeout_add(75, settled)

    def track_tray_menu(self, event):
        if event.type in (X.UnmapNotify, X.DestroyNotify) and event.window.id == self.tray_window:
            self.tray_window = None
            self.tray_deadline = time.monotonic() + 1
        if event.type != X.MapNotify or not event.override or self.tray_window is not None:
            return
        try:
            window = event.window
            pid = window.get_full_property(self.pid_atom, Xatom.CARDINAL)
            if pid is None or list(pid.value) != [os.getppid()]:
                return
            kind = window.get_full_property(self.window_type_atom, Xatom.ATOM)
            if kind is None or self.popup_atom not in kind.value:
                return
        except error.XError:
            return
        # XEmbed opens a GTK popup after it takes the keyboard grab. Keep that
        # grab's field for this menu even if the menu stays open for a while.
        self.tray_window = window.id
        self.tray_target = self.shortcut_target if self.grabbed else None

    def x_event(self, *_args):
        active_changed = False
        while self.x.pending_events():
            event = self.x.next_event()
            active_changed |= event.type == X.PropertyNotify and event.atom == self.active_atom
            self.track_tray_menu(event)
            if not self.watched or getattr(getattr(event, "window", None), "id", None) != self.watched[0]:
                continue
            if event.type == X.FocusOut and event.mode == X.NotifyGrab:
                # X11 delivers the passive keyboard grab before the toolkit's
                # transient accessibility focus loss. Keep the pre-grab object.
                self.grabbed = True
                self.shortcut_target = (self.watched, self.focused, time.monotonic()) if self.focused is not None else None
                self.focused = None
            elif event.type == X.FocusIn and event.mode == X.NotifyUngrab:
                self.grabbed = False
            lost = event.type in (X.DestroyNotify, X.UnmapNotify)
            if lost or (event.type == X.FocusOut and event.mode == X.NotifyNormal
                        and event.detail != X.NotifyInferior):
                self.focused = None
                self.shortcut_target = None
                self.tray_target = None
                self.binding = None
                self.invalidate()
        if active_changed:
            previous = self.watched
            self.watch_window()
            if previous != self.watched:
                self.binding = None
            self.check()
        return True

    def receive(self, fd, _condition):
        data = os.read(fd, 65536)
        if not data:
            loop.quit()
            return False
        self.input += data
        while b"\n" in self.input:
            line, self.input = self.input.split(b"\n", 1)
            self.handle(line)
        return True

    def handle(self, line):
        message = json.loads(line)
        reply = {"request": message["request"]}
        try:
            action = message["action"]
            if action in ("bind-shortcut", "bind-tray"):
                self.x_event()
                self.bind_after_grab(message["token"], action, reply)
                return
            elif action == "insert":
                self.x_event()
                self.insert(message["token"], message["text"])
            elif action == "release":
                self.release(message["token"])
            else:
                raise TargetError("Unknown accessibility request.")
        except TargetError as error:
            reply["error"] = str(error)
        except Exception:
            reply["error"] = (LOST_TARGET if action == "insert" else
                              "Accessibility could not verify the focused field. "
                              "Check the X11 session and AT-SPI accessibility settings.")
        send(reply)


if __name__ == "__main__":
    Atspi.init()
    focus = Focus()
    listener = Atspi.EventListener.new(focus.focus_event)
    if not listener.register("object:state-changed:focused"):
        raise SystemExit("AT-SPI focused-control events unavailable")
    focus.watch_window()
    GLib.io_add_watch(focus.x.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN, focus.x_event)
    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, focus.receive)
    GLib.timeout_add(300, focus.check)
    send({"ready": True})
    loop = GLib.MainLoop()
    loop.run()
