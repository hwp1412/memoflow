'use strict';

const { Modal } = require('obsidian');

class ConfirmActionModal extends Modal {
  constructor(app, { title, body, confirmText = '确定', onConfirm, onCancel } = {}) {
    super(app);
    this.title = title || '确认操作';
    this.body = body || '';
    this.confirmText = confirmText;
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.settled = false;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-confirm-action');
    contentEl.createDiv({ cls: 'mf-confirm-action-body', text: this.body });
    const actions = contentEl.createDiv({ cls: 'mf-highlight-confirm-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this._finish(false));
    const confirm = actions.createEl('button', {
      text: this.confirmText,
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

module.exports = { ConfirmActionModal };
