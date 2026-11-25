'use strict';

// PR-11 — SR Card boundary audit with Mock Obsidian and synthetic data.
// Source-level proofs and mock-executed host methods are labelled separately.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

// ---- Mock Obsidian -------------------------------------------------------

class MockTFile {}
class MockTFolder {}
class MockPlugin { constructor(app, manifest) { this.app = app; this.manifest = manifest; } }
const notices = [];
class MockNotice { constructor(message) { notices.push(String(message)); } }

const obsidian = {
  Plugin: MockPlugin,
  Notice: MockNotice,
  TFile: MockTFile,
  TFolder: MockTFolder,
  Modal: class {},
  FuzzySuggestModal: class {},
  PluginSettingTab: class {},
  Setting: class {},
  ItemView: class {},
  FileSystemAdapter: class {},
  Menu: class {},
  MarkdownView: class {},
  Platform: { isMobile: false },
  parseYaml: () => ({}),
  normalizePath: value => value,
  setIcon: () => {},
  MarkdownRenderer: { render: async () => {} },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidian;
  return originalLoad.call(this, request, parent, isMain);
};
const HostPlugin = require('../main.js');
Module._load = originalLoad;

const workspace = path.join(__dirname, '..');
const hostSource = fs.readFileSync(path.join(workspace, 'main.js'), 'utf8');
const srcSource = fs.readFileSync(path.join(workspace, 'src', 'main.js'), 'utf8');
const { selectDailyQueue, validateTopic, executeUnifiedEvent, SyntheticUnifiedStorage, PersistentEventLedger, MemoryLedgerStore, issueSyntheticUnifiedCapability } = require('../src/scheduling/index.js');
const { buildDashboardModel } = require('../src/ui/scheduler-dashboard-model.js');

class FakeVault {
  constructor() {
    this.root = this.folder('');
    this.files = new Map();
  }

  folder(path) {
    const node = new MockTFolder();
    node.path = path;
    node.children = [];
    return node;
  }

  getAbstractFileByPath(path) {
    if (path === '' || path === '/') return this.root;
    if (this.files.has(path)) return this.files.get(path);
    const parts = path.split('/');
    let node = this.root;
    for (const part of parts) {
      const child = (node.children || []).find(entry => entry.name === part && entry instanceof MockTFolder);
      if (!child) return null;
      node = child;
    }
    return node;
  }

  async createFolder(path) {
    const parts = path.split('/');
    let parent = this.root;
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let node = (parent.children || []).find(entry => entry.name === part && entry instanceof MockTFolder);
      if (!node) {
        node = this.folder(current);
        node.name = part;
        parent.children.push(node);
      }
      parent = node;
    }
  }

  async create(path, data) {
    const file = new MockTFile();
    file.path = path;
    file.name = path.split('/').pop();
    file.basename = file.name.replace(/\.md$/, '');
    file.extension = 'md';
    file.content = data;
    this.files.set(path, file);
    const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    const parent = this.getAbstractFileByPath(parentPath);
    if (parent && Array.isArray(parent.children)) parent.children.push(file);
    return file;
  }

  async read(file) { return this.files.get(file.path).content; }
  async cachedRead(file) { return this.files.get(file.path).content; }
  async process(file, fn) { const next = fn(this.files.get(file.path).content); this.files.get(file.path).content = next; return next; }
}

function makePlugin({ commands = {}, files = {}, parentFm = {} } = {}) {
  const vault = new FakeVault();
  vault.createFolder('Sources/Incremental Reading/Cards');
  const metadata = new Map();
  const app = {
    vault,
    metadataCache: { getFileCache: file => metadata.get(file.path) || null },
    commands: {
      commands,
      executeCommandById: id => { app.executed = app.executed || []; app.executed.push(id); return commands[id] != null; },
    },
    workspace: { getActiveFile: () => null },
    fileManager: { processFrontMatter: async (file, fn) => { const fm = metadata.get(file.path)?.frontmatter || {}; fn(fm); } },
  };
  const plugin = Object.create(HostPlugin.prototype);
  plugin.app = app;
  plugin.settings = {
    spaced_repetition: { flashcardTag: 'flashcards/incremental-reading' },
    folders: { cards: 'Sources/Incremental Reading/Cards' },
  };
  plugin.spacedRepetitionCloseGeneration = 0;
  plugin.spacedRepetitionCloseAttempt = 0;
  plugin.cardScheduleSignatures = new Map();
  plugin.pendingSpacedRepetitionReview = null;
  plugin.duePoolCache = null;
  for (const [filePath, entry] of Object.entries(files)) {
    const file = new MockTFile();
    file.path = filePath;
    file.basename = filePath.split('/').pop().replace(/\.md$/, '');
    file.extension = 'md';
    file.content = entry.content;
    vault.files.set(filePath, file);
    vault.root.children.push(file);
    metadata.set(filePath, { frontmatter: entry.fm || {} });
  }
  return { plugin, vault, metadata, app };
}

function parentFile(plugin) {
  const file = new MockTFile();
  file.path = 'Sources/Parent.md';
  file.basename = 'Parent';
  file.extension = 'md';
  file.content = '---\ntype: source\npriority: 50\ninterval: 8\nreview_count: 3\n---\nBody';
  plugin.app.vault.files.set(file.path, file);
  plugin.app.vault.root.children.push(file);
  return file;
}

// ---- Card creation boundary ---------------------------------------------

test('creating a card writes no IR scheduling fields and leaves the parent untouched', async () => {
  notices.length = 0;
  const { plugin } = makePlugin();
  const parent = parentFile(plugin);
  const before = parent.content;
  let hostCalls = 0;
  plugin._mfUs1Run = () => { hostCalls += 1; throw new Error('host facade must not run for cards'); };

  const { file, name } = await plugin._createSpacedRepetitionCard(parent, {
    format: 'basic', question: 'Q?', answer: 'A.',
  });
  assert.match(name, /Parent - Card/);
  assert.match(file.content, /type: card/);
  assert.match(file.content, /ir_spaced_repetition: true/);
  assert.match(file.content, /flashcards\/incremental-reading/);
  assert.doesNotMatch(file.content, /^(interval|next_review|review_count|priority|a_factor):/m);
  assert.doesNotMatch(file.content, /mf_id|mf_revision|mf_ideal_due/);
  assert.equal(parent.content, before);
  assert.equal(hostCalls, 0);
});

test('basic, reverse and cloze C1/C2/C3 inputs stay SR-owned', async () => {
  const { plugin } = makePlugin();
  const parent = parentFile(plugin);
  const cardCore = require('../src/data/card.js');
  for (const [format, raw] of [
    ['basic', { question: 'Q', answer: 'A' }],
    ['reverse', { question: 'Q', answer: 'A' }],
    ['cloze', { question: '{{c1::one}} {{c2::two::hint}} {{c3::three}}', answer: '' }],
  ]) {
    const validated = cardCore.validateCardInput({ format, ...raw });
    assert.equal(validated.ok, true, format);
    const { file } = await plugin._createSpacedRepetitionCard(parent, { format, ...validated.value });
    assert.match(file.content, new RegExp(`card_format: ${format}`));
    assert.match(file.content, /ir_spaced_repetition: true/);
  }
  const cloze = cardCore.normalizeCardInput({
    format: 'cloze', question: '{{c1::one}} {{c2::two}} {{c3::three}}',
  });
  assert.equal(cardCore.countClozeCards(cloze.question), 3);
  assert.equal(cardCore.hasClozeMarker('==keyword=='), true);
});

// ---- MF-US-1 ownership boundary -----------------------------------------

test('cards are rejected by the MF-US-1 schema, queue, dashboard and writer', () => {
  const cardTopic = {
    type: 'card', status: 'active', priority: 50,
    mf_id: '00000000-0000-4000-8000-000000000901',
    mf_ideal_due: '2026-11-20', mf_not_before: null, mf_interval_days: 1,
    a_factor: 2, review_count: 0, mf_scheduler_version: 1, mf_revision: 1,
    estimated_minutes: 5,
  };
  assert.throws(() => validateTopic(cardTopic), error => error.code === 'E_TOPIC_TYPE');
  const queue = selectDailyQueue([cardTopic], undefined, '2026-11-24');
  assert.equal(queue.selected.length, 0);
  assert.equal(queue.invalid[0].code, 'E_TOPIC_TYPE');
  const dashboard = buildDashboardModel({ topics: [cardTopic], today: '2026-11-24', dateFormat: 'DD-MM-YYYY' });
  assert.equal(dashboard.cardsExcluded, 1);
  assert.equal(dashboard.queue.selected.length, 0);
  assert.equal(dashboard.queue.overdueCount, 0);
  assert.equal(dashboard.queue.invalid.length, 0, 'a card is not an invalid/unmigrated reading topic');
});

test('a source/extract event cannot modify a card file', () => {
  const cardFile = {
    path: 'Cards/Card.md',
    frontmatter: { type: 'card', ir_spaced_repetition: true, interval: 3, next_review: '20-11-2026' },
    body: 'Q?\n?\nA.\n',
    content: '---\ntype: card\nir_spaced_repetition: true\ninterval: 3\nnext_review: 20-11-2026\n---\nQ?\n?\nA.\n',
    hash: '0'.repeat(64),
    revision: 0,
  };
  const storage = new SyntheticUnifiedStorage({ [cardFile.path]: cardFile });
  const ledger = new PersistentEventLedger(new MemoryLedgerStore());
  const request = {
    eventId: '00000000-0000-4000-8000-000000000902',
    topicId: '00000000-0000-4000-8000-000000000901',
    type: 'ADVANCED',
    payload: {},
    expectedRevision: 0,
    algorithmVersion: 1,
    today: '2026-11-24',
    calendarDate: '2026-11-24',
    dateFormat: 'DD-MM-YYYY',
  };
  let outcome;
  try {
    outcome = executeUnifiedEvent(request, {
      mode: { mode: 'unified' }, storage, ledger, capability: issueSyntheticUnifiedCapability(),
    });
  } catch (error) {
    assert.ok(['E_TOPIC_TYPE', 'E_TOPIC_NOT_FOUND', 'E_SCHEMA'].includes(error.code), error.code);
    outcome = null;
  }
  if (outcome) assert.notEqual(outcome.status, 'applied');
  assert.match(cardFile.content, /interval: 3/);
});

// ---- SR review path and degradation -------------------------------------

test('card review delegates to the Spaced Repetition command only', async () => {
  const commands = {
    'obsidian-spaced-repetition:srs-review-flashcards': {},
    'obsidian-spaced-repetition:srs-review-flashcards-in-note': {},
  };
  const { plugin, app } = makePlugin({ commands });
  const card = new MockTFile();
  card.path = 'Cards/Card.md';
  card.basename = 'Card';
  card.extension = 'md';
  card.content = '---\ntype: card\n---\nQ\n?\nA\n';
  plugin.app.vault.files.set(card.path, card);
  plugin.app.vault.root.children.push(card);
  app.workspace.getActiveFile = () => card;

  await plugin.reviewCardsInNote(card);
  assert.deepEqual(app.executed, ['obsidian-spaced-repetition:srs-review-flashcards-in-note']);
  assert.equal(plugin.pendingSpacedRepetitionReview.path, card.path);
});

test('missing Spaced Repetition degrades with a notice and writes nothing', async () => {
  notices.length = 0;
  let executed = 0;
  const { plugin, app } = makePlugin({ commands: {} });
  app.commands.executeCommandById = () => { executed += 1; return false; };
  plugin.reviewCards();
  assert.equal(executed, 1, 'root reviewCards attempts the command and notices when it is absent');
  assert.ok(notices.some(message => /Spaced Repetition/.test(message)));
  assert.match(srcSource, /isSpacedRepetitionReady\(\)[\s\S]{0,200}需要先安装并启用 Spaced Repetition/);
});

test('unified or shadow settings do not block independent card review', async () => {
  const commands = {
    'obsidian-spaced-repetition:srs-review-flashcards': {},
    'obsidian-spaced-repetition:srs-review-flashcards-in-note': {},
  };
  for (const mode of ['shadow', 'unified']) {
    const { plugin, app } = makePlugin({ commands });
    plugin.settings.mf_us1_mode = mode;
    const card = new MockTFile();
    card.path = `Cards/${mode}.md`;
    card.basename = mode;
    card.extension = 'md';
    card.content = '---\ntype: card\n---\nQ\n?\nA\n';
    plugin.app.vault.files.set(card.path, card);
    await plugin.reviewCardsInNote(card);
    assert.deepEqual(app.executed, ['obsidian-spaced-repetition:srs-review-flashcards-in-note']);
  }
});

test('creating a card under an extract leaves the extract unchanged', async () => {
  const { plugin } = makePlugin();
  const extract = parentFile(plugin);
  extract.basename = 'Extract';
  extract.path = 'Sources/Extract.md';
  extract.content = '---\ntype: extract\npriority: 40\ninterval: 5\nreview_count: 2\nnext_review: 20-11-2026\n---\nBody';
  plugin.app.vault.files.set(extract.path, extract);
  const before = extract.content;
  const { file } = await plugin._createSpacedRepetitionCard(extract, {
    format: 'cloze', question: '{{c1::answer}}',
  });
  assert.match(file.content, /type: card/);
  assert.equal(extract.content, before);
  assert.doesNotMatch(file.content, /review_count|next_review|interval:/);
});

test('the card creation and review paths never call the host scheduler facade', () => {
  const createStart = hostSource.indexOf('async _createSpacedRepetitionCard');
  const createEnd = hostSource.indexOf('  _legacyCardFiles()', createStart);
  assert.ok(createEnd > createStart);
  assert.doesNotMatch(hostSource.slice(createStart, createEnd), /_mfUs1Run/);

  const reviewStart = hostSource.indexOf('reviewCards() {');
  const reviewEnd = hostSource.indexOf('async _confirmSpacedRepetitionReview', reviewStart);
  assert.ok(reviewEnd > reviewStart);
  assert.doesNotMatch(hostSource.slice(reviewStart, reviewEnd), /_mfUs1Run/);
  assert.match(hostSource, /if \(type === 'card'\) this\.reviewCardsInNote\(file\);/);
});
