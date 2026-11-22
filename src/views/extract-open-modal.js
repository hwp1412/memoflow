'use strict';

const { Modal } = require('obsidian');

class ExtractOpenModal extends Modal {
  constructor(app, { file, onOpenFile } = {}) {
    super(app);
    this.file = file;
    this.onOpenFile = onOpenFile;
  }

  onOpen() {
    this.titleEl.setText('摘录已生成');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-extract-open-modal');
    contentEl.createDiv({
      cls: 'mf-extract-open-path',
      text: this.file?.path || '',
    });
    contentEl.createDiv({
      cls: 'mf-highlight-confirm-meta',
      text: '要现在打开这条摘录吗？',
    });
    const actions = contentEl.createDiv({ cls: 'mf-highlight-confirm-actions' });
    const stay = actions.createEl('button', { text: '留在当前', attr: { type: 'button' } });
    stay.addEventListener('click', () => this.close());
    const open = actions.createEl('button', {
      text: '在新标签页打开',
      cls: 'mod-cta',
      attr: { type: 'button' },
    });
    open.addEventListener('click', async () => {
      open.disabled = true;
      try {
        await this.onOpenFile?.(this.file);
      } finally {
        this.close();
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { ExtractOpenModal };
