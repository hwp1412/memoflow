'use strict';

const { Modal, Setting, Notice } = require('obsidian');
const cardCore = require('../data/card.js');

class MemoFlowCardModal extends Modal {
  constructor(app, { parentFile, prefill, onSubmit } = {}) {
    super(app);
    this.parentFile = parentFile;
    this.prefill = prefill || { question: '', answer: '' };
    this.onSubmit = onSubmit;
    this.format = 'basic';
    this.answerWrap = null;
    this.answerEl = null;
    this.hintEl = null;
    this.questionEl = null;
    this.clozeTools = null;
    this.clozeCountEl = null;
    this.submitted = false;
  }

  onOpen() {
    this.titleEl.setText('从当前摘录制卡');
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('mf-card-modal');

    contentEl.createDiv({
      cls: 'mf-card-modal-info',
      text: `父笔记：${this.parentFile?.basename || '未命名'} · 卡片会进入 Spaced Repetition 的复习队列`,
    });

    new Setting(contentEl)
      .setName('卡片类型')
      .setDesc('基础问答：问题 / 答案；双向问答：正反两张；Cloze：用 {{c1::答案}}、{{c2::答案::提示}} 或 ==关键词== 标出挖空。')
      .addDropdown(dropdown => dropdown
        .addOption('basic', '基础问答')
        .addOption('reverse', '双向问答')
        .addOption('cloze', 'Cloze 填空')
        .setValue('basic')
        .onChange(value => {
          this.format = value;
          this._syncFormat();
        }));

    const questionWrap = contentEl.createDiv({ cls: 'mf-card-modal-row' });
    questionWrap.createDiv({ cls: 'mf-card-modal-label', text: '问题 / 正文' });
    this.questionEl = questionWrap.createEl('textarea', {
      cls: 'mf-card-textarea',
      attr: { rows: '5', placeholder: '写下问题；Cloze 模式可写 {{c1::答案}} / {{c2::答案::提示}}，或 ==关键词==。' },
    });
    this.questionEl.value = this.prefill.question || '';

    this.answerWrap = contentEl.createDiv({ cls: 'mf-card-modal-row' });
    this.answerWrap.createDiv({ cls: 'mf-card-modal-label', text: '答案' });
    this.answerEl = this.answerWrap.createEl('textarea', {
      cls: 'mf-card-textarea',
      attr: { rows: '4', placeholder: '写下答案；基础问答必填。' },
    });
    this.answerEl.value = this.prefill.answer || '';

    this.clozeTools = contentEl.createDiv({ cls: 'mf-cloze-tools' });
    this.clozeTools.createSpan({ cls: 'mf-card-modal-label', text: '插入挖空：' });
    for (const number of [1, 2, 3]) {
      const button = this.clozeTools.createEl('button', {
        text: `C${number}`,
        attr: { type: 'button', title: `把选中文字包成 C${number} 挖空` },
      });
      button.addEventListener('click', () => this._insertCloze(number));
    }
    this.clozeCountEl = this.clozeTools.createSpan({ cls: 'mf-cloze-count' });

    this.hintEl = contentEl.createDiv({
      cls: 'mf-card-modal-hint',
      text: 'Cloze：用 {{c1::答案}} 标记挖空；C1/C2/C3 会生成不同卡片。双向问答会生成正反两张卡。',
    });
    this.questionEl.addEventListener('input', () => this._updateClozeTools());

    const more = contentEl.createDiv({ cls: 'mf-card-more-types' });
    more.createDiv({
      cls: 'mf-card-modal-label',
      text: '更多卡片类型（沿用上游流程）',
    });
    const moreRow = more.createDiv({ cls: 'mf-card-more-row' });
    const addUpstream = (label, method, title) => {
      const button = moreRow.createEl('button', { text: label, attr: { type: 'button', title } });
      button.addEventListener('click', () => {
        const plugin = this.app['plugins']?.plugins?.['memoflow'];
        if (!plugin || typeof plugin[method] !== 'function') return;
        this.close();
        window.setTimeout(() => plugin[method](), 0);
      });
    };
    addUpstream('图片卡', 'flashcardImageName', '从剪贴板/当前来源图片制卡');
    addUpstream('图片遮挡', 'occlusionCreate', '为图片创建遮挡卡');
    more.createDiv({
      cls: 'mf-card-modal-hint',
      text: '图片卡和遮挡卡使用上游的图片选择/遮挡编辑器；它们仍会进入同一个 SR deck。',
    });

    const actions = contentEl.createDiv({ cls: 'mf-card-modal-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } });
    cancel.addEventListener('click', () => this.close());
    const create = actions.createEl('button', { text: '创建卡片', cls: 'mod-cta', attr: { type: 'button' } });
    create.addEventListener('click', () => this._submit());

    this._syncFormat();
    window.setTimeout(() => {
      this.questionEl?.focus();
      this.questionEl?.setSelectionRange(this.questionEl.value.length, this.questionEl.value.length);
    }, 20);
  }

  _syncFormat() {
    const cloze = this.format === 'cloze';
    if (this.answerWrap) this.answerWrap.style.display = cloze ? 'none' : '';
    if (this.answerEl) this.answerEl.disabled = cloze;
    if (this.clozeTools) this.clozeTools.style.display = cloze ? '' : 'none';
    if (this.hintEl) {
      this.hintEl.textContent = cloze
        ? '用 {{c1::答案}}、{{c2::答案::提示}} 或 ==关键词== 标记；保存后会变成 SR 的多挖空卡。'
        : this.format === 'reverse'
          ? '双向问答会写成“问题 ?? 答案”的 Spaced Repetition 卡片，正反都会出题。'
          : '基础问答会写成“问题 ? 答案”的 Spaced Repetition 卡片。';
    }
    this._updateClozeTools();
  }

  _insertCloze(number) {
    if (!this.questionEl) return;
    const start = this.questionEl.selectionStart ?? this.questionEl.value.length;
    const end = this.questionEl.selectionEnd ?? start;
    const selected = this.questionEl.value.slice(start, end).trim();
    const marker = `{{c${number}::${selected || '答案'}}}`;
    this.questionEl.setRangeText(marker, start, end, 'end');
    this.questionEl.focus();
    this._updateClozeTools();
  }

  _updateClozeTools() {
    if (!this.clozeCountEl) return;
    if (this.format !== 'cloze') return;
    const count = cardCore.countClozeCards(this.questionEl?.value || '');
    this.clozeCountEl.textContent = count
      ? `检测到 ${count} 张挖空卡片`
      : '还没有挖空标记';
  }

  _submit() {
    if (this.submitted) return;
    const result = cardCore.validateCardInput({
      format: this.format,
      question: this.questionEl?.value || '',
      answer: this.answerEl?.value || '',
    });
    if (!result.ok) {
      new Notice(result.message, 6000);
      if (result.value.format === 'cloze') this.questionEl?.focus();
      else if (!result.value.answer) this.answerEl?.focus();
      else this.questionEl?.focus();
      return;
    }
    this.submitted = true;
    this.close();
    Promise.resolve(this.onSubmit?.(result.value)).catch(error => {
      console.error('[MemoFlow] card creation failed', error);
      new Notice(`制卡失败：${error.message || '未知错误'}。请检查父笔记和卡片文件夹。`, 7000);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { MemoFlowCardModal };
