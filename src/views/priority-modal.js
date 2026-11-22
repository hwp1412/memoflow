'use strict';

const { Modal, Notice } = require('obsidian');
const { isValidPriority, normalizePriority } = require('../data/priority.js');

class MemoFlowPriorityModal extends Modal {
  constructor(app, { file, current, onApply } = {}) {
    super(app);
    this.file = file;
    this.current = normalizePriority(current);
    this.onApply = onApply;
    this.submitted = false;
    this.inputEl = null;
  }

  onOpen() {
    this.titleEl.setText('设置优先级');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-priority-modal');

    contentEl.createDiv({
      cls: 'mf-card-modal-info',
      text: `当前 P${this.current} · P1 最高，P100 最低。卡片不参与主题优先级。`,
    });

    const row = contentEl.createDiv({ cls: 'mf-priority-current' });
    row.createSpan({ cls: 'mf-priority-badge', text: `P${this.current}` });
    row.createSpan({ text: this.file?.basename || '' });

    const inputWrap = contentEl.createDiv({ cls: 'mf-card-modal-row' });
    inputWrap.createDiv({ cls: 'mf-card-modal-label', text: '新优先级（1–100）' });
    this.inputEl = inputWrap.createEl('input', {
      cls: 'mf-priority-input',
      attr: { type: 'number', min: '1', max: '100', step: '1' },
    });
    this.inputEl.value = String(this.current);

    const quick = contentEl.createDiv({ cls: 'mf-priority-quick' });
    for (const value of [1, 5, 10, 20, 30, 50, 70, 100]) {
      const button = quick.createEl('button', { text: `P${value}`, attr: { type: 'button' } });
      button.addEventListener('click', () => {
        this.inputEl.value = String(value);
        this.inputEl.focus();
      });
    }

    const boost = contentEl.createDiv({ cls: 'mf-priority-boost' });
    boost.createSpan({ cls: 'mf-card-modal-label', text: '快速提升：' });
    for (const delta of [5, 15, 30]) {
      const button = boost.createEl('button', { text: `提升 ${delta}`, attr: { type: 'button' } });
      button.addEventListener('click', () => this._applyBoost(delta));
    }

    const actions = contentEl.createDiv({ cls: 'mf-card-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const save = actions.createEl('button', { text: '保存', cls: 'mod-cta', attr: { type: 'button' } });
    save.addEventListener('click', () => this._submit());

    window.setTimeout(() => {
      this.inputEl?.focus();
      this.inputEl?.select();
    }, 20);
  }

  _submit() {
    if (this.submitted) return;
    const value = Number(this.inputEl?.value);
    if (!isValidPriority(value)) {
      new Notice('优先级必须是 1–100 之间的整数。', 6000);
      this.inputEl?.focus();
      return;
    }
    this.submitted = true;
    this.close();
    Promise.resolve(this.onApply?.({ priority: value })).catch(error => {
      console.error('[MemoFlow] priority update failed', error);
      new Notice(`优先级保存失败：${error.message || '未知错误'}。可关闭后重试。`, 6000);
    });
  }

  _applyBoost(delta) {
    if (this.submitted) return;
    this.submitted = true;
    this.close();
    Promise.resolve(this.onApply?.({ boost: delta })).catch(error => {
      console.error('[MemoFlow] priority boost failed', error);
      new Notice(`优先级保存失败：${error.message || '未知错误'}。可关闭后重试。`, 6000);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { MemoFlowPriorityModal };
