'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

class StubPlugin {}
class StubMenu {}
class StubMarkdownView {}
class StubItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.containerEl = { children: [{}, {}] };
    this.contentEl = {};
  }
}
class StubModal {}
class StubFuzzySuggestModal {}
class StubPluginSettingTab {}
class StubSetting {}
class StubTFile {}
class StubFileSystemAdapter {}

const obsidianStub = {
  Plugin: StubPlugin,
  ItemView: StubItemView,
  Modal: StubModal,
  FuzzySuggestModal: StubFuzzySuggestModal,
  PluginSettingTab: StubPluginSettingTab,
  Setting: StubSetting,
  TFile: StubTFile,
  FileSystemAdapter: StubFileSystemAdapter,
  Menu: StubMenu,
  MarkdownView: StubMarkdownView,
  Notice: class {},
  parseYaml: () => ({}),
  Platform: { isMobile: false, isDesktop: true, isMobileApp: false },
};

test('the bundled plugin entry loads with an Obsidian API stub', () => {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'obsidian') return obsidianStub;
    return originalLoad.apply(this, arguments);
  };
  try {
    const PluginClass = require('../src/main.js');
    assert.equal(typeof PluginClass, 'function');
    assert.ok(PluginClass.prototype instanceof StubPlugin);
    assert.equal(typeof PluginClass.prototype.openMemoFlow, 'function');
    assert.equal(typeof PluginClass.prototype.openPdf, 'function');
  } finally {
    Module._load = originalLoad;
  }
});
