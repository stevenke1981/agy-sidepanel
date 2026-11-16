// Minimal fake DOM for ui-*.test.js. Supports only what the pure view modules use:
// createElement / createTextNode / createDocumentFragment, appendChild, replaceChildren,
// textContent (get/set), setAttribute / getAttribute. Fragments flatten on append, as in browsers.

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }

  appendChild(child) {
    const incoming = child.tagName === '#fragment' ? [...child.childNodes] : [child];
    for (const node of incoming) {
      node.parentNode = this;
      this.childNodes.push(node);
    }
    if (child.tagName === '#fragment') child.childNodes = [];
    return child;
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    for (const node of nodes) this.appendChild(node);
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = value === '' ? [] : [new FakeText(String(value))];
  }
}

class FakeText {
  constructor(value) {
    this.nodeType = 3;
    this.value = value;
    this.parentNode = null;
  }

  get textContent() {
    return this.value;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.className = '';
    this.attributes = {};
    this.hidden = false;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
  }
}

class FakeFragment extends FakeNode {
  constructor() {
    super();
    this.tagName = '#fragment';
  }
}

/** @returns {Document-like object} */
export function createFakeDocument() {
  return {
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (text) => new FakeText(String(text)),
    createDocumentFragment: () => new FakeFragment()
  };
}

/** Depth-first list of element nodes (text nodes excluded). */
export function elementsOf(node, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      out.push(child);
      elementsOf(child, out);
    }
  }
  return out;
}

/** Find the first element with the given tag, or null. */
export function findTag(node, tag) {
  return elementsOf(node).find((e) => e.tagName === tag) ?? null;
}

/** Find all elements carrying a class token. */
export function withClass(node, className) {
  return elementsOf(node).filter((e) => e.className.split(/\s+/).includes(className));
}
