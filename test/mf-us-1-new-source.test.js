'use strict';

// Regression: "New source" (incl. PDF) must work in Unified mode instead of
// silently doing nothing because the scheduling host has no CREATE_SOURCE route.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlugin, makeSettings } = require('./helpers/obsidian-mock.js');
const { createPluginDataCoordinator } = require('../src/integration/plugin-data-coordinator.js');
const { BATCH_KEY } = require('../src/integration/batch-store.js');

async function authorizedPlugin() {
  if (!global.window) {
    global.window = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id), innerWidth: 1200, innerHeight: 800 };
  }
  const { plugin, app } = createPlugin({ settings: makeSettings() });
  plugin.pluginData = createPluginDataCoordinator({ plugin, reservedKeys: ['mfUs1Ledger', BATCH_KEY], notice: () => {} });
  plugin.mfUs1Recovery = { healthy: true, recovered: [], blockedTopicIds: [] };
  plugin.mfUs1BatchRecovery = { batches: [], blockedTopicIds: [], summary: { checked: 0, manual: 0, pending: 0 } };
  plugin.__mfUs1BackupVerified = true;
  const result = await plugin._mfUs1AutoStartRuntime();
  assert.equal(result.ok, true, JSON.stringify(result.blockers || []));
  return { plugin, app };
}

test('New source creates an MF-US-1 source in Unified mode (PDF path prompts)', async () => {
  const { plugin, app } = await authorizedPlugin();
  app.__promptState.texts = ['我的 PDF 来源', '50', 'papers/book.pdf', '120'];
  app.__promptState.quality = 'pdf';
  app.__promptState.confirm = true;
  await plugin.newSource();
  const created = app.vault.getAbstractFileByPath(`${plugin.sourcesFolder()}/我的 PDF 来源.md`);
  assert.ok(created, 'source note should be created');
  const text = app.vault.readContent(created);
  assert.match(text, /type: source/);
  assert.match(text, /mf_id: [0-9a-f-]{36}/);
  assert.match(text, /pdf_path: "papers\/book\.pdf"/);
  assert.match(text, /total_pages: 120/);
});
