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


class Field:
    def __init__(self, can_advance=True):
        self.text = ""
        self.offset = 0
        self.can_advance = can_advance
        self.clear_cache = Mock()

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
        self.field = Field()
        self.focus.window = lambda: self.window
        self.focus.locate = lambda _: (self.frame, self.field)
        self.focus.editable = self.require_focused
        self.request("authorize")

    def require_focused(self, field):
        if field is not self.field:
            raise helper["TargetError"]()

    def request(self, action, **fields):
        with redirect_stdout(io.StringIO()) as output:
            self.focus.handle({"request": 1, "action": action, "token": "dictation", **fields})
        self.assertEqual(json.loads(output.getvalue()), {"request": 1})

    def test_focus_changes_during_final_caret_query(self):
        previous, current = self.field, Field()
        focus_by_query = iter((previous, current))

        def query_selections():
            self.field = next(focus_by_query, self.field)
            return 0

        previous.get_n_selections = query_selections
        self.request("insert", text="skip")
        self.assertEqual((previous.text, current.text), ("", ""))
        self.request("insert", text="next")
        self.assertEqual((previous.text, current.text), ("", "next"))

    def test_rejected_caret_advance_skips_until_caret_moves(self):
        blocked = self.field = Field(can_advance=False)
        self.request("insert", text="A")
        self.assertEqual((blocked.text, blocked.offset), ("A", 0))
        self.request("insert", text="B")
        self.assertEqual(blocked.text, "A")

        other = self.field = Field()
        self.request("insert", text="C")
        self.assertEqual(other.text, "C")
        self.field = blocked
        self.request("insert", text="D")
        self.assertEqual(blocked.text, "A")

        blocked.offset = 1
        self.request("insert", text="E")
        self.assertEqual(blocked.text, "AE")


if __name__ == "__main__":
    unittest.main()
