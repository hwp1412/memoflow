'use strict';

const { Modal } = require('obsidian');

class MemoFlowUserGuideModal extends Modal {
  onOpen() {
    this.titleEl.setText('MemoFlow 使用指南');
    const root = this.contentEl;
    root.empty();
    root.addClass('mf-guide-modal');

    const section = (title, children) => {
      root.createEl('h3', { text: title });
      for (const child of children) {
        if (typeof child === 'string') root.createEl('p', { text: child });
        else root.appendChild(child);
      }
    };
    const list = items => {
      const ul = root.createEl('ul');
      for (const item of items) ul.createEl('li', { text: item });
      return ul;
    };

    section('快速开始', [
      '打开一条来源/摘录，点阅读条上的「评阅并下一项」；摘录用「完成并下一项」。',
      '需要摘录时，选中文字后运行「生成时间戳摘录（选中 / 剪贴板）」，或点总览的「摘录选中 / 剪贴板」。',
      '需要制卡时，在摘录阅读条点「制卡」；基础问答和 ==Cloze== 都支持。',
      '卡片复习交给 Spaced Repetition：卡片阅读条点「复习此卡」。',
    ]);

    section('每日流程', [
      list([
        '总览 →「开始今日学习」：构建今日混合 session（主题 + 卡片）。',
        '来源：读一小段，记录页码，评阅并进入下一项。',
        '摘录：处理完点「完成并下一项」；需要时先「制卡」。',
        '卡片：在 Spaced Repetition 中显示答案、评分；SR 负责下次复习日期。',
        '过载：总览「过载处理」→ Mercy，或设置里开启自动过载。',
      ]),
    ]);

    section('优先级与子集复习', [
      '阅读条和总览队列的 P 数字都可点击；P1 最高，P100 最低。',
      '队列按类型 / 逾期 / 搜索筛选后，底部「复习筛选（N）」只把当前筛选结果组成 session。',
    ]);

    section('PDF、阅读点与摘录', [
      '来源有 PDF 时，阅读条显示 p.N / 总页数；点页码打开阅读点。',
      '「评阅并下一项」会问读到的页码，写入 read_point 并更新排程。',
      '时间戳摘录会带 `**来源**：[[...pdf#page=N|...]]`；点击可回 PDF。',
    ]);

    section('推荐快捷键', [
      '命令面板搜索中文命令即可；原有命令 ID 不变，旧快捷键继续有效。',
    ]);

    section('故障排查', [
      list([
        '卡片不能复习：确认 Spaced Repetition 已启用，且 deck tag 为 flashcards/incremental-reading。',
        'PDF 打不开：确认 pdf_path 或 pdf_vault_path 指向 Vault 内/外真实存在的 PDF。',
        '没有到期项：检查 next_review 和状态；或运行「构建今日学习队列」。',
        '详细复现：见 docs/WORKFLOW-TEST.md；SR 安装见 docs/SR-SETUP.md。',
      ]),
    ]);

    root.createEl('p', {
      cls: 'mf-guide-footnote',
      text: 'MemoFlow 个人自用版 · 作者：三斤的多多 / DeepSeek。保留 Incremental Reading Toolkit 的调度引擎；卡片评分与下次日期由 Spaced Repetition 负责。',
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

module.exports = { MemoFlowUserGuideModal };
