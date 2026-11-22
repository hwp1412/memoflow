'use strict';

const { ItemView, Notice, Platform } = require('obsidian');
const { createDashboard } = require('../ui/dashboard.js');
const { buildModel } = require('../data/model.js');
const { buildDemoModel } = require('../data/demo.js');
const copy = require('../ui/copy.js');

const VIEW_TYPE = 'memoflow-dashboard';

class MemoFlowDashboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.ui = null;
    this.model = null;
    this.state = {
      query: '',
      filter: 'all',
      sort: 'urgency',
      demo: false,
      expanded: new Set(),
      collapsed: new Set(),
    };
    this.refreshTimer = null;
    this.midnightTimer = null;
    this.collectionRevision = -1;
    this.needsRender = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return 'MemoFlow';
  }

  getIcon() {
    return 'layout-dashboard';
  }

  async onOpen() {
    this.contentEl.addClass('mf-view-host');
    this.contentEl.style.padding = '0';
    this.ui = createDashboard(this.contentEl, {
      onAction: (action, data) => this.handleAction(action, data),
      isMobile: Platform.isMobile,
    });
    this.ui.setLoading();
    this.collectionRevision = this.plugin.irCollectionRevision;
    await this.refresh({ initial: true });

    this.registerEvent(this.app.metadataCache.on('changed', () => {
      if (this.plugin.irCollectionRevision === this.collectionRevision) return;
      this.collectionRevision = this.plugin.irCollectionRevision;
      this.scheduleRefresh('metadata');
    }));
    for (const event of ['create', 'delete', 'rename']) {
      this.registerEvent(this.app.vault.on(event, () => this.scheduleRefresh(`vault-${event}`)));
    }
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      if (this.needsRender && this.isVisible()) this.scheduleRefresh('visible');
    }));
    this.scheduleMidnightRefresh();
  }

  async onClose() {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    if (this.midnightTimer) window.clearTimeout(this.midnightTimer);
    this.refreshTimer = null;
    this.midnightTimer = null;
    if (this.ui) {
      this.ui.destroy();
      this.ui = null;
    }
  }

  isVisible() {
    const el = this.containerEl;
    if (!el || !el.isConnected) return false;
    return el.offsetParent !== null || (typeof el.getClientRects === 'function' && el.getClientRects().length > 0);
  }

  scheduleRefresh(reason) {
    if (!this.isVisible() && reason !== 'initial') {
      this.needsRender = true;
      return;
    }
    this.needsRender = false;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, 250);
  }

  scheduleMidnightRefresh() {
    if (this.midnightTimer) window.clearTimeout(this.midnightTimer);
    const now = new Date();
    const next = new Date(now.getTime());
    next.setHours(24, 0, 0, 100);
    this.midnightTimer = window.setTimeout(() => {
      this.midnightTimer = null;
      this.refresh();
      this.scheduleMidnightRefresh();
    }, Math.max(1000, next.getTime() - now.getTime()));
  }

  async refresh({ initial = false } = {}) {
    if (!this.ui) return;
    this.needsRender = false;
    if (initial) this.ui.setLoading();
    try {
      const model = this.state.demo
        ? buildDemoModel(new Date(), { isMobile: Platform.isMobile })
        : await buildModel({ plugin: this.plugin, isMobile: Platform.isMobile });
      this.model = model;
      this.ui.update(model, this.state);
    } catch (error) {
      console.error('[MemoFlow] failed to build dashboard model', error);
      this.ui.setError(error && error.message ? error.message : '无法读取增量阅读数据。');
    }
  }

  async handleAction(action, data = {}) {
    const isDemo = this.state.demo;
    switch (action) {
      case 'search':
        this.state.query = data.query || '';
        if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
        return;
      case 'filter':
        this.state.filter = data.filter || 'all';
        if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
        return;
      case 'sort':
        this.state.sort = data.sort || 'urgency';
        if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
        return;
      case 'tree-toggle': {
        const depth = Number(data.depth) || 0;
        const set = depth === 0 ? this.state.collapsed : this.state.expanded;
        if (set.has(data.path)) set.delete(data.path);
        else set.add(data.path);
        if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
        return;
      }
      case 'clear-filters':
        this.state.query = '';
        this.state.filter = 'all';
        this.ui?.setSearchValue('');
        if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
        return;
      case 'demo-toggle':
      case 'retry':
      case 'refresh':
        if (action === 'demo-toggle') this.state.demo = !this.state.demo;
        await this.refresh();
        return;
      default:
        break;
    }

    if (isDemo) {
      new Notice(copy.demoAction);
      return;
    }

    switch (action) {
      case 'start':
        if (typeof this.plugin.startLearning === 'function') {
          await this.plugin.startLearning();
        } else if (typeof this.plugin.buildSessionQueue === 'function') {
          await this.plugin.buildSessionQueue({ openFirst: true });
        }
        return;
      case 'queue':
      case 'more-queue':
        if (typeof this.plugin._activateQueueView === 'function') await this.plugin._activateQueueView();
        return;
      case 'review-cards':
        if (typeof this.plugin.reviewCards === 'function') this.plugin.reviewCards();
        return;
      case 'card-review':
        if (typeof this.plugin.openCardReview === 'function') await this.plugin.openCardReview();
        return;
      case 'overload':
        if (typeof this.plugin.openOverloadDialog === 'function') await this.plugin.openOverloadDialog();
        return;
      case 'queue-priority': {
        if (!data.path) return;
        const file = this.app.vault.getAbstractFileByPath(data.path);
        if (!file) {
          new Notice('找不到这条阅读项。');
          return;
        }
        if (typeof this.plugin.openPriorityDialog === 'function') {
          await this.plugin.openPriorityDialog(file, {
            onApplied: () => this.refresh({ initial: false }),
          });
        }
        return;
      }
      case 'review-filtered': {
        let paths = [];
        try { paths = JSON.parse(data.paths || '[]'); } catch { paths = []; }
        if (!paths.length) {
          new Notice('当前筛选没有可复习项目。');
          return;
        }
        if (typeof this.plugin.buildSubsetSession === 'function') {
          await this.plugin.buildSubsetSession(paths, { openFirst: true, label: data.label || '筛选' });
        }
        return;
      }
      case 'tree':
      case 'tree-full':
        if (typeof this.plugin._activateKnowledgeTree === 'function') await this.plugin._activateKnowledgeTree();
        return;
      case 'guide':
        if (typeof this.plugin.openUserGuide === 'function') this.plugin.openUserGuide();
        return;
      case 'quick-card':
        if (typeof this.plugin.flashcardClipboard === 'function') await this.plugin.flashcardClipboard();
        return;
      case 'quick-extract':
        if (typeof this.plugin.createTimestampExtract === 'function') {
          await this.plugin.createTimestampExtract({ fromSelection: true });
        } else if (typeof this.plugin.extractSelection === 'function') {
          await this.plugin.extractSelection();
        }
        return;
      case 'quick-new':
        if (typeof this.plugin.captureOrCreate === 'function') await this.plugin.captureOrCreate();
        return;
      case 'open':
        await this.openPath(data.path);
        return;
      case 'open-note':
        await this.openNote(data.path);
        return;
      case 'open-pdf':
        await this.openPdf(data.path);
        return;
      default:
        return;
    }
  }

  findQueueItem(path) {
    if (!this.model || !path) return null;
    const pools = [
      this.model.queue || [],
      this.model.recent || [],
      this.model.sources || [],
    ];
    for (const pool of pools) {
      const found = pool.find(item => item.path === path);
      if (found) return found;
    }
    return null;
  }

  findRow(path) {
    if (!path) return null;
    return (this.plugin.getIRRows() || []).find(row => row.tfile && row.tfile.path === path) || null;
  }

  async openPath(path) {
    if (!path) return;
    const item = this.findQueueItem(path);
    if (item && item.tfile && item.fm && typeof this.plugin.openLearningItem === 'function') {
      await this.plugin.openLearningItem({ tfile: item.tfile, fm: item.fm });
      return;
    }
    const row = this.findRow(path);
    if (row && typeof this.plugin.openLearningItem === 'function') {
      await this.plugin.openLearningItem(row);
      return;
    }
    await this.openNote(path);
  }

  async openNote(path) {
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice('找不到对应笔记。');
      return;
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  async openPdf(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      new Notice('找不到对应来源笔记。');
      return;
    }
    if (typeof this.plugin.openPdfForSource === 'function') {
      await this.plugin.openPdfForSource(file);
      return;
    }
    await this.openNote(path);
    if (typeof this.plugin.openPdf === 'function') await this.plugin.openPdf();
  }

  scrollToSection(section) {
    if (section === 'analytics' && this.ui) this.ui.scrollToAnalytics();
  }
}

module.exports = { VIEW_TYPE, MemoFlowDashboardView };
