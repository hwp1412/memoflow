'use strict';

// Test-only Obsidian API mock for M03 write-regression tests.
// It intentionally lives outside production code and never touches a real Vault.

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const REPO = path.resolve(__dirname, '..', '..');
const dateCore = require(path.join(REPO, 'date-core.js'));

let noticeSink = [];
let currentApp = null;

function createElement(tag = 'div', options = {}) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; },
    },
    className: options.cls || '',
    textContent: options.text ? String(options.text) : '',
    value: options.value != null ? options.value : '',
    type: '',
    checked: false,
    disabled: false,
    draggable: false,
    title: '',
    empty() { this.children = []; },
    setText(value) { this.textContent = String(value); },
    createEl(childTag, childOptions = {}) {
      const child = createElement(childTag, childOptions);
      this.children.push(child);
      return child;
    },
    createDiv(childOptions = {}) { return this.createEl('div', childOptions); },
    createSpan(childOptions = {}) { return this.createEl('span', childOptions); },
    addEventListener() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    select() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeClass() {},
    addClass() {},
    toggleClass() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return element;
}

class MockPlugin {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.__data = {};
  }
  async loadData() { return this.__data; }
  async saveData(data) { this.__data = data; }
  registerView() {}
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
  registerEvent() {}
}

class MockItemView extends MockPlugin {
  constructor(leaf) {
    super(null, null);
    this.leaf = leaf;
    this.containerEl = createElement();
    this.contentEl = createElement();
  }
}

class MockModal {
  constructor(app) {
    this.app = app;
    this.titleEl = createElement();
    this.contentEl = createElement();
    this.modalEl = createElement();
    this.closed = false;
  }
  open() {
    this.onOpen?.();
    const state = this.app.__promptState || {};
    if (this.constructor.name === 'TextPromptModal') {
      const value = state.texts && state.texts.length ? state.texts.shift() : this.defaultValue;
      state.calls?.push({ type: 'text', title: this.title, value });
      this._submit(value);
    } else if (this.constructor.name === 'ConfirmModal') {
      const value = state.confirm !== false;
      state.calls?.push({ type: 'confirm', title: this.title, value });
      this._answer(value);
    } else if (this.constructor.name === 'LongTextModal') {
      const value = state.longTexts && state.longTexts.length ? state.longTexts.shift() : this.defaultValue;
      state.calls?.push({ type: 'long', title: this.title, value });
      this._submit(value);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }
}

class MockFuzzySuggestModal {
  constructor(app) { this.app = app; }
  setPlaceholder() {}
  open() {
    this.onOpen?.();
    const state = this.app.__promptState || {};
    if (state.quality === null) {
      state.calls?.push({ type: 'suggest', value: null });
      this.onChooseItem(null, null);
      return;
    }
    const items = this.getItems();
    const chosen = items.find(item => item && item.v === state.quality) || items[0];
    state.calls?.push({ type: 'suggest', value: chosen && chosen.v });
    this.onChooseItem(chosen, null);
  }
}

class MockTFile {
  constructor(filePath) {
    this.path = filePath;
    this.name = path.basename(filePath);
    this.basename = path.basename(filePath, path.extname(filePath));
    this.extension = path.extname(filePath).replace(/^\./, '');
    this.stat = { mtime: Date.now(), size: 0 };
  }
}

class MockTFolder {
  constructor(folderPath) {
    this.path = folderPath;
    this.name = path.basename(folderPath);
    this.children = [];
  }
}

class MockNotice {
  constructor(message) {
    this.message = String(message == null ? '' : message);
    noticeSink.push(this.message);
    if (currentApp) currentApp.notices = noticeSink;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value == null ? null : value));
}

function frontmatterText(frontmatter) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter || {})) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${item}`);
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function makeSettings(overrides = {}, today = dateCore.formatDate(new Date(), 'YYYY-MM-DD')) {
  const base = {
    scheduling: {
      a_factor_min: 1.05,
      a_factor_max: 5,
      progress_aware: true,
      stall_guard: true,
      quality_hold: 1,
      quality_speed_up: 0.95,
      quality_slow_down: 1.05,
      initial_af_base: 2.5,
      initial_af_slope: 0.25,
      initial_af_units_divisor: 10,
      extract_bump: 1.05,
    },
    queue: { sidebar_enabled: true, default_tag_filter: '', sort_key: 'urgency', mix_cards: true },
    inline_cards: { enabled: true, qa_regex: '^Q::\\s*(.+?)\\s*::A::\\s*(.+)$', cloze_regex: '\\{\\{c(\\d+)::([^}]+?)(?:::([^}]+?))?\\}\\}' },
    spaced_repetition: {
      flashcardTag: 'flashcards/incremental-reading',
      multilineCardSeparator: '?',
      multilineReversedCardSeparator: '??',
    },
    paths: {
      sources: 'Sources',
      extracts: 'Extracts',
      cards: 'Cards',
      attachments: 'Attachments',
      categories: 'Categories',
      dashboard: 'Dashboard.md',
      review_log: 'Review Log.md',
    },
    misc: { debug: false, date_format: 'YYYY-MM-DD', extract_highlight_color: '#ffd166' },
    tree: { expanded: [], child_warn_threshold: 100, show_completed: false },
    session: { date: today, paths: [], types: {}, readPoints: {} },
  };
  const merge = (target, source) => {
    for (const [key, value] of Object.entries(source || {})) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        target[key] = merge(target[key] && typeof target[key] === 'object' ? target[key] : {}, value);
      } else if (Array.isArray(value)) {
        target[key] = value.slice();
      } else {
        target[key] = value;
      }
    }
    return target;
  };
  return merge(base, overrides);
}

function createApp() {
  noticeSink = [];
  const app = {
    notices: noticeSink,
    __promptState: { texts: [], longTexts: [], quality: 1, confirm: true, calls: [] },
    activeFile: null,
    leaves: {},
    commands: { executeCommandById: () => false },
    plugins: { plugins: {} },
  };
  currentApp = app;

  const vault = {
    entries: new Map(),
    folders: new Set(),
    processCalls: [],
    appendCalls: [],
    createCalls: [],
    createFolderCalls: [],
    appendError: null,
    addFolder(folderPath) {
      this.folders.add(folderPath);
      return new MockTFolder(folderPath);
    },
    addFile(filePath, frontmatter = {}, body = '') {
      const file = new MockTFile(filePath);
      const content = frontmatterText(frontmatter) + String(body || '');
      this.entries.set(filePath, { file, frontmatter: clone(frontmatter), body: String(body || ''), content });
      return file;
    },
    getAbstractFileByPath(filePath) {
      const entry = this.entries.get(filePath);
      if (entry) return entry.file;
      if (this.folders.has(filePath)) return new MockTFolder(filePath);
      return null;
    },
    async cachedRead(file) { return this.read(file); },
    async read(file) {
      const entry = this.entries.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      return entry.content;
    },
    async process(file, fn) {
      const entry = this.entries.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      const before = entry.content;
      const after = fn(before);
      if (typeof after !== 'string') throw new Error('vault.process must return a string');
      entry.content = after;
      this.processCalls.push({ file, before, after });
      return after;
    },
    async append(file, text) {
      if (this.appendError) throw this.appendError;
      const entry = this.entries.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      entry.content += String(text);
      entry.body += String(text);
      this.appendCalls.push({ file, text: String(text) });
    },
    async create(filePath, content) {
      if (this.entries.has(filePath)) throw new Error(`file exists: ${filePath}`);
      const file = new MockTFile(filePath);
      this.entries.set(filePath, { file, frontmatter: {}, body: String(content), content: String(content) });
      this.createCalls.push({ file, content: String(content) });
      return file;
    },
    async createFolder(folderPath) {
      this.folders.add(folderPath);
      this.createFolderCalls.push(folderPath);
      return new MockTFolder(folderPath);
    },
    readFm(file) {
      const entry = this.entries.get(file.path);
      return entry ? entry.frontmatter : null;
    },
    readBody(file) {
      const entry = this.entries.get(file.path);
      if (!entry) return null;
      const match = String(entry.content).match(/^---\n[\s\S]*?\n---\n/);
      return match ? String(entry.content).slice(match[0].length) : String(entry.content);
    },
    readContent(file) {
      const entry = this.entries.get(file.path);
      return entry ? entry.content : null;
    },
  };

  const metadataCache = {
    getFileCache(file) {
      const entry = file ? vault.entries.get(file.path) : null;
      if (!entry) return null;
      return { frontmatter: entry.frontmatter, tags: (entry.frontmatter.tags || []).map(tag => ({ tag: `#${tag}` })) };
    },
    getFirstLinkpathDest(name) {
      for (const key of vault.entries.keys()) {
        if (path.basename(key, path.extname(key)) === name) return vault.entries.get(key).file;
      }
      return null;
    },
  };

  const fileManager = {
    writes: [],
    async processFrontMatter(file, mutator) {
      const entry = vault.entries.get(file.path);
      if (!entry) throw new Error(`missing file: ${file.path}`);
      const before = clone(entry.frontmatter);
      const next = clone(entry.frontmatter);
      mutator(next);
      entry.frontmatter = next;
      this.writes.push({ file, before, after: clone(next) });
      return next;
    },
    async renameFile() {},
  };

  const workspace = {
    getActiveFile() { return app.activeFile; },
    getLeavesOfType(type) { return app.leaves[type] || []; },
    getLeaf() {
      return { openFile: async () => {}, setViewState: async () => {} };
    },
    getActiveViewOfType() { return null; },
    on() { return {}; },
    onLayoutReady(callback) { callback?.(); },
  };

  app.vault = vault;
  app.metadataCache = metadataCache;
  app.fileManager = fileManager;
  app.workspace = workspace;
  return app;
}

function loadPluginClass() {
  const obsidianMock = {
    Plugin: MockPlugin,
    ItemView: MockItemView,
    Modal: MockModal,
    FuzzySuggestModal: MockFuzzySuggestModal,
    PluginSettingTab: MockPlugin,
    Setting: class MockSetting { constructor() {} },
    TFile: MockTFile,
    TFolder: MockTFolder,
    FileSystemAdapter: class MockFileSystemAdapter {},
    Menu: class MockMenu {},
    MarkdownView: class MockMarkdownView {},
    Notice: MockNotice,
    parseYaml: () => ({}),
    normalizePath: value => String(value),
    Platform: { isMobile: false, isDesktop: true, isMobileApp: false },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'obsidian') return obsidianMock;
    return originalLoad.apply(this, arguments);
  };
  try {
    for (const file of [path.join(REPO, 'src/main.js'), path.join(REPO, 'main.js')]) {
      try { delete require.cache[require.resolve(file)]; } catch { /* ignore */ }
    }
    return require(path.join(REPO, 'src/main.js'));
  } finally {
    Module._load = originalLoad;
  }
}

function createPlugin({ settings = null, today = dateCore.formatDate(new Date(), 'YYYY-MM-DD') } = {}) {
  const app = createApp();
  app.vault.addFile('Review Log.md', {}, '# Review Log\n\n| Date | Element | Type | Grade | Interval |\n| --- | --- | --- | --- | --- |\n');
  const PluginClass = loadPluginClass();
  const plugin = new PluginClass(app, { id: 'memoflow', version: '0.1.0' });
  plugin.settings = settings || makeSettings({}, today);
  plugin.cardDueCache = new Map();
  plugin.cardScheduleSignatures = new Map();
  plugin.pendingSpacedRepetitionReview = null;
  plugin.irFilesCache = null;
  plugin.irRowsCache = null;
  plugin.irMetadataSignatures = new Map();
  plugin.irCollectionRevision = 0;
  plugin.collectionRenderDeferrals = 0;
  plugin.sessionSaveTimer = null;
  plugin.duePoolCache = null;
  app.plugin = plugin;
  return { plugin, app };
}

function withFrozenDate(t, date = new Date(2026, 10, 24, 12, 0, 0)) {
  const previousDate = global.Date;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const previousWindow = global.window;
  const previousWindowHadSetTimeout = Boolean(previousWindow && Object.prototype.hasOwnProperty.call(previousWindow, 'setTimeout'));
  const previousSetTimeout = previousWindow ? previousWindow.setTimeout : undefined;
  const fixed = date.getTime();
  class FakeDate extends previousDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  global.Date = FakeDate;
  if (previousWindow) global.window = previousWindow;
  else global.window = {};
  global.window.setTimeout = global.setTimeout;
  t.after(() => {
    global.Date = previousDate;
    if (!hadWindow) {
      delete global.window;
      return;
    }
    global.window = previousWindow;
    if (previousWindow) {
      if (previousWindowHadSetTimeout) previousWindow.setTimeout = previousSetTimeout;
      else delete previousWindow.setTimeout;
    }
  });
  return new previousDate(fixed);
}

function flushAsync() {
  return new Promise(resolve => setImmediate(resolve));
}

function makeFile(app, filePath, frontmatter = {}, body = '') {
  return app.vault.addFile(filePath, frontmatter, body);
}

function getNotices(app) {
  return (app && app.notices) || noticeSink;
}

module.exports = {
  REPO,
  createElement,
  createApp,
  createPlugin,
  makeFile,
  makeSettings,
  withFrozenDate,
  flushAsync,
  getNotices,
  MockTFile,
  MockTFolder,
  notificationSink: () => noticeSink,
};
