'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RefineEditorController,
  offsetToPos,
} = require('../src/data/refine-editor.js');
const { RefineHistoryStore } = require('../src/data/refine-store.js');
const { splitContent } = require('../src/data/refine-history.js');

const NOTE_PATH = 'Extracts/Refine.md';

class MemoryAdapter {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
    this.writeFailures = [];
    this.renameFailures = [];
    this.writes = [];
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
    if (this.renameFailures.some(pattern => from.includes(pattern) || to.includes(pattern))) {
      throw new Error(`rename failed: ${from} -> ${to}`);
    }
    if (!this.files.has(from)) throw new Error(`missing: ${from}`);
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  async list(path) {
    const prefix = `${path}/`;
    const files = [...this.files.keys()]
      .filter(file => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'))
      .map(file => file.slice(prefix.length));
    return { files, folders: [] };
  }
}

class FakeEditor {
  constructor(text) {
    this.text = text;
    this.from = { line: 0, ch: 0 };
    this.to = { line: 0, ch: 0 };
    this.autoSave = null;
  }
  getValue() { return this.text; }
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
  selectOffsets(start, end) {
    this.from = offsetToPos(this.text, start);
    this.to = offsetToPos(this.text, end);
  }
  replaceRange(text, from, to) {
    const a = this.posToOffset(from);
    const b = this.posToOffset(to);
    this.text = this.text.slice(0, Math.min(a, b)) + text + this.text.slice(Math.max(a, b));
    this.from = offsetToPos(this.text, Math.min(a, b) + text.length);
    this.to = { ...this.from };
    this.autoSave?.();
  }
}

class FakeView {
  constructor(app, file, editor) {
    this.app = app;
    this.file = file;
    this.editor = editor;
    this.saveError = null;
    this.saves = 0;
    this.diskAfterSave = null;
  }
  async save() {
    this.saves++;
    if (this.saveError) throw this.saveError;
    const value = this.diskAfterSave == null ? this.editor.text : this.diskAfterSave;
    this.app.disk.set(this.file.path, value);
  }
}

function setup(t, {
  text = '---\ntype: extract\npriority: 50\n---\nHello world\n',
  selectedStart = 0,
  selectedEnd = 5,
  extraLeaves = false,
} = {}) {
  const adapter = new MemoryAdapter();
  const app = {
    disk: new Map([[NOTE_PATH, text]]),
    notices: [],
    leaves: [],
    workspace: {
      getLeavesOfType: () => app.leaves,
      getActiveFile: () => file,
    },
    vault: {
      async read(file) {
        if (!app.disk.has(file.path)) throw new Error('missing note');
        return app.disk.get(file.path);
      },
    },
  };
  const file = { path: NOTE_PATH, extension: 'md', basename: 'Refine' };
  const editor = new FakeEditor(text);
  const split = splitContent(text);
  editor.selectOffsets(split.bodyStart + selectedStart, split.bodyStart + selectedEnd);
  const view = new FakeView(app, file, editor);
  app.leaves.push({ view });
  if (extraLeaves) app.leaves.push({ view: { file, editor: new FakeEditor(text) } });
  const store = new RefineHistoryStore({
    adapter,
    historyRoot: 'MemoFlow History/refine',
    now: (() => { let n = 0; return () => `2026-11-25T00:00:${String(n++).padStart(2, '0')}.000Z`; })(),
  });
  const prompts = {
    preview: async () => 'Hi',
    restore: async () => true,
  };
  const controller = new RefineEditorController({
    app,
    store,
    settings: {},
    notice: (message, duration) => app.notices.push({ message, duration }),
    getActiveView: () => view,
    promptPreview: options => prompts.preview(options),
    promptRestore: options => prompts.restore(options),
  });
  return { app, adapter, file, editor, view, store, prompts, controller };
}

async function files(adapter) {
  return [...adapter.files.keys()].filter(path => path.endsWith('.json') && !path.includes('.state'));
}

test('normal refine writes history first, replaces only the body, saves and verifies', async (t) => {
  const { app, adapter, editor, view, store, controller } = setup(t);
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal(view.saves, 1);
  assert.equal((await files(adapter)).length, 1);
  assert.equal((await store.latestVerified(NOTE_PATH)).state.status, 'verified');
  assert.match(app.notices.at(-1).message, /完成/);
});

test('cancelled preview makes no history or file changes', async (t) => {
  const { app, adapter, editor, view, prompts, controller } = setup(t);
  prompts.preview = async () => null;
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(app.disk.get(NOTE_PATH), before);
  assert.equal((await files(adapter)).length, 0);
  assert.equal(view.saves, 0);
});

test('identical replacement does not create history', async (t) => {
  const { app, adapter, editor, view, prompts, controller } = setup(t);
  prompts.preview = async options => options.selectedText;
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(app.disk.get(NOTE_PATH), before);
  assert.equal((await files(adapter)).length, 0);
  assert.equal(view.saves, 0);
});

test('dirty editor is rejected without saving or writing history', async (t) => {
  const { app, adapter, editor, view, controller } = setup(t);
  editor.text += 'unsaved\n';
  const before = app.disk.get(NOTE_PATH);
  assert.equal(await controller.refineActive(), null);
  assert.equal(app.disk.get(NOTE_PATH), before);
  assert.equal(view.saves, 0);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /尚未保存/);
});

test('multiple windows are rejected before history or body changes', async (t) => {
  const { app, adapter, editor, view, controller } = setup(t, { extraLeaves: true });
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(view.saves, 0);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /多个编辑窗口/);
});

test('preview-period editor changes are rejected', async (t) => {
  const { app, adapter, editor, view, prompts, controller } = setup(t);
  prompts.preview = async () => {
    editor.text += 'external edit\n';
    return 'Hi';
  };
  const beforeDisk = app.disk.get(NOTE_PATH);
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text.endsWith('external edit\n'), true);
  assert.equal(app.disk.get(NOTE_PATH), beforeDisk);
  assert.equal(view.saves, 0);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /内容已变化|编辑内容已变化/);
});

test('modal focus/selection change alone does not reject a stable snapshot', async (t) => {
  const { app, editor, prompts, controller } = setup(t);
  prompts.preview = async () => {
    editor.from = { line: 0, ch: 0 };
    editor.to = { line: 0, ch: 0 };
    return 'Hi';
  };
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
});

test('history write failure leaves editor and disk untouched', async (t) => {
  const { app, adapter, editor, view, controller } = setup(t);
  adapter.writeFailures.push('op-tmp');
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(app.disk.get(NOTE_PATH), before);
  assert.equal(view.saves, 0);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /历史已保留|操作/);
});

test('save failure leaves applied history and does not claim verified', async (t) => {
  const { app, adapter, editor, view, store, controller } = setup(t);
  view.saveError = new Error('disk full');
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal((await files(adapter)).length, 1);
  const entry = (await store.listEntries(NOTE_PATH))[0];
  assert.equal(entry.state.status, 'applied');
  await assert.rejects(() => store.latestVerified(NOTE_PATH), error => error.code === 'UNRESOLVED_HISTORY');
  assert.match(app.notices.at(-1).message, /历史已保留/);
});

test('status applied failure leaves prepared history and does not save body', async (t) => {
  const { app, adapter, editor, view, store, controller } = setup(t);
  const original = store.setStatus.bind(store);
  store.setStatus = async (id, status, options) => {
    if (status === 'applied') throw new Error('status write failed');
    return original(id, status, options);
  };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHello world\n');
  const entry = (await store.listEntries(NOTE_PATH))[0];
  assert.equal(entry.state.status, 'prepared');
  assert.equal(view.saves, 0);
  assert.match(app.notices.at(-1).message, /历史已保留/);
});

test('markVerified failure leaves applied history and keeps disk content', async (t) => {
  const { app, adapter, editor, store, controller } = setup(t);
  store.markVerified = async () => { throw new Error('verify unavailable'); };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  const entry = (await store.listEntries(NOTE_PATH))[0];
  assert.equal(entry.state.status, 'applied');
  assert.equal((await files(adapter)).length, 1);
  assert.match(app.notices.at(-1).message, /历史已保留/);
});

test('saved disk content mismatch marks conflict and never verifies', async (t) => {
  const { app, editor, view, store, controller } = setup(t);
  view.diskAfterSave = '---\ntype: extract\npriority: 50\n---\nWrong\n';
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nWrong\n');
  const entry = (await store.listEntries(NOTE_PATH))[0];
  assert.equal(entry.state.status, 'conflict');
});

test('protected SR/card/readpoint/code/table selections and unsafe replacements are rejected', async (t) => {
  const cases = [
    '---\ntype: extract\n---\nA {{c1::cloze}}\n',
    '---\ntype: extract\n---\nA <!--SR:2026-->\n',
    '---\ntype: extract\n---\nA 📍\n',
    '---\ntype: extract\n---\n```\ncode\n```\n',
    '---\ntype: extract\n---\n| a | b |\n| --- | --- |\n| c | d |\n',
  ];
  for (const text of cases) {
    const ctx = setup(t, { text, selectedStart: 0, selectedEnd: 3 });
    assert.equal(await ctx.controller.refineActive(), null);
    assert.equal((await files(ctx.adapter)).length, 0, text);
    assert.match(ctx.app.notices.at(-1).message, /安全|受保护|拒绝/);
  }
});

test('replacement introducing protected SR syntax is rejected', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  prompts.preview = async () => 'Hi {{c1::x}}';
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /受保护/);
});

test('CRLF and Unicode selection/refine preserve exact bytes around the body edit', async (t) => {
  const text = '---\r\ntype: extract\r\n---\r\nHello 😀 world\r\n';
  const { app, editor, view, controller } = setup(t, { text, selectedStart: 0, selectedEnd: 5 });
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(editor.text, '---\r\ntype: extract\r\n---\r\nHi 😀 world\r\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal(view.saves, 1);
});

test('autosave before explicit save still validates the exact full file', async (t) => {
  const { app, editor, view, controller } = setup(t);
  editor.autoSave = () => { app.disk.set(NOTE_PATH, editor.text); };
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(view.saves, 1);
});

test('disk changes during preview are rejected before history', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  prompts.preview = async () => {
    app.disk.set(NOTE_PATH, `${editor.text}external\n`);
    return 'Hi';
  };
  assert.equal(await controller.refineActive(), null);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /磁盘内容已变化/);
});

test('restore latest refinement preserves current Frontmatter and becomes restored', async (t) => {
  const { app, editor, view, store, controller } = setup(t);
  await controller.refineActive();
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');

  const restore = await controller.restoreActive();
  assert.ok(restore);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal(view.saves, 2);
  const entries = await store.listEntries(NOTE_PATH);
  assert.equal(entries.at(-1).state.status, 'restored');
  await assert.rejects(() => store.latestRestorable(NOTE_PATH), error => error.code === 'ALREADY_RESTORED');
});

test('restore preserves a Frontmatter change that happened after refinement', async (t) => {
  const { app, editor, view, controller } = setup(t);
  await controller.refineActive();
  const before = '---\ntype: extract\npriority: 99\n---\nHi world\n';
  editor.text = before;
  app.disk.set(NOTE_PATH, before);
  const result = await controller.restoreActive();
  assert.ok(result);
  assert.equal(editor.text, '---\ntype: extract\npriority: 99\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal(view.saves, 2);
});

test('restore refuses a body changed after refinement', async (t) => {
  const { app, editor, store, controller } = setup(t);
  await controller.refineActive();
  const changed = '---\ntype: extract\npriority: 50\n---\nUser later edit\n';
  editor.text = changed;
  app.disk.set(NOTE_PATH, changed);
  const countBefore = (await store.listEntries(NOTE_PATH)).length;
  assert.equal(await controller.restoreActive(), null);
  assert.equal((await store.listEntries(NOTE_PATH)).length, countBefore);
  assert.match(app.notices.at(-1).message, /current body|冲突|does not match/i);
});

test('second restore is refused and does not rewrite the body', async (t) => {
  const { app, editor, store, controller } = setup(t);
  await controller.refineActive();
  await controller.restoreActive();
  const afterFirst = editor.text;
  const countBefore = (await store.listEntries(NOTE_PATH)).length;
  assert.equal(await controller.restoreActive(), null);
  assert.equal(editor.text, afterFirst);
  assert.equal((await store.listEntries(NOTE_PATH)).length, countBefore);
  assert.match(app.notices.at(-1).message, /already been restored|已恢复/);
});

test('no vault.process or Frontmatter writer is used by refine/restore', async (t) => {
  const { app, editor, view, controller } = setup(t);
  app.vault.process = async () => { throw new Error('vault.process must not be used'); };
  app.fileManager = { processFrontMatter: async () => { throw new Error('processFrontMatter must not be used'); } };
  await controller.refineActive();
  await controller.restoreActive();
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(view.saves, 2);
});
