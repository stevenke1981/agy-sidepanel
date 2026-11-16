// Tiny, safe markdown subset for assistant output: fenced code blocks, inline `code`, paragraphs.
// parseBlocks/parseInline are pure. renderMarkdown builds DOM with textContent only.

const OPEN_FENCE_RE = /^\s{0,3}```(.*)$/;
const CLOSE_FENCE_RE = /^\s{0,3}```\s*$/;
const LANG_RE = /^[A-Za-z0-9_+.-]{1,32}$/;

/**
 * Split text into blocks: {type:'code', lang, text, closed} | {type:'p', lines: string[]}.
 * An unclosed fence (streaming) is returned as a code block with closed:false.
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: 'p', lines: paragraph });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const open = OPEN_FENCE_RE.exec(lines[i]);
    if (open) {
      flush();
      const fence = readFence(lines, i, open[1]);
      blocks.push(fence.block);
      i = fence.next;
      continue;
    }
    if (lines[i].trim() === '') flush();
    else paragraph.push(lines[i]);
    i++;
  }
  flush();
  return blocks;
}

function readFence(lines, start, info) {
  const body = [];
  let i = start + 1;
  while (i < lines.length && !CLOSE_FENCE_RE.test(lines[i])) {
    body.push(lines[i]);
    i++;
  }
  const closed = i < lines.length;
  return {
    block: { type: 'code', lang: cleanLang(info), text: body.join('\n'), closed },
    next: closed ? i + 1 : i
  };
}

function cleanLang(info) {
  const first = String(info ?? '').trim().split(/\s+/)[0] ?? '';
  return LANG_RE.test(first) ? first : '';
}

/**
 * Split one line into text and inline-code parts. An unmatched backtick stays literal text.
 * @param {string} line
 * @returns {Array<{type: 'text'|'code', value: string}>}
 */
export function parseInline(line) {
  const parts = [];
  let rest = String(line);
  while (rest.length > 0) {
    const start = rest.indexOf('`');
    const end = start === -1 ? -1 : rest.indexOf('`', start + 1);
    if (start === -1 || end === -1) {
      parts.push({ type: 'text', value: rest });
      break;
    }
    if (start > 0) parts.push({ type: 'text', value: rest.slice(0, start) });
    parts.push({ type: 'code', value: rest.slice(start + 1, end) });
    rest = rest.slice(end + 1);
  }
  return parts;
}

/**
 * @param {Document} doc
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(doc, text) {
  const fragment = doc.createDocumentFragment();
  for (const block of parseBlocks(text)) fragment.appendChild(renderBlock(doc, block));
  return fragment;
}

function renderBlock(doc, block) {
  return block.type === 'code' ? renderCode(doc, block) : renderParagraph(doc, block.lines);
}

function renderCode(doc, block) {
  const wrap = doc.createElement('div');
  wrap.className = 'md-code';
  if (block.lang) {
    const label = doc.createElement('span');
    label.className = 'md-lang';
    label.textContent = block.lang;
    wrap.appendChild(label);
  }
  const pre = doc.createElement('pre');
  pre.className = 'md-pre';
  const code = doc.createElement('code');
  code.textContent = block.text;
  pre.appendChild(code);
  wrap.appendChild(pre);
  return wrap;
}

function renderParagraph(doc, lines) {
  const p = doc.createElement('p');
  lines.forEach((line, index) => {
    if (index > 0) p.appendChild(doc.createElement('br'));
    for (const part of parseInline(line)) p.appendChild(renderInlinePart(doc, part));
  });
  return p;
}

function renderInlinePart(doc, part) {
  if (part.type === 'text') return doc.createTextNode(part.value);
  const code = doc.createElement('code');
  code.textContent = part.value;
  return code;
}
