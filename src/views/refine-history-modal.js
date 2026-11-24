'use strict';

const { Modal } = require('obsidian');
const { diffLines, diffStats } = require('../data/refine-diff.js');

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return date.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusText(status) {
  return {
    prepared: '准备中',
    applied: '已应用',
    verified: '已验证',
    restored: '已恢复',
    failed: '失败',
    conflict: '冲突',
  }[status] || String(status || '未知');
}

function statusTone(status) {
  if (status === 'verified' || status === 'restored') return 'ok';
  if (status === 'failed' || status === 'conflict') return 'danger';
  return 'warn';
}

class RefineHistoryModal extends Modal {
  constructor(app, { path = '', model = null, error = null } = {}) {
    super(app);
    this.path = path;
    this.model = model;
    this.error = error;
    this.baseId = model?.current?.id || 'current';
    this.targetId = model?.events?.length
      ? model.events[model.events.length - 1].after.id
      : (model?.current?.id || 'current');
    this._baseSelect = null;
    this._targetSelect = null;
    this._preview = null;
    this._diff = null;
    this._summary = null;
  }

  onOpen() {
    this.titleEl.setText('精简历史');
    this.modalEl.addClass('mf-refine-history-host');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-refine-history');

    const head = contentEl.createDiv({ cls: 'mf-refine-history-head' });
    const copy = head.createDiv({ cls: 'mf-refine-history-head-copy' });
    copy.createDiv({ cls: 'mf-refine-eyebrow', text: 'EXTRACT · 精简历史' });
    copy.createDiv({ cls: 'mf-refine-history-path', text: this.path });
    if (this.model) {
      copy.createDiv({
        cls: 'mf-refine-history-meta',
        text: `${this.model.count} 次操作 · 约 ${this._sizeLabel(this.model.historyBytes)}`,
      });
    }
    head.createDiv({ cls: 'mf-refine-badge', text: '只读' });

    if (this.error) {
      const err = contentEl.createDiv({ cls: 'mf-refine-error', attr: { role: 'alert' } });
      err.createEl('strong', { text: '历史不可用' });
      err.createSpan({ text: ` ${this.error.message || this.error.code || '无法读取历史。'} 当前正文未修改；未伪造历史内容。` });
      return;
    }

    if (this.model?.unresolved) {
      contentEl.createDiv({
        cls: 'mf-refine-history-alert',
        text: `有 ${this.model.unresolved} 条历史未完成（prepared/applied/failed/conflict）。仍可只读查看已核验内容；本版本不提供恢复或自动修复。`,
      });
    }
    if (this.model?.softLimitExceeded) {
      contentEl.createDiv({
        cls: 'mf-refine-history-capacity',
        text: `历史已达 ${this.model.count} 条，超过 20 条软限制。不会自动清理；建议备份或后续手动整理。`,
      });
    }

    const body = contentEl.createDiv({ cls: 'mf-refine-history-body' });
    const list = body.createDiv({ cls: 'mf-refine-history-list' });
    const currentRow = list.createDiv({ cls: 'mf-refine-history-row is-current is-selected' });
    currentRow.createSpan({ cls: 'mf-refine-history-index', text: '●' });
    const currentCopy = currentRow.createDiv({ cls: 'mf-refine-history-row-copy' });
    currentCopy.createDiv({ cls: 'mf-refine-history-row-title', text: '当前正文' });
    currentCopy.createDiv({
      cls: 'mf-refine-history-row-meta',
      text: this.model.current.dirty ? 'Editor 未保存 · 历史只读' : '与磁盘一致',
    });
    currentRow.addEventListener('click', () => {
      this.baseId = this.model.current.id;
      this.targetId = this.model.current.id;
      this._syncSelects();
      this._render();
      this._setSelectedRow(currentRow);
    });

    if (!this.model.events.length) {
      const empty = list.createDiv({ cls: 'mf-refine-history-empty' });
      empty.createDiv({ cls: 'mf-refine-history-empty-title', text: '还没有精简历史' });
      empty.createDiv({
        cls: 'mf-refine-history-empty-text',
        text: '在 Extract 中执行一次原位精简后，这里会显示可回看的事件与正文快照。若笔记曾重命名/移动，历史可能仍关联旧路径；系统不会自动猜测。',
      });
    }
    for (const event of [...this.model.events].reverse()) {
      const row = list.createDiv({ cls: `mf-refine-history-row ${event.typeCode === 'restore' ? 'is-restore' : ''}` });
      row.createSpan({ cls: 'mf-refine-history-index', text: String(event.index).padStart(2, '0') });
      const rowCopy = row.createDiv({ cls: 'mf-refine-history-row-copy' });
      const rowTitle = rowCopy.createDiv({ cls: 'mf-refine-history-row-title' });
      rowTitle.createDiv({ cls: 'mf-refine-history-row-label', text: event.type });
      const pill = rowTitle.createSpan({ cls: `mf-history-pill is-${statusTone(event.status)}`, text: statusText(event.status) });
      rowCopy.createDiv({
        cls: 'mf-refine-history-row-meta',
        text: `${formatTime(event.createdAt)} · ${event.before.text.length}→${event.after.text.length} 字`,
      });
      row.addEventListener('click', () => {
        this.baseId = this.model.current.id;
        this.targetId = event.after.id;
        this._syncSelects();
        this._render();
        this._setSelectedRow(row);
      });
    }

    const main = body.createDiv({ cls: 'mf-refine-history-main' });
    const tools = main.createDiv({ cls: 'mf-refine-history-tools' });
    const baseWrap = tools.createDiv({ cls: 'mf-refine-history-select-wrap' });
    baseWrap.createEl('label', { text: '基准', attr: { for: 'mf-history-base' } });
    this._baseSelect = baseWrap.createEl('select', { cls: 'mf-refine-history-select', attr: { id: 'mf-history-base' } });
    const targetWrap = tools.createDiv({ cls: 'mf-refine-history-select-wrap' });
    targetWrap.createEl('label', { text: '对比', attr: { for: 'mf-history-target' } });
    this._targetSelect = targetWrap.createEl('select', { cls: 'mf-refine-history-select', attr: { id: 'mf-history-target' } });
    this._baseSelect.addEventListener('change', () => {
      this.baseId = this._baseSelect.value;
      this._render();
    });
    this._targetSelect.addEventListener('change', () => {
      this.targetId = this._targetSelect.value;
      this._render();
    });
    const swap = tools.createEl('button', { text: '交换', cls: 'mf-refine-history-swap', attr: { type: 'button' } });
    swap.addEventListener('click', () => {
      const previous = this.baseId;
      this.baseId = this.targetId;
      this.targetId = previous;
      this._syncSelects();
      this._render();
    });
    this._summary = tools.createDiv({ cls: 'mf-refine-history-summary', text: '' });

    this._preview = main.createDiv({ cls: 'mf-refine-history-preview', attr: { 'aria-label': '历史正文预览' } });
    const diffHead = main.createDiv({ cls: 'mf-refine-diff-head' });
    diffHead.createDiv({ cls: 'mf-refine-pane-label', text: '只读差异' });
    this._diffSummary = diffHead.createDiv({ cls: 'mf-refine-count', text: '' });
    this._diff = main.createDiv({ cls: 'mf-refine-diff mf-refine-history-diff', attr: { 'aria-label': '历史文本差异' } });
    main.createDiv({ cls: 'mf-refine-history-footnote', text: '只读浏览；不会修改正文、Frontmatter 或历史。指定版本恢复不在本任务范围。' });

    this._populateSelects();
    this._syncSelects();
    this._render();
  }

  _sizeLabel(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  _populateSelects() {
    if (!this._baseSelect || !this._targetSelect) return;
    for (const select of [this._baseSelect, this._targetSelect]) {
      select.empty();
      for (const snapshot of this.model.snapshots) {
        const option = select.createEl('option', { text: snapshot.label, attr: { value: snapshot.id } });
        option.value = snapshot.id;
      }
    }
  }

  _syncSelects() {
    if (this._baseSelect) this._baseSelect.value = this.baseId;
    if (this._targetSelect) this._targetSelect.value = this.targetId;
  }

  _setSelectedRow(row) {
    for (const node of this.contentEl.querySelectorAll('.mf-refine-history-row')) {
      node.classList.toggle('is-selected', node === row);
    }
  }

  _snapshot(id) {
    return this.model.snapshots.find(snapshot => snapshot.id === id) || this.model.current;
  }

  _render() {
    if (!this._preview) return;
    const base = this._snapshot(this.baseId);
    const target = this._snapshot(this.targetId);
    this._preview.setText(target.text || '（空正文）');
    if (this._summary) this._summary.setText(`${base.label} → ${target.label}`);
    const rows = diffLines(base.text, target.text);
    const stats = diffStats(rows);
    if (this._diffSummary) this._diffSummary.setText(`+${stats.added} / −${stats.removed}`);
    this._diff.empty();
    const maxRows = 400;
    const shown = rows.length > maxRows
      ? [...rows.slice(0, maxRows), { type: 'equal', text: `… 其余 ${rows.length - maxRows} 行未展开` }]
      : rows;
    for (const row of shown) {
      const line = this._diff.createDiv({ cls: `mf-refine-diff-line is-${row.type}` });
      line.createSpan({ cls: 'mf-refine-diff-marker', text: row.type === 'ins' ? '+' : row.type === 'del' ? '−' : ' ' });
      line.createSpan({ cls: 'mf-refine-diff-text', text: row.text || ' ' });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { RefineHistoryModal, formatTime, statusText, statusTone };
