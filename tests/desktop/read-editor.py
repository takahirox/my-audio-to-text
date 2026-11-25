"""Read test documents from the independent editor without changing its focus."""
import json
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi


def descendants(node):
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child is not None:
            yield from descendants(child)


Atspi.init()
desktop = Atspi.get_desktop(0)
pid = int(sys.argv[1])
for index in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(index)
    if app is None or app.get_process_id() != pid:
        continue
    documents = [node for node in descendants(app) if node.get_role() == Atspi.Role.TEXT
                 and node.get_state_set().contains(Atspi.StateType.MULTI_LINE)]
    value = {"values": [node.get_text(0, -1) for node in documents],
             "focus": next((i for i, node in enumerate(documents)
                            if node.get_state_set().contains(Atspi.StateType.FOCUSED)), -1)}
    print(json.dumps(value))
    break
