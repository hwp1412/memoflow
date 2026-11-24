'use strict';

const { Modal } = require('obsidian');
const { diffLines, diffStats } = require('../data/refine-diff.js');

class RefinePreviewModal extends Modal {
  constructor(app, {
    path = '',
    selectedText = '',
    replacementText = '',
    validate = null,
  } = {}) {
    super(app);
    this.path = path;
    this.selectedText = selectedText;
    this.replacementText = replacementText;
    this.validate = validate;
    this.settled = false;
    this._resolve = null;
    this._promise = null;
    this._textarea = null;
    this._confirm = null;
    this._errorEl = null;
    this._diffEl = null;
    this._originalCount = null;
    this._replacementCount = null;
    this._diffStats = null;
    this._hint = null;
  }

  open() {
    if (this._promise) return this._promise;
    this._promise = new Promise(resolve => { this._resolve = resolve; });
    super.open();
    return this._promise;
  }

  onOpen() {
    this.titleEl.setText('原位精简');
    this.modalEl.addClass('mf-refine-modal-host');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-card-modal');
    contentEl.addClass('mf-refine-modal');

    const body = contentEl.createDiv({ cls: 'mf-refine-body' });
    const head = body.createDiv({ cls: 'mf-refine-head' });
    const headCopy = head.createDiv({ cls: 'mf-refine-head-copy' });
    headCopy.createDiv({ cls: 'mf-refine-eyebrow', text: 'EXTRACT · 原位精简' });
    headCopy.createDiv({ cls: 'mf-refine-path', text: this.path });
    head.createDiv({ cls: 'mf-refine-badge', text: '仅修改正文' });

    const grid = body.createDiv({ cls: 'mf-refine-grid' });
    const originalPane = grid.createDiv({ cls: 'mf-refine-pane' });
    const originalHead = originalPane.createDiv({ cls: 'mf-refine-pane-head' });
    originalHead.createDiv({ cls: 'mf-refine-pane-label', text: '选中的原文' });
    this._originalCount = originalHead.createDiv({ cls: 'mf-refine-count', text: '' });
    const original = originalPane.createDiv({ cls: 'mf-refine-original' });
    original.setText(this.selectedText);
    original.setAttribute('tabindex', '0');

    const replacementPane = grid.createDiv({ cls: 'mf-refine-pane' });
    const replacementHead = replacementPane.createDiv({ cls: 'mf-refine-pane-head' });
    replacementHead.createDiv({ cls: 'mf-refine-pane-label', text: '替换为' });
    this._replacementCount = replacementHead.createDiv({ cls: 'mf-refine-count', text: '' });
    this._textarea = replacementPane.createEl('textarea', {
      cls: 'mf-card-textarea mf-refine-replacement',
      attr: { rows: '8', 'aria-label': '替换文本' },
    });
    this._textarea.value = this.replacementText;
    this._textarea.addEventListener('input', () => this._sync());

    const diffHead = body.createDiv({ cls: 'mf-refine-diff-head' });
    diffHead.createDiv({ cls: 'mf-refine-pane-label', text: '前后对比' });
    this._diffStats = diffHead.createDiv({ cls: 'mf-refine-count', text: '' });
    this._diffEl = body.createDiv({ cls: 'mf-refine-diff' });
    this._diffEl.setAttribute('aria-label', '精简前后文本差异');

    const safety = body.createDiv({ cls: 'mf-refine-safety-note' });
    safety.createEl('strong', { text: '安全说明' });
    safety.createSpan({
      text: ' 确认后会先保存完整历史，再替换当前选区。Frontmatter、parent/source、调度字段与 SR 数据不会修改；失败时不会静默覆盖正文。',
    });

    this._errorEl = body.createDiv({ cls: 'mf-refine-error', attr: { role: 'alert' } });
    this._errorEl.hide?.();
    this._hint = body.createDiv({ cls: 'mf-refine-hint', text: '' });

    const actions = contentEl.createDiv({ cls: 'mf-refine-actions' });
    actions.createSpan({ cls: 'mf-refine-footer-note', text: '先保存历史 · 仅修改正文' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this._settle(null));
    this._confirm = actions.createEl('button', {
      text: '确认精简',
      cls: 'mf-refine-confirm',
      attr: { type: 'button' },
    });
    this._confirm.addEventListener('click', () => this._confirmValue());

    this._sync();
    window.setTimeout(() => this._textarea?.focus(), 20);
  }

  _sync() {
    const value = this._textarea?.value ?? '';
    if (this._originalCount) this._originalCount.setText(`${this.selectedText.length} 字`);
    if (this._replacementCount) this._replacementCount.setText(`${value.length} 字`);
    const unchanged = value === this.selectedText;
    if (this._confirm) this._confirm.disabled = unchanged;
    this._confirm?.toggleAttribute('disabled', unchanged);
    this._confirm?.classList.toggle('is-disabled', unchanged);
    if (this._hint) {
      this._hint.setText(unchanged
        ? '替换文本与原文相同：不会创建历史。'
        : '确认后才会保存历史并修改正文。');
    }
    this._showError('');
    this._renderDiff(value);
  }

  _renderDiff(value) {
    if (!this._diffEl) return;
    const rows = diffLines(this.selectedText, value);
    const stats = diffStats(rows);
    if (this._diffStats) this._diffStats.setText(`+${stats.added} / −${stats.removed}`);
    this._diffEl.empty();
    const maxRows = 400;
    const shown = rows.length > maxRows
      ? [...rows.slice(0, maxRows), { type: 'equal', text: `… 其余 ${rows.length - maxRows} 行未展开` }]
      : rows;
    for (const row of shown) {
      const line = this._diffEl.createDiv({
        cls: `mf-refine-diff-line is-${row.type}`,
        attr: { 'data-diff': row.type },
      });
      const marker = line.createSpan({ cls: 'mf-refine-diff-marker', text: row.type === 'ins' ? '+' : row.type === 'del' ? '−' : ' ' });
      const text = line.createSpan({ cls: 'mf-refine-diff-text' });
      text.setText(row.text || ' ');
    }
  }

  _showError(message) {
    if (!this._errorEl) return;
    this._errorEl.setText(message || '');
    if (message) this._errorEl.show?.();
    else this._errorEl.hide?.();
  }

  async _confirmValue() {
    if (this.settled || !this._textarea) return;
    const value = this._textarea.value;
    if (value === this.selectedText) return;
    this._showError('');
    this._confirm.disabled = true;
    try {
      if (this.validate) await this.validate(value);
    } catch (error) {
      this._confirm.disabled = false;
      this._showError(error?.message || '无法安全执行原位精简。');
      return;
    }
    this._confirm.disabled = false;
    this._settle(value);
  }

  _settle(value) {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this._resolve?.(value);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this._resolve?.(null);
    }
  }
}

module.exports = { RefinePreviewModal };
