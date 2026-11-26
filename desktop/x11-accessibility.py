"""Insert into the current X11 field using AT-SPI. JSON lines are private pipes."""
import json
import os
import sys
import time
from collections import deque

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi, GLib
from Xlib import X, Xatom, display, error
from x11_shortcut import Shortcut


class TargetError(Exception):
    pass


class AuthorizationError(Exception):
    pass


AUTHORIZATION_ERROR = "The voice typing session is no longer authorized."
FOCUS_SETTLE_MS = 75


def send(value):
    print(json.dumps(value), flush=True)


def children(node):
    return (node.get_child_at_index(index) for index in range(node.get_child_count()))


class Focus:
    def __init__(self):
        self.x = display.Display()
        self.root = self.x.screen().root
        self.shortcut = Shortcut(self.x, self.root)
        self.active_atom = self.x.intern_atom("_NET_ACTIVE_WINDOW")
        self.pid_atom = self.x.intern_atom("_NET_WM_PID")
        self.token = None
        self.shortcut_context = 0
        self.held_context = 0
        self.focus_settles_at = 0
        self.input_fd = sys.stdin.fileno()
        os.set_blocking(self.input_fd, False)
        self.input = b""
        self.input_closed = False
        self.requests = deque()
        self.dispatch_source = None

    def window(self):
        active = self.root.get_full_property(self.active_atom, Xatom.WINDOW)
        if active is None or len(active.value) != 1 or active.value[0] == 0:
            raise TargetError()
        xid = int(active.value[0])
        window = self.x.create_resource_object("window", xid)
        pid = window.get_full_property(self.pid_atom, Xatom.CARDINAL)
        if pid is None or len(pid.value) != 1 or pid.value[0] == os.getppid():
            raise TargetError()
        focused = self.x.get_input_focus().focus
        # Editors can use an input child window of their EWMH toplevel.
        while hasattr(focused, "id") and focused.id not in (xid, self.root.id):
            focused = focused.query_tree().parent
        if not hasattr(focused, "id") or focused.id != xid:
            raise TargetError()
        return xid, int(pid.value[0])

    @staticmethod
    def editable(node):
        states = node.get_state_set()
        required = (Atspi.StateType.FOCUSED, Atspi.StateType.EDITABLE, Atspi.StateType.ENABLED,
                    Atspi.StateType.SENSITIVE, Atspi.StateType.SHOWING)
        if node.get_role() not in (Atspi.Role.ENTRY, Atspi.Role.TEXT):
            raise TargetError()
        if not all(states.contains(state) for state in required) or any(
                states.contains(state) for state in (Atspi.StateType.DEFUNCT, Atspi.StateType.READ_ONLY)):
            raise TargetError()
        if not {"EditableText", "Text"}.issubset(node.get_interfaces()):
            raise TargetError()

    @staticmethod
    def caret(node):
        offset = node.get_caret_offset()
        count = node.get_character_count()
        if offset < 0 or offset > count:
            raise TargetError()
        if node.get_n_selections():
            raise TargetError()

        # The editable state covers the control. Explicit run attributes
        # can additionally mark locked spans on either side of the caret.
        for index in (offset - 1, offset):
            if 0 <= index < count:
                attributes, _, _ = node.get_attribute_run(index, False)
                if (attributes or {}).get("editable") == "false":
                    raise TargetError()
        return offset, count

    def locate(self, window):
        frames = []
        for app in children(Atspi.get_desktop(0)):
            if app is not None and app.get_process_id() == window[1]:
                frames.extend(frame for frame in children(app) if frame is not None
                              and frame.get_state_set().contains(Atspi.StateType.ACTIVE))
        if len(frames) != 1:
            raise TargetError()
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
                    raise TargetError()
                focused = node
                continue
            if states.contains(Atspi.StateType.SHOWING):
                pending.extend(child for child in reversed(list(children(node))) if child is not None)
        if focused is None or pending or self.window() != window:
            raise TargetError()
        return frames[0], focused

    def focus_is_settling(self):
        return self.shortcut.pressed is not None or time.monotonic() < self.focus_settles_at

    def insert_after_grab(self, token, text, reply):
        next_update = 0

        def settle():
            nonlocal next_update
            self.x_event()
            try:
                self.require_authorization(token)
                if self.focus_is_settling() or not self.insert(token, text):
                    # A held shortcut can outlast the host request timeout.
                    now = time.monotonic()
                    if now >= next_update:
                        send({**reply, "waiting": True})
                        next_update = now + 1
                    return True
            except AuthorizationError:
                reply["error"] = AUTHORIZATION_ERROR
            except (TargetError, GLib.Error, error.XError):
                # The target can disappear or reject an edit. Consume the
                # chunk even if AT-SPI may have already applied it.
                pass
            except Exception:
                reply["error"] = "The X11 accessibility service could not deliver text."
            send(reply)
            return False

        if settle():
            GLib.timeout_add(FOCUS_SETTLE_MS, settle)

    def verify(self, window, frame, node):
        if self.window() != window or not frame.get_state_set().contains(Atspi.StateType.ACTIVE):
            raise TargetError()
        self.editable(node)

    def require_authorization(self, token):
        # Synchronous target discovery can delay the stdin watch. Read any
        # pending revocations without running other commands inside an insert.
        self.read_requests()
        if self.token != token or self.input_closed or any(
                request.get("action") == "release" and request.get("token") == token
                for request in self.requests):
            raise AuthorizationError()

    def insert(self, token, text):
        window = self.window()
        frame, node = self.locate(window)
        offset, before = self.caret(node)
        self.x_event()
        if self.focus_is_settling():
            return False
        self.verify(window, frame, node)
        if self.caret(node) != (offset, before):
            raise TargetError()
        length = len(text.encode("utf-8"))
        self.require_authorization(token)
        if node.insert_text(offset, text, length):
            # Some implementations leave the caret in place. Advance by the
            # actual insertion length, including any native filtering.
            inserted = node.get_character_count() - before
            if inserted > 0 and node.get_caret_offset() == offset and not node.get_n_selections():
                self.verify(window, frame, node)
                self.require_authorization(token)
                node.set_caret_offset(offset + inserted)
        return True

    def x_event(self, *_args):
        # Also called on a timer because synchronous Xlib replies can pull
        # events into the internal queue before the GLib fd watch sees them.
        while self.x.pending_events():
            event = self.x.next_event()
            was_pressed = self.shortcut.pressed is not None
            if self.shortcut.released(event):
                self.focus_settles_at = time.monotonic() + FOCUS_SETTLE_MS / 1000
                send({"shortcut": self.shortcut.value, "context": self.held_context})
            elif not was_pressed and self.shortcut.pressed is not None:
                self.held_context = self.shortcut_context
        return True

    def read_requests(self):
        while not self.input_closed:
            try:
                data = os.read(self.input_fd, 65536)
            except BlockingIOError:
                break
            if not data:
                self.input_closed = True
                break
            self.input += data
        while b"\n" in self.input:
            line, self.input = self.input.split(b"\n", 1)
            self.requests.append(json.loads(line))
        if self.dispatch_source is None and (self.requests or self.input_closed):
            self.dispatch_source = GLib.idle_add(self.dispatch_requests, priority=GLib.PRIORITY_DEFAULT)

    def receive(self, *_args):
        self.read_requests()
        return not self.input_closed

    def dispatch_requests(self):
        while self.requests:
            self.handle(self.requests.popleft())
        self.dispatch_source = None
        if self.input_closed:
            loop.quit()
        return False

    def handle(self, message):
        reply = {"request": message["request"]}
        try:
            action = message["action"]
            token = message.get("token")
            if action == "shortcut-context":
                self.x_event()
                self.shortcut_context = message["text"]
            elif action == "authorize":
                if self.token is not None or not isinstance(token, str):
                    raise ValueError(AUTHORIZATION_ERROR)
                self.token = token
            elif action == "insert":
                if self.token is None or token != self.token:
                    raise ValueError(AUTHORIZATION_ERROR)
                text = message["text"]
                if "\0" in text:
                    raise ValueError("The accessibility service cannot insert null characters.")
                self.insert_after_grab(token, text, reply)
                return
            elif action == "release":
                if token == self.token:
                    self.token = None
            elif action == "set-shortcut":
                self.shortcut.set(message["text"])
            else:
                raise ValueError("Unknown accessibility request.")
        except ValueError as failure:
            reply["error"] = str(failure)
        except Exception:
            reply["error"] = ("The X11 accessibility service could not process the request. "
                              "Check the X11 session and AT-SPI accessibility settings.")
        send(reply)


if __name__ == "__main__":
    Atspi.init()
    focus = Focus()
    GLib.io_add_watch(focus.x.fileno(), GLib.PRIORITY_DEFAULT, GLib.IO_IN, focus.x_event)
    GLib.io_add_watch(focus.input_fd, GLib.PRIORITY_DEFAULT, GLib.IO_IN | GLib.IO_HUP, focus.receive)
    GLib.timeout_add(75, focus.x_event)
    send({"ready": True})
    loop = GLib.MainLoop()
    loop.run()
