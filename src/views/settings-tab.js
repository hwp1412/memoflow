'use strict';

const { PluginSettingTab, Setting, Notice } = require('obsidian');
const dateCore = require('../../date-core.js');

const PATH_DEFAULTS = {
  sources: 'Sources/Incremental Reading/Sources',
  extracts: 'Sources/Incremental Reading/Extracts',
  cards: 'Sources/Incremental Reading/Cards',
  attachments: 'Sources/Incremental Reading/Attachments',
  categories: 'Sources/Incremental Reading/Categories',
  dashboard: 'Sources/Incremental Reading/Incremental-Reading-Dashboard.md',
  review_log: 'Sources/Incremental Reading/Review Log.md',
};

const DEFAULT_HIGHLIGHT = '#ffd166';
const DATE_LABELS = {
  'DD-MM-YYYY': 'DD-MM-YYYY（日-月-年）',
  'MM-DD-YYYY': 'MM-DD-YYYY（月-日-年）',
  'YYYY-MM-DD': 'YYYY-MM-DD（年-月-日）',
};

function configuredDateFormat(settings) {
  return dateCore.normalizeDateFormat(settings?.misc?.date_format);
}

function normalizeColor(value) {
  const candidate = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(candidate)) return candidate.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(candidate)) {
    return `#${candidate.slice(1).split('').map(char => char + char).join('')}`.toLowerCase();
  }
  return DEFAULT_HIGHLIGHT;
}

class MemoFlowSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this._about(containerEl);
    this._unifiedScheduler(containerEl);
    this._scheduling(containerEl);
    this._queue(containerEl);
    this._inlineCards(containerEl);
    this._spacedRepetition(containerEl);
    this._knowledgeTree(containerEl);
    this._paths(containerEl);
    this._misc(containerEl);
  }

  _about(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section)
      .setName(`MemoFlow ${this.plugin.manifest.version}`)
      .setDesc('个人自用版 · 作者：三斤的多多 / DeepSeek。基于 Incremental Reading Toolkit 1.1.8（MIT）构建，保留上游阅读引擎。')
      .setHeading();
    new Setting(section)
      .setName('使用指南')
      .setDesc('在 Obsidian 内打开快捷上手、建议快捷键、每日流程与故障排查。')
      .addButton(button => button
        .setButtonText('打开使用指南')
        .setCta()
        .onClick(() => this.plugin.openUserGuide()));
    const ready = this.plugin.isSpacedRepetitionReady();
    new Setting(section)
      .setName('环境状态')
      .setDesc(ready
        ? 'Spaced Repetition 已就绪，可以复习卡片。'
        : '尚未检测到 Spaced Repetition；复习卡片前请先安装并启用它。')
      .addButton(button => button
        .setButtonText('运行环境检查')
        .onClick(() => this._runSetupCheck()));
  }

  _unifiedScheduler(root) {
    const sec = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(sec).setName('Unified Scheduler (MF-US-1)').setHeading();
    let status = null;
    try {
      status = this.plugin.mfUs1ActivationDiagnostics();
    } catch (error) {
      status = null;
    }
    const mode = this.plugin._mfUs1EffectiveMode();
    const authorized = Boolean(status && status.authorized);
    const suspended = Boolean(status && status.suspended);
    const blockers = status && Array.isArray(status.activationBlockers) ? status.activationBlockers : [];
    let evidence = null;
    try {
      evidence = this.plugin._mfUs1ActivationEvidence();
    } catch (error) {
      evidence = null;
    }
    const sessionLabel = authorized
      ? '本次会话：已授权 Unified 写入'
      : (suspended
        ? '本次会话：已暂停（写入被拒绝）'
        : (mode === 'unified'
          ? '本次会话：Unified 未授权（写入被阻断，需重新确认激活）'
          : '本次会话：未授权（默认 Legacy）'));
    const describe = [
      `当前模式：${mode}`,
      sessionLabel,
      evidence ? `Topic：${evidence.topicCount}（旧格式 ${evidence.legacyTopicCount}；索引完整=${evidence.indexComplete ? '是' : '未知'}）` : null,
      blockers.length ? `阻断项：${blockers.join('、')}` : '阻断项：无',
    ].filter(Boolean).join(' · ');
    new Setting(sec)
      .setName('状态与授权')
      .setDesc(`${describe}。激活只在本次会话有效，重启后必须重新确认；旧库迁移暂不支持。`)
      .addButton(button => button.setButtonText('激活 Unified…').onClick(async () => {
        await this.plugin.mfUs1ProductionActivate();
        this.display();
      }))
      .addButton(button => button.setButtonText('暂停/撤销授权…').onClick(async () => {
        await this.plugin.mfUs1ProductionRevoke();
        this.display();
      }))
      .addButton(button => button.setButtonText('刷新状态').onClick(() => this.display()));
  }

  _numberSetting(section, name, description, target, key, { min, max, step = 'any' } = {}) {
    const save = () => this.plugin.saveSettings();
    new Setting(section).setName(name).setDesc(description).addText(text => {
      text.inputEl.type = 'number';
      text.inputEl.step = String(step);
      if (min != null) text.inputEl.min = String(min);
      if (max != null) text.inputEl.max = String(max);
      text.setValue(String(target[key])).onChange(value => {
        const number = Number(value);
        const valid = Number.isFinite(number)
          && (min == null || number >= min)
          && (max == null || number <= max);
        text.inputEl.toggleClass('is-invalid', !valid);
        if (!valid) return;
        target[key] = number;
        save();
      });
    });
  }

  _scheduling(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('阅读排程').setHeading();
    const settings = this.plugin.settings.scheduling;
    const save = () => this.plugin.saveSettings();

    new Setting(section)
      .setName('进度感知 A-Factor')
      .setDesc('根据剩余页数或视频时长调整间隔。书籍、PDF、视频建议开启。')
      .addToggle(toggle => toggle.setValue(settings.progress_aware).onChange(value => {
        settings.progress_aware = value;
        save();
      }));

    new Setting(section)
      .setName('停滞保护')
      .setDesc('当页码、时间戳或 Markdown 阅读点没有前进时，不再扩大间隔。')
      .addToggle(toggle => toggle.setValue(settings.stall_guard).onChange(value => {
        settings.stall_guard = value;
        save();
      }));

    this._numberSetting(section, 'A-Factor 最小值', '最小的间隔增长倍率；略高于 1 可以让材料保持较高出现频率。', settings, 'a_factor_min', { min: 1.01, max: 10, step: 0.01 });
    this._numberSetting(section, 'A-Factor 最大值', '接近读完的材料允许的最大间隔增长倍率。', settings, 'a_factor_max', { min: 1.01, max: 10, step: 0.01 });

    new Setting(section).setName('复习节奏调整').setHeading();
    this._numberSetting(section, '保持倍率', '选择“保持”时应用的倍率；设为 1 表示维持当前 A-Factor。', settings, 'quality_hold', { min: 0.1, max: 3, step: 0.01 });
    this._numberSetting(section, '提前复习倍率', '选择“提前”时应用的倍率；小于 1 会缩短后续增长。', settings, 'quality_speed_up', { min: 0.1, max: 3, step: 0.01 });
    this._numberSetting(section, '推后复习倍率', '选择“推后”时应用的倍率；大于 1 会拉长后续增长。', settings, 'quality_slow_down', { min: 0.1, max: 3, step: 0.01 });

    new Setting(section).setName('初始间隔模型').setHeading();
    this._numberSetting(section, '基础 A-Factor', '考虑来源长度之前使用的起始倍率。', settings, 'initial_af_base', { min: 1.01, max: 10, step: 0.01 });
    this._numberSetting(section, '长度敏感度', '来源越长，初始 A-Factor 越小的程度。', settings, 'initial_af_slope', { min: 0, max: 3, step: 0.01 });
    this._numberSetting(section, '长度基准', '视为“中性来源大小”的页数或媒体分钟数。', settings, 'initial_af_units_divisor', { min: 1, max: 10000, step: 1 });
    this._numberSetting(section, '摘录加成', '创建摘录后，对父来源 A-Factor 应用的倍率。', settings, 'extract_bump', { min: 0.1, max: 3, step: 0.01 });

    new Setting(section).setName('过载与 Mercy').setHeading();
    const misc = this.plugin.settings.misc;
    if (misc.overload_threshold == null) misc.overload_threshold = 10;
    new Setting(section)
      .setName('自动过载（Mercy）')
      .setDesc('开始今日学习前，如果逾期阅读主题超过阈值，自动按 7 天摊平。默认关闭。')
      .addToggle(toggle => toggle.setValue(Boolean(misc.auto_overload)).onChange(value => {
        misc.auto_overload = value;
        save();
      }));
    this._numberSetting(section, '自动过载阈值', '逾期主题超过这个数量时触发自动 Mercy。', misc, 'overload_threshold', { min: 1, max: 1000, step: 1 });
  }

  _queue(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('队列').setHeading();
    const settings = this.plugin.settings.queue;
    const save = () => this.plugin.saveSettings();

    new Setting(section)
      .setName('启用阅读队列侧栏')
      .setDesc('允许阅读队列在侧栏打开，并随笔记变化刷新。')
      .addToggle(toggle => toggle.setValue(settings.sidebar_enabled).onChange(value => {
        settings.sidebar_enabled = value;
        save();
      }));

    new Setting(section)
      .setName('默认标签过滤')
      .setDesc('侧栏的初始过滤条件。留空表示显示全部已排期主题。')
      .addText(text => text.setValue(settings.default_tag_filter).onChange(value => {
        settings.default_tag_filter = value;
        save();
      }));

    new Setting(section)
      .setName('补充列表排序')
      .setDesc('控制逾期、新素材和未排期分区；今日会话仍保持自己的排期顺序。')
      .addDropdown(dropdown => {
        dropdown
          .addOption('urgency', '紧急度')
          .addOption('priority', '优先级')
          .addOption('due_date', '到期日')
          .setValue(settings.sort_key)
          .onChange(value => {
            settings.sort_key = value;
            save();
          });
      });

    new Setting(section)
      .setName('卡片与阅读主题混合')
      .setDesc('在每日学习流中交替出现卡片与阅读主题；卡片评分仍由 Spaced Repetition 负责。')
      .addToggle(toggle => toggle.setValue(settings.mix_cards !== false).onChange(value => {
        settings.mix_cards = value;
        save();
      }));
  }

  _inlineCards(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('内联卡片导出').setHeading();
    const settings = this.plugin.settings.inline_cards;
    const save = () => this.plugin.saveSettings();

    new Setting(section)
      .setName('启用')
      .setDesc('允许“导出内联卡片”识别问答、填空和高亮文本形式。')
      .addToggle(toggle => toggle.setValue(settings.enabled).onChange(value => {
        settings.enabled = value;
        save();
      }));

    new Setting(section)
      .setName('Q::A 正则')
      .setDesc('用于单行 Q::问题::A::答案 卡片的高级匹配规则。')
      .addText(text => text.setValue(settings.qa_regex).onChange(value => {
        settings.qa_regex = value;
        save();
      }));

    new Setting(section)
      .setName('填空正则')
      .setDesc('用于 {{c1::答案::提示}} 卡片的高级匹配规则。')
      .addText(text => text.setValue(settings.cloze_regex).onChange(value => {
        settings.cloze_regex = value;
        save();
      }));
  }

  _spacedRepetition(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('间隔重复（Spaced Repetition）').setHeading();
    const settings = this.plugin.settings.spaced_repetition;
    const save = () => this.plugin.saveSettings();

    new Setting(section)
      .setName('依赖状态')
      .setDesc(this.plugin.isSpacedRepetitionReady()
        ? '已就绪；卡片复习命令会打开 Spaced Repetition。'
        : '未就绪；请安装并启用 Spaced Repetition 社区插件。');

    new Setting(section)
      .setName('卡片 deck 标签')
      .setDesc('与 Spaced Repetition 中配置的 flashcard 标签保持一致；不要包含开头的 #。')
      .addText(text => text.setValue(settings.flashcardTag).onChange(value => {
        settings.flashcardTag = value.replace(/^#/, '').trim() || 'flashcards/incremental-reading';
        save();
      }));

    new Setting(section)
      .setName('多行卡片分隔符')
      .setDesc('与 Spaced Repetition 的多行卡片分隔符一致。')
      .addText(text => text.setValue(settings.multilineCardSeparator).onChange(value => {
        settings.multilineCardSeparator = value.trim() || '?';
        save();
      }));

    new Setting(section)
      .setName('双向卡片分隔符')
      .setDesc('与 Spaced Repetition 的多行双向分隔符一致。')
      .addText(text => text.setValue(settings.multilineReversedCardSeparator).onChange(value => {
        settings.multilineReversedCardSeparator = value.trim() || '??';
        save();
      }));
  }

  _knowledgeTree(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('知识树').setHeading();
    this._numberSetting(
      section,
      '大分支提醒阈值',
      '当分类子项数量超过此值时，在知识树中高亮提醒。',
      this.plugin.settings.tree,
      'child_warn_threshold',
      { min: 1, max: 100000, step: 1 },
    );
    new Setting(section)
      .setName('显示已完成内容')
      .setDesc('在知识树中显示已完成和已移出队列的主题。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.tree.show_completed).onChange(value => {
        this.plugin.settings.tree.show_completed = value;
        this.plugin.saveSettings();
        this.plugin._refreshTreeViews();
      }));
  }

  _paths(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('路径').setHeading();
    const settings = this.plugin.settings.paths;
    const save = () => {
      this.plugin._invalidateIRCollection(true);
      return this.plugin.saveSettings();
    };
    const paths = [
      ['sources', '来源文件夹', '来源笔记与本地视频文件。'],
      ['extracts', '摘录文件夹', '作为独立阅读主题排期的段落。'],
      ['cards', '卡片文件夹', '供 Spaced Repetition 使用的 Markdown 卡片。'],
      ['attachments', '附件文件夹', '剪贴板图片与视觉学习素材。'],
      ['categories', '分类文件夹', '知识树分类笔记。'],
      ['dashboard', '总览笔记', '可选的会话快照与总览笔记路径。'],
      ['review_log', '复习日志', '记录已完成主题复习的 Markdown 表格。'],
    ];
    for (const [key, name, description] of paths) {
      new Setting(section).setName(name).setDesc(description)
        .addText(text => text
          .setPlaceholder(PATH_DEFAULTS[key])
          .setValue(settings[key] || PATH_DEFAULTS[key])
          .onChange(value => {
            settings[key] = value.trim() || PATH_DEFAULTS[key];
            save();
          }))
        .addExtraButton(button => button
          .setIcon('rotate-ccw')
          .setTooltip(`重置${name}`)
          .onClick(async () => {
            settings[key] = PATH_DEFAULTS[key];
            await save();
            this.display();
          }));
    }
  }

  _misc(root) {
    const section = root.createDiv({ cls: 'ir-settings-section' });
    new Setting(section).setName('通用').setHeading();
    const settings = this.plugin.settings.misc;
    const save = () => this.plugin.saveSettings();

    new Setting(section)
      .setName('日期格式')
      .setDesc('用于排期字段、提示、检查点和复习日志。')
      .addDropdown(dropdown => {
        for (const format of dateCore.SUPPORTED_DATE_FORMATS) {
          dropdown.addOption(format, DATE_LABELS[format] || format);
        }
        dropdown.setValue(configuredDateFormat(this.plugin.settings)).onChange(async value => {
          const previous = configuredDateFormat(this.plugin.settings);
          if (previous === value) return;
          try {
            const changed = await this.plugin.migrateDateFormat(previous, value);
            settings.date_format = value;
            await save();
            new Notice(`日期格式已切换为 ${value}；迁移了 ${changed} 个已存日期。`);
          } catch (error) {
            new Notice(`日期迁移失败：${error.message}`);
          }
        });
      });

    new Setting(section)
      .setName('摘录高亮颜色')
      .setDesc('编辑视图与阅读视图中摘录片段和摘录笔记的强调色。')
      .addColorPicker(picker => picker
        .setValue(normalizeColor(settings.extract_highlight_color))
        .onChange(async value => {
          settings.extract_highlight_color = normalizeColor(value);
          await save();
          this.plugin._refreshExcerptViews();
        }))
      .addExtraButton(button => button
        .setIcon('rotate-ccw')
        .setTooltip('重置摘录高亮颜色')
        .onClick(async () => {
          settings.extract_highlight_color = DEFAULT_HIGHLIGHT;
          await save();
          this.plugin._refreshExcerptViews();
          this.display();
        }));

    new Setting(section).setName('诊断').setHeading();
    new Setting(section)
      .setName('调试日志')
      .setDesc('把额外细节写入开发者控制台；日常使用请保持关闭。')
      .addToggle(toggle => toggle.setValue(settings.debug).onChange(value => {
        settings.debug = value;
        save();
      }));
  }

  _runSetupCheck() {
    const plugin = this.plugin;
    const issues = [];
    const notes = [];

    if (!plugin.isSpacedRepetitionReady()) {
      issues.push('未检测到可用的 Spaced Repetition 插件；请先安装并启用。');
    } else {
      notes.push('Spaced Repetition 已就绪。');
    }

    const folders = [
      ['sources', '来源文件夹'],
      ['extracts', '摘录文件夹'],
      ['cards', '卡片文件夹'],
      ['categories', '分类文件夹'],
    ];
    for (const [key, label] of folders) {
      const path = plugin.settings.paths?.[key];
      if (!path || !plugin.app.vault.getAbstractFileByPath(path)) {
        issues.push(`${label}不存在：${path || '(未设置)'}`);
      }
    }

    if (!dateCore.SUPPORTED_DATE_FORMATS.includes(configuredDateFormat(plugin.settings))) {
      issues.push('日期格式不在支持范围内。');
    }
    for (const [label, source] of [
      ['Q::A 正则', plugin.settings.inline_cards?.qa_regex],
      ['填空正则', plugin.settings.inline_cards?.cloze_regex],
    ]) {
      try {
        new RegExp(String(source || ''));
      } catch (error) {
        issues.push(`${label}无法编译：${error.message}`);
      }
    }

    const lines = ['MemoFlow 环境检查'];
    if (issues.length === 0) {
      lines.push('✅ 一切就绪。');
      lines.push(...notes);
    } else {
      lines.push('⚠️ 需要处理：');
      for (const issue of issues) lines.push(`- ${issue}`);
    }
    new Notice(lines.join('\n'), 10000);
  }
}

module.exports = { MemoFlowSettingTab, PATH_DEFAULTS };
