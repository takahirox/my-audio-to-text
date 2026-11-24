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
        self.root.change_attributes(event_mask=X.PropertyChangeMask)
        self.x.flush()
        self.bound = None
        self.input = b""

    def window(self):
        active = self.root.get_full_property(self.active_atom, Xatom.WINDOW)
        if active is None or len(active.value) != 1 or active.value[0] == 0:
            raise TargetError(NO_TARGET)
        xid = int(active.value[0])
        window = self.x.create_resource_object("window", xid)
        pid = window.get_full_property(self.pid_atom, Xatom.CARDINAL)
        if pid is None or len(pid.value) != 1 or pid.value[0] == os.getppid():
            raise TargetError(NO_TARGET)
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
        if offset < 0 or offset > node.get_character_count() or node.get_n_selections():
            raise TargetError("Place a caret with no text selected in the authorized field.")
        return offset

    def bind(self, token):
        self.bound = None
        window = self.window()
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
        self.caret(focused)
        xwindow = self.x.create_resource_object("window", window[0])
        failed = error.CatchError()
        xwindow.change_attributes(event_mask=X.FocusChangeMask | X.StructureNotifyMask, onerror=failed)
        self.x.sync()
        if failed.get_error():
            raise TargetError(NO_TARGET)
        self.bound = (token, window, frames[0], focused)

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
        self.current(token)
        if not node.insert_text(offset, text, len(text.encode("utf-8"))):
            raise TargetError("The authorized field rejected text insertion.")
        # A browser can acknowledge AT-SPI before its content process commits
        # the edit. Wait for the effect, never retry the mutation itself.
        deadline = time.monotonic() + 0.65
        while True:
            self.current(token)
            added = node.get_character_count() - before
            if added > 0 and node.get_text(offset, offset + added) == text:
                break
            if time.monotonic() >= deadline:
                raise TargetError("The field did not preserve the inserted text exactly. Voice typing stopped.")
            time.sleep(0.02)
        self.current(token)
        if node.get_caret_offset() != offset + added and not node.set_caret_offset(offset + added):
            raise TargetError("The field could not advance its caret. Voice typing stopped.")

    def release(self, token):
        if self.bound and token == self.bound[0]:
            window = self.x.create_resource_object("window", self.bound[1][0])
            window.change_attributes(event_mask=0, onerror=error.CatchError())
            self.x.flush()
            self.bound = None

    def invalidate(self):
        if self.bound:
            token = self.bound[0]
            self.release(token)
            send({"invalid": token, "error": LOST_TARGET})

    def check(self):
        if self.bound:
            try:
                self.current(self.bound[0])
            except Exception:
                self.invalidate()
        return True

    def focus_event(self, event):
        if not self.bound:
            return
        token, window, _, node = self.bound
        if event.detail1:
            if not same_node(event.source, node) and event.source.get_process_id() == window[1]:
                self.invalidate()
        elif same_node(event.source, node):
            # A global accelerator's passive keyboard grab also emits a
            # transient unfocus/focus pair for an unchanged GTK control.
            def settled():
                if self.bound and token == self.bound[0]:
                    self.check()
                return False
            GLib.timeout_add(75, settled)

    def x_event(self, *_args):
        active_changed = False
        while self.x.pending_events():
            event = self.x.next_event()
            active_changed |= event.type == X.PropertyNotify and event.atom == self.active_atom
            if not self.bound or getattr(getattr(event, "window", None), "id", None) != self.bound[1][0]:
                continue
            lost = event.type in (X.DestroyNotify, X.UnmapNotify)
            if lost or (event.type == X.FocusOut and event.mode == X.NotifyNormal
                        and event.detail != X.NotifyInferior):
                self.invalidate()
        if active_changed and self.bound:
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
            if action == "bind":
                # Flush queued X notifications before taking a new lease.
                self.x_event()
                self.bind(message["token"])
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
    GLib.io_add_watch(focus.x.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN, focus.x_event)
    GLib.io_add_watch(sys.stdin.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, focus.receive)
    GLib.timeout_add(300, focus.check)
    send({"ready": True})
    loop = GLib.MainLoop()
    loop.run()
