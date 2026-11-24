'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
const {
  createRefineOperation,
  makeState,
} = require('../src/data/refine-history.js');
const { buildHistoryView } = require('../src/data/refine-history-read.js');

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.value = '';
    this.textContent = '';
    this.classList = { toggle() {} };
    this.attributes = {};
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
  addEventListener() {}
  focus() {}
  querySelectorAll() { return []; }
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
let RefineHistoryModal;
try {
  ({ RefineHistoryModal } = require('../src/views/refine-history-modal.js'));
} finally {
  Module._load = originalLoad;
}

const NOTE = 'Extracts/History.md';
const A = '---\ntype: extract\npriority: 50\n---\nAlpha beta\n';
const B = '---\ntype: extract\npriority: 50\n---\nAlpha\n';

async function view(extraEntries = []) {
  const op = await createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: NOTE,
    fullContent: A,
    selection: { start: 0, end: 5 },
    replacementText: 'Hi',
  });
  return buildHistoryView({
    entries: [{ operation: op, state: makeState(op.operationId, 'verified') }, ...extraEntries],
    currentContent: B,
    currentPath: NOTE,
  });
}

test('empty history modal shows the current body and a real empty state', () => {
  const model = buildHistoryView({ entries: [], currentContent: A, currentPath: NOTE });
  const modal = new RefineHistoryModal({}, { path: NOTE, model });
  modal.onOpen();
  assert.equal(modal.model.count, 0);
  assert.match(JSON.stringify(modal.contentEl), /还没有精简历史/);
  assert.ok(modal.contentEl);
});

test('history modal exposes before/after snapshots and bounded diff', async () => {
  const model = await view();
  const modal = new RefineHistoryModal({}, { path: NOTE, model });
  modal.onOpen();
  assert.equal(modal._targetSelect.children.length, 3);
  assert.equal(modal._preview.textContent, 'Hi beta\n');
  assert.ok(modal._diff.children.length > 0);
});

test('history modal displays read errors without inventing entries', () => {
  const model = buildHistoryView({ entries: [], currentContent: A, currentPath: NOTE });
  const modal = new RefineHistoryModal({}, {
    path: NOTE,
    model,
    error: new Error('历史文件损坏'),
  });
  modal.onOpen();
  assert.match(JSON.stringify(modal.contentEl), /历史不可用/);
  assert.match(JSON.stringify(modal.contentEl), /不会伪造|未伪造/);
  assert.match(JSON.stringify(modal.contentEl), /历史文件损坏/);
});

test('restore action is enabled only for a selected completed historical target', async () => {
  const model = await view();
  const modal = new RefineHistoryModal({}, {
    path: NOTE,
    model,
    onRestore: async () => {},
  });
  modal.onOpen();
  assert.equal(modal._restoreButton.disabled, false);
  const target = modal._restoreTarget();
  assert.ok(target);
  assert.equal(target.side, 'after');
});

test('restore action is disabled for dirty current body and for no-op target', async () => {
  const model = await view();
  model.current.dirty = true;
  const dirty = new RefineHistoryModal({}, { path: NOTE, model, onRestore: async () => {} });
  dirty.onOpen();
  assert.equal(dirty._restoreButton.disabled, true);
  assert.match(dirty._restoreHint.textContent, /未保存/);

  model.current.dirty = false;
  model.current.text = model.events[0].after.text;
  model.snapshots[0].text = model.events[0].after.text;
  const noop = new RefineHistoryModal({}, { path: NOTE, model, onRestore: async () => {} });
  noop.onOpen();
  assert.equal(noop._restoreButton.disabled, true);
});
