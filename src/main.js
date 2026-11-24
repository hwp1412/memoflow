'use strict';

const { Platform, Notice, MarkdownView, TFile } = require('obsidian');
const BasePlugin = require('../main.js');
const dateCore = require('../date-core.js');
const treeCore = require('../tree-core.js');
const extractCore = require('./data/extract.js');
const pdfPage = require('./data/pdf-page.js');
const { VIEW_TYPE, MemoFlowDashboardView } = require('./views/dashboard-view.js');
const { REVIEW_VIEW_TYPE, MemoFlowReviewView } = require('./views/review-view.js');
const { MemoFlowSettingTab } = require('./views/settings-tab.js');
const { MemoFlowCardModal } = require('./views/card-modal.js');
const { MemoFlowPriorityModal } = require('./views/priority-modal.js');
const { MemoFlowOverloadModal } = require('./views/overload-modal.js');
const { MemoFlowUserGuideModal } = require('./views/user-guide-modal.js');
const { ExtractOpenModal } = require('./views/extract-open-modal.js');
const { RefinePreviewModal } = require('./views/refine-modal.js');
const { RefineHistoryModal, formatTime } = require('./views/refine-history-modal.js');
const { RefineRestoreModal } = require('./views/refine-restore-modal.js');
const { buildHistoryView } = require('./data/refine-history-read.js');
const { RefineHistoryStore } = require('./data/refine-store.js');
const { RefineEditorController } = require('./data/refine-editor.js');
const { ConfirmActionModal } = require('./views/confirm-modal.js');
const priorityCore = require('./data/priority.js');
const cardCore = require('./data/card.js');
const { COMMAND_NAMES, MENU_LABELS } = require('./i18n/zh.js');
const { resolveMobilePdfTarget } = require('./platform/pdf.js');

const READER_TYPES = new Set(['source', 'extract', 'card']);

class MemoFlowPlugin extends BasePlugin {
  async onload() {
    await super.onload();

    this.registerView(VIEW_TYPE, leaf => new MemoFlowDashboardView(leaf, this));
    this.registerView(REVIEW_VIEW_TYPE, leaf => new MemoFlowReviewView(leaf, this));
    this.addRibbonIcon('layout-dashboard', 'MemoFlow：学习面板', () => this.openMemoFlow());
    this.addCommand({
      id: 'open-memoflow',
      name: '打开 MemoFlow 学习面板',
      callback: () => this.openMemoFlow(),
    });
    this.addCommand({
      id: 'memoflow-reading-actions',
      name: '当前阅读操作…',
      callback: () => this.openReadingActionMenu(),
    });
    this.addCommand({
      id: 'memoflow-timestamp-extract',
      name: '生成时间戳摘录（选中 / 剪贴板）',
      callback: () => this.createTimestampExtract({ fromSelection: true }),
    });
    this.addCommand({
      id: 'memoflow-create-card',
      name: '从当前摘录制卡',
      callback: () => this.openCardDialog(),
    });
    this.addCommand({
      id: 'memoflow-unified-review',
      name: '开始学习',
      callback: () => this.startLearning(),
    });
    this.addCommand({
      id: 'memoflow-card-review',
      name: '卡片复习',
      callback: () => this.openCardReview(),
    });
    this.addCommand({
      id: 'memoflow-clipboard-extract',
      name: '从剪贴板生成摘录',
      callback: () => this.clipboardExtract(),
    });
    this.addCommand({
      id: 'memoflow-refine-extract',
      name: '原位精简当前摘录',
      callback: () => this._getRefineController().refineActive(),
    });
    this.addCommand({
      id: 'memoflow-restore-refine',
      name: '恢复上次精简',
      callback: () => this._getRefineController().restoreActive(),
    });
    this.addCommand({
      id: 'memoflow-refine-history',
      name: '查看精简历史',
      callback: () => this.openRefineHistory(),
    });

    this._applyChineseCommandNames();

    this.registerEvent(this.app.workspace.on('file-open', () => this._syncReadingSurface()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this._syncReadingSurface()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this._syncReadingSurface()));
    this.app.workspace.onLayoutReady(() => this._syncReadingSurface());
  }

  addSettingTab(tab) {
    // Upstream registers its English settings tab inside super.onload().
    // Replace it with the Chinese tab, but let any later tab pass through.
    if (this.__mfChineseSettingsTab) return super.addSettingTab(tab);
    this.__mfChineseSettingsTab = true;
    return super.addSettingTab(new MemoFlowSettingTab(this.app, this));
  }

  isSpacedRepetitionReady() {
    // Upstream checks listCommands(), which hides srs-review-flashcards-in-note
    // unless a flashcard note is already active. For readiness we only need
    // both commands to exist; the command itself will validate the active note.
    const commands = this.app.commands?.commands || {};
    return Boolean(
      commands['obsidian-spaced-repetition:srs-review-flashcards']
      && commands['obsidian-spaced-repetition:srs-review-flashcards-in-note']
    );
  }

  reviewCards() {
    if (!this.isSpacedRepetitionReady()) {
      new Notice('需要先安装并启用 Spaced Repetition 才能复习卡片。');
      return;
    }
    return super.reviewCards();
  }

  async reviewCardsInNote(file = this.app.workspace.getActiveFile()) {
    if (!this.isSpacedRepetitionReady()) {
      new Notice('需要先安装并启用 Spaced Repetition 才能复习卡片。');
      return;
    }
    return super.reviewCardsInNote(file);
  }

  _applyChineseCommandNames() {
    const prefix = `${this.manifest.id}:`;
    const commands = this.app.commands?.commands;
    if (!commands) return;
    for (const [id, name] of Object.entries(COMMAND_NAMES)) {
      const command = commands[`${prefix}${id}`];
      if (command) command.name = name;
    }
    // Commands registered via addCommand() carry a "MemoFlow: " prefix; strip
    // it so the palette is consistent with the renamed upstream commands.
    for (const [id, command] of Object.entries(commands)) {
      if (!id.startsWith(prefix) || !command) continue;
      command.name = String(command.name || '').replace(/^MemoFlow:\s*/, '');
    }
  }

  captureOrCreate() {
    return this._runActionMenu(MENU_LABELS.captureTitle, [
      { label: MENU_LABELS.capture[0], run: () => this.newSource() },
      { label: MENU_LABELS.capture[1], run: () => this.importClipping() },
      { label: MENU_LABELS.capture[2], run: () => this.extractClipboard() },
      { label: MENU_LABELS.capture[3], run: () => this.flashcardImageName() },
      { label: MENU_LABELS.capture[4], run: () => this.imageExtractClipboard() },
      { label: MENU_LABELS.capture[5], run: () => this.occlusionCreate() },
    ]);
  }

  currentElementActions() {
    return this._runActionMenu(MENU_LABELS.currentTitle, [
      { label: MENU_LABELS.current[0], run: () => this.markDone() },
      { label: MENU_LABELS.current[1], run: () => this.resetCurrent() },
      { label: MENU_LABELS.current[2], run: () => this.dismiss() },
      { label: MENU_LABELS.current[3], run: () => this.postpone() },
      { label: MENU_LABELS.current[4], run: () => this.schedule() },
      { label: MENU_LABELS.current[5], run: () => this.setPriority() },
      { label: MENU_LABELS.current[6], run: () => this.boost() },
      { label: MENU_LABELS.current[7], run: () => this.openParent() },
      { label: MENU_LABELS.current[8], run: () => this.openPdf() },
      { label: MENU_LABELS.current[9], run: () => this.toggleReadPoint() },
      { label: MENU_LABELS.current[10], run: () => this.jumpToReadPoint() },
      { label: MENU_LABELS.current[11], run: () => this.addCheckpoint() },
    ]);
  }

  openToolkitView() {
    return this._runActionMenu(MENU_LABELS.toolkitTitle, [
      { label: MENU_LABELS.toolkit[0], run: () => this.openDashboard() },
      { label: MENU_LABELS.toolkit[1], run: () => this.openDashboard('stats') },
      { label: MENU_LABELS.toolkit[2], run: () => this._activateQueueView() },
      { label: MENU_LABELS.toolkit[3], run: () => this._activateKnowledgeTree() },
      { label: MENU_LABELS.toolkit[4], run: () => this._activateKnowledgeTreeSidebar() },
      { label: MENU_LABELS.toolkit[5], run: () => this.openUserGuide() },
    ]);
  }

  advancedTools() {
    return this._runActionMenu(MENU_LABELS.advancedTitle, [
      { label: MENU_LABELS.advanced[0], run: () => this.subsetReview() },
      { label: MENU_LABELS.advanced[1], run: () => this.mercy() },
      { label: MENU_LABELS.advanced[2], run: () => this.postponeSubtree() },
      { label: MENU_LABELS.advanced[3], run: () => this.splitArticle() },
      { label: MENU_LABELS.advanced[4], run: () => this.splitBook() },
      { label: MENU_LABELS.advanced[5], run: async () => { await this.createCategory(); this._refreshTreeViews(); } },
      { label: MENU_LABELS.advanced[6], run: async () => { await this.reparentActive(); this._refreshTreeViews(); } },
      { label: MENU_LABELS.advanced[7], run: () => this.seedInlineCards() },
      { label: MENU_LABELS.advanced[8], run: () => this.migrateLegacyCards() },
      { label: MENU_LABELS.advanced[9], run: () => this.performanceDiagnostics() },
    ]);
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE);
    this._closeReadingPopover?.();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view?.__mfReadingAction) {
        view.__mfReadingAction.remove?.();
        view.__mfReadingAction = null;
      }
      view?.contentEl?.querySelector(':scope > .mf-reading-bar')?.remove();
    }
    if (typeof super.onunload === 'function') await super.onunload();
  }

  async openMemoFlow() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  // Upstream commands and menus call this method; route them to the new page.
  async openDashboard(section = null) {
    const leaf = await this.openMemoFlow();
    if (section === 'stats' && leaf?.view?.scrollToSection) {
      leaf.view.scrollToSection('analytics');
    }
  }

  _pdfFileForSource(fm) {
    if (!fm) return null;
    for (const raw of [fm.pdf_vault_path, fm.pdf_path]) {
      if (!raw) continue;
      const clean = String(raw).replace(/^['"]|['"]$/g, '').split('#')[0].replace(/^\/+/, '');
      const file = this.app.vault.getAbstractFileByPath(clean);
      if (file instanceof TFile && file.extension === 'pdf') return file;
    }
    return null;
  }

  _findSourceForPdf(pdfFile) {
    if (!pdfFile || pdfFile.extension !== 'pdf') return null;
    return this.getIRRows().find(row => {
      if (row.fm?.type !== 'source') return false;
      const target = this._pdfFileForSource(row.fm);
      return target?.path === pdfFile.path;
    }) || null;
  }

  async openPdf() {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === 'pdf') {
      const source = this._findSourceForPdf(active);
      if (source) return this.openPdfForSource(source.tfile);
      new Notice('没有来源笔记链接到这个 PDF。');
      return;
    }
    if (active?.extension === 'md') return this.openPdfForSource(active);
    new Notice('请先打开来源笔记或对应的 PDF。');
  }

  async openPdfForSource(file) {
    if (!file) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== 'source') {
      new Notice('当前文件不是 Incremental Reading 来源笔记。');
      return;
    }
    const pdf = this._pdfFileForSource(fm);
    if (!pdf) {
      new Notice('Obsidian 原生 PDF 阅读器需要 Vault 内 PDF；请设置 pdf_vault_path。');
      return;
    }
    const page = Math.max(1, Number(fm.read_point) || 1);
    try {
      await this.app.workspace.openLinkText(`${pdf.path}#page=${page}`, file.path, false);
    } catch (error) {
      console.error('[MemoFlow] could not open native PDF', error);
      new Notice(`打开 PDF 失败：${error.message || '未知错误'}。确认 PDF 仍在 Vault 内，或检查 pdf_vault_path。`, 7000);
    }
  }

  // A restored sidebar leaf can outlive a plugin reload and be materialised as
  // a generic markdown view. Upstream assumes every ir-queue-view leaf is an
  // IRQueueView; guard that so session navigation is not blocked by a stale
  // layout entry.
  _flushDeferredCollectionRenders() {
    // Same intent as upstream, but every leaf is checked before calling its
    // view method. A restored sidebar leaf can be a generic view after a
    // plugin reload, and upstream's unguarded call would abort session
    // navigation before the first note opens.
    for (const leaf of this.app.workspace.getLeavesOfType('ir-queue-view')) {
      const view = leaf.view;
      if (view?.needsRowsRender && typeof view._scheduleRowsRender === 'function') {
        view._scheduleRowsRender('grade-complete');
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType('ir-main-dashboard')) {
      const view = leaf.view;
      if (view?.needsRender && typeof view._requestRender === 'function') view._requestRender();
    }
    for (const type of ['ir-tree-view', 'ir-tree-sidebar']) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (view?.needsRender && typeof view._requestBodyRender === 'function') view._requestBodyRender();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reading session bar / header action
  // ---------------------------------------------------------------------------

  _todayKey() {
    return dateCore.formatDate(new Date(), dateCore.normalizeDateFormat(this.settings?.misc?.date_format));
  }

  _sessionInfo(path) {
    const session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths)) return null;
    const index = session.paths.indexOf(path);
    if (index < 0) return null;
    const file = this._fileByPath(path);
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    return {
      index: index + 1,
      total: session.paths.length,
      type: session.types?.[path] || fm?.type || '',
    };
  }

  _fileByPath(path) {
    return path ? this.app.vault.getAbstractFileByPath(path) : null;
  }

  _nextSessionTarget(currentPath) {
    const session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths)) return null;
    const index = session.paths.indexOf(currentPath);
    if (index < 0) return null;
    for (let i = index + 1; i < session.paths.length; i++) {
      const path = session.paths[i];
      const file = this._fileByPath(path);
      if (!(file instanceof TFile)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return {
        file,
        type: session.types?.[path] || fm?.type || 'source',
        readPoint: Number(session.readPoints?.[path]) || Number(fm?.read_point_line) || 0,
      };
    }
    return null;
  }

  async _activateReadingFile(file) {
    const leaf = this.app.workspace.getLeavesOfType('markdown')
      .find(candidate => candidate.view?.file?.path === file.path);
    if (leaf) {
      if (typeof this.app.workspace.setActiveLeaf === 'function') {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      await new Promise(resolve => window.setTimeout(resolve, 0));
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    await new Promise(resolve => window.setTimeout(resolve, 0));
  }

  async _openLearningFile(file, type, readPointLine = 0) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.type === 'source' && this._pdfFileForSource(fm)) {
      await this.openPdfForSource(file);
      return;
    }
    const result = await super._openLearningFile(file, type, readPointLine);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const leaf = this.app.workspace.getLeavesOfType('markdown')
      .find(candidate => candidate.view?.file?.path === file.path);
    if (leaf) {
      if (typeof this.app.workspace.setActiveLeaf === 'function') {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      this.app.workspace.revealLeaf(leaf);
    }
    return result;
  }

  async _openNextSessionTarget(target) {
    if (!target) {
      new Notice('今日队列已清空。');
      return;
    }
    if (typeof this._openLearningFile === 'function') {
      await this._openLearningFile(target.file, target.type, target.readPoint);
    }
  }

  async _postponeReadingFile(file, days) {
    const fmt = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + days);
    const next = dateCore.formatDate(base, fmt);
    await this.app.fileManager.processFrontMatter(file, fmWriter => {
      fmWriter.next_review = next;
      fmWriter.interval = days;
    });
    new Notice(`已延后 ${days} 天 · 下次：${next}`);
  }

  _confirmDestructive(title, body, confirmText = '确认') {
    return new Promise(resolve => {
      new ConfirmActionModal(this.app, {
        title,
        body,
        confirmText,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      }).open();
    });
  }

  async _runReadingAction(action, file, data = {}) {
    if (!file) return;
    if (this.app.workspace.getActiveFile()?.extension !== 'pdf') {
      await this._activateReadingFile(file);
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !READER_TYPES.has(fm.type)) {
      new Notice('当前笔记不是 Incremental Reading 阅读项。');
      return;
    }
    const next = this._nextSessionTarget(file.path);
    try {
      switch (action) {
        case 'start-session':
          await this.buildSessionQueue({ openFirst: true });
          return;
        case 'review-card':
          if (fm.type === 'card') {
            if (typeof this.reviewCardsInNote === 'function') await this.reviewCardsInNote(file);
            else new Notice('卡片复习需要 Spaced Repetition 插件。');
          }
          return;
        case 'create-card':
          await this.openCardDialog(file);
          return;
        case 'refine-extract':
          if (fm.type !== 'extract') {
            new Notice('原位精简只支持 Extract。');
            return;
          }
          await this._getRefineController().refineActive();
          return;
        case 'refine-history':
          if (fm.type !== 'extract') {
            new Notice('精简历史只支持 Extract。');
            return;
          }
          await this.openRefineHistory();
          return;
        case 'clipboard-extract':
          await this.clipboardExtract(file);
          return;
        case 'priority':
          await this.openPriorityDialog(file);
          return;
        case 'open-pdf':
          await this.openPdfForSource(file);
          return;
        case 'complete':
          if (fm.type === 'card') {
            new Notice('卡片复习由 Spaced Repetition 管理；用「下一项」继续。');
            return;
          }
          if (fm.type === 'extract') {
            await this.markPathsDone([file.path], { confirm: false });
          } else {
            const graded = await this._gradeTopic(file, fm, this._todayKey());
            if (!graded) return;
          }
          await this._openNextSessionTarget(next);
          return;
        case 'skip':
          await this.nextElement();
          return;
        case 'postpone':
          await this._postponeReadingFile(file, Math.max(1, Number(data.days) || 1));
          await this.consumeSessionItem(file.path);
          await this._openNextSessionTarget(next);
          return;
        case 'dismiss':
          if (!(await this._confirmDestructive(
            '移出队列？',
            `「${file.basename}」会被标记为 dismissed，并从今日队列移除。笔记不会删除。`,
            '移出队列',
          ))) return;
          if (this.app.workspace.getActiveFile()?.path !== file.path) {
            await this.app.fileManager.processFrontMatter(file, fmw => { fmw.status = 'dismissed'; });
            new Notice('已移出队列。');
          } else {
            await this.dismiss();
          }
          await this.consumeSessionItem(file.path);
          await this._openNextSessionTarget(next);
          return;
        case 'mark-done':
          if (!(await this._confirmDestructive(
            '仅标记完成？',
            `「${file.basename}」会被标记为 done，并清除后续复习排期。笔记不会删除。`,
            '标记完成',
          ))) return;
          await this.markPathsDone([file.path], { confirm: false });
          await this._openNextSessionTarget(next);
          return;
        case 'dashboard':
          await this.openMemoFlow();
          return;
        default:
          return;
      }
    } catch (error) {
      console.error('[MemoFlow] reading action failed', action, error);
      new Notice(`${({ complete: '完成阅读', skip: '下一项', postpone: '延后', dismiss: '移出队列', 'mark-done': '标记完成', 'clipboard-extract': '剪贴摘录', 'create-card': '制卡', 'refine-extract': '原位精简', 'refine-history': '精简历史', priority: '设置优先级', 'open-pdf': '打开 PDF' })[action] || '操作'}失败：${error.message || '未知错误'}。可重试；仍失败时打开原笔记或重载 Obsidian。`, 8000);
    } finally {
      this._syncReadingSurface();
    }
  }

  async openReadingActionMenu(event, fileOverride = null) {
    const file = fileOverride || this.app.workspace.getActiveFile();
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    if (!file || !fm || !READER_TYPES.has(fm.type)) {
      new Notice('打开一个 Incremental Reading 阅读项后再试。');
      return;
    }
    this._openReadingPopover(event, file);
  }

  _closeReadingPopover() {
    if (this._mfReadingPopover) this._mfReadingPopover.remove();
    this._mfReadingPopover = null;
    if (this._mfPopClick) document.removeEventListener('click', this._mfPopClick, true);
    if (this._mfPopKey) document.removeEventListener('keydown', this._mfPopKey, true);
    this._mfPopClick = null;
    this._mfPopKey = null;
  }

  _openReadingPopover(event, file, { delayOnly = false } = {}) {
    this._closeReadingPopover();
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    if (!file || !fm || !READER_TYPES.has(fm.type)) return;
    const session = this._sessionInfo(file.path);
    const popover = document.createElement('div');
    popover.className = 'mf-reading-popover';
    popover.setAttribute('role', 'menu');

    const add = (label, action, data = null, className = '') => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `mf-reading-popover-item${className ? ` ${className}` : ''}`;
      item.textContent = label;
      item.addEventListener('click', clickEvent => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        this._closeReadingPopover();
        this._runReadingAction(action, file, data || {});
      });
      popover.appendChild(item);
    };
    const separator = () => {
      const line = document.createElement('div');
      line.className = 'mf-reading-popover-sep';
      popover.appendChild(line);
    };

    if (delayOnly) {
      add('延后 1 天', 'postpone', { days: 1 });
      add('延后 3 天', 'postpone', { days: 3 });
      add('延后 7 天', 'postpone', { days: 7 });
    } else if (fm.type === 'card') {
      if (session) add('下一项', 'skip', null, 'is-primary');
      else add('开始今日学习', 'start-session', null, 'is-primary');
      add('复习此卡', 'review-card');
      separator();
      add('打开 MemoFlow 总览', 'dashboard');
    } else {
      if (session) {
        add(fm.type === 'extract' ? '完成并下一项' : '评阅并下一项', 'complete', null, 'is-primary');
        add('跳过（保留在队列）', 'skip');
      } else {
        add('开始今日学习', 'start-session', null, 'is-primary');
      }
      if (this.app.workspace.getActiveFile()?.extension !== 'pdf') {
        add('从当前摘录制卡', 'create-card');
      }
      if (fm.type === 'extract') {
        add('原位精简…', 'refine-extract');
        add('查看精简历史…', 'refine-history');
      }
      separator();
      add('设置优先级…', 'priority');
      if (fm.type === 'source' && (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path)) {
        add('打开 PDF 阅读点', 'open-pdf');
      }
      add('延后 1 天', 'postpone', { days: 1 });
      add('延后 3 天', 'postpone', { days: 3 });
      add('延后 7 天', 'postpone', { days: 7 });
      add('移出队列', 'dismiss');
      add('仅标记完成', 'mark-done');
      separator();
      add('打开 MemoFlow 总览', 'dashboard');
    }

    document.body.appendChild(popover);
    const target = event?.currentTarget || event?.target;
    const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
    const width = popover.offsetWidth || 200;
    const height = popover.offsetHeight || 0;
    const x = rect ? rect.left : Math.max(16, window.innerWidth / 2 - width / 2);
    const y = rect ? rect.bottom + 6 : 120;
    popover.style.left = `${Math.min(Math.max(8, x), window.innerWidth - width - 8)}px`;
    popover.style.top = `${Math.min(Math.max(8, y), window.innerHeight - height - 8)}px`;
    this._mfReadingPopover = popover;
    const closeOnClick = clickEvent => {
      if (!popover.contains(clickEvent.target)) this._closeReadingPopover();
    };
    const closeOnKey = keyEvent => {
      if (keyEvent.key === 'Escape') this._closeReadingPopover();
    };
    this._mfPopClick = closeOnClick;
    this._mfPopKey = closeOnKey;
    window.setTimeout(() => {
      if (!this._mfReadingPopover) return;
      document.addEventListener('click', closeOnClick, true);
      document.addEventListener('keydown', closeOnKey, true);
    }, 0);
  }

  _buildReadingBar(file, fm, info) {
    const bar = document.createElement('div');
    bar.className = 'mf-reading-bar';
    bar.dataset.path = file.path;
    bar.dataset.session = `${info.index}/${info.total}`;

    const main = document.createElement('div');
    main.className = 'mf-rb-main';
    const dot = document.createElement('span');
    dot.className = 'mf-rb-dot';
    const label = document.createElement('span');
    label.className = 'mf-rb-label';
    label.textContent = `今日队列 · ${info.index} / ${info.total}`;
    const sep = document.createElement('span');
    sep.className = 'mf-rb-sep';
    const type = document.createElement('span');
    type.className = 'mf-rb-type mf-stage';
    type.textContent = fm.type === 'source' ? '阅读' : (fm.type === 'card' ? '卡片' : '摘录');
    const hint = document.createElement('span');
    hint.className = 'mf-rb-hint';
    hint.textContent = fm.type === 'card'
      ? '卡片由 Spaced Repetition 评分，完成后点下一项'
      : (fm.type === 'extract' ? '处理完就完成并进入下一项' : '读到这里就评阅并进入下一项');
    main.append(dot, label, sep, type, hint);

    if (fm.type !== 'card') {
      const priority = document.createElement('button');
      priority.type = 'button';
      priority.className = 'mf-rb-priority';
      priority.textContent = `P${priorityCore.normalizePriority(fm.priority)}`;
      priority.title = '设置优先级';
      priority.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this.openPriorityDialog(file);
      });
      main.appendChild(priority);
    }

    if (fm.type === 'source' && (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path)) {
      const page = document.createElement('button');
      page.type = 'button';
      page.className = 'mf-rb-page';
      const current = Number(fm.read_point) || 1;
      page.textContent = `p.${current}${fm.total_pages ? ` / ${fm.total_pages}` : ''}`;
      page.title = '打开 PDF 阅读点';
      page.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this.openPdfForSource(file);
      });
      main.appendChild(page);
    }

    const actions = document.createElement('div');
    actions.className = 'mf-rb-actions';

    const addButton = (text, action = null, variant = '', data = null) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mf-rb-btn${variant ? ` ${variant}` : ''}`;
      button.textContent = text;
      if (action) {
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          this._runReadingAction(action, file, data || {});
        });
      }
      actions.appendChild(button);
      return button;
    };

    if (fm.type === 'card') {
      addButton('下一项', 'skip', 'is-primary');
      addButton('复习此卡', 'review-card');
      const cardDisabled = (text, title) => {
        const button = addButton(text);
        button.disabled = true;
        button.classList.add('is-disabled');
        button.title = title;
      };
      cardDisabled('制卡', '问答卡片不适用；请在摘录/来源中制卡');
      cardDisabled('完成', '问答卡片由 Spaced Repetition 评分');
    } else {
      addButton(fm.type === 'extract' ? '完成并下一项' : '评阅并下一项', 'complete', 'is-primary');
      addButton('跳过', 'skip');
      addButton('制卡', 'create-card');
      if (fm.type === 'extract') addButton('精简', 'refine-extract');
      const postpone = addButton('延后');
      postpone.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        this._openReadingPopover(event, file, { delayOnly: true });
      });
      addButton('移出队列', 'dismiss', 'is-subtle');
    }

    bar.append(main, actions);
    return bar;
  }

  _syncReadingSurface() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        const contentEl = view?.contentEl;
        const file = view?.file;
        if (!contentEl || !(file instanceof TFile)) continue;
        const existing = contentEl.querySelector(':scope > .mf-reading-bar');
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const info = fm && READER_TYPES.has(fm.type) ? this._sessionInfo(file.path) : null;
        if (!info) {
          existing?.remove();
          continue;
        }
        existing?.remove();
        contentEl.prepend(this._buildReadingBar(file, fm, info));
      }
      this._syncReadingHeaderActions();
      this._syncPdfHeaderActions();
    } catch (error) {
      console.error('[MemoFlow] could not sync reading surface', error);
    }
  }

  _syncReadingHeaderActions() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf.view;
        if (!view || typeof view.addAction !== 'function') continue;
        const fm = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : null;
        const isTopic = Boolean(fm && READER_TYPES.has(fm.type));
        if (isTopic && !view.__mfReadingAction) {
          view.__mfReadingAction = view.addAction('list-checks', 'MemoFlow 阅读操作', event => this.openReadingActionMenu(event));
        } else if (!isTopic && view.__mfReadingAction) {
          view.__mfReadingAction.remove?.();
          view.__mfReadingAction = null;
        }
      }
    } catch (error) {
      console.error('[MemoFlow] could not sync reading header action', error);
    }
  }

  _syncPdfHeaderActions() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('pdf')) {
        const view = leaf.view;
        const contentEl = view?.contentEl;
        const pdfFile = view?.file;
        if (!contentEl || !pdfFile || pdfFile.extension !== 'pdf') continue;
        contentEl.querySelector(':scope > .mf-pdf-bar')?.remove();
        const source = this._findSourceForPdf(pdfFile);
        if (!source) continue;
        const bar = this._buildPdfActionBar(view, source.tfile, source.fm);
        const toolbar = contentEl.querySelector(':scope > .pdf-toolbar');
        contentEl.insertBefore(bar, toolbar?.nextSibling || contentEl.firstChild);
      }
    } catch (error) {
      console.error('[MemoFlow] could not sync PDF reading actions', error);
    }
  }

  _buildPdfActionBar(view, file, fm) {
    const bar = document.createElement('div');
    bar.className = 'mf-pdf-bar';
    bar.dataset.path = file.path;
    const stage = document.createElement('span');
    stage.className = 'mf-pdf-stage mf-stage';
    stage.textContent = '阅读';
    bar.appendChild(stage);

    const addButton = (label, action, { primary = false, disabled = false, title = '' } = {}) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `mf-pdf-btn${primary ? ' is-primary' : ''}`;
      button.textContent = label;
      if (title) button.title = title;
      button.disabled = disabled;
      if (!disabled) {
        button.addEventListener('click', event => {
          if (action === 'more') this.openReadingActionMenu(event, file);
          else this._runReadingAction(action, file);
        });
      }
      bar.appendChild(button);
      return button;
    };

    addButton('剪贴摘录', 'clipboard-extract', {
      title: '复制 PDF 文字后，在后台生成摘录（平板 fallback）',
    });
    addButton('制卡', 'create-card', {
      disabled: true,
      title: '阅读 PDF 阶段先剪贴摘录；有摘录后再制卡',
    });
    addButton(fm.type === 'extract' ? '完成并下一项' : '完成阅读', 'complete', { primary: true });
    addButton('下一项', 'skip');
    addButton('更多', 'more');
    return bar;
  }


  _activePdfPageNumber(sourceFile = null) {
    let pdfPath = null;
    if (sourceFile) {
      const fm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
      pdfPath = this._pdfFileForSource(fm)?.path || null;
    } else {
      const active = this.app.workspace.getActiveFile();
      if (active?.extension === 'pdf') pdfPath = active.path;
    }
    if (!pdfPath) return null;
    const view = this.app.workspace.getLeavesOfType('pdf')
      .map(leaf => leaf.view)
      .find(candidate => candidate?.file?.path === pdfPath);
    return pdfPage.currentPageNumber(view);
  }

  async clipboardExtract(sourceFile = null) {
    const pageFallback = this._activePdfPageNumber(sourceFile);
    const created = await this.createTimestampExtract({ sourceFile, pageFallback, fromSelection: false, open: false });
    if (created) this._promptOpenExtract(created);
    return created;
  }

  _promptOpenExtract(file) {
    new ExtractOpenModal(this.app, {
      file,
      onOpenFile: async target => {
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(target);
      },
    }).open();
  }


  async buildSubsetSession(paths, { openFirst = true, label = '筛选' } = {}) {
    const queue = [];
    const seen = new Set();
    for (const path of Array.isArray(paths) ? paths : []) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const tfile = this.app.vault.getAbstractFileByPath(path);
      if (!(tfile instanceof TFile)) continue;
      const fm = this.app.metadataCache.getFileCache(tfile)?.frontmatter;
      if (!fm || (fm.type !== 'source' && fm.type !== 'extract' && fm.type !== 'card')) continue;
      queue.push({ tfile, fm });
    }
    if (!queue.length) {
      new Notice('筛选结果里没有可复习的阅读项。');
      return;
    }
    await this.persistSessionSnapshot(queue);
    this._markCollectionViewsStale();
    this._flushDeferredCollectionRenders();
    new Notice(`已建立「${label}」复习会话 · ${queue.length} 项`, 6000);
    if (openFirst) await this.nextElement({ fromStart: true });
  }

  async buildSessionQueue(options = {}) {
    await this._maybeAutoOverload();
    return super.buildSessionQueue(options);
  }

  async _maybeAutoOverload() {
    if (!this.settings?.misc?.auto_overload) return;
    const threshold = Math.max(1, Number(this.settings.misc.overload_threshold) || 10);
    const overdue = this._overdueTopics();
    if (overdue.length <= threshold) return;
    await this.spreadOverdue(overdue, 7);
    new Notice(`自动过载：${overdue.length} 个逾期主题已按 7 天摊平。`, 7000);
  }

  openUserGuide() {
    new MemoFlowUserGuideModal(this.app).open();
  }

  async _openReviewView(mode, paths) {
    const leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (leaf?.view?.configure) {
      await leaf.view.configure({ mode, paths });
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    this._reviewConfig = { mode, paths };
    const nextLeaf = this.app.workspace.getLeaf('tab');
    await nextLeaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(nextLeaf);
  }

  async startLearning() {
    await this.buildSessionQueue({ openFirst: true });
  }

  async openUnifiedReview() {
    let session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths) || !session.paths.length) {
      await this.buildSessionQueue({ openFirst: false });
      session = this.settings?.session;
      if (!session || !Array.isArray(session.paths) || !session.paths.length) return;
    }
    await this._openReviewView('learn', session.paths.slice());
  }

  async openCardReview() {
    if (!this.isSpacedRepetitionReady()) {
      new Notice('需要先安装并启用 Spaced Repetition 才能复习卡片。');
      return;
    }
    const pool = await this.buildDuePool({ skipCurrent: false });
    let paths = pool
      .filter(item => item.fm?.type === 'card' && item.tfile)
      .map(item => item.tfile.path);
    if (!paths.length) {
      // Card review should work even when the mixed reading queue has cards
      // disabled; fall back to the card rows themselves.
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const rows = this.getIRRows()
        .filter(row => row.fm?.type === 'card' && row.tfile && row.fm.status !== 'done' && row.fm.status !== 'dismissed')
        .slice(0, 500);
      const due = await Promise.all(rows.map(async row => {
        try { return await this._cardIsDue(row.tfile, today); } catch { return false; }
      }));
      paths = rows.filter((row, index) => due[index]).map(row => row.tfile.path);
    }
    if (!paths.length) {
      new Notice('今天没有到期卡片。');
      return;
    }
    await this._openReviewView('cards', paths);
  }

  async openPriorityDialog(file = this.app.workspace.getActiveFile(), { onApplied = null } = {}) {
    if (!file || file.extension !== 'md') {
      new Notice('请先打开来源或摘录笔记。');
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract')) {
      new Notice('只能给来源或摘录设置优先级。');
      return;
    }
    const current = priorityCore.normalizePriority(fm.priority);
    new MemoFlowPriorityModal(this.app, {
      file,
      current,
      onApply: async result => {
        const original = priorityCore.normalizePriority(fm.priority);
        const next = result.boost
          ? priorityCore.boostPriority(original, result.boost)
          : priorityCore.normalizePriority(result.priority, original);
        if (next === original) {
          new Notice(`优先级保持 P${original}。`);
          return;
        }
        await this.app.fileManager.processFrontMatter(file, fmw => {
          if (result.boost && fmw.boost_from == null) fmw.boost_from = original;
          fmw.priority = next;
        });
        // metadataCache may still hold the old frontmatter object for a tick;
        // mutate it so the visible chip updates immediately.
        fm.priority = next;
        new Notice(`优先级 P${original} → P${next}`);
        if (typeof this._invalidateIRCollection === 'function') this._invalidateIRCollection(true);
        await this._syncReadingSurface();
        await onApplied?.();
      },
    }).open();
  }

  _overdueTopics() {
    const format = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.getIRRows().filter(row => {
      const fm = row.fm;
      if (!fm || fm.type === 'card') return false;
      if (fm.status === 'done' || fm.status === 'container' || fm.status === 'dismissed' || fm.status === 'inbox') return false;
      const date = dateCore.parseDate(fm.next_review, format);
      return Boolean(date && date < today);
    });
  }

  async openOverloadDialog() {
    const overdue = this._overdueTopics();
    if (!overdue.length) {
      new Notice('当前没有逾期阅读主题。');
      return;
    }
    new MemoFlowOverloadModal(this.app, {
      overdueCount: overdue.length,
      onChoose: days => this.spreadOverdue(overdue, days),
    }).open();
  }

  async spreadOverdue(overdueRows, days) {
    const format = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = overdueRows
      .slice()
      .sort((a, b) => {
        const pa = Number(a.fm.priority) || 50;
        const pb = Number(b.fm.priority) || 50;
        if (pa !== pb) return pa - pb;
        return String(a.fm.next_review || '').localeCompare(String(b.fm.next_review || ''));
      });
    let updated = 0;
    for (let rank = 0; rank < rows.length; rank++) {
      const offset = Math.floor((rank * days) / rows.length);
      const date = new Date(today.getTime());
      date.setDate(date.getDate() + offset);
      const nextReview = dateCore.formatDate(date, format);
      await this.app.fileManager.processFrontMatter(rows[rank].tfile, fmw => {
        fmw.next_review = nextReview;
        fmw.interval = Math.max(1, offset);
      });
      updated++;
    }
    new Notice(`Mercy：${updated} 个逾期主题摊平到未来 ${days} 天。`, 7000);
    if (typeof this._invalidateIRCollection === 'function') this._invalidateIRCollection(true);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      await leaf.view?.refresh?.();
    }
  }

  async openCardDialog(file = this.app.workspace.getActiveFile()) {
    if (!file || file.extension !== 'md') {
      new Notice('请先打开来源或摘录笔记再制卡。');
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract')) {
      new Notice('只能从来源或摘录制卡。');
      return;
    }
    const body = await this.app.vault.cachedRead(file).catch(() => '');
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = activeView?.file?.path === file.path
      ? (activeView.editor?.getSelection?.() || '')
      : '';
    const prefill = { question: cardCore.buildCardPrefill(body, selection, 400), answer: '' };
    new MemoFlowCardModal(this.app, {
      parentFile: file,
      prefill,
      onSubmit: async value => {
        const created = await this._createSpacedRepetitionCard(file, {
          format: value.format,
          question: value.question,
          answer: value.answer,
        });
        const srReady = this.isSpacedRepetitionReady();
        new Notice(`卡片已创建：${created.name}${srReady ? '' : '（启用 Spaced Repetition 后才能复习）'}`, 6000);
        if (typeof this._invalidateIRCollection === 'function') this._invalidateIRCollection(true);
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(created.file);
        await this._syncReadingSurface();
      },
    }).open();
  }

  // ---------------------------------------------------------------------------
  // Timestamped extract with a citation back to the PDF page
  // ---------------------------------------------------------------------------

  _hierarchyRows() {
    try {
      return this.getIRRows();
    } catch (error) {
      return [];
    }
  }

  _isUniqueIRBasename(name) {
    const key = String(name || '').toLowerCase();
    if (!key) return false;
    return this._hierarchyRows().filter(row => row.tfile.basename.toLowerCase() === key).length === 1;
  }

  // Follow source links from an Extract to the original root Source.
  // Old data may store the direct parent in `source`, so this walks the chain.
  _resolveTopicRoot(file, fm, seen = new Set(), depth = 0) {
    if (!file || !fm || depth > 64) return null;
    if (fm.type === 'source') return { file, fm };
    if (fm.type !== 'extract') return null;
    if (seen.has(file.path)) return null;
    const nextSeen = new Set(seen);
    nextSeen.add(file.path);
    const name = treeCore.linkTargetName(fm.source) || treeCore.linkTargetName(fm.parent);
    if (!name) return null;
    const matches = this._hierarchyRows().filter(row => row.tfile.basename.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) return null;
    return this._resolveTopicRoot(matches[0].tfile, matches[0].fm, nextSeen, depth + 1);
  }

  // Resolve the current direct parent and the original root without changing
  // how existing priority/A-Factor/interval writes are calculated.
  _resolveExtractContext({ active = null, sourceFile = null } = {}) {
    const candidate = sourceFile || active;
    if (!candidate) return null;
    if (candidate.extension === 'pdf') {
      const source = this._resolveExtractSource(active);
      return source ? { direct: source, root: source } : null;
    }
    if (candidate.extension !== 'md') return null;
    const fm = this.app.metadataCache.getFileCache(candidate)?.frontmatter;
    if (!fm || (fm.type !== 'source' && fm.type !== 'extract')) return null;
    const direct = { file: candidate, fm };
    const root = fm.type === 'source' ? direct : this._resolveTopicRoot(candidate, fm);
    if (!root || root.fm.type !== 'source') return null;
    if (!this._isUniqueIRBasename(direct.file.basename) || !this._isUniqueIRBasename(root.file.basename)) return null;
    return { direct, root };
  }

  _resolveExtractSource(active) {
    if (!active) return null;
    if (active.extension === 'md') {
      const fm = this.app.metadataCache.getFileCache(active)?.frontmatter;
      if (fm?.type === 'source') return { file: active, fm };
      if (fm?.type === 'extract') {
        const link = String(fm.source || fm.parent || '');
        const name = link.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim();
        const dest = name ? this.app.metadataCache.getFirstLinkpathDest(name, active.path) : null;
        if (dest instanceof TFile) {
          const destFm = this.app.metadataCache.getFileCache(dest)?.frontmatter;
          if (destFm?.type === 'source') return { file: dest, fm: destFm };
        }
      }
      return null;
    }
    if (active.extension === 'pdf') {
      for (const row of this.getIRRows()) {
        const fm = row.fm;
        if (!fm || fm.type !== 'source') continue;
        const candidates = [fm.pdf_vault_path, fm.pdf_path]
          .filter(Boolean)
          .map(value => String(value).replace(/^\/+/, '').split('#')[0]);
        if (candidates.some(path => path === active.path || active.path.endsWith('/' + path))) {
          return { file: row.tfile, fm };
        }
      }
    }
    return null;
  }

  _getRefineStore() {
    if (!this._refineStore) {
      this._refineStore = new RefineHistoryStore({ adapter: this.app.vault.adapter });
    }
    return this._refineStore;
  }

  async openRefineHistory() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file || this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('请先打开一个 Markdown 摘录。');
      return;
    }
    try {
      const disk = await this.app.vault.read(file);
      const currentContent = view?.editor?.getValue?.() ?? disk;
      const currentDirty = view?.editor ? currentContent !== disk : false;
      let model = null;
      let error = null;
      try {
        const entries = await this._getRefineStore().listEntries(file.path);
        model = buildHistoryView({
          entries,
          currentContent,
          currentPath: file.path,
          currentDirty,
        });
      } catch (readError) {
        error = readError;
        model = buildHistoryView({
          entries: [],
          currentContent,
          currentPath: file.path,
          currentDirty,
        });
      }
      let modal = null;
      modal = new RefineHistoryModal(this.app, {
        path: file.path,
        model,
        error,
        onRestore: target => this._restoreHistoryTarget(target, modal),
      });
      modal.open();
    } catch (error) {
      new Notice(`无法打开精简历史：${error.message || '未知错误'}。笔记未修改。`, 8000);
    }
  }

  async _restoreHistoryTarget(target, modal) {
    if (!target) return null;
    const result = await this._getRefineController().restoreVersion({
      targetOperationId: target.operationId,
      targetSide: target.side,
    });
    if (result && result.operationId) {
      modal?.close?.();
      await this.openRefineHistory();
    }
    return result;
  }

  _getRefineController() {
    if (!this._refineController) {
      this._refineStore = this._getRefineStore();
      this._refineController = new RefineEditorController({
        app: this.app,
        store: this._refineStore,
        settings: this.settings,
        notice: (message, duration) => new Notice(message, duration),
        getActiveView: () => this.app.workspace.getActiveViewOfType(MarkdownView),
        promptPreview: options => new Promise(resolve => {
          new RefinePreviewModal(this.app, options).open().then(resolve);
        }),
        promptRestore: options => new Promise(resolve => {
          const current = String(options.currentBody || '').slice(0, 500);
          const restored = String(options.restoredBody || '').slice(0, 500);
          new ConfirmActionModal(this.app, {
            title: '恢复上次精简？',
            body: `当前正文：\n${current}\n\n将恢复为：\n${restored}\n\nFrontmatter、parent/source 和调度数据不会修改。`,
            confirmText: '恢复',
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }).open();
        }),
        promptVersionRestore: options => new Promise(resolve => {
          new RefineRestoreModal(this.app, {
            ...options,
            targetCreatedAt: options.targetCreatedAt ? formatTime(options.targetCreatedAt) : '',
            onConfirm: () => resolve(true),
            onCancel: () => resolve(false),
          }).open();
        }),
      });
    }
    return this._refineController;
  }

  _selectionOrClipboard(fromSelection) {
    if (fromSelection) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selected = view?.editor?.getSelection?.() || '';
      if (selected.trim()) return selected.trim();
    }
    return null;
  }

  async _ensureVaultFolder(folder) {
    if (this._fileByPath(folder)) return;
    const parts = String(folder).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this._fileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!this._fileByPath(current)) throw error;
        }
      }
    }
  }

  async createTimestampExtract({ fromSelection = true, text = null, sourceFile = null, page = null, pageFallback = null, open = true } = {}) {
    const active = this.app.workspace.getActiveFile();
    const context = this._resolveExtractContext({ active, sourceFile });
    if (!context) {
      new Notice('请先打开 Incremental Reading 来源或摘录，或对应的 PDF。');
      return null;
    }
    const direct = context.direct;
    const root = context.root;
    // Preserve the existing 0.1 scheduling write target per entry point:
    // active extract -> root; explicit sourceFile -> that file.
    const scheduling = sourceFile ? direct : root;
    const parentTitle = direct.fm.type === 'extract' ? direct.file.basename : null;
    let body = text != null ? String(text) : this._selectionOrClipboard(fromSelection);
    if (!body) {
      try {
        body = (await navigator.clipboard.readText()).trim();
      } catch (error) {
        new Notice('无法读取剪贴板。');
        return null;
      }
    }
    body = String(body || '').trim();
    if (!body) {
      new Notice('剪贴板为空，也没有选中文字。');
      return null;
    }

    const parsed = extractCore.parsePdfSelection(body);
    let pdfPath = null;
    if (parsed.target && this._fileByPath(parsed.target)) pdfPath = parsed.target;
    if (!pdfPath) {
      for (const candidate of [root.fm.pdf_vault_path, root.fm.pdf_path]) {
        const path = candidate ? String(candidate).replace(/^\/+/, '').split('#')[0] : '';
        if (path && this._fileByPath(path)) {
          pdfPath = path;
          break;
        }
      }
    }
    const resolvedPage = Number(page) > 0
      ? Number(page)
      : parsed.page
        || (Number(pageFallback) > 0 ? Number(pageFallback) : null)
        || (Number(root.fm.read_point) > 0 ? Number(root.fm.read_point) : null);
    const citation = extractCore.buildCitation({
      sourceTitle: root.file.basename,
      pdfPath,
      page: resolvedPage,
      params: parsed.params,
    });

    const folder = this.extractsFolder();
    await this._ensureVaultFolder(folder);
    const baseTitle = extractCore.timestampTitle(new Date());
    let name = baseTitle;
    let suffix = 1;
    const usedNames = new Set(this._hierarchyRows().map(row => row.tfile.basename.toLowerCase()));
    while (this._fileByPath(`${folder}/${name}.md`) || usedNames.has(name.toLowerCase())) {
      name = `${baseTitle} ${++suffix}`;
    }
    const path = `${folder}/${name}.md`;

    const priority = Math.min(100, Math.max(1, Number(scheduling.fm.priority) || 50));
    const interval = Math.max(1, Math.ceil(priority * 0.15));
    const fmt = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const nextDate = new Date();
    nextDate.setHours(0, 0, 0, 0);
    nextDate.setDate(nextDate.getDate() + interval);
    const content = extractCore.buildExtractContent({
      sourceTitle: root.file.basename,
      parentTitle,
      body,
      priority,
      interval,
      nextReview: dateCore.formatDate(nextDate, fmt),
      dateAdded: this._todayKey(),
      page: resolvedPage,
      citation,
    });

    let created;
    try {
      created = await this.app.vault.create(path, content);
    } catch (error) {
      console.error('[MemoFlow] could not create timestamp extract', error);
      new Notice(`生成摘录失败：${error.message || '未知错误'}。请检查 Vault 写入权限和摘录文件夹。`, 7000);
      return null;
    }

    let bumpFailed = null;
    try {
      await this.app.fileManager.processFrontMatter(scheduling.file, fmWriter => {
        const current = Number(fmWriter.priority) || 50;
        fmWriter.priority = Math.min(100, current + 1);
      });
      if (typeof this._bumpAFactor === 'function') {
        await this._bumpAFactor(scheduling.file, scheduling.fm, this.settings?.scheduling?.extract_bump || 1.05);
      }
    } catch (error) {
      bumpFailed = error;
      console.error('[MemoFlow] extract created, but parent bump failed', error);
      new Notice(`摘录已创建：${name}，但父级 priority/A-Factor 更新失败：${error.message || '未知错误'}。笔记已保留。`, 9000);
    }

    if (typeof this._invalidateIRCollection === 'function') this._invalidateIRCollection(true);
    new Notice(`已生成摘录：${name}${resolvedPage ? ` · p.${resolvedPage}` : ''}${bumpFailed ? ' · 父级更新失败，笔记已保留' : ''}`);

    if (open) {
      try {
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.openFile(created);
      } catch (error) {
        console.error('[MemoFlow] could not open timestamp extract', error);
      }
    }
    return created;
  }
}

module.exports = MemoFlowPlugin;
