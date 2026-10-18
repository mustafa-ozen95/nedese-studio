/**
 * The chat's status line while a turn runs shows how full the context is, not every step's input added up; the open
 * thinking block follows its new lines unless the reader scrolled up in it.
 * 18.10.2026: "785,675 tokens" during a turn with a 23k context read as if auto compact had not worked, and the thinking
 * block stayed at its top while the model wrote below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../web/chat.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('chat status: the running line shows the context fill and what was written, not the summed input', () => {
  assert.match(chat, /const fill = ctx\?\.size && ctx\.used \? `Context \$\{Math\.min\(100, Math\.round\(\(ctx\.used \/ ctx\.size\) \* 100\)\)\}%/);
  assert.match(chat, /text: \[fill, wrote\]\.filter\(Boolean\)\.join\(' · '\)/);
  assert.doesNotMatch(chat, /text: `\$\{sum\(run\)\.toLocaleString/);
  // a new context size (after a step or a compact) redraws the line
  assert.match(chat, /c\.context = \{ used: e\.used, size: e\.size \};\n\s+renderContext\(\);\n\s+renderStatus\(\);/);
});

test('chat thinking: the live block scrolls to its end when the reader was at the end', () => {
  const at = chat.indexOf('l.thinking.text += text;');
  assert.ok(at > 0);
  const near = chat.slice(at - 300, at + 200);
  assert.match(near, /const atEnd = body\.scrollHeight - body\.scrollTop - body\.clientHeight < 24;/);
  assert.match(near, /if \(atEnd\) body\.scrollTop = body\.scrollHeight;/);
});
