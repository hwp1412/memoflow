'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RefineEditorController,
  offsetToPos,
} = require('../src/data/refine-editor.js');
const { RefineHistoryStore } = require('../src/data/refine-store.js');
const { splitContent, createRefineOperation, makeState } = require('../src/data/refine-history.js');

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
  settings = {},
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
      async process(file, fn) {
        const current = app.disk.get(file.path);
        const next = await fn(current);
        app.disk.set(file.path, next);
        return next;
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
    settings,
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

function historyPath(store, id, name) {
  return `${store.root}/${id}${name ? `.${name}` : ''}.json`;
}

async function seedExternalOperation(store, adapter, status = 'verified') {
  const op = await createRefineOperation({
    operationId: crypto.randomUUID(),
    notePath: NOTE_PATH,
    fullContent: '---\ntype: extract\npriority: 50\n---\nExternal base\n',
    selection: { start: 0, end: 5 },
    replacementText: 'External',
  });
  adapter.files.set(historyPath(store, op.operationId), JSON.stringify(op, null, 2));
  const state = makeState(op.operationId, status);
  adapter.files.set(historyPath(store, op.operationId, 'state'), JSON.stringify(state, null, 2));
  return op;
}

test('normal refine writes history first, replaces only the body, saves and verifies', async (t) => {
  const { app, adapter, editor, view, store, controller } = setup(t);
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal(view.saves, 0);
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

test('process failure leaves original body and conflict history', async (t) => {
  const { app, editor, store, controller } = setup(t);
  app.vault.process = async () => { throw new Error('process unavailable'); };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
})

test('applied status failure leaves committed body and conflict history', async (t) => {
  const { app, editor, store, controller } = setup(t);
  const original = store.setStatus.bind(store);
  store.setStatus = async (id, status, options) => {
    if (status === 'applied') throw new Error('status write failed');
    return original(id, status, options);
  };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
})

test('markVerified failure leaves conflict and does not claim success', async (t) => {
  const { app, editor, store, controller } = setup(t);
  store.markVerified = async () => { throw new Error('verify unavailable'); };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
})

test('process disk mismatch marks conflict and never verifies', async (t) => {
  const { app, editor, store, controller } = setup(t);
  app.vault.process = async (file, fn) => {
    const current = app.disk.get(file.path);
    await fn(current);
    app.disk.set(file.path, '---\ntype: extract\npriority: 50\n---\nWrong\n');
  };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nWrong\n');
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
})

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
  assert.equal(view.saves, 0);
});

test('autosave before explicit save still validates the exact full file', async (t) => {
  const { app, editor, view, controller } = setup(t);
  editor.autoSave = () => { app.disk.set(NOTE_PATH, editor.text); };
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(view.saves, 0);
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
  assert.equal(view.saves, 0);
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
  assert.equal(view.saves, 0);
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

test('conditional process is used and Frontmatter writer is not', async (t) => {
  const { app, adapter, editor, controller } = setup(t);
  let calls = 0;
  const original = app.vault.process.bind(app.vault);
  app.vault.process = async (file, fn) => { calls++; return original(file, fn); };
  app.fileManager = { processFrontMatter: async () => { throw new Error('processFrontMatter must not be used'); } };
  await controller.refineActive();
  await controller.restoreActive();
  assert.equal(calls, 2);
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal([...adapter.files.keys()].filter(path => path.includes('.json')).length > 0, true);
})

test('invalid configured inline Card regex safely rejects refinement', async (t) => {
  const { app, adapter, editor, controller } = setup(t, {
    settings: { inline_cards: { qa_regex: '[' } },
  });
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /正则配置无效|安全拒绝/);
});

test('no-outer-pipe Markdown table selection is rejected, including an interior row', async (t) => {
  const text = '---\ntype: extract\n---\nAlpha | Beta\n--- | ---\nOne | Two\n';
  const split = splitContent(text);
  const { app, adapter, editor, controller } = setup(t, {
    text,
    selectedStart: text.indexOf('One') - split.bodyStart,
    selectedEnd: text.indexOf('One') - split.bodyStart + 3,
  });
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, text);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /表格/);
});

test('process plus applied-status failure reports committed editor/disk state', async (t) => {
  const { app, editor, store, controller } = setup(t);
  const original = store.setStatus.bind(store);
  store.setStatus = async (id, status, options) => {
    if (status === 'applied') throw new Error('status write failed');
    return original(id, status, options);
  };
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
})

test('history snapshot write failure with state initialization failure is diagnostic, not a no-op claim', async (t) => {
  const { app, adapter, editor, controller } = setup(t);
  adapter.writeFailures.push('state-tmp');
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(adapter.files.size > 0, true);
  const message = app.notices.at(-1).message;
  assert.match(message, /历史快照已写入/);
  assert.match(message, /状态初始化失败/);
  assert.doesNotMatch(message, /操作未开始/);
});

test('replacement creating a complete no-outer-pipe table is rejected', async (t) => {
  const { app, adapter, editor, prompts, controller } = setup(t);
  prompts.preview = async () => 'Alpha | Beta\n--- | ---\nOne | Two';
  const before = editor.text;
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, before);
  assert.equal(app.disk.get(NOTE_PATH), before);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /表格/);
});

test('replacement plus surrounding context forming a table is rejected', async (t) => {
  const text = '---\ntype: extract\n---\nAlpha | Beta\nPLACEHOLDER\n';
  const split = splitContent(text);
  const { app, adapter, editor, prompts, controller } = setup(t, {
    text,
    selectedStart: text.indexOf('PLACEHOLDER') - split.bodyStart,
    selectedEnd: text.indexOf('PLACEHOLDER') - split.bodyStart + 'PLACEHOLDER'.length,
  });
  prompts.preview = async () => '--- | ---\nOne | Two';
  assert.equal(await controller.refineActive(), null);
  assert.equal(editor.text, text);
  assert.equal(app.disk.get(NOTE_PATH), text);
  assert.equal((await files(adapter)).length, 0);
  assert.match(app.notices.at(-1).message, /表格/);
});

test('ordinary text and Markdown link replacement remains allowed', async (t) => {
  const { editor, app, prompts, controller } = setup(t);
  prompts.preview = async () => 'Hi [link](https://example.com)';
  const result = await controller.refineActive();
  assert.ok(result);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHi [link](https://example.com) world\n');
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
});

test('legacy restore rejects a target changed while the confirmation modal is open', async (t) => {
  const { app, adapter, editor, store, prompts, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const body = editor.text;
  prompts.restore = async () => {
    for (const key of [...adapter.files.keys()]) {
      if (key.includes(refined.operationId) && key.endsWith('.json') && !key.includes('.state')) adapter.files.delete(key);
    }
    return true;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  assert.equal((await store.listEntries(NOTE_PATH)).length, 0);
});

test('legacy restore rejects target disappearing after prepared before body replacement', async (t) => {
  const { app, adapter, editor, store, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const body = editor.text;
  const original = store.writeRestorePlan.bind(store);
  store.writeRestorePlan = async plan => {
    const result = await original(plan);
    adapter.files.delete(historyPath(store, refined.operationId));
    return result;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  assert.equal((await store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
});

test('legacy restore rejects target state changes after prepared', async (t) => {
  const { app, adapter, editor, store, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const body = editor.text;
  const original = store.writeRestorePlan.bind(store);
  store.writeRestorePlan = async plan => {
    const result = await original(plan);
    await store.writeStateEvent(refined.operationId, makeState(refined.operationId, 'conflict'));
    return result;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  const entries = await store.listEntries(NOTE_PATH);
  assert.equal(entries.find(entry => entry.operation.restoreOf === refined.operationId).state.status, 'conflict');
});

test('legacy restore rejects history count growth after prepared', async (t) => {
  const { app, adapter, editor, store, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const body = editor.text;
  const original = store.writeRestorePlan.bind(store);
  store.writeRestorePlan = async plan => {
    const result = await original(plan);
    await seedExternalOperation(store, adapter, 'verified');
    return result;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  const entries = await store.listEntries(NOTE_PATH);
  assert.equal(entries.find(entry => entry.operation.restoreOf === refined.operationId).state.status, 'conflict');
});

test('legacy restore rejects another unresolved record after prepared', async (t) => {
  const { app, adapter, editor, store, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const body = editor.text;
  const original = store.writeRestorePlan.bind(store);
  store.writeRestorePlan = async plan => {
    const result = await original(plan);
    await seedExternalOperation(store, adapter, 'prepared');
    return result;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.equal(editor.text, body);
  assert.equal(app.disk.get(NOTE_PATH), body);
  const entries = await store.listEntries(NOTE_PATH);
  assert.equal(entries.find(entry => entry.operation.restoreOf === refined.operationId).state.status, 'conflict');
});

test('legacy restore rejects current file changes after prepared', async (t) => {
  const { app, editor, store, controller } = setup(t);
  const refined = await controller.refineActive();
  assert.ok(refined);
  const original = store.writeRestorePlan.bind(store);
  store.writeRestorePlan = async plan => {
    const result = await original(plan);
    editor.text += 'external-after-prepared';
    app.disk.set(NOTE_PATH, editor.text);
    return result;
  };
  const result = await controller.restoreActive();
  assert.equal(result, null);
  assert.match(editor.text, /external-after-prepared$/);
  assert.equal(app.disk.get(NOTE_PATH), editor.text);
  assert.equal((await store.listEntries(NOTE_PATH)).at(-1).state.status, 'conflict');
});

test('process callback detects D1 after preflight and leaves Editor free of target body', async (t) => {
  const { app, editor, store, controller } = setup(t);
  const D1 = '---\ntype: extract\npriority: 50\n---\nexternal-d1\n';
  const original = app.vault.process.bind(app.vault);
  app.vault.process = async (file, fn) => {
    app.disk.set(file.path, D1);
    return original(file, fn);
  };
  const result = await controller.refineActive();
  assert.equal(result, null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), D1);
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  // Simulate a later Editor autosave: there is no target buffer to write.
  await editor.autoSave?.();
  assert.equal(app.disk.get(NOTE_PATH), D1);
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
});

test('process success followed by Editor sync failure is a diagnostic conflict', async (t) => {
  const { app, editor, store, controller } = setup(t);
  editor.setValue = () => { throw new Error('editor sync failed'); };
  const result = await controller.refineActive();
  assert.equal(result, null);
  assert.equal(editor.text, '---\ntype: extract\npriority: 50\n---\nHello world\n');
  assert.equal(app.disk.get(NOTE_PATH), '---\ntype: extract\npriority: 50\n---\nHi world\n');
  assert.equal((await store.listEntries(NOTE_PATH))[0].state.status, 'conflict');
  assert.doesNotMatch(app.notices.at(-1).message, /已完成/);
});
