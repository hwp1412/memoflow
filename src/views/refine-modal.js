'use strict';

const { Modal } = require('obsidian');

class RefinePreviewModal extends Modal {
  constructor(app, { path = '', selectedText = '', replacementText = '' } = {}) {
    super(app);
    this.path = path;
    this.selectedText = selectedText;
    this.replacementText = replacementText;
    this.settled = false;
    this._resolve = null;
    this._promise = null;
  }

  open() {
    if (this._promise) return this._promise;
    this._promise = new Promise(resolve => { this._resolve = resolve; });
    super.open();
    return this._promise;
  }

  onOpen() {
    this.titleEl.setText('原位精简当前摘录');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-card-modal');
    contentEl.createDiv({ cls: 'mf-card-modal-info', text: this.path });
    contentEl.createEl('h3', { text: '选中原文' });
    const original = contentEl.createEl('pre', { cls: 'mf-refine-original' });
    original.setText(this.selectedText);
    contentEl.createEl('h3', { text: '替换为' });
    const textarea = contentEl.createEl('textarea', {
      cls: 'mf-card-textarea mf-refine-replacement',
      attr: { rows: '8' },
    });
    textarea.value = this.replacementText;
    contentEl.createDiv({
      cls: 'mf-card-modal-info',
      text: '只替换当前选区；历史会先保存；不会修改 Frontmatter、parent/source 或调度数据。',
    });
    const actions = contentEl.createDiv({ cls: 'mf-highlight-confirm-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this._settle(null));
    const confirm = actions.createEl('button', {
      text: '确认精简',
      cls: 'mod-warning',
      attr: { type: 'button' },
    });
    confirm.addEventListener('click', () => this._settle(textarea.value));
    setTimeout(() => textarea.focus(), 20);
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
