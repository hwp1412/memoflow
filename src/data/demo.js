'use strict';

const text = require('./text.js');

function addDays(today, offset) {
  const d = new Date(today.getTime());
  d.setDate(d.getDate() + offset);
  return d;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDmy(date) {
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

function dueLabelFor(offset) {
  if (offset === 0) return '今天';
  if (offset < 0) return `逾期 ${Math.abs(offset)} 天`;
  if (offset === 1) return '明天';
  return `${offset} 天后`;
}

function dueToneFor(offset) {
  if (offset < 0) return 'overdue';
  if (offset === 0) return 'today';
  return 'future';
}

function makeItem(today, options) {
  const offset = options.offset;
  const dueDate = offset == null ? null : addDays(today, offset);
  const type = options.type;
  return {
    path: `demo/${encodeURIComponent(options.basename)}.md`,
    basename: options.basename,
    type,
    sourceTitle: options.sourceTitle || '',
    priority: options.priority,
    interval: options.interval == null ? null : options.interval,
    aFactor: options.aFactor == null ? null : options.aFactor,
    status: options.status || 'active',
    dueDate,
    dueTime: dueDate ? dueDate.getTime() : null,
    dueLabel: type === 'card' ? '卡片' : (dueDate ? dueLabelFor(offset) : '新素材'),
    dueTitle: type === 'card'
      ? '卡片复习由 Spaced Repetition 管理'
      : (dueDate ? formatDmy(dueDate) : '还没有安排下次复习'),
    dueTone: type === 'card' ? 'card' : (dueDate ? dueToneFor(offset) : 'new'),
    isOverdue: type !== 'card' && dueDate != null && offset < 0,
    hasPdf: Boolean(options.hasPdf),
    urgency: 0,
    excerpt: options.excerpt || '',
    tfile: null,
    fm: null,
  };
}

function makeTree() {
  return [
    {
      path: 'demo/tree/阅读主题',
      basename: '阅读主题',
      type: 'category',
      dueCount: 9,
      hasChildren: true,
      hiddenCount: 0,
      children: [
        {
          path: 'demo/tree/学会提问',
          basename: '学会提问',
          type: 'source',
          dueCount: 5,
          hasChildren: true,
          hiddenCount: 0,
          children: [
            { path: 'demo/tree/学会提问 Extract 1', basename: '学会提问 Extract 1', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
            { path: 'demo/tree/学会提问 Extract 2', basename: '学会提问 Extract 2', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
            { path: 'demo/tree/学会提问 Extract 3', basename: '学会提问 Extract 3', type: 'extract', dueCount: 0, children: [], hasChildren: false, hiddenCount: 0 },
          ],
        },
        {
          path: 'demo/tree/如何阅读一本书',
          basename: '如何阅读一本书',
          type: 'source',
          dueCount: 4,
          hasChildren: true,
          hiddenCount: 0,
          children: [
            { path: 'demo/tree/如何阅读一本书 Extract 1', basename: '如何阅读一本书 Extract 1', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
            { path: 'demo/tree/如何阅读一本书 Extract 2', basename: '如何阅读一本书 Extract 2', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
          ],
        },
      ],
    },
    {
      path: 'demo/tree/认知科学',
      basename: '认知科学',
      type: 'category',
      dueCount: 7,
      hasChildren: true,
      hiddenCount: 0,
      children: [
        {
          path: 'demo/tree/深度工作',
          basename: '深度工作',
          type: 'source',
          dueCount: 3,
          hasChildren: true,
          hiddenCount: 0,
          children: [
            { path: 'demo/tree/深度工作 Extract 1', basename: '深度工作 Extract 1', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
            { path: 'demo/tree/深度工作 Extract 2', basename: '深度工作 Extract 2', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
          ],
        },
        {
          path: 'demo/tree/思考，快与慢',
          basename: '思考，快与慢',
          type: 'source',
          dueCount: 4,
          hasChildren: true,
          hiddenCount: 0,
          children: [
            { path: 'demo/tree/思考，快与慢 Extract 1', basename: '思考，快与慢 Extract 1', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
            { path: 'demo/tree/思考，快与慢 Extract 2', basename: '思考，快与慢 Extract 2', type: 'extract', dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
          ],
        },
      ],
    },
  ];
}

function buildDemoModel(todayInput, options = {}) {
  const today = todayInput instanceof Date ? new Date(todayInput.getTime()) : new Date();
  today.setHours(0, 0, 0, 0);
  const isMobile = Boolean(options.isMobile);

  const queue = [
    makeItem(today, {
      basename: '学会提问 Extract 1', type: 'extract', sourceTitle: '学会提问',
      priority: 8, offset: -2, interval: 3, aFactor: 2.0,
      excerpt: '海绵式思维相对被动，它并不需要你绞尽脑汁，但它的致命缺陷是：对哪些信息可以相信、哪些应该摒弃，提供不了任何判断方法。',
    }),
    makeItem(today, {
      basename: '如何阅读一本书 Extract 2', type: 'extract', sourceTitle: '如何阅读一本书',
      priority: 12, offset: -1, interval: 4, aFactor: 2.1,
      excerpt: '分析阅读的四个问题：这本书在谈什么？作者细部说了什么、怎么说的？这本书说得有道理吗？这本书跟我有什么关系？',
    }),
    makeItem(today, {
      basename: '学会提问 Extract 4', type: 'extract', sourceTitle: '学会提问',
      priority: 15, offset: 0, interval: 2, aFactor: 1.75,
      excerpt: '淘金式思维要求读者主动提问、与作者互动，而不是像海绵一样被动吸收。',
    }),
    makeItem(today, {
      basename: '如何阅读一本书 Extract 4', type: 'extract', sourceTitle: '如何阅读一本书',
      priority: 20, offset: -1, interval: 3, aFactor: 2.05,
      excerpt: '在检视阅读中，速度不是目的，理解结构才是；先看骨架，再决定哪里值得慢下来。',
    }),
    makeItem(today, {
      basename: '深度工作 Extract 1', type: 'extract', sourceTitle: '深度工作',
      priority: 18, offset: 0, interval: 6, aFactor: 1.8,
      excerpt: '深度工作是在无干扰状态下专注进行职业活动，使个人的认知能力达到极限。这种努力能够创造新价值，提升技能，而且难以复制。',
    }),
    makeItem(today, {
      basename: '思考，快与慢 Extract 1', type: 'extract', sourceTitle: '思考，快与慢',
      priority: 25, offset: 0, interval: 5, aFactor: 2.3,
      excerpt: '系统 1 的运行是自动且快速的，几乎不需要努力；系统 2 则调动注意力来分析和解决问题，它比较慢，也更可靠。',
    }),
    makeItem(today, {
      basename: '学会提问', type: 'source', sourceTitle: '阅读主题',
      priority: 51, offset: -4, interval: 8, aFactor: 1.33, hasPdf: true,
      excerpt: '批判性思维不是一味反对，而是在相信或拒绝一个观点之前，先问清楚它的事实依据、概念含义与推理过程。',
    }),
    makeItem(today, {
      basename: '如何阅读一本书', type: 'source', sourceTitle: '阅读主题',
      priority: 40, offset: 0, interval: 6, aFactor: 1.62,
      excerpt: '阅读的层次分为基础阅读、检视阅读、分析阅读和主题阅读。真正困难的不是读完，而是带着问题读。',
    }),
    makeItem(today, {
      basename: '深度工作', type: 'source', sourceTitle: '认知科学',
      priority: 30, offset: 1, interval: 9, aFactor: 1.45,
      excerpt: '注意力残留会让人在任务切换后仍有一部分注意力停留在上一件事上，这就是为什么频繁查看消息会让深度工作变得昂贵。',
    }),
    makeItem(today, {
      basename: '思考，快与慢 Extract 2', type: 'extract', sourceTitle: '思考，快与慢',
      priority: 35, offset: 2, interval: 4, aFactor: 2.0,
      excerpt: '锚定效应：人们在做判断时，会不自觉地过度依赖最初接触到的信息，即使这个信息与当前问题毫无关系。',
    }),
    makeItem(today, {
      basename: '学会提问 Extract 2', type: 'extract', sourceTitle: '学会提问',
      priority: 22, offset: 2, interval: 3, aFactor: 1.9,
      excerpt: '一个论证由结论和理由构成。要评价一个论证，先找到作者的结论，再看他给出的理由能不能支撑这个结论。',
    }),
    makeItem(today, {
      basename: '如何阅读一本书 Extract 1', type: 'extract', sourceTitle: '如何阅读一本书',
      priority: 45, offset: 3, interval: 5, aFactor: 2.2,
      excerpt: '检视阅读的任务是在有限时间里抓住一本书的骨架：先看标题、序言、目录和索引，再快速通读，不要被细节拖住。',
    }),
    makeItem(today, {
      basename: '深度工作 Extract 2', type: 'extract', sourceTitle: '深度工作',
      priority: 55, offset: 4, interval: 7, aFactor: 1.7,
      excerpt: '与其追求长时间工作，不如把注意力当成稀缺资源来管理：设定固定的深度工作时段，并像对待会议一样保护它。',
    }),
    makeItem(today, {
      basename: '思考，快与慢 Extract 3', type: 'extract', sourceTitle: '思考，快与慢',
      priority: 60, offset: 5, interval: 6, aFactor: 2.4,
      excerpt: '后见之明偏差让我们在事情发生后觉得结果“本来就可以预料”，从而高估自己当初的判断能力。',
    }),
    makeItem(today, {
      basename: '思考，快与慢', type: 'source', sourceTitle: '认知科学',
      priority: 65, offset: 6, interval: 10, aFactor: 1.5,
      excerpt: '我们以为自己在理性地判断，但大量判断其实来自快速、直觉、自动的系统 1。',
    }),
    makeItem(today, {
      basename: '学会提问 Extract 3', type: 'extract', sourceTitle: '学会提问',
      priority: 28, offset: null, interval: null, aFactor: 2.0,
      excerpt: '描述性假设是作者没有明说、但论证必须成立的前提。找到它，往往是评价一个论证的关键一步。',
    }),
    makeItem(today, {
      basename: '如何阅读一本书 Extract 3', type: 'extract', sourceTitle: '如何阅读一本书',
      priority: 32, offset: null, interval: null, aFactor: 1.85,
      excerpt: '主题阅读不是把几本书各读一遍，而是围绕同一个问题，让不同作者在你的问题下对话。',
    }),
    makeItem(today, {
      basename: '人类简史', type: 'source', sourceTitle: '认知科学',
      priority: 70, offset: null, interval: null, aFactor: 1.3,
      excerpt: '智人能够大规模协作，很大程度上依赖于共同相信的虚构故事：国家、货币、公司、法律。',
    }),
    makeItem(today, {
      basename: '学会提问 - Card 1', type: 'card', sourceTitle: '学会提问',
      priority: 60, offset: null, interval: null, aFactor: null,
      excerpt: '海绵式思维与淘金式思维的区别是什么？',
    }),
    makeItem(today, {
      basename: '深度工作 - Card 1', type: 'card', sourceTitle: '深度工作',
      priority: 70, offset: null, interval: null, aFactor: null,
      excerpt: '什么是注意力残留？',
    }),
  ];

  // Keep the demo order intentional: overdue, today, future, new, cards.
  queue.forEach((item, index) => { item.urgency = 10000 - index; });
  const due = queue.filter(item => item.type !== 'card' && item.dueTime != null && item.dueDate <= today).length;
  const overdue = queue.filter(item => item.isOverdue).length;
  const todayDue = queue.filter(item => item.type !== 'card' && item.dueTime != null && item.dueDate.getTime() === today.getTime()).length;
  const newItems = queue.filter(item => item.type !== 'card' && item.dueTime == null).length;
  const cards = queue.filter(item => item.type === 'card').length;
  const reviewedToday = 16;
  const progress = due + reviewedToday === 0 ? 1 : Math.min(1, reviewedToday / (reviewedToday + due));
  const estimatedMinutes = Math.max(0, Math.round((due * 1.5) / 5) * 5);

  return {
    today,
    dateLabel: text.formatDateLabel(today),
    counts: { due, overdue, todayDue, newItems, cards, cardsDue: 2, reviewedToday },
    progress,
    estimatedMinutes,
    hero: { primary: queue[0] || null },
    queue,
    tree: makeTree(),
    forecast: [
      { label: '今天', shortLabel: '今天', count: due, isToday: true },
      { label: '明天', shortLabel: '明天', count: 2, isToday: false },
      { label: '周三', shortLabel: '周三', count: 3, isToday: false },
      { label: '周四', shortLabel: '周四', count: 2, isToday: false },
      { label: '周五', shortLabel: '周五', count: 2, isToday: false },
      { label: '周六', shortLabel: '周六', count: 1, isToday: false },
      { label: '周日', shortLabel: '周日', count: 2, isToday: false },
    ],
    activity: [3, 5, 8, 4, 9, 12, 6, 11, 14, 9, 16, 12, 18, 15].map((count, index, arr) => ({
      key: String(index),
      label: index === arr.length - 1 ? '今天' : text.formatShortDate(addDays(today, index - (arr.length - 1))),
      count,
      isToday: index === arr.length - 1,
    })),
    streak: 12,
    reviews14d: 142,
    sources: [
      { path: 'demo/source/学会提问', basename: '学会提问', type: 'source', readPoint: 190, totalPages: 308, progress: 190 / 308, extractCount: 3, hasPdf: true, lastReviewed: 0, tfile: null, fm: null },
      { path: 'demo/source/如何阅读一本书', basename: '如何阅读一本书', type: 'source', readPoint: 87, totalPages: 424, progress: 87 / 424, extractCount: 3, hasPdf: false, lastReviewed: 0, tfile: null, fm: null },
      { path: 'demo/source/深度工作', basename: '深度工作', type: 'source', readPoint: 42, totalPages: 296, progress: 42 / 296, extractCount: 2, hasPdf: false, lastReviewed: 0, tfile: null, fm: null },
    ],
    srReady: true,
    recent: [
      {
        path: 'demo/extract/海绵式思维',
        basename: '学会提问 Extract 1',
        title: '学会提问 Extract 1',
        sourceTitle: '学会提问',
        page: 12,
        text: '海绵式思维相对被动，它并不需要你绞尽脑汁，但它的致命缺陷是：对哪些信息可以相信、哪些应该摒弃，提供不了任何判断方法。',
      },
      {
        path: 'demo/extract/分析阅读',
        basename: '如何阅读一本书 Extract 2',
        title: '如何阅读一本书 Extract 2',
        sourceTitle: '如何阅读一本书',
        page: 87,
        text: '分析阅读的四个问题：这本书在谈什么？作者细部说了什么、怎么说的？这本书说得有道理吗？这本书跟我有什么关系？',
      },
      {
        path: 'demo/extract/深度工作',
        basename: '深度工作 Extract 1',
        title: '深度工作 Extract 1',
        sourceTitle: '深度工作',
        page: 42,
        text: '深度工作是在无干扰状态下专注进行职业活动，使个人的认知能力达到极限。这种努力能够创造新价值，提升技能，而且难以复制。',
      },
    ],
    demo: true,
    isMobile,
  };
}

function buildEmptyModel(todayInput, options = {}) {
  const today = todayInput instanceof Date ? new Date(todayInput.getTime()) : new Date();
  today.setHours(0, 0, 0, 0);
  return {
    today,
    dateLabel: text.formatDateLabel(today),
    counts: { due: 0, overdue: 0, todayDue: 0, newItems: 0, cards: 0, cardsDue: 0, reviewedToday: 0 },
    progress: 0,
    estimatedMinutes: 0,
    hero: { primary: null },
    queue: [],
    tree: [],
    forecast: Array.from({ length: 7 }, (_, index) => {
      const date = addDays(today, index);
      const weekday = ['日', '一', '二', '三', '四', '五', '六'][date.getDay()];
      return { label: index === 0 ? '今天' : `周${weekday}`, shortLabel: index === 0 ? '今天' : `周${weekday}`, count: 0, isToday: index === 0 };
    }),
    activity: Array.from({ length: 14 }, (_, index) => ({
      key: String(index), label: text.formatShortDate(addDays(today, index - 13)), count: 0, isToday: index === 13,
    })),
    streak: 0,
    reviews14d: 0,
    sources: [],
    recent: [],
    demo: false,
    srReady: false,
    isMobile: Boolean(options.isMobile),
  };
}

module.exports = { buildDemoModel, buildEmptyModel };
