'use strict';

const { ItemView, Notice, MarkdownRenderer, TFile } = require('obsidian');

const REVIEW_VIEW_TYPE = 'memoflow-review';
const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));

function el(tag, { cls = '', text = '', attrs = null } = {}, children = []) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  if (attrs) for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function stripFrontmatter(content) {
  const source = String(content || '');
  if (!source.startsWith('---')) return source;
  const end = source.indexOf('\n---', 3);
  if (end === -1) return source;
  return source.slice(end + 4).replace(/^\n+/, '');
}

class MemoFlowReviewView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.mode = 'learn';
    this.paths = [];
    this.index = 0;
    this.token = 0;
    this.busy = false;
    this.pendingCard = null;
    this.srContent = null;
    this.srCard = null;
    this.srModal = null;
    this.srNoteLeaf = null;
    this.answerShown = false;
  }

  getViewType() {
    return REVIEW_VIEW_TYPE;
  }

  getDisplayText() {
    return 'MemoFlow 学习';
  }

  getIcon() {
    return 'book';
  }

  async onOpen() {
    this.contentEl.addClass('mf-review-view');
    const config = this.plugin._reviewConfig || null;
    this.plugin._reviewConfig = null;
    if (config) {
      this.mode = config.mode === 'cards' ? 'cards' : 'learn';
      this.paths = Array.isArray(config.paths) ? config.paths.slice() : [];
      this.index = 0;
    } else {
      this.mode = 'learn';
      await this.loadSession();
    }
    await this.render();
  }

  async configure({ mode = 'learn', paths = [] } = {}) {
    this._closeSR();
    this.mode = mode === 'cards' ? 'cards' : 'learn';
    this.paths = Array.isArray(paths) ? paths.slice() : [];
    this.index = 0;
    await this.render();
  }

  async onClose() {
    this._closeSR();
  }

  async loadSession() {
    const plugin = this.plugin;
    let session = plugin.settings?.session;
    const today = typeof plugin._todayKey === 'function' ? plugin._todayKey() : null;
    if (!session || (today && session.date !== today) || !Array.isArray(session.paths) || !session.paths.length) {
      if (typeof plugin.buildSessionQueue === 'function') {
        try { await plugin.buildSessionQueue({ openFirst: false }); } catch (error) { console.error('[MemoFlow] review session build failed', error); }
      }
      session = plugin.settings?.session;
    }
    this.paths = Array.isArray(session?.paths) ? session.paths.slice() : [];
    this.index = 0;
  }

  _header(panel) {
    const total = Math.max(1, this.paths.length);
    const position = Math.min(this.index + 1, total);
    const head = el('div', { cls: 'mf-rv-header' }, [
      el('div', { cls: 'mf-rv-brand' }, [
        el('span', { cls: 'mf-rv-pill', text: 'MemoFlow' }),
        el('strong', { text: this.mode === 'cards' ? '卡片复习' : '开始学习' }),
      ]),
      el('div', { cls: 'mf-rv-progress' }, [
        el('span', { text: `${position} / ${total}` }),
        el('button', {
          cls: 'mf-rv-close',
          text: '✕',
          attrs: { type: 'button', title: '关闭学习页' },
        }),
      ]),
    ]);
    head.querySelector('.mf-rv-close')?.addEventListener('click', () => {
      this._closeSR();
      this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE);
    });
    panel.appendChild(head);
  }

  async render() {
    const token = ++this.token;
    this.busy = false;
    this.answerShown = false;
    const root = this.contentEl;
    root.empty();
    const shell = el('div', { cls: 'mf-rv-shell' });
    this._header(shell);
    root.appendChild(shell);

    if (!this.paths.length) {
      shell.appendChild(this._emptyState(
        this.mode === 'cards' ? '今天没有到期卡片' : '今天没有可学习项',
        this.mode === 'cards' ? 'Spaced Repetition 里暂时没有到期卡片。' : '先构建今日学习队列，或回到总览。',
      ));
      return;
    }
    if (this.index >= this.paths.length) {
      shell.appendChild(this._emptyState(
        this.mode === 'cards' ? '卡片复习完成' : '今天的学习完成',
        '队列已走到末尾。关闭后可以回到总览查看统计。',
      ));
      return;
    }

    const path = this.paths[this.index];
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.index += 1;
      if (this.index >= this.paths.length) return this.render();
      return this.render();
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const type = this.plugin.settings?.session?.types?.[path] || fm?.type;
    if (type === 'card') await this._renderCard(shell, file, fm, token);
    else await this._renderTopic(shell, file, fm, token);
  }

  _emptyState(title, text) {
    const wrap = el('div', { cls: 'mf-rv-panel mf-rv-empty' }, [
      el('h2', { text: title }),
      el('p', { text }),
    ]);
    const actions = el('div', { cls: 'mf-rv-actions', style: 'justify-content:center' });
    const dashboard = el('button', { cls: 'mf-rv-btn is-primary', text: '打开 MemoFlow 总览', attrs: { type: 'button' } });
    dashboard.addEventListener('click', () => this.plugin.openMemoFlow());
    actions.appendChild(dashboard);
    if (!this.paths.length && this.mode !== 'cards') {
      const build = el('button', { cls: 'mf-rv-btn', text: '构建今日队列', attrs: { type: 'button' } });
      build.addEventListener('click', async () => {
        await this.plugin.buildSessionQueue({ openFirst: false });
        await this.loadSession();
        await this.render();
      });
      actions.appendChild(build);
    }
    wrap.appendChild(actions);
    return wrap;
  }

  _actionButton(label, handler, { primary = false, subtle = false } = {}) {
    const button = el('button', {
      cls: `mf-rv-btn${primary ? ' is-primary' : ''}${subtle ? ' is-subtle' : ''}`,
      text: label,
      attrs: { type: 'button' },
    });
    button.addEventListener('click', async () => {
      if (this.busy) return;
      this.busy = true;
      button.disabled = true;
      try { await handler(); } catch (error) {
        console.error('[MemoFlow] unified review action failed', error);
        new Notice(`复习操作失败：${error.message || '未知错误'}。可返回原笔记后重试。`, 7000);
        button.disabled = false;
        this.busy = false;
      }
    });
    return button;
  }

  async _renderTopic(shell, file, fm, token) {
    const content = await this.app.vault.cachedRead(file).catch(() => '');
    if (token !== this.token) return;
    const panel = el('div', { cls: 'mf-rv-panel' });
    const meta = el('div', { cls: 'mf-rv-meta' }, [
      el('span', { cls: 'mf-rv-type', text: fm?.type === 'source' ? '阅读主题' : '摘录' }),
      el('span', { cls: 'mf-rv-pill', text: `P${Number(fm?.priority) || 50}` }),
      fm?.read_point ? el('span', { cls: 'mf-rv-pill', text: `p.${fm.read_point}${fm.total_pages ? ` / ${fm.total_pages}` : ''}` }) : null,
      fm?.source ? el('span', { text: `来源：${String(fm.source).replace(/^\[\[|\]\]$/g, '').split('|')[0]}` }) : null,
    ]);
    panel.appendChild(meta);
    panel.appendChild(el('h1', { cls: 'mf-rv-title', text: file.basename }));
    const contentEl = el('div', { cls: 'mf-rv-content' });
    panel.appendChild(contentEl);
    try {
      await MarkdownRenderer.render(this.app, stripFrontmatter(content), contentEl, file.path, this);
    } catch {
      contentEl.textContent = stripFrontmatter(content);
    }
    const actions = el('div', { cls: 'mf-rv-actions' });
    const isExtract = fm?.type === 'extract';
    actions.appendChild(this._actionButton(isExtract ? '完成并下一项' : '评阅并下一项', async () => {
      if (isExtract) {
        await this.plugin.markPathsDone([file.path], { confirm: false });
      } else {
        const graded = await this.plugin._gradeTopic(file, fm, this.plugin._todayKey());
        if (!graded) {
          this.busy = false;
          await this.render();
          return;
        }
      }
      await this.plugin.consumeSessionItem(file.path, { background: true });
      this.index += 1;
      await this.render();
    }, { primary: true }));
    actions.appendChild(this._actionButton('跳过', async () => {
      this.index += 1;
      await this.render();
    }));
    actions.appendChild(this._actionButton('打开原笔记', async () => {
      this.busy = false;
      await this.app.workspace.getLeaf(false).openFile(file);
    }, { subtle: true }));
    panel.appendChild(actions);
    shell.appendChild(panel);
  }

  async _renderCard(shell, file, fm, token) {
    const panel = el('div', { cls: 'mf-rv-panel' });
    panel.appendChild(el('div', { cls: 'mf-rv-meta' }, [
      el('span', { cls: 'mf-rv-type', text: '问答卡片' }),
      el('span', { cls: 'mf-rv-pill', text: fm?.source ? String(fm.source).replace(/^\[\[|\]\]$/g, '').split('|')[0] : '卡片' }),
    ]));
    const stage = el('div', { cls: 'mf-rv-card-stage' }, [
      el('div', { cls: 'mf-rv-card-kicker', text: '先回忆，再显示答案' }),
    ]);
    panel.appendChild(stage);
    shell.appendChild(panel);
    const status = el('p', { cls: 'mf-rv-note', text: '正在准备卡片…' });
    stage.appendChild(status);

    const pending = this.pendingCard?.path === file.path ? this.pendingCard.card : null;
    this.pendingCard = null;
    const card = pending || await this._openSRForCard(file);
    if (token !== this.token) {
      this._closeSR();
      return;
    }
    if (!card) {
      status.remove();
      stage.appendChild(el('p', { cls: 'mf-rv-note', text: '这个卡片没有可用的 Spaced Repetition 会话。仍可打开原笔记，或用「复习此卡」在 SR 中评分。' }));
      const actions = el('div', { cls: 'mf-rv-actions' });
      actions.appendChild(this._actionButton('跳过', async () => {
        this.index += 1;
        await this.render();
      }));
      actions.appendChild(this._actionButton('打开原笔记', async () => {
        this.busy = false;
        await this.app.workspace.getLeaf(false).openFile(file);
      }, { subtle: true }));
      panel.appendChild(actions);
      return;
    }

    status.remove();
    stage.empty?.();
    stage.appendChild(el('div', { cls: 'mf-rv-card-kicker', text: '先回忆，再显示答案' }));
    const front = el('div', { cls: 'mf-rv-card-face' });
    const back = el('div', { cls: 'mf-rv-card-face is-answer' });
    back.hidden = true;
    stage.append(front, back);
    await this._renderCardFace(front, card.front);
    if (token !== this.token) return;

    const actions = el('div', { cls: 'mf-rv-actions' });
    const reveal = this._actionButton('显示答案', async () => {
      reveal.remove();
      await this._renderCardFace(back, card.back);
      back.hidden = false;
      this.answerShown = true;
      stage.appendChild(this._gradeRow(file, card));
      this.busy = false;
    }, { primary: true });
    actions.appendChild(reveal);
    actions.appendChild(this._actionButton('跳过', async () => {
      this._closeSR();
      this.index += 1;
      await this.render();
    }, { subtle: true }));
    actions.appendChild(this._actionButton('打开原笔记', async () => {
      this.busy = false;
      await this.app.workspace.getLeaf(false).openFile(file);
    }, { subtle: true }));
    panel.appendChild(actions);
  }

  _gradeRow(file, card) {
    const labels = [
      ['记得', '较熟', 1],
      ['较难', '吃力', 2],
      ['重来', '忘了', 3],
      ['简单', '很熟', 0],
    ];
    const row = el('div', { cls: 'mf-rv-grade' });
    for (const [label, hint, response] of labels) {
      const button = el('button', { attrs: { type: 'button' } }, [
        el('strong', { text: label }),
        el('span', { text: hint }),
      ]);
      button.addEventListener('click', async () => {
        if (this.busy) return;
        this.busy = true;
        button.disabled = true;
        await this._gradeCard(file, response);
      });
      row.appendChild(button);
    }
    return row;
  }

  async _renderCardFace(target, markdown) {
    target.empty();
    try {
      await MarkdownRenderer.render(this.app, String(markdown || ''), target, '', this);
    } catch {
      target.textContent = String(markdown || '');
    }
  }

  async _openSRForCard(file) {
    this._closeSR();
    const sr = this.app['plugins']?.plugins?.['obsidian-spaced-repetition'];
    if (!sr || typeof this.plugin.reviewCardsInNote !== 'function') return null;
    if (sr.manifest?.version && sr.manifest.version !== '1.15.4') {
      console.warn('[MemoFlow] Spaced Repetition version is not the tested 1.15.4:', sr.manifest.version);
    }

    const noteLeaf = this.app.workspace.getLeaf('tab');
    this.srNoteLeaf = noteLeaf;
    try {
      await noteLeaf.openFile(file);
      this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
      await this.plugin.reviewCardsInNote(file);
    } catch (error) {
      console.error('[MemoFlow] Spaced Repetition review could not start', error);
      try { noteLeaf.detach(); } catch (detachError) { /* ignore */ }
      this.srNoteLeaf = null;
      this._closeSR();
      new Notice('Spaced Repetition 未能启动，已退回卡片笔记。可重载 Obsidian 后再试。', 6000);
      return null;
    }

    let contentManager = null;
    let card = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      await sleep(50);
      contentManager = sr.uiManager?.contentManager || null;
      card = contentManager?.reviewSequencer?.currentCard || null;
      if (card) break;
    }
    const modal = [...document.querySelectorAll('.modal-container')].find(node => node.querySelector('.sr-container'));
    if (modal) {
      modal.classList.add('mf-sr-hidden');
      modal.style.display = 'none';
      this.srModal = modal;
    }
    this.srContent = contentManager;
    this.srCard = card;
    // The note leaf was only needed to let the SR command resolve its active
    // note. Detaching it right away keeps the view free of extra tabs.
    if (this.srNoteLeaf) {
      try { this.srNoteLeaf.detach(); } catch (error) { /* ignore */ }
      this.srNoteLeaf = null;
    }
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    if (!card) {
      this._closeSR();
      return null;
    }
    return card;
  }

  async _gradeCard(file, response) {
    const contentManager = this.srContent;
    if (!contentManager) {
      this.busy = false;
      await this.render();
      return;
    }
    try {
      contentManager.lastPressedOnProcessReview = 0;
      await contentManager._processReview(response);
      await sleep(80);
      const next = contentManager.reviewSequencer?.currentCard;
      if (next && next.question?.note?.file?.path === file.path) {
        this.srCard = next;
        this.pendingCard = { path: file.path, card: next };
        this.busy = false;
        await this.render();
        return;
      }
      this._closeSR();
      await this.plugin.consumeSessionItem(file.path, { background: true });
      this.index += 1;
      await this.render();
    } catch (error) {
      console.error('[MemoFlow] unified card grade failed', error);
      new Notice('卡片评分失败，已回退到原笔记；可点「复习此卡」。');
      this._closeSR();
      this.busy = false;
      await this.render();
    }
  }

  _closeSR() {
    try { this.srContent?.close?.(); } catch (error) { /* ignore */ }
    if (this.srModal) {
      this.srModal.remove();
      this.srModal = null;
    }
    document.querySelectorAll('.modal-container.mf-sr-hidden').forEach(node => node.remove());
    this.srContent = null;
    this.srCard = null;
    if (this.srNoteLeaf) {
      try { this.srNoteLeaf.detach(); } catch (error) { /* ignore */ }
      this.srNoteLeaf = null;
    }
    if (this.leaf && this.app.workspace.activeLeaf !== this.leaf) {
      this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    }
  }
}

module.exports = { REVIEW_VIEW_TYPE, MemoFlowReviewView };
