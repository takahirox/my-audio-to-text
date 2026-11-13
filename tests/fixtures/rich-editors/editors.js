// Real editor models, bundled only for localhost browser tests (never shipped).
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Editor, EditorState as DraftState, ContentState } from 'draft-js';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from 'prosemirror-schema-basic';
import { history, undo as pmUndo, redo as pmRedo } from 'prosemirror-history';
import { createEditor, $getRoot, $createParagraphNode, $createTextNode, UNDO_COMMAND, REDO_COMMAND } from 'lexical';
import { registerPlainText } from '@lexical/plain-text';
import { registerHistory, createEmptyHistoryState } from '@lexical/history';
import Quill from 'quill';

window.editors = {};
function mount(id, label) {
  const section = document.createElement('section');
  section.innerHTML = `<label>${label}</label><div id="${id}"></div>`;
  document.body.append(section); return section.lastChild;
}
let rerenderReact;
function Controlled() {
  const [value, set] = React.useState('hello world'), [, tick] = React.useState(0);
  rerenderReact = () => tick(x => x + 1);
  window.editors.react = { read: () => value, render: () => flushSync(rerenderReact) };
  return React.createElement('textarea', { 'aria-label': 'Controlled React composer', value, onChange: e => set(e.target.value) });
}
flushSync(() => createRoot(mount('react', 'React')).render(React.createElement(Controlled)));
const pm = new EditorView(mount('pm', 'Claude-style ProseMirror composer'), {
  state: EditorState.create({ schema, doc: schema.node('doc', null, [schema.node('paragraph', null, schema.text('hello world'))]), plugins: [history()] }),
});
editors.pm = { read: () => pm.state.doc.textBetween(0, pm.state.doc.content.size, '\n'), render: () => pm.updateState(pm.state), undo: () => pmUndo(pm.state, pm.dispatch), redo: () => pmRedo(pm.state, pm.dispatch) };
const lexRoot = mount('lexical', 'ChatGPT-style nested rich composer');
lexRoot.innerHTML = '<div role="textbox" aria-label="Rich composer" contenteditable="true"></div>';
const lexical = createEditor({ namespace: 'dictation-test', onError: error => { throw error; } });
lexical.setRootElement(lexRoot.firstChild); registerPlainText(lexical); registerHistory(lexical, createEmptyHistoryState(), 100);
lexical.update(() => { $getRoot().append($createParagraphNode().append($createTextNode('hello world'))); }, { discrete: true });
editors.lexical = { read: () => lexical.getEditorState().read(() => $getRoot().getTextContent()), render: () => lexical.setEditorState(lexical.getEditorState()), undo: () => lexical.dispatchCommand(UNDO_COMMAND), redo: () => lexical.dispatchCommand(REDO_COMMAND) };
function Draft() {
  const [state, set] = React.useState(() => DraftState.createWithContent(ContentState.createFromText('hello world')));
  const [, tick] = React.useState(0);
  editors.draft = { read: () => state.getCurrentContent().getPlainText(), render: () => flushSync(() => tick(x => x + 1)), undo: () => flushSync(() => set(DraftState.undo(state))), redo: () => flushSync(() => set(DraftState.redo(state))) };
  return React.createElement(Editor, { editorState: state, onChange: set, ariaLabel: 'X-style post composer' });
}
flushSync(() => createRoot(mount('draft', 'X-style Draft.js post composer')).render(React.createElement(Draft)));
const quill = new Quill(mount('quill', 'Quill composer'), { modules: { toolbar: false, history: { delay: 100 } }, theme: null });
quill.setText('hello world'); quill.history.clear();
editors.quill = { read: () => quill.getText().replace(/\n$/, ''), render: () => quill.update(), undo: () => quill.history.undo(), redo: () => quill.history.redo() };
window.fixtureReady = true;
