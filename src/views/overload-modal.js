'use strict';

const { Modal } = require('obsidian');

class MemoFlowOverloadModal extends Modal {
  constructor(app, { overdueCount = 0, onChoose } = {}) {
    super(app);
    this.overdueCount = overdueCount;
    this.onChoose = onChoose;
    this.chosen = false;
  }

  onOpen() {
    this.titleEl.setText('过载处理');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-overload-modal');
    contentEl.createDiv({
      cls: 'mf-card-modal-info',
      text: `当前有 ${this.overdueCount} 个逾期阅读主题。Mercy 会把它们摊平到未来几天，卡片不参与。`,
    });
    const grid = contentEl.createDiv({ cls: 'mf-overload-options' });
    for (const days of [3, 7, 14, 30]) {
      const button = grid.createEl('button', {
        attr: { type: 'button' },
      });
      button.createSpan({ cls: 'mf-overload-days', text: `未来 ${days} 天` });
      button.createSpan({ cls: 'mf-overload-hint', text: days === 3 ? '适合轻度积压' : (days === 30 ? '适合长假后' : '把逾期均匀摊开') });
      button.addEventListener('click', () => {
        if (this.chosen) return;
        this.chosen = true;
        this.close();
        Promise.resolve(this.onChoose?.(days)).catch(error => console.error('[MemoFlow] overload failed', error));
      });
    }
    const actions = contentEl.createDiv({ cls: 'mf-card-modal-actions' });
    const cancel = actions.createEl('button', { text: '先不处理', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { MemoFlowOverloadModal };
