import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, renderMarkdown } from '../src/ui/markdown.js';
import { createFakeDocument, elementsOf, findTag } from './ui-fake-dom.js';

test('parseBlocks splits paragraphs on blank lines', () => {
  // Arrange
  const text = 'first line\nsecond line\n\nthird';
  // Act
  const blocks = parseBlocks(text);
  // Assert
  assert.deepEqual(blocks, [
    { type: 'p', lines: ['first line', 'second line'] },
    { type: 'p', lines: ['third'] }
  ]);
});

test('parseBlocks reads a closed fenced block with its language', () => {
  const text = 'before\n```js\nconst a = 1;\n```\nafter';
  const blocks = parseBlocks(text);
  assert.deepEqual(blocks, [
    { type: 'p', lines: ['before'] },
    { type: 'code', lang: 'js', text: 'const a = 1;', closed: true },
    { type: 'p', lines: ['after'] }
  ]);
});

test('parseBlocks treats an unclosed fence as an open code block (streaming)', () => {
  const blocks = parseBlocks('intro\n```\npartial code');
  assert.deepEqual(blocks.at(-1), { type: 'code', lang: '', text: 'partial code', closed: false });
});

test('parseBlocks drops an invalid language token instead of rendering it', () => {
  const [block] = parseBlocks('```<img src=x>\nx\n```');
  assert.equal(block.lang, '');
});

test('parseInline separates inline code from text and keeps unmatched backticks literal', () => {
  assert.deepEqual(parseInline('use `npm test` now'), [
    { type: 'text', value: 'use ' },
    { type: 'code', value: 'npm test' },
    { type: 'text', value: ' now' }
  ]);
  assert.deepEqual(parseInline('a ` b'), [{ type: 'text', value: 'a ` b' }]);
});

test('renderMarkdown builds <pre><code> for fences and <code> for inline spans', () => {
  // Arrange
  const doc = createFakeDocument();
  // Act
  const fragment = renderMarkdown(doc, 'run `ls`\n\n```sh\necho hi\n```');
  // Assert
  const pre = findTag(fragment, 'PRE');
  assert.ok(pre, 'code fence rendered as pre');
  assert.equal(findTag(pre, 'CODE').textContent, 'echo hi');
  const inline = elementsOf(fragment).filter((e) => e.tagName === 'CODE');
  assert.equal(inline[0].textContent, 'ls');
});

test('renderMarkdown never interprets HTML: markup stays plain text', () => {
  const doc = createFakeDocument();
  const hostile = '<img src=x onerror="alert(1)"> and ```<script>x</script>```';
  const fragment = renderMarkdown(doc, hostile);
  assert.equal(elementsOf(fragment).some((e) => e.tagName === 'IMG' || e.tagName === 'SCRIPT'), false);
  assert.ok(fragment.textContent.includes('<img src=x onerror="alert(1)">'));
});

test('renderMarkdown renders empty input as an empty fragment', () => {
  const fragment = renderMarkdown(createFakeDocument(), '');
  assert.equal(fragment.childNodes.length, 0);
});
