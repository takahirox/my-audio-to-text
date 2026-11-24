"""Own the configured X11 passive key grab and report physical key releases."""
from Xlib import X, XK, error
from Xlib.protocol import rq


# python-xlib does not wrap XKB. Enable DetectableAutorepeat on this connection
# so a held key produces repeat presses and exactly one real release.
class UseExtension(rq.ReplyRequest):
    _request = rq.Struct(rq.Card8("opcode"), rq.Opcode(0), rq.RequestLength(),
                         rq.Card16("major"), rq.Card16("minor"))
    _reply = rq.Struct(rq.ReplyCode(), rq.Card8("supported"), rq.Card16("sequence_number"),
                       rq.ReplyLength(), rq.Card16("major"), rq.Card16("minor"), rq.Pad(20))


class PerClientFlags(rq.ReplyRequest):
    _request = rq.Struct(rq.Card8("opcode"), rq.Opcode(21), rq.RequestLength(),
                         rq.Card16("device"), rq.Pad(2), rq.Card32("change"), rq.Card32("value"), rq.Pad(12))
    _reply = rq.Struct(rq.ReplyCode(), rq.Pad(1), rq.Card16("sequence_number"), rq.ReplyLength(),
                       rq.Card32("supported"), rq.Card32("value"), rq.Pad(16))


class Shortcut:
    def __init__(self, connection, root):
        self.x = connection
        self.root = root
        self.value = ""
        self.grabs = set()
        self.pressed = None
        self.detectable_repeat = False

    def enable_detectable_repeat(self):
        extension = self.x.query_extension("XKEYBOARD")
        if extension and UseExtension(self.x.display, opcode=extension.major_opcode, major=1, minor=0).supported:
            # XkbUseCoreKbd = 0x0100, XkbPCF_DetectableAutoRepeatMask = 1.
            flags = PerClientFlags(self.x.display, opcode=extension.major_opcode, device=0x0100, change=1, value=1)
            self.detectable_repeat = bool(flags.value & 1)
        if not self.detectable_repeat:
            raise ValueError("The X11 session could not detect physical shortcut releases.")

    def set(self, value):
        grabs = set()
        if value:
            if not self.detectable_repeat:
                self.enable_detectable_repeat()
            *modifiers, key = value.split("+")
            keycode = self.x.keysym_to_keycode(XK.string_to_keysym(key.lower() if len(key) == 1 else key))
            if not keycode:
                raise ValueError(f"{value} is unavailable. Choose a different shortcut in Settings.")
            masks = {"Control": X.ControlMask, "Alt": X.Mod1Mask, "Shift": X.ShiftMask, "Super": X.Mod4Mask}
            variants = {sum(masks[key] for key in modifiers)}
            lock_keys = {self.x.keysym_to_keycode(XK.string_to_keysym(key)) for key in ("Num_Lock", "Scroll_Lock")} - {0}
            lock_masks = {X.LockMask}
            lock_masks.update(1 << index for index, keys in enumerate(self.x.get_modifier_mapping())
                              if lock_keys.intersection(keys))
            for mask in lock_masks:
                variants.update({modifiers | mask for modifiers in variants})
            grabs = {(keycode, modifiers) for modifiers in variants}

        added = []
        for keycode, modifiers in grabs - self.grabs:
            failure = error.CatchError()
            self.root.grab_key(keycode, modifiers, False, X.GrabModeAsync, X.GrabModeAsync, onerror=failure)
            added.append((keycode, modifiers, failure))
        self.x.sync()
        if any(failure.get_error() for _, _, failure in added):
            for keycode, modifiers, failure in added:
                if not failure.get_error():
                    self.root.ungrab_key(keycode, modifiers)
            self.x.flush()
            raise ValueError(f"{value} is unavailable. Choose a different shortcut in Settings.")
        for keycode, modifiers in self.grabs - grabs:
            self.root.ungrab_key(keycode, modifiers)
        self.x.flush()
        self.value, self.grabs, self.pressed = value, grabs, None

    def released(self, event):
        if event.type not in (X.KeyPress, X.KeyRelease) or event.send_event:
            return False
        if event.type == X.KeyPress:
            if self.pressed is None and (event.detail, event.state & 0xff) in self.grabs:
                self.pressed = event.detail
        elif self.pressed == event.detail:
            self.pressed = None
            return True
        return False
