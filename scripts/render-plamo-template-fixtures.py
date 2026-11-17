#!/usr/bin/env python3
"""Regenerate deterministic PFML3 oracles with Jinja2==3.1.6 (review tool only).

Default Node/browser tests read the committed fixture and need no Python package.
Uses the unmodified pinned official template, with BOS omitted because llama.cpp
adds it when the runtime submits a handwritten prompt.
"""
import hashlib
import json
from pathlib import Path
from jinja2 import Environment

ROOT = Path(__file__).resolve().parents[1]
template_bytes = (ROOT / 'web/plamo-chat-template.jinja').read_bytes()
template = Environment(trim_blocks=True, lstrip_blocks=True).from_string(template_bytes.decode())


def fail(message):
    raise ValueError(message)


template.environment.globals['raise_exception'] = fail
# Official README's Supported Languages table at revision 4f672106, independently
# transcribed here so the test also catches changes to the application's list.
codes = 'ja en zh-hans zh-hant ko ar az be bg bn ca ceb de es et eu fa fr gu he hi hr hu hy id it jv ka kk km lt lv ml mr ms my ne nl pa pl ru si sk sl sr sw ta te th tl ur uz vi'.split()


def render(text, languages):
    # source=auto is the Node's documented omission adapter. The official
    # template itself accepts an omitted source, not the source code "auto".
    kwargs = {k: v for k, v in languages.items() if k != 'source_lang' or v != 'auto'}
    return template.render(messages=[{'role': 'user', 'content': text}], bos_token='', **kwargs)


cases = [
    ('こんにちは。', {}), ('Hello.', {}),
    ('Hello.', {'target_lang': 'auto'}),
    ('こんにちは。', {'source_lang': 'auto', 'target_lang': 'auto'}),
    ('Hello.', {'target_lang': 'ja'}),
    ('こんにちは。', {'source_lang': 'auto', 'target_lang': 'en'}),
    ('Bonjour.', {'source_lang': 'fr', 'target_lang': 'ja'}),
    ('안녕하세요.', {'source_lang': 'ko', 'target_lang': 'en'}),
    ('你好。', {'source_lang': 'zh-hans', 'target_lang': 'ja'}),
    ('你好。', {'source_lang': 'zh-hant', 'target_lang': 'fr'}),
    ('Guten Tag.', {'source_lang': 'de', 'target_lang': 'fr'}),
    ('Hello.', {'context': ''}),
    ('かみを切りました。', {'context': '折り紙を作っています。'}),
    ('Text <>& \"quoted\"', {'source_lang': 'en', 'target_lang': 'ja', 'context': '参考情報\nTCP:443 & <xml> \"quote\"\t終わり'}),
    ('Hello.', {'target_lang': 'ja', 'context': ' \t\r\n'}),
]
all_prompts = [render('text', languages) for code in codes for languages in
               [{'source_lang': code, 'target_lang': 'ja'}, {'target_lang': code}]]
fixture = {
    'source': 'pfnet/plamo-3-translate-2b-GGUF@4f672106b847200bfdc0f6af6c321cd94eba1aed/chat_template.jinja',
    'templateSha256': hashlib.sha256(template_bytes).hexdigest(),
    'languageCodes': codes,
    'cases': [dict(text=text, languages=languages, prompt=render(text, languages)) for text, languages in cases],
    'allLanguagePromptsSha256': hashlib.sha256('\n'.join(all_prompts).encode()).hexdigest(),
}
(ROOT / 'tests/fixtures/plamo-template.json').write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + '\n')
