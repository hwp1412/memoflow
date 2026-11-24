'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
global.window = { setTimeout: fn => fn() };

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.attributes = {};
    this.classList = { toggle() {} };
  }
  createEl(tag, options = {}) {
    const child = new FakeElement(tag);
    if (options.text != null) child.textContent = String(options.text);
    if (options.attr) child.attributes = { ...options.attr };
    this.children.push(child);
    return child;
  }
  createDiv(options = {}) { return this.createEl('div', options); }
  createSpan(options = {}) { return this.createEl('span', options); }
  empty() { this.children = []; }
  setText(value) { this.textContent = String(value); }
  addClass() {}
  setAttribute(key, value) { this.attributes[key] = value; }
  toggleAttribute(key, force) { this.attributes[key] = force; }
  hide() { this.hidden = true; }
  show() { this.hidden = false; }
  addEventListener() {}
  focus() {}
}
class FakeModal {
  constructor() {
    this.titleEl = new FakeElement();
    this.contentEl = new FakeElement();
    this.modalEl = new FakeElement();
  }
  open() { this.onOpen?.(); }
  close() { this.onClose?.(); }
}

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') return { Modal: FakeModal };
  return originalLoad.call(this, request, parent, isMain);
};
let RefinePreviewModal;
try {
  ({ RefinePreviewModal } = require('../src/views/refine-modal.js'));
} finally {
  Module._load = originalLoad;
}

function makeModal(overrides = {}) {
  const modal = new RefinePreviewModal({}, {
    path: 'Extracts/E.md',
    selectedText: 'alpha beta',
    replacementText: 'alpha',
    ...overrides,
  });
  const promise = modal.open();
  return { modal, promise };
}

test('no-change modal keeps confirmation disabled and does not call validate', async () => {
  const { modal, promise } = makeModal({ replacementText: 'alpha beta' });
  let called = 0;
  modal.validate = async () => { called++; };
  assert.equal(modal._confirm.disabled, true);
  await modal._confirmValue();
  assert.equal(called, 0);
  modal._settle(null);
  assert.equal(await promise, null);
});

test('validation failure stays in the modal and displays the reason', async () => {
  const { modal, promise } = makeModal();
  modal.validate = async () => { throw new Error('表格结构受保护'); };
  await modal._confirmValue();
  assert.equal(modal.settled, false);
  assert.equal(modal._confirm.disabled, false);
  assert.match(modal._errorEl.textContent, /表格结构受保护/);
  assert.equal(modal._errorEl.hidden, false);
  modal._settle(null);
  assert.equal(await promise, null);
});

test('successful validation closes only after validation and resolves the replacement', async () => {
  const { modal, promise } = makeModal();
  let validated = null;
  modal.validate = async value => { validated = value; };
  await modal._confirmValue();
  assert.equal(validated, 'alpha');
  assert.equal(modal.settled, true);
  assert.equal(await promise, 'alpha');
});
