"""Drive real X11 helper requests with deterministic AT-SPI field responses."""
import io
import json
import os
import runpy
import sys
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

sys.path.insert(0, "desktop")
helper = runpy.run_path("desktop/x11-accessibility.py")
Atspi = helper["Atspi"]


class Field:
    def __init__(self, is_focused, can_advance=True):
        self.text = ""
        self.offset = 0
        self.is_focused = is_focused
        self.can_advance = can_advance
        self.clear_cache = Mock()

    def get_state_set(self):
        states = [Atspi.StateType.EDITABLE, Atspi.StateType.ENABLED,
                  Atspi.StateType.SENSITIVE, Atspi.StateType.SHOWING]
        if self.is_focused(self):
            states.append(Atspi.StateType.FOCUSED)
        return Atspi.StateSet.new(states)

    def get_role(self):
        return Atspi.Role.ENTRY

    def get_interfaces(self):
        return ["EditableText", "Text"]

    def get_caret_offset(self):
        return self.offset

    def get_character_count(self):
        return len(self.text)

    def get_n_selections(self):
        return 0

    def get_attribute_run(self, index, include_defaults):
        return {}, 0, len(self.text)

    def insert_text(self, offset, text, length):
        self.text = self.text[:offset] + text + self.text[offset:]
        return True

    def set_caret_offset(self, offset):
        if not self.can_advance:
            return False
        self.offset = offset
        return True


class InsertTest(unittest.TestCase):
    def setUp(self):
        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, write_fd)
        stdin = os.fdopen(read_fd)
        self.addCleanup(stdin.close)
        with patch("sys.stdin", stdin):
            self.focus = helper["Focus"]()
        self.addCleanup(self.focus.x.close)
        self.window = object()
        self.frame = Mock()
        self.frame.get_state_set().contains.return_value = True
        self.field = self.new_field()
        self.focus.window = lambda: self.window
        self.focus.locate = lambda *_: (self.frame, self.field)
        self.request("authorize")

    def new_field(self, can_advance=True):
        return Field(lambda field: field is self.field, can_advance)

    def request(self, action, **fields):
        with redirect_stdout(io.StringIO()) as output:
            self.focus.handle({"request": 1, "action": action, "token": "dictation", **fields})
        self.assertEqual(json.loads(output.getvalue()), {"request": 1})

    def test_focus_changes_during_final_caret_query(self):
        previous, current = self.field, self.new_field()
        focus_by_query = iter((previous, current))

        def query_selections():
            self.field = next(focus_by_query, self.field)
            return 0

        previous.get_n_selections = query_selections
        self.request("insert", text="skip")
        self.assertEqual((previous.text, current.text), ("", ""))
        self.request("insert", text="next")
        self.assertEqual((previous.text, current.text), ("", "next"))

    def test_field_changes_during_final_role_query(self):
        previous, current = self.field, self.new_field()

        def query_role():
            self.field = current
            return Atspi.Role.ENTRY

        previous.get_role = query_role
        self.request("insert", text="skip")
        self.assertEqual((previous.text, current.text), ("", ""))
        self.request("insert", text="next")
        self.assertEqual((previous.text, current.text), ("", "next"))

    def test_window_changes_during_final_interface_query(self):
        previous, current = self.field, self.new_field()

        def query_interfaces():
            # AT-SPI can still report the old field as focused after X11 moves on.
            self.window = object()
            return ["EditableText", "Text"]

        previous.get_interfaces = query_interfaces
        self.request("insert", text="skip")
        self.assertEqual((previous.text, current.text), ("", ""))
        self.field = current
        self.request("insert", text="next")
        self.assertEqual((previous.text, current.text), ("", "next"))

    def test_rejected_caret_advance_skips_until_caret_moves(self):
        blocked = self.field = self.new_field(can_advance=False)
        self.request("insert", text="A")
        self.assertEqual((blocked.text, blocked.offset), ("A", 0))
        self.request("insert", text="B")
        self.assertEqual(blocked.text, "A")

        other = self.field = self.new_field()
        self.request("insert", text="C")
        self.assertEqual(other.text, "C")
        self.field = blocked
        self.request("insert", text="D")
        self.assertEqual(blocked.text, "A")

        blocked.offset = 1
        self.request("insert", text="E")
        self.assertEqual(blocked.text, "AE")

    def test_lost_insert_reply_preserves_chunk_order(self):
        original_insert = self.field.insert_text

        def lose_reply(offset, text, length):
            original_insert(offset, text, length)
            raise helper["GLib"].Error("Lost reply after insertion")

        self.field.insert_text = Mock(side_effect=lose_reply)
        self.request("insert", text="A")
        self.assertEqual((self.field.text, self.field.offset), ("A", 0))
        self.request("insert", text="B")
        self.field.insert_text.assert_called_once_with(0, "A", 1)
        self.assertEqual(self.field.text, "A")

        self.field.insert_text = original_insert
        self.field.offset = 1
        self.request("insert", text="C")
        self.assertEqual((self.field.text, self.field.offset), ("AC", 2))

    def test_failed_insert_allows_new_chunks_when_count_and_caret_are_unchanged(self):
        recovered = self.field
        failure = helper["GLib"].Error("Insert failed before editing")
        with patch.object(recovered, "insert_text", side_effect=failure) as insert:
            self.request("insert", text="skip")
            insert.assert_called_once_with(0, "skip", 4)
        self.assertEqual((recovered.text, recovered.offset), ("", 0))

        other = self.field = self.new_field()
        self.request("insert", text="other")
        self.assertEqual(other.text, "other")
        self.field = recovered
        self.request("insert", text="A")
        self.request("insert", text="B")
        self.assertEqual((recovered.text, recovered.offset), ("AB", 2))


if __name__ == "__main__":
    unittest.main()
