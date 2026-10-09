/**
 * Syntax colors of code blocks in chat answers (web/js/highlight.js, user request 08.10.2026): tokens per language,
 * everything escaped (a block with HTML in it stays text), the text itself unchanged.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= globalThis;
await import('../web/js/highlight.js');
const { highlight, language } = globalThis.NedeseHighlight;
const tokens = (html) => [...html.matchAll(/<span class="hl-(\w+)">([^<]*)<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
const plainText = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('highlight: languages and their aliases, tokens, the text unchanged and escaped', () => {
  assert.deepEqual(['js', 'TypeScript', 'tsx', 'py', 'json', 'svg', 'html', 'scss', 'sh', 'ps1', 'pwsh', 'postgresql', 'sql', 'brainfuck', ''].map(language), ['js', 'js', 'js', 'python', 'json', 'html', 'html', 'css', 'bash', 'powershell', 'powershell', 'sql', 'sql', null, null]);
  const js = 'const a = `x ${y}`; // note\nif (a > 1) return foo(null, 0x1F, "s\\"q");';
  assert.equal(plainText(highlight(js, 'js')), js, 'the text is the same');
  assert.deepEqual(tokens(highlight(js, 'js')), ['keyword:const', 'string:`x ${y}`', 'comment:// note', 'keyword:if', 'number:1', 'keyword:return', 'fn:foo', 'literal:null', 'number:0x1F', 'string:&quot;s\\&quot;q&quot;']);
  assert.deepEqual(tokens(highlight('def run(x):\n    """Doc."""\n    return None  # done\n@cache\nprint(f"{x}")', 'python')), ['keyword:def', 'fn:run', 'string:&quot;&quot;&quot;Doc.&quot;&quot;&quot;', 'keyword:return', 'literal:None', 'comment:# done', 'meta:@cache', 'fn:print', 'string:f&quot;{x}&quot;']);
  assert.deepEqual(tokens(highlight('{"a": [1, true, "b"]}', 'json')), ['prop:&quot;a&quot;', 'number:1', 'literal:true', 'string:&quot;b&quot;']);
  const html = '<!-- c --><a href="/x" data-k=\'v\' hidden>T &amp; U</a>';
  assert.equal(plainText(highlight(html, 'html')), html);
  assert.deepEqual(tokens(highlight(html, 'html')), ['comment:&lt;!-- c --&gt;', 'tag:&lt;a', 'attr:href', 'string:&quot;/x&quot;', 'attr:data-k', "string:'v'", 'attr:hidden', 'tag:&gt;', 'literal:&amp;amp;', 'tag:&lt;/a', 'tag:&gt;']);
  // a script and a style in a page: their code in its own colors
  assert.deepEqual(tokens(highlight('<script type="module">const a = 1;</script><style>b { top: 0 }</style>', 'html')), ['tag:&lt;script', 'attr:type', 'string:&quot;module&quot;', 'tag:&gt;', 'keyword:const', 'number:1', 'tag:&lt;/script', 'tag:&gt;', 'tag:&lt;style', 'tag:&gt;', 'prop:top', 'number:0', 'tag:&lt;/style', 'tag:&gt;']);
  assert.deepEqual(tokens(highlight('.a { color: #fff; margin: 0 2px !important; } @media (x) {}', 'css')), ['prop:color', 'number:#fff', 'prop:margin', 'number:0', 'number:2px', 'keyword:!important', 'keyword:@media']);
  assert.deepEqual(tokens(highlight('if [ -f "$HOME/x" ]; then echo ${A} --all; fi # end', 'bash')), ['keyword:if', 'attr:-f', 'string:&quot;$HOME/x&quot;', 'keyword:then', 'var:${A}', 'attr:--all', 'keyword:fi', 'comment:# end']);
  assert.deepEqual(tokens(highlight('Get-ChildItem -Path $env:USERPROFILE | Where-Object { $_.Length -gt 1MB } # big', 'powershell')), ['fn:Get-ChildItem', 'attr:-Path', 'var:$env:USERPROFILE', 'fn:Where-Object', 'var:$_', 'keyword:-gt', 'number:1MB', 'comment:# big']);
  assert.deepEqual(tokens(highlight("SELECT name FROM t WHERE id = 3 AND x IS NULL; -- c", 'sql')), ['keyword:SELECT', 'keyword:FROM', 'keyword:WHERE', 'number:3', 'keyword:AND', 'keyword:IS', 'literal:NULL', 'comment:-- c']);
  // no language: escaped text only; a script in it stays text
  assert.equal(highlight('<script>alert(1)</script>', ''), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(highlight('<img onerror=x>', 'brainfuck'), '&lt;img onerror=x&gt;');
  assert.doesNotMatch(highlight('<img src=x onerror="alert(1)">', 'html'), /<img/);
  // unfinished strings and comments end the block without hanging
  assert.equal(plainText(highlight('"open string\n/* open comment', 'js')), '"open string\n/* open comment');
});
