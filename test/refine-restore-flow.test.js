'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { RefineEditorController, offsetToPos } = require('../src/data/refine-editor.js');
const { RefineHistoryStore } = require('../src/data/refine-store.js');
const { splitContent, createRefineOperation } = require('../src/data/refine-history.js');

const NOTE_PATH = 'Extracts/RestoreFlow.md';
const INITIAL = '---\ntype: extract\npriority: 50\nparent: Sources/A.md\n---\nAlpha beta\n';

class MemoryAdapter {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
    this.writes = [];
    this.writeFailures = [];
  }
  async exists(path) { return this.files.has(path) || this.dirs.has(path); }
  async mkdir(path) { this.dirs.add(path); }
  async read(path) {
    if (!this.files.has(path)) throw new Error(`missing: ${path}`);
    return this.files.get(path);
  }
  async write(path, text) {
    this.writes.push(path);
    if (this.writeFailures.some(pattern => path.includes(pattern))) throw new Error(`write failed: ${path}`);
    this.files.set(path, String(text));
  }
  async rename(from, to) {
    if (!this.files.has(from)) throw new Error(`missing: ${from}`);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async list(path) {
    const prefix = `${path}/`;
    return {
      files: [...this.files.keys()].filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/')).map(file => file.slice(prefix.length)),
      folders: [],
    };
  }
}

class FakeEditor {
  constructor(text) {
    this.text = text;
    this.from = { line: 0, ch: 0 };
    this.to = { line: 0, ch: 0 };
  }
  getValue() { return this.text; }
  setValue(value) { this.text = String(value); this.from = { line: 0, ch: 0 }; this.to = { ...this.from }; this.autoSave?.(); }
  getSelection() {
    const a = this.posToOffset(this.from);
    const b = this.posToOffset(this.to);
    return this.text.slice(Math.min(a, b), Math.max(a, b));
  }
  getCursor(which) { return which === 'to' ? { ...this.to } : { ...this.from }; }
  listSelections() { return [{ anchor: this.from, head: this.to }]; }
  posToOffset(pos) {
    const lines = this.text.split('\n');
    const line = Math.max(0, Math.min(lines.length - 1, pos.line));
    let offset = 0;
    for (let i = 0; i < line; i++) offset += lines[i].length + 1;
    return offset + Math.max(0, Math.min(lines[line].length, pos.ch));
  }
  offsetToPos(offset) { return offsetToPos(this.text, offset); }
  selectOffsets(start, end) { this.from = offsetToPos(this.text, start); this.to = offsetToPos(this.text, end); }
  replaceRange(text, from, to) {
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    this.text = this.text.slice(0, Math.min(a, b)) + text + this.text.slice(Math.max(a, b));
    this.from = offsetToPos(this.text, Math.min(a, b) + text.length);
    this.to = { ...this.from };
  }
}

class FakeView {
  constructor(app, file, editor) {
    this.app = app;
    this.file = file;
    this.editor = editor;
    this.saves = 0;
    this.saveError = null;
    this.diskAfterSave = null;
  }
  async save() {
    this.saves++;
    if (this.saveError) throw this.saveError;
    this.app.disk.set(this.file.path, this.diskAfterSave == null ? this.editor.text : this.diskAfterSave);
  }
}

function setup(t, text = INITIAL) {
  const adapter = new MemoryAdapter();
  const file = { path: NOTE_PATH, extension: 'md', basename: 'RestoreFlow' };
  const editor = new FakeEditor(text);
  const app = {
    disk: new Map([[NOTE_PATH, text]]),
    notices: [],
    leaves: [],
    workspace: {
      getLeavesOfType: () => app.leaves,
      getActiveFile: () => file,
    },
    vault: {
      async read(target) { return app.disk.get(target.path); },
      async process(file, fn) {
        const current = app.disk.get(file.path);
        const next = await fn(current);
        app.disk.set(file.path, next);
        return next;
      },
    },
  };
  const view = new FakeView(app, file, editor);
  app.leaves.push({ view });
  const store = new RefineHistoryStore({
    adapter,
    historyRoot: 'MemoFlow History/refine',
    now: (() => { let n = 0; return () => `2026-11-25T01:00:${String(n++).padStart(2, '0')}.000Z`; })(),
  });
  const prompts = {
    preview: async () => 'Hi',
    restore: async () => true,
    versionRestore: async () => true,
    versionOptions: null,
  };
  const controller = new RefineEditorController({
    app,
    store,
    settings: {},
    notice: (message, duration) => app.notices.push({ message, duration }),
    getActiveView: () => view,
    promptPreview: options => prompts.preview(options),
    promptRestore: options => prompts.restore(options),
    promptVersionRestore: async options => {
      prompts.versionOptions = options;
      return prompts.versionRestore(options);
    },
  });
  return { app, adapter, file, editor, view, store, prompts, controller };
}

function jsonFiles(adapter) {
  return [...adapter.files.keys()].filter(path => path.endsWith('.json') && !path.includes('.state'));
}

function selectBody(editor) {
  const split = splitContent(editor.text);
  editor.selectOffsets(split.bodyStart, split.bodyStart + split.body.length);
}

async function twoRefines(editor, prompts, controller) {
  selectBody(editor);
  prompts.preview = async () => 'Hi beta';
  const op1 = await controller.refineActive();
  selectBody(editor);
  prompts.preview = async () => 'Done';
  const op2 = await controller.refineActive();
  return { op1, op2 };
}

test('restore a v2 before snapshot writes history, replaces body, preserves frontmatter and marks restored', async (t) => {
  const { app, adapter, editor, view, store, prompts, controller } = setup(t);
  selectBody(editor);
  prompts.preview = async () => 'Hi beta';
  const op1 = await controller.refineActive();
  assert.ok(op1);
  selectBody(editor);
  prompts.preview = async () => 'Done';
  const op2 = await controller.refineActive();
  assert.ok(op2);
  const beforeFrontmatter = splitContent(editor.text).prefix;

  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.ok(result && !result.status);
  assert.equal(result.schemaVersion, 2);
  assert.equal(editor.text, INITIAL);
  assert.equal(app.disk.get(NOTE_PATH), INITIAL);
  assert.equal(splitContent(editor.text).prefix, beforeFrontmatter);
  const entries = await store.listEntries(NOTE_PATH);
  assert.equal(entries.length, 3);
  assert.equal(entries[2].state.status, 'restored');
  assert.equal(entries[2].operation.restoreTarget.side, 'before');
  assert.equal(view.saves, 0);
  assert.match(app.notices.at(-1).message, /已恢复/);
});

test('restoring the current body is a no-op and creates no history', async (t) => {
  const { adapter, editor, prompts, controller } = setup(t);
  selectBody(editor);
  prompts.preview = async () => 'Hi beta';
  const op = await controller.refineActive();
  const before = jsonFiles(adapter).length;
  const result = await controller.restoreVersion({ targetOperationId: op.operationId, targetSide: 'after' });
  assert.equal(result.status, 'noop');
  assert.equal(jsonFiles(adapter).length, before);
});

test('dirty editor is rejected before any restore history is written', async (t) => {
  const { adapter, editor, prompts, controller } = setup(t);
  selectBody(editor);
  prompts.preview = async () => 'Hi beta';
  const op = await controller.refineActive();
  editor.text += 'dirty';
  const before = jsonFiles(adapter).length;
  const result = await controller.restoreVersion({ targetOperationId: op.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(jsonFiles(adapter).length, before);
  assert.match(adapter.writes.join('\n'), /state/);
});

test('protected structure differences are rejected before confirmation and writes', async (t) => {
  const prefix = '---\ntype: extract\npriority: 50\n---\n';
  const beforeBody = '| A | B |\n|---|---|\n| 1 | 2 |\n';
  const afterBody = '| A | B |\n|---|---|\n| 1 | 3 |\n';
  const text = prefix + beforeBody;
  const { adapter, editor, prompts, controller } = setup(t, text);
  const after = prefix + afterBody;
  const op = await createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: NOTE_PATH,
    fullContent: text,
    selection: { start: 0, end: beforeBody.length },
    replacementText: afterBody,
  });
  const store = controller.store;
  await store.writeOperation(op);
  await store.setStatus(op.operationId, 'applied');
  await store.markVerified(op.operationId, after);
  editor.text = after;
  controller.app.disk.set(NOTE_PATH, after);
  const beforeFiles = jsonFiles(adapter).length;
  let prompted = false;
  prompts.versionRestore = async () => { prompted = true; return true; };
  const result = await controller.restoreVersion({ targetOperationId: op.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(prompted, false);
  assert.equal(jsonFiles(adapter).length, beforeFiles);
});

test('a change during confirmation forces a fresh plan and rejects the stale preview', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  selectBody(editor);
  prompts.preview = async () => 'Hi beta';
  const op1 = await controller.refineActive();
  selectBody(editor);
  prompts.preview = async () => 'Done';
  const op2 = await controller.refineActive();
  const before = editor.text;
  prompts.versionRestore = async () => {
    editor.text = before + 'external';
    app.disk.set(NOTE_PATH, editor.text);
    return true;
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, before + 'external');
  assert.equal(splitContent(editor.text).prefix, splitContent(before).prefix);
  const entries = await controller.store.listEntries(NOTE_PATH);
  assert.equal(entries.length, 2);
  assert.equal(jsonFiles(adapter).length, 2);
});


test('operation write failure leaves body and disk untouched', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const body = editor.text;
  adapter.writeFailures.push('op-tmp');
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
});

test('prepared state write failure leaves body untouched and history diagnosable', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const body = editor.text;
  adapter.writeFailures.push('state-tmp');
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
});

test('process failure leaves restore body unchanged and conflict history', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const body = editor.text;
  app.vault.process = async () => { throw new Error('process failed'); };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
})

test('process failure never reports success and preserves conflict history', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const disk = app.disk.get(NOTE_PATH);
  app.vault.process = async () => { throw new Error('process failed'); };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(app.disk.get(NOTE_PATH), disk);
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
})

test('markVerified and markRestored failures remain diagnostic conflicts', async (t) => {
  const first = setup(t);
  const a = await twoRefines(first.editor, first.prompts, first.controller);
  first.controller.store.markVerified = async () => { throw new Error('verify failed'); };
  const resultA = await first.controller.restoreVersion({ targetOperationId: a.op1.operationId, targetSide: 'before' });
  assert.equal(resultA, null);
  assert.equal((await first.controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');

  const second = setup(t);
  const b = await twoRefines(second.editor, second.prompts, second.controller);
  second.controller.store.markRestored = async () => { throw new Error('restore failed'); };
  const resultB = await second.controller.restoreVersion({ targetOperationId: b.op1.operationId, targetSide: 'before' });
  assert.equal(resultB, null);
  assert.equal((await second.controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'verified');
})

test('target history changing during confirmation is rejected by the fresh plan', async (t) => {
  const { adapter, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const body = editor.text;
  prompts.versionRestore = async () => {
    for (const key of [...adapter.files.keys()]) {
      if (key.includes(op1.operationId) && key.endsWith('.json') && !key.includes('.state')) adapter.files.delete(key);
    }
    return true;
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, body);
});


test('applied status failure leaves committed body and reports no success', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const original = controller.store.setStatus.bind(controller.store);
  controller.store.setStatus = async (id, status, options) => {
    if (status === 'applied') throw new Error('status failed');
    return original(id, status, options);
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.match(editor.text, /Alpha beta/);
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
})

test('process disk mismatch is a conflict, not success', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  app.vault.process = async (file, fn) => {
    const current = app.disk.get(file.path);
    await fn(current);
    app.disk.set(file.path, 'not the expected content');
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(app.disk.get(NOTE_PATH), 'not the expected content');
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
})

test('target history disappearing after prepared is rejected before body replacement', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const body = editor.text;
  const original = controller.store.writeRestorePlan.bind(controller.store);
  controller.store.writeRestorePlan = async plan => {
    const result = await original(plan);
    for (const key of [...adapter.files.keys()]) {
      if (key.includes(op1.operationId) && key.endsWith('.json') && !key.includes('.state')) adapter.files.delete(key);
    }
    return result;
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
});

test('external body change after prepared is rejected before replacement', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  const { op1 } = await twoRefines(editor, prompts, controller);
  const original = controller.store.writeRestorePlan.bind(controller.store);
  controller.store.writeRestorePlan = async plan => {
    const result = await original(plan);
    editor.text += 'external-after-prepared';
    app.disk.set(NOTE_PATH, editor.text);
    return result;
  };
  const result = await controller.restoreVersion({ targetOperationId: op1.operationId, targetSide: 'before' });
  assert.equal(result, null);
  assert.equal(editor.text, app.disk.get(NOTE_PATH));
  assert.match(editor.text, /external-after-prepared$/);
  assert.equal((await controller.store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
});
