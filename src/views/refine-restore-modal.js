'use strict';

const { Modal } = require('obsidian');
const { diffLines, diffStats } = require('../data/refine-diff.js');

class RefineRestoreModal extends Modal {
  constructor(app, {
    path = '',
    targetLabel = '',
    targetCreatedAt = '',
    currentBody = '',
    targetBody = '',
    onConfirm,
    onCancel,
  } = {}) {
    super(app);
    this.path = path;
    this.targetLabel = targetLabel;
    this.targetCreatedAt = targetCreatedAt;
    this.currentBody = currentBody;
    this.targetBody = targetBody;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.settled = false;
  }

  onOpen() {
    this.titleEl.setText('恢复历史快照？');
    this.modalEl.addClass('mf-refine-restore-host');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-refine-restore');

    const head = contentEl.createDiv({ cls: 'mf-refine-restore-head' });
    head.createDiv({ cls: 'mf-refine-eyebrow', text: 'EXTRACT · 恢复历史快照' });
    head.createDiv({ cls: 'mf-refine-restore-path', text: this.path });
    const meta = head.createDiv({ cls: 'mf-refine-restore-meta' });
    meta.createSpan({ text: this.targetLabel || '历史快照' });
    if (this.targetCreatedAt) meta.createSpan({ text: ` · ${this.targetCreatedAt}` });

    const warning = contentEl.createDiv({ cls: 'mf-refine-restore-warning', attr: { role: 'alert' } });
    warning.createDiv({ text: '将用目标快照替换当前正文。' });
    warning.createDiv({ text: 'Frontmatter、parent/source、调度和 SR 数据不会修改；会新增一条恢复历史。' });

    const diffHead = contentEl.createDiv({ cls: 'mf-refine-diff-head' });
    diffHead.createDiv({ cls: 'mf-refine-pane-label', text: '当前 → 目标' });
    const rows = diffLines(this.currentBody, this.targetBody);
    const stats = diffStats(rows);
    diffHead.createDiv({ cls: 'mf-refine-count', text: `+${stats.added} / −${stats.removed}` });
    const diff = contentEl.createDiv({ cls: 'mf-refine-diff mf-refine-restore-diff' });
    const maxRows = 400;
    const shown = rows.length > maxRows
      ? [...rows.slice(0, maxRows), { type: 'equal', text: `… 其余 ${rows.length - maxRows} 行未展开` }]
      : rows;
    for (const row of shown) {
      const line = diff.createDiv({ cls: `mf-refine-diff-line is-${row.type}` });
      line.createSpan({ cls: 'mf-refine-diff-marker', text: row.type === 'ins' ? '+' : row.type === 'del' ? '−' : ' ' });
      line.createSpan({ cls: 'mf-refine-diff-text', text: row.text || ' ' });
    }

    const actions = contentEl.createDiv({ cls: 'mf-refine-restore-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this._finish(false));
    const confirm = actions.createEl('button', {
      text: '确认恢复',
      cls: 'mod-warning',
      attr: { type: 'button' },
    });
    confirm.addEventListener('click', () => this._finish(true));
  }

  async _finish(confirmed) {
    if (this.settled) return;
    this.settled = true;
    if (confirmed) await this.onConfirm?.();
    else await this.onCancel?.();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.onCancel?.();
    }
  }
}

module.exports = { RefineRestoreModal };
