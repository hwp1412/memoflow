"use strict";
(() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // src/ui/icons.js
  var require_icons = __commonJS({
    "src/ui/icons.js"(exports, module) {
      "use strict";
      var NS = "http://www.w3.org/2000/svg";
      var ICONS = {
        search: [
          { tag: "path", d: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" },
          { tag: "path", d: "m21 21-4.35-4.35" }
        ],
        refresh: [
          { tag: "path", d: "M20 11a8 8 0 0 0-14.9-4M4 4v4h4" },
          { tag: "path", d: "M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4" }
        ],
        more: [
          { tag: "circle", cx: 5, cy: 12, r: 1.4, fill: "currentColor", stroke: "none" },
          { tag: "circle", cx: 12, cy: 12, r: 1.4, fill: "currentColor", stroke: "none" },
          { tag: "circle", cx: 19, cy: 12, r: 1.4, fill: "currentColor", stroke: "none" }
        ],
        book: [
          { tag: "path", d: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 0 4 18.5V5.5Z" },
          { tag: "path", d: "M4 18.5A2.5 2.5 0 0 1 6.5 16H20" },
          { tag: "path", d: "M8 7h7M8 10.5h5" }
        ],
        extract: [
          { tag: "path", d: "M6 3h8l4 4v14H6z" },
          { tag: "path", d: "M14 3v4h4" },
          { tag: "path", d: "M9 12h6M9 16h6" }
        ],
        card: [
          { tag: "path", d: "M4 7h16v10H4z" },
          { tag: "path", d: "M8 11h8M8 14h5" }
        ],
        tree: [
          { tag: "path", d: "M6 4v16" },
          { tag: "path", d: "M6 8h5M11 8v4M11 12h7M6 14h5M11 14v4M11 18h7" }
        ],
        clock: [
          { tag: "path", d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
          { tag: "path", d: "M12 7v5l3 2" }
        ],
        flame: [
          { tag: "path", d: "M12 22c4 0 7-2.7 7-6.5 0-2.4-1.5-4.4-3.2-6.1C14.5 8.1 13 6 12 3c-.5 3-2 5.2-4 7.2C6.4 11.9 5 13.7 5 15.5 5 19.3 8 22 12 22Z" },
          { tag: "path", d: "M12 18c1.7 0 3-1.2 3-2.8 0-1.5-1.7-2.8-3-4.2-1.3 1.4-3 2.7-3 4.2 0 1.6 1.3 2.8 3 2.8Z" }
        ],
        target: [
          { tag: "path", d: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" },
          { tag: "path", d: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" },
          { tag: "circle", cx: 12, cy: 12, r: 1, fill: "currentColor", stroke: "none" }
        ],
        trend: [
          { tag: "path", d: "m4 17 6-6 4 4 6-8" },
          { tag: "path", d: "M20 7h-4M20 7v4" }
        ],
        chevronRight: [{ tag: "path", d: "m9 6 6 6-6 6" }],
        chevronDown: [{ tag: "path", d: "m6 9 6 6 6-6" }],
        arrowRight: [{ tag: "path", d: "M5 12h14M13 6l6 6-6 6" }],
        plus: [{ tag: "path", d: "M12 5v14M5 12h14" }],
        check: [{ tag: "path", d: "m5 12 4 4L19 6" }],
        spark: [{ tag: "path", d: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" }],
        alert: [
          { tag: "path", d: "M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" },
          { tag: "path", d: "M12 9v4" },
          { tag: "circle", cx: 12, cy: 16.5, r: 1, fill: "currentColor", stroke: "none" }
        ],
        inbox: [
          { tag: "path", d: "M4 13h4l2 3h4l2-3h4" },
          { tag: "path", d: "M4 13V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v7" },
          { tag: "path", d: "M4 13v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" }
        ],
        file: [
          { tag: "path", d: "M6 3h8l4 4v14H6z" },
          { tag: "path", d: "M14 3v4h4" }
        ],
        calendar: [
          { tag: "path", d: "M5 5h14v16H5z" },
          { tag: "path", d: "M8 3v4M16 3v4M5 10h14" }
        ],
        layers: [
          { tag: "path", d: "M12 3 3 8l9 5 9-5-9-5Z" },
          { tag: "path", d: "m3 13 9 5 9-5" },
          { tag: "path", d: "m3 18 9 5 9-5" }
        ],
        dot: [{ tag: "circle", cx: 12, cy: 12, r: 2, fill: "currentColor", stroke: "none" }],
        play: [{ tag: "path", d: "M8 5v14l11-7L8 5Z" }]
      };
      function createIcon(name, size = 16, className = "mf-icon") {
        const spec = ICONS[name] || ICONS.dot;
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.7");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");
        if (className) svg.setAttribute("class", className);
        for (const shape of spec) {
          const node = document.createElementNS(NS, shape.tag);
          for (const [key, value] of Object.entries(shape)) {
            if (key === "tag") continue;
            node.setAttribute(key, String(value));
          }
          svg.appendChild(node);
        }
        return svg;
      }
      module.exports = { ICONS, createIcon };
    }
  });

  // src/ui/copy.js
  var require_copy = __commonJS({
    "src/ui/copy.js"(exports, module) {
      "use strict";
      module.exports = {
        brand: "MemoFlow",
        subtitle: "增量阅读 · 间隔重复",
        searchPlaceholder: "搜索标题、来源或标签…",
        searchHint: "⌘K",
        start: "开始今日学习",
        openQueue: "打开阅读队列",
        todayStudy: "今日学习",
        remaining: (n) => `今天还有 ${n} 项`,
        todayDone: "今天的阅读已经清空",
        estimated: (value) => `预计阅读 ${value}`,
        nextUp: "接下来",
        nextUpEyebrow: "NEXT UP",
        open: "打开",
        openPdf: "PDF",
        queue: "优先级队列",
        queueAll: "全部",
        queueReading: "阅读",
        queueExtracts: "摘录",
        queueCards: "卡片",
        queueOverdue: "逾期",
        viewAll: (n) => `查看全部 ${n} 项`,
        sortUrgency: "紧急度",
        sortPriority: "优先级",
        sortDue: "到期日",
        rhythm: "学习节奏",
        streakUnit: "天",
        streakLabel: "连续学习",
        reviews14d: "近 14 天复习",
        forecast: "未来 7 天负荷",
        forecastTotal: (n) => `共 ${n} 项`,
        tree: "知识树",
        fullTree: "完整知识树",
        sources: "阅读中",
        pages: (read, total) => total ? `第 ${read} / ${total} 页` : "页码未记录",
        extracts: (n) => `${n} 条摘录`,
        recent: "最近摘录",
        quick: "快速开始",
        quickCard: "从剪贴板制卡",
        quickCardDesc: "复制一段话，直接变成卡片",
        quickExtract: "摘录选中 / 剪贴板",
        quickExtractDesc: "生成带时间戳与来源的摘录",
        quickNew: "新建来源 / 导入",
        quickNewDesc: "PDF、文章或一条新笔记",
        footer: "MemoFlow · built on Incremental Reading Toolkit",
        demoPill: "示例数据",
        demoBanner: "示例数据 · 仅用于预览界面，不会写入你的笔记",
        exitDemo: "退出示例",
        enterDemo: "查看示例布局",
        emptyQueueTitle: "还没有增量阅读素材",
        emptyQueueText: "把 PDF 放进 Vault，选中高亮或摘录，再回到这里开始今天的学习。",
        emptyQueueStep1: "放入 PDF 或文章",
        emptyQueueStep2: "用高亮 / 摘录收集素材",
        emptyQueueStep3: "开始今天的阅读队列",
        emptyTree: "知识树还是空的",
        emptySources: "还没有阅读中的 PDF 来源",
        emptyRecent: "还没有摘录",
        noMatch: "没有匹配项",
        loading: "正在整理今天的学习内容…",
        errorTitle: "页面加载失败",
        errorRetry: "重试",
        menuRefresh: "刷新数据",
        menuGuide: "使用指南",
        menuQueue: "打开阅读队列",
        menuTree: "打开知识树",
        menuDemoOn: "切换到示例数据",
        menuDemoOff: "切换回真实数据",
        cardHint: "卡片复习由 Spaced Repetition 管理",
        demoAction: "示例模式下不可操作，切换回真实数据后再试。",
        overdue: "逾期",
        today: "今天",
        newItem: "新素材",
        cards: "卡片",
        reviewCards: "复习卡片",
        unifiedReview: "开始学习",
        cardReview: "卡片复习",
        reviewFiltered: (n) => `复习筛选（${n}）`,
        overload: "过载处理",
        due: "待读",
        queueEmptyFiltered: "当前筛选下没有项目",
        moreHidden: (n) => `还有 ${n} 项`,
        priorityShort: (p) => `P${p}`,
        noPriority: "P—",
        afShort: (v) => `AF ${v}`,
        intervalShort: (v) => `${v} 天`,
        rhythmEmpty: "完成一次阅读评分后开始记录"
      };
    }
  });

  // src/ui/components.js
  var require_components = __commonJS({
    "src/ui/components.js"(exports, module) {
      "use strict";
      var { createIcon } = require_icons();
      var copy = require_copy();
      var SVG_NS = "http://www.w3.org/2000/svg";
      function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        if (props.cls) node.className = props.cls;
        if (props.text != null) node.textContent = String(props.text);
        if (props.title) node.title = props.title;
        if (props.attrs) {
          for (const [key, value] of Object.entries(props.attrs)) {
            if (value == null || value === false) continue;
            node.setAttribute(key, value === true ? "" : String(value));
          }
        }
        if (props.style) {
          for (const [key, value] of Object.entries(props.style)) {
            if (key.startsWith("--")) node.style.setProperty(key, value);
            else node.style[key] = value;
          }
        }
        if (props.dataset) {
          for (const [key, value] of Object.entries(props.dataset)) {
            if (value != null) node.dataset[key] = String(value);
          }
        }
        if (props.on) {
          for (const [event, handler] of Object.entries(props.on)) node.addEventListener(event, handler);
        }
        appendChildren(node, children);
        return node;
      }
      function appendChildren(node, children) {
        const list = Array.isArray(children) ? children : [children];
        for (const child of list) {
          if (child == null || child === false) continue;
          if (Array.isArray(child)) appendChildren(node, child);
          else if (child instanceof Node) node.appendChild(child);
          else node.appendChild(document.createTextNode(String(child)));
        }
      }
      function icon(name, size = 16, className = "mf-icon") {
        return createIcon(name, size, className);
      }
      function button({
        label = "",
        iconName = null,
        variant = "ghost",
        title = "",
        action = null,
        data = null,
        iconOnly = false,
        onClick = null,
        className = ""
      } = {}) {
        const classes = ["mf-btn", `mf-btn-${variant}`];
        if (iconOnly) classes.push("mf-icon-btn");
        if (className) classes.push(className);
        const node = el("button", {
          cls: classes.join(" "),
          title: title || label,
          attrs: { type: "button", "aria-label": title || label },
          dataset: action ? { action, ...data || {} } : data
        });
        if (iconName) node.appendChild(icon(iconName, iconOnly ? 16 : 15));
        if (label) node.appendChild(el("span", { cls: "mf-btn-label", text: label }));
        if (onClick) node.addEventListener("click", onClick);
        return node;
      }
      function ring(value, { size = 132, stroke = 9, label = "今日进度" } = {}) {
        const pct = Math.max(0, Math.min(1, Number(value) || 0));
        const radius = (size - stroke) / 2;
        const circumference = 2 * Math.PI * radius;
        const wrap = el("div", {
          cls: "mf-ring",
          style: { width: `${size}px`, height: `${size}px` },
          attrs: { role: "img", "aria-label": `${label} ${Math.round(pct * 100)}%` }
        });
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
        svg.setAttribute("width", String(size));
        svg.setAttribute("height", String(size));
        svg.setAttribute("class", "mf-ring-svg");
        const track = document.createElementNS(SVG_NS, "circle");
        track.setAttribute("cx", String(size / 2));
        track.setAttribute("cy", String(size / 2));
        track.setAttribute("r", String(radius));
        track.setAttribute("class", "mf-ring-track");
        track.setAttribute("stroke-width", String(stroke));
        const valueCircle = document.createElementNS(SVG_NS, "circle");
        valueCircle.setAttribute("cx", String(size / 2));
        valueCircle.setAttribute("cy", String(size / 2));
        valueCircle.setAttribute("r", String(radius));
        valueCircle.setAttribute("class", "mf-ring-value");
        valueCircle.setAttribute("stroke-width", String(stroke));
        valueCircle.setAttribute("stroke-dasharray", `${circumference}`);
        valueCircle.setAttribute("stroke-dashoffset", `${circumference * (1 - pct)}`);
        valueCircle.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
        svg.appendChild(track);
        svg.appendChild(valueCircle);
        wrap.appendChild(svg);
        wrap.appendChild(el("div", { cls: "mf-ring-center" }, [
          el("span", { cls: "mf-ring-number", text: `${Math.round(pct * 100)}%` }),
          el("span", { cls: "mf-ring-label", text: label })
        ]));
        return wrap;
      }
      function barChart(items, { showValues = true, label = "" } = {}) {
        const list = Array.isArray(items) ? items : [];
        const max = Math.max(1, ...list.map((item) => Number(item.count) || 0));
        const chart = el("div", {
          cls: "mf-bars",
          attrs: { role: "img", "aria-label": label || `${list.length} 天学习负荷` }
        });
        list.forEach((item, index) => {
          const count = Number(item.count) || 0;
          const height = count ? Math.max(8, Math.round(count / max * 100)) : 2;
          const column = el("div", { cls: `mf-bar-col${item.isToday ? " is-today" : ""}` });
          if (showValues) {
            column.appendChild(el("span", { cls: "mf-bar-value", text: String(count) }));
          }
          const track = el("div", { cls: "mf-bar-track" });
          const bar = el("div", {
            cls: "mf-bar",
            style: { height: `${height}%` },
            title: `${item.label || ""}${count ? `：${count}` : "：无"}`
          });
          track.appendChild(bar);
          column.appendChild(track);
          const showLabel = item.isToday || list.length <= 10 || index % 2 === 0;
          column.appendChild(el("span", {
            cls: "mf-bar-label",
            text: showLabel ? item.isToday ? "今天" : item.shortLabel || item.label || "" : ""
          }));
          chart.appendChild(column);
        });
        return chart;
      }
      function progressBar(value, tone = "accent") {
        const pct = Math.max(0, Math.min(1, Number(value) || 0));
        const track = el("div", { cls: "mf-progress", attrs: { role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct * 100)) } });
        track.appendChild(el("div", { cls: `mf-progress-fill is-${tone}`, style: { width: `${pct * 100}%` } }));
        return track;
      }
      function typeIcon(type) {
        if (type === "source") return "book";
        if (type === "extract") return "extract";
        if (type === "card") return "card";
        if (type === "category") return "tree";
        return "file";
      }
      function typeClass(type) {
        return ["source", "extract", "card", "category"].includes(type) ? type : "file";
      }
      function priorityTone(priority) {
        if (priority == null) return "none";
        if (priority <= 25) return "high";
        if (priority <= 60) return "mid";
        return "low";
      }
      function emptyState({ iconName = "spark", title, text = "", steps = null, actions = [] } = {}) {
        const wrap = el("div", { cls: "mf-empty" });
        wrap.appendChild(el("div", { cls: "mf-empty-icon" }, [icon(iconName, 22)]));
        wrap.appendChild(el("h3", { cls: "mf-empty-title", text: title || "" }));
        if (text) wrap.appendChild(el("p", { cls: "mf-empty-text", text }));
        if (steps && steps.length) {
          const list = el("ol", { cls: "mf-steps" });
          for (const step of steps) list.appendChild(el("li", { text: step }));
          wrap.appendChild(list);
        }
        if (actions.length) {
          const row = el("div", { cls: "mf-empty-actions" });
          for (const action of actions) row.appendChild(button(action));
          wrap.appendChild(row);
        }
        return wrap;
      }
      function skeletonBlock(width = "100%", height = "14px", extra = "") {
        return el("div", { cls: `mf-skel ${extra}`.trim(), style: { width, height } });
      }
      function dashboardSkeleton() {
        const wrap = el("div", { cls: "mf-skeleton" });
        const hero = el("div", { cls: "mf-skel-hero" }, [
          skeletonBlock("38%", "34px"),
          skeletonBlock("22%", "18px"),
          skeletonBlock("100%", "88px", "mf-skel-soft")
        ]);
        const grid = el("div", { cls: "mf-skel-grid" }, [
          skeletonBlock("100%", "260px", "mf-skel-panel"),
          skeletonBlock("100%", "260px", "mf-skel-panel")
        ]);
        wrap.appendChild(hero);
        wrap.appendChild(grid);
        return wrap;
      }
      function countPill(value) {
        return el("span", { cls: "mf-count", text: String(value) });
      }
      function menuItem({ iconName, label, action, data }) {
        const node = el("button", {
          cls: "mf-menu-item",
          attrs: { type: "button" },
          dataset: { action, ...data || {} }
        });
        if (iconName) node.appendChild(icon(iconName, 15));
        node.appendChild(el("span", { text: label }));
        return node;
      }
      module.exports = {
        SVG_NS,
        el,
        appendChildren,
        icon,
        button,
        ring,
        barChart,
        progressBar,
        typeIcon,
        typeClass,
        priorityTone,
        emptyState,
        dashboardSkeleton,
        skeletonBlock,
        countPill,
        menuItem,
        copy
      };
    }
  });

  // src/data/text.js
  var require_text = __commonJS({
    "src/data/text.js"(exports, module) {
      "use strict";
      var WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }
      function pad2(value) {
        return String(value).padStart(2, "0");
      }
      function stripFrontmatter(content) {
        const text = String(content == null ? "" : content);
        if (!text.startsWith("---")) return text;
        const firstBreak = text.indexOf("\n");
        if (firstBreak === -1) return text;
        const closing = text.indexOf("\n---", firstBreak);
        if (closing === -1) return text;
        return text.slice(closing + 4).replace(/^\r?\n/, "");
      }
      function stripMarkdown(content) {
        let text = String(content == null ? "" : content);
        text = stripFrontmatter(text);
        text = text.replace(/<!--[\s\S]*?-->/g, " ");
        text = text.replace(/```[\s\S]*?```/g, " ");
        text = text.replace(/~~~[\s\S]*?~~~/g, " ");
        text = text.replace(/!\[\[([^\]]+)\]\]/g, " ");
        text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
        text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
        text = text.replace(/\[\[([^\]]+)\]\]/g, "$1");
        text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
        text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
        text = text.replace(/^[ \t]*>[ \t]?/gm, "");
        text = text.replace(/^[ \t]*\[![^\]]+\][+-]?/gm, "");
        text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
        text = text.replace(/(\*|_)(.*?)\1/g, "$2");
        text = text.replace(/~~(.*?)~~/g, "$1");
        text = text.replace(/==(.*?)==/g, "$1");
        text = text.replace(/`([^`]+)`/g, "$1");
        text = text.replace(/<[^>]+>/g, " ");
        text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "");
        text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, "");
        text = text.replace(/^[ \t]*[-*_]{3,}[ \t]*$/gm, " ");
        text = text.replace(/📍|<!--ir-readpoint-->/g, " ");
        text = text.replace(/<!--[\s\S]*?-->/g, " ");
        text = text.replace(/[ \t]+/g, " ");
        text = text.replace(/\s*\n\s*/g, " ");
        return text.trim();
      }
      function extractExcerpt(content, maxLength = 180) {
        const text = stripMarkdown(content);
        if (!text) return "";
        const limit = Math.max(20, Number(maxLength) || 180);
        if (text.length <= limit) return text;
        const slice = text.slice(0, limit);
        const lastBreak = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"), slice.lastIndexOf("；"));
        const cut = lastBreak >= Math.floor(limit * 0.55) ? slice.slice(0, lastBreak + 1) : slice;
        return cut.replace(/[，、；：,;:\s]+$/, "") + "…";
      }
      function formatDateLabel(date) {
        const d = date instanceof Date ? date : new Date(date);
        return `${d.getMonth() + 1}月${d.getDate()}日 · ${WEEKDAYS[d.getDay()]}`;
      }
      function formatShortDate(date) {
        const d = date instanceof Date ? date : new Date(date);
        return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      }
      function startOfDay(value) {
        const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
        d.setHours(0, 0, 0, 0);
        return d;
      }
      function daysBetween(a, b) {
        return Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 864e5);
      }
      function formatRelativeDay(date, today) {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "未排期";
        const diff = daysBetween(date, today);
        if (diff === 0) return "今天";
        if (diff < 0) return `逾期 ${Math.abs(diff)} 天`;
        if (diff === 1) return "明天";
        if (diff <= 14) return `${diff} 天后`;
        return formatShortDate(date);
      }
      function formatMinutes(minutes) {
        const value = Math.max(0, Math.round(Number(minutes) || 0));
        if (value === 0) return "不到 1 分钟";
        if (value < 60) return `${value} 分钟`;
        const hours = Math.floor(value / 60);
        const rest = value % 60;
        return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
      }
      function formatNumber(value) {
        try {
          return new Intl.NumberFormat("zh-CN").format(Number(value) || 0);
        } catch (error) {
          return String(Number(value) || 0);
        }
      }
      function percent(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return Math.round(clamp(n, 0, 1) * 100);
      }
      module.exports = {
        WEEKDAYS,
        clamp,
        pad2,
        stripFrontmatter,
        stripMarkdown,
        extractExcerpt,
        formatDateLabel,
        formatShortDate,
        startOfDay,
        daysBetween,
        formatRelativeDay,
        formatMinutes,
        formatNumber,
        percent
      };
    }
  });

  // src/ui/dashboard.js
  var require_dashboard = __commonJS({
    "src/ui/dashboard.js"(exports, module) {
      "use strict";
      var {
        el,
        icon,
        button,
        ring,
        barChart,
        progressBar,
        typeIcon,
        typeClass,
        priorityTone,
        emptyState,
        dashboardSkeleton,
        countPill,
        copy
      } = require_components();
      var text = require_text();
      var SVG_NS = "http://www.w3.org/2000/svg";
      var TYPE_LABEL = { source: "阅读", extract: "摘录", card: "卡片", category: "分类" };
      function pad2(n) {
        return String(n).padStart(2, "0");
      }
      function formatAF(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return "";
        return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
      }
      function brandMark() {
        const wrap = el("span", { cls: "mf-mark" });
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 28 28");
        svg.setAttribute("width", "28");
        svg.setAttribute("height", "28");
        svg.setAttribute("aria-hidden", "true");
        const box = document.createElementNS(SVG_NS, "rect");
        box.setAttribute("x", "1");
        box.setAttribute("y", "1");
        box.setAttribute("width", "26");
        box.setAttribute("height", "26");
        box.setAttribute("rx", "8");
        box.setAttribute("fill", "currentColor");
        box.setAttribute("opacity", "0.12");
        svg.appendChild(box);
        for (const [d, width] of [["M8 10h12", 1.7], ["M8 14h9", 1.7], ["M8 18h6", 1.7]]) {
          const path = document.createElementNS(SVG_NS, "path");
          path.setAttribute("d", d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", "currentColor");
          path.setAttribute("stroke-width", String(width));
          path.setAttribute("stroke-linecap", "round");
          svg.appendChild(path);
        }
        const dot = document.createElementNS(SVG_NS, "circle");
        dot.setAttribute("cx", "20");
        dot.setAttribute("cy", "18");
        dot.setAttribute("r", "2.2");
        dot.setAttribute("fill", "currentColor");
        svg.appendChild(dot);
        wrap.appendChild(svg);
        return wrap;
      }
      function typeLabel(type) {
        return TYPE_LABEL[type] || "条目";
      }
      function typeBadge(type) {
        return el("span", { cls: `mf-type-badge is-${typeClass(type)}` }, [
          icon(typeIcon(type), 13),
          el("span", { text: typeLabel(type) })
        ]);
      }
      function createDashboard2(container, { onAction = () => {
      }, isMobile = false } = {}) {
        const root = el("div", { cls: `mf-view${isMobile ? " mf-mobile" : ""}` });
        container.appendChild(root);
        let currentModel = null;
        let currentState = null;
        let menuOpen = false;
        const dateEl = el("span", { cls: "mf-date" });
        const demoPill = el("span", { cls: "mf-demo-pill", text: copy.demoPill });
        demoPill.hidden = true;
        const searchInput = el("input", {
          cls: "mf-search-input",
          attrs: {
            type: "search",
            placeholder: copy.searchPlaceholder,
            "aria-label": copy.searchPlaceholder,
            autocomplete: "off",
            spellcheck: "false",
            "data-role": "search"
          }
        });
        const search = el("label", { cls: "mf-search" }, [
          icon("search", 15),
          searchInput,
          el("kbd", { cls: "mf-kbd", text: copy.searchHint })
        ]);
        const demoLabel = el("span", { text: copy.menuDemoOn });
        const menu = el("div", { cls: "mf-menu", attrs: { role: "menu" } }, [
          menuItem("refresh", copy.menuRefresh, "refresh"),
          menuItem("book", copy.menuGuide, "guide"),
          menuItem("layers", copy.menuQueue, "queue"),
          menuItem("tree", copy.menuTree, "tree"),
          menuItemWithLabel("spark", copy.menuDemoOn, "demo-toggle", demoLabel)
        ]);
        menu.hidden = true;
        const moreButton = button({ iconName: "more", iconOnly: true, title: "更多", action: "menu" });
        moreButton.setAttribute("aria-haspopup", "menu");
        const menuWrap = el("div", { cls: "mf-menu-wrap" }, [moreButton, menu]);
        const tools = el("div", { cls: "mf-header-tools" }, [
          search,
          button({ iconName: "refresh", iconOnly: true, title: "刷新数据", action: "refresh" }),
          menuWrap
        ]);
        const brand = el("div", { cls: "mf-brand" }, [
          brandMark(),
          el("div", { cls: "mf-brand-text" }, [
            el("div", { cls: "mf-wordmark", text: copy.brand }),
            el("div", { cls: "mf-subtitle", text: copy.subtitle })
          ])
        ]);
        const meta = el("div", { cls: "mf-header-meta" }, [dateEl, demoPill]);
        const header = el("header", { cls: "mf-header" }, [brand, meta, tools]);
        const bannerExit = button({ label: copy.exitDemo, variant: "subtle", action: "demo-toggle" });
        const banner = el("div", { cls: "mf-demo-banner", attrs: { hidden: true } }, [
          icon("spark", 16),
          el("span", { cls: "mf-demo-banner-text", text: copy.demoBanner }),
          bannerExit
        ]);
        const body = el("div", { cls: "mf-body" });
        const footer = el("footer", { cls: "mf-footer", text: copy.footer });
        root.append(header, banner, body, footer);
        function setLoading() {
          body.empty?.();
          body.textContent = "";
          body.appendChild(dashboardSkeleton());
        }
        function setError(message) {
          body.textContent = "";
          const card = el("div", { cls: "mf-card mf-error" }, [
            el("div", { cls: "mf-empty-icon" }, [icon("alert", 22)]),
            el("h3", { cls: "mf-empty-title", text: copy.errorTitle }),
            el("p", { cls: "mf-empty-text", text: message || "请重试。" }),
            button({ label: copy.errorRetry, variant: "primary", action: "retry" })
          ]);
          body.appendChild(card);
        }
        function updateHeader(model2) {
          dateEl.textContent = model2.dateLabel || "";
          demoPill.hidden = !model2.demo;
          banner.hidden = !model2.demo;
          demoLabel.textContent = model2.demo ? copy.menuDemoOff : copy.menuDemoOn;
          if (document.activeElement !== searchInput) {
            searchInput.value = currentState?.query || "";
          }
          root.classList.toggle("mf-mobile", Boolean(model2.isMobile || isMobile));
        }
        function update(model2, state2) {
          currentModel = model2;
          currentState = state2;
          updateHeader(model2);
          renderBody(model2, state2);
          closeMenu();
        }
        function updateLists(model2, state2) {
          currentModel = model2;
          currentState = state2;
          renderBody(model2, state2);
        }
        function renderBody(model2, state2) {
          body.textContent = "";
          body.appendChild(renderHero(model2, state2));
          body.appendChild(renderMain(model2, state2));
        }
        function renderHero(model2, state2) {
          const counts = model2.counts || {};
          const due = Number(counts.due) || 0;
          const newItems = Number(counts.newItems) || 0;
          const title = due > 0 ? `今天还有 ${due} 项` : newItems > 0 ? "今天没有到期项" : copy.todayDone;
          const subParts = [];
          if (due > 0) subParts.push(copy.estimated(text.formatMinutes(model2.estimatedMinutes)));
          if (counts.overdue > 0) subParts.push(`逾期 ${counts.overdue} 项`);
          else if (counts.todayDue > 0) subParts.push(`今日到期 ${counts.todayDue} 项`);
          if (newItems > 0) subParts.push(`${newItems} 条新素材`);
          if (!subParts.length) subParts.push("可以安心读一点新东西");
          const copyCol = el("div", { cls: "mf-hero-copy" }, [
            el("div", { cls: "mf-eyebrow" }, [icon("spark", 13), el("span", { text: copy.todayStudy })]),
            el("h1", { cls: "mf-hero-title" }, due > 0 ? [
              el("span", { text: "今天还有 " }),
              el("span", { cls: "mf-hero-number", text: String(due) }),
              el("span", { text: " 项" })
            ] : [el("span", { text: title })]),
            el("p", { cls: "mf-hero-sub", text: subParts.join(" · ") }),
            renderStats(model2),
            el("div", { cls: "mf-actions" }, [
              button({ label: copy.start, iconName: "play", variant: "primary", action: "start", className: "mf-btn-lg" }),
              button({ label: copy.openQueue, iconName: "layers", variant: "secondary", action: "queue" }),
              button({ label: copy.cardReview, iconName: "card", variant: "secondary", action: "card-review", title: "只复习问答 / Cloze 卡片" }),
              button({ label: copy.overload, iconName: "calendar", variant: "ghost", action: "overload", title: "摊平逾期主题" })
            ])
          ]);
          const ringWrap = el("div", { cls: "mf-hero-ring" }, [ring(model2.progress, { size: 136, stroke: 9 })]);
          const hero = el("section", { cls: "mf-card mf-hero-main" }, [copyCol, ringWrap]);
          const next = renderNext(model2, state2);
          return el("div", { cls: "mf-hero-grid" }, [hero, next]);
        }
        function renderStats(model2) {
          const counts = model2.counts || {};
          const cardsDue = Number(counts.cardsDue) || 0;
          const stats = [
            { label: "逾期", value: counts.overdue || 0, tone: counts.overdue ? "danger" : "", title: `${counts.overdue || 0} 项逾期` },
            { label: "今日到期", value: counts.todayDue || 0, tone: counts.todayDue ? "amber" : "", title: `${counts.todayDue || 0} 项今天到期` },
            { label: "新素材", value: counts.newItems || 0, tone: "", title: `${counts.newItems || 0} 条新素材` },
            model2.srReady ? { label: "卡片待复习", value: cardsDue, tone: cardsDue ? "amber" : "", title: `共 ${counts.cards || 0} 张卡片` } : { label: "卡片（需 SR）", value: "—", tone: "", title: "安装并启用 Spaced Repetition 后可复习卡片" }
          ];
          const row = el("div", { cls: "mf-stat-row" });
          for (const stat of stats) {
            row.appendChild(el("div", {
              cls: `mf-stat ${stat.tone ? `is-${stat.tone}` : ""}`.trim(),
              title: stat.title
            }, [
              el("span", { cls: "mf-stat-value", text: String(stat.value) }),
              el("span", { cls: "mf-stat-label", text: stat.label })
            ]));
          }
          return row;
        }
        function renderNext(model2, state2) {
          const item = model2.hero && model2.hero.primary;
          if (!item) {
            return el("aside", { cls: "mf-card mf-next-card is-empty" }, [
              el("div", { cls: "mf-eyebrow", text: copy.nextUp }),
              el("h2", { cls: "mf-next-title", text: copy.todayDone }),
              el("p", { cls: "mf-next-excerpt", text: "去读一点新东西，或者先看看示例布局。" }),
              el("div", { cls: "mf-next-actions" }, [
                model2.demo ? button({ label: copy.openQueue, iconName: "layers", variant: "secondary", action: "queue" }) : button({ label: copy.enterDemo, iconName: "spark", variant: "secondary", action: "demo-toggle" })
              ])
            ]);
          }
          const metaRow = el("div", { cls: "mf-next-meta" }, [
            item.priority != null ? el("span", { cls: `mf-pill is-${priorityTone(item.priority)}`, text: copy.priorityShort(item.priority) }) : null,
            item.interval ? el("span", { cls: "mf-next-meta-item", text: copy.intervalShort(item.interval) }) : null,
            item.aFactor ? el("span", { cls: "mf-next-meta-item", text: copy.afShort(formatAF(item.aFactor)) }) : null,
            el("span", { cls: `mf-due is-${item.dueTone}`, text: item.dueLabel, title: item.dueTitle })
          ]);
          const actions = [
            button({ label: copy.open, iconName: "arrowRight", variant: "secondary", action: "open", data: { path: item.path } })
          ];
          if (item.type === "source" && item.hasPdf) {
            actions.push(button({ label: copy.openPdf, iconName: "file", variant: "subtle", action: "open-pdf", data: { path: item.path } }));
          }
          return el("aside", { cls: "mf-card mf-next-card" }, [
            el("div", { cls: "mf-next-head" }, [
              el("div", { cls: "mf-eyebrow", text: copy.nextUpEyebrow }),
              typeBadge(item.type)
            ]),
            el("h2", { cls: "mf-next-title", text: item.basename }),
            item.sourceTitle ? el("div", { cls: "mf-next-source", text: `来源 · ${item.sourceTitle}` }) : null,
            el("p", { cls: "mf-next-excerpt", text: item.excerpt || "打开后继续上次的阅读位置。" }),
            metaRow,
            el("div", { cls: "mf-next-actions" }, actions)
          ]);
        }
        function renderMain(model2, state2) {
          const left = el("div", { cls: "mf-main-col" }, [renderQueue(model2, state2)]);
          const recent = renderRecent(model2, state2);
          if (recent) left.appendChild(recent);
          left.appendChild(renderQuickActions());
          const rail = el("aside", { cls: "mf-rail" }, [
            renderRhythm(model2),
            renderForecast(model2),
            renderTree(model2, state2),
            renderSources(model2)
          ]);
          return el("div", { cls: "mf-main" }, [left, rail]);
        }
        function panelHeading(title, count) {
          const heading = el("div", { cls: "mf-panel-heading" }, [
            el("span", { cls: "mf-title-dot" }),
            el("span", { cls: "mf-panel-title-text", text: title })
          ]);
          if (count != null) heading.appendChild(countPill(count));
          return heading;
        }
        function simplePanel({ title, count, cls = "", section = null, children = [] }) {
          const panel = el("section", {
            cls: `mf-card mf-panel ${cls}`.trim(),
            dataset: section ? { section } : null
          });
          panel.appendChild(el("div", { cls: "mf-panel-head" }, [panelHeading(title, count)]));
          for (const child of children) if (child) panel.appendChild(child);
          return panel;
        }
        function filterQueue(queue, state2) {
          const query = String(state2.query || "").trim().toLowerCase();
          let list = (queue || []).slice();
          if (state2.filter === "source" || state2.filter === "extract" || state2.filter === "card") {
            list = list.filter((item) => item.type === state2.filter);
          } else if (state2.filter === "overdue") {
            list = list.filter((item) => item.isOverdue);
          }
          if (query) {
            list = list.filter((item) => {
              const haystack = [item.basename, item.sourceTitle, typeLabel(item.type)].join(" ").toLowerCase();
              return haystack.includes(query);
            });
          }
          if (state2.sort === "priority") {
            list.sort((a, b) => {
              const ap = a.priority == null ? 999 : a.priority;
              const bp = b.priority == null ? 999 : b.priority;
              return ap - bp || String(a.basename).localeCompare(String(b.basename), "zh-CN");
            });
          } else if (state2.sort === "due") {
            list.sort((a, b) => {
              const at = a.dueTime == null ? Infinity : a.dueTime;
              const bt = b.dueTime == null ? Infinity : b.dueTime;
              return at - bt || String(a.basename).localeCompare(String(b.basename), "zh-CN");
            });
          }
          return list;
        }
        function renderQueue(model2, state2) {
          const queue = model2.queue || [];
          const filtered = filterQueue(queue, state2);
          const counts = {
            all: queue.length,
            source: queue.filter((item) => item.type === "source").length,
            extract: queue.filter((item) => item.type === "extract").length,
            card: queue.filter((item) => item.type === "card").length,
            overdue: queue.filter((item) => item.isOverdue).length
          };
          const chips = [
            ["all", copy.queueAll, counts.all],
            ["source", copy.queueReading, counts.source],
            ["extract", copy.queueExtracts, counts.extract],
            ["card", copy.queueCards, counts.card],
            ["overdue", copy.queueOverdue, counts.overdue]
          ];
          const chipRow = el("div", { cls: "mf-chips" });
          for (const [id, label, count] of chips) {
            chipRow.appendChild(el("button", {
              cls: `mf-chip${state2.filter === id ? " is-active" : ""}`,
              attrs: { type: "button" },
              dataset: { action: "filter", filter: id }
            }, [el("span", { text: label }), count ? el("span", { cls: "mf-chip-count", text: String(count) }) : null]));
          }
          const sort = el("select", { cls: "mf-sort", attrs: { "data-role": "sort", "aria-label": "队列排序" } });
          for (const [value, label] of [["urgency", copy.sortUrgency], ["priority", copy.sortPriority], ["due", copy.sortDue]]) {
            const option = el("option", { text: label, attrs: { value } });
            if (state2.sort === value) option.selected = true;
            sort.appendChild(option);
          }
          const panel = el("section", { cls: "mf-card mf-panel mf-queue-panel" });
          panel.appendChild(el("div", { cls: "mf-panel-head mf-panel-head-wrap" }, [
            panelHeading(copy.queue, filtered.length),
            el("div", { cls: "mf-panel-tools" }, [chipRow, sort])
          ]));
          if (!queue.length) {
            panel.appendChild(emptyState({
              iconName: "inbox",
              title: copy.emptyQueueTitle,
              text: copy.emptyQueueText,
              steps: [copy.emptyQueueStep1, copy.emptyQueueStep2, copy.emptyQueueStep3],
              actions: model2.demo ? [] : [button({ label: copy.enterDemo, variant: "secondary", action: "demo-toggle" })]
            }));
          } else if (!filtered.length) {
            panel.appendChild(emptyState({
              iconName: "search",
              title: copy.noMatch,
              text: "换个关键词，或清除当前筛选。",
              actions: [button({ label: "清除筛选", variant: "subtle", action: "clear-filters" })]
            }));
          } else {
            const rows = el("div", { cls: "mf-queue" });
            filtered.slice(0, 8).forEach((item, index) => rows.appendChild(renderQueueRow(item, index)));
            panel.appendChild(rows);
            const foot = el("div", { cls: "mf-panel-foot" });
            if ((state2.filter !== "all" || String(state2.query || "").trim()) && filtered.length) {
              foot.appendChild(button({
                label: copy.reviewFiltered(filtered.length),
                iconName: "play",
                variant: "secondary",
                action: "review-filtered",
                data: {
                  paths: JSON.stringify(filtered.map((item) => item.path).filter(Boolean)),
                  label: state2.filter === "overdue" ? "逾期筛选" : "队列筛选"
                }
              }));
            }
            if (filtered.length > 8) {
              foot.appendChild(button({ label: copy.viewAll(filtered.length), variant: "subtle", action: "more-queue" }));
            }
            if (foot.children.length) panel.appendChild(foot);
          }
          return panel;
        }
        function renderQueueRow(item, index) {
          const row = el("button", {
            cls: `mf-row${item.isOverdue ? " is-overdue" : ""}`,
            attrs: { type: "button", title: `${item.basename}（${typeLabel(item.type)}）` },
            dataset: { action: "open", path: item.path }
          });
          row.appendChild(el("span", { cls: "mf-row-index", text: pad2(index + 1) }));
          const editable = item.type !== "card";
          const prio = el("span", {
            cls: `mf-prio is-${priorityTone(item.priority)}${editable ? " is-editable" : ""}`,
            title: editable ? item.priority == null ? "点击设置优先级" : `优先级 ${item.priority}（数字越小越优先）；点击修改` : "卡片优先级由 Spaced Repetition 管理",
            attrs: editable ? { role: "button", tabindex: "0", "aria-label": "修改优先级" } : null
          }, [
            el("span", { cls: "mf-prio-bar" }),
            el("span", { cls: "mf-prio-text", text: item.priority == null ? copy.noPriority : copy.priorityShort(item.priority) })
          ]);
          if (editable) {
            const editPriority = (event) => {
              event.preventDefault();
              event.stopPropagation();
              onAction("queue-priority", { path: item.path });
            };
            prio.addEventListener("click", editPriority);
            prio.addEventListener("keydown", (event) => {
              if (event.key === "Enter" || event.key === " ") editPriority(event);
            });
          }
          row.appendChild(prio);
          row.appendChild(el("span", { cls: `mf-row-icon is-${typeClass(item.type)}` }, [icon(typeIcon(item.type), 16)]));
          const sub = item.sourceTitle ? `来源 · ${item.sourceTitle}` : typeLabel(item.type);
          row.appendChild(el("span", { cls: "mf-row-body" }, [
            el("span", { cls: "mf-row-title", text: item.basename }),
            el("span", { cls: "mf-row-sub", text: sub })
          ]));
          const meta2 = el("span", { cls: "mf-row-meta" }, [
            el("span", { cls: `mf-due is-${item.dueTone}`, text: item.dueLabel, title: item.dueTitle })
          ]);
          if (item.type !== "card") {
            if (item.interval) meta2.appendChild(el("span", { cls: "mf-meta", text: copy.intervalShort(item.interval) }));
            if (item.aFactor) meta2.appendChild(el("span", { cls: "mf-meta mf-af", text: copy.afShort(formatAF(item.aFactor)) }));
          }
          meta2.appendChild(icon("chevronRight", 15, "mf-row-arrow"));
          row.appendChild(meta2);
          return row;
        }
        function renderRhythm(model2) {
          const panel = el("section", { cls: "mf-card mf-panel mf-rhythm-panel", dataset: { section: "analytics" } });
          panel.appendChild(el("div", { cls: "mf-panel-head" }, [panelHeading(copy.rhythm)]));
          const top = el("div", { cls: "mf-rhythm-top" });
          const streak = Number(model2.streak) || 0;
          const reviews = Number(model2.reviews14d) || 0;
          top.appendChild(el("div", { cls: "mf-rhythm-stat" }, [
            el("div", { cls: "mf-rhythm-value" }, [
              el("span", { cls: "mf-rhythm-big", text: streak > 0 ? String(streak) : "—" }),
              el("span", { cls: "mf-rhythm-unit", text: copy.streakUnit })
            ]),
            el("div", { cls: "mf-rhythm-label", text: copy.streakLabel })
          ]));
          top.appendChild(el("div", { cls: "mf-rhythm-divider" }));
          top.appendChild(el("div", { cls: "mf-rhythm-stat" }, [
            el("div", { cls: "mf-rhythm-value" }, [
              el("span", { cls: "mf-rhythm-mid", text: String(reviews) }),
              el("span", { cls: "mf-rhythm-unit", text: "次" })
            ]),
            el("div", { cls: "mf-rhythm-label", text: copy.reviews14d })
          ]));
          panel.appendChild(top);
          if (reviews > 0) {
            panel.appendChild(el("div", { cls: "mf-activity" }, [barChart(model2.activity || [], { showValues: false, label: "近 14 天复习活动" })]));
          } else {
            panel.appendChild(el("p", { cls: "mf-panel-note", text: copy.rhythmEmpty }));
            panel.appendChild(el("div", { cls: "mf-activity is-muted" }, [barChart(model2.activity || [], { showValues: false, label: "近 14 天复习活动" })]));
          }
          return panel;
        }
        function renderForecast(model2) {
          const items = model2.forecast || [];
          const total = items.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
          const panel = simplePanel({ title: copy.forecast, count: total, cls: "mf-forecast-panel" });
          panel.appendChild(el("div", { cls: "mf-forecast" }, [barChart(items, { showValues: true, label: "未来 7 天负荷" })]));
          if (!total) panel.appendChild(el("p", { cls: "mf-panel-note", text: "未来 7 天没有安排。" }));
          return panel;
        }
        function filterTreeNodes(nodes, query) {
          if (!query) return nodes || [];
          const out = [];
          for (const node of nodes || []) {
            const children = filterTreeNodes(node.children, query);
            if (String(node.basename || "").toLowerCase().includes(query) || children.length) {
              out.push({ ...node, children });
            }
          }
          return out;
        }
        function countTreeNodes(nodes) {
          let total = 0;
          for (const node of nodes || []) total += 1 + countTreeNodes(node.children);
          return total;
        }
        function renderTree(model2, state2) {
          const query = String(state2.query || "").trim().toLowerCase();
          const nodes = filterTreeNodes(model2.tree || [], query);
          const total = countTreeNodes(model2.tree || []);
          const panel = simplePanel({ title: copy.tree, count: total, cls: "mf-tree-panel" });
          if (!nodes.length) {
            panel.appendChild(el("div", { cls: "mf-mini-empty" }, [
              icon("tree", 18),
              el("p", { text: query ? copy.noMatch : copy.emptyTree })
            ]));
            panel.appendChild(el("div", { cls: "mf-panel-foot" }, [
              button({ label: copy.fullTree, variant: "subtle", action: "tree-full" })
            ]));
            return panel;
          }
          const body2 = el("div", { cls: "mf-tree" });
          const renderNode = (node, depth) => {
            const forceOpen = Boolean(query);
            const isExpanded = forceOpen || (depth === 0 ? !state2.collapsed?.has(node.path) : Boolean(state2.expanded?.has(node.path)));
            const row = el("div", { cls: "mf-tree-row", style: { "--depth": String(depth) } });
            if (node.children && node.children.length) {
              const toggle = button({
                iconName: isExpanded ? "chevronDown" : "chevronRight",
                iconOnly: true,
                title: isExpanded ? "收起" : "展开",
                action: "tree-toggle",
                data: { path: node.path, depth: String(depth) },
                className: "mf-tree-toggle"
              });
              toggle.setAttribute("aria-expanded", String(isExpanded));
              row.appendChild(toggle);
            } else {
              row.appendChild(el("span", { cls: "mf-tree-spacer" }));
            }
            row.appendChild(el("button", {
              cls: `mf-tree-label is-${typeClass(node.type)}`,
              attrs: { type: "button", title: node.basename },
              dataset: { action: "open-note", path: node.path }
            }, [
              icon(typeIcon(node.type), 14),
              el("span", { cls: "mf-tree-name", text: node.basename }),
              node.dueCount > 0 ? el("span", { cls: "mf-tree-due", text: String(node.dueCount) }) : null
            ]));
            body2.appendChild(row);
            if (isExpanded && node.children && node.children.length) {
              for (const child of node.children) renderNode(child, depth + 1);
            }
            if (isExpanded && node.hiddenCount > 0) {
              body2.appendChild(el("div", { cls: "mf-tree-more", style: { "--depth": String(depth + 1) } }, [
                el("span", { text: copy.moreHidden(node.hiddenCount) })
              ]));
            }
          };
          for (const node of nodes) renderNode(node, 0);
          panel.appendChild(body2);
          panel.appendChild(el("div", { cls: "mf-panel-foot" }, [
            button({ label: copy.fullTree, variant: "subtle", action: "tree-full" })
          ]));
          return panel;
        }
        function renderSources(model2) {
          const sources = model2.sources || [];
          const panel = simplePanel({ title: copy.sources, count: sources.length, cls: "mf-sources-panel" });
          if (!sources.length) {
            panel.appendChild(el("div", { cls: "mf-mini-empty" }, [
              icon("file", 18),
              el("p", { text: copy.emptySources })
            ]));
            return panel;
          }
          for (const source of sources) {
            const item = el("div", { cls: "mf-source" });
            const top = el("div", { cls: "mf-source-top" });
            top.appendChild(el("button", {
              cls: "mf-source-title",
              attrs: { type: "button", title: source.basename },
              dataset: { action: "open-note", path: source.path }
            }, [
              icon("book", 14),
              el("span", { text: source.basename })
            ]));
            if (source.hasPdf) {
              top.appendChild(button({
                label: copy.openPdf,
                iconName: "file",
                variant: "subtle",
                action: "open-pdf",
                data: { path: source.path },
                className: "mf-pdf-btn"
              }));
            }
            item.appendChild(top);
            item.appendChild(el("div", { cls: "mf-source-meta" }, [
              el("span", { text: copy.pages(source.readPoint || 0, source.totalPages) }),
              el("span", { cls: "mf-dot-sep" }),
              el("span", { text: copy.extracts(source.extractCount) })
            ]));
            item.appendChild(progressBar(source.progress, "accent"));
            panel.appendChild(item);
          }
          return panel;
        }
        function renderQuickActions() {
          const panel = simplePanel({ title: copy.quick, cls: "mf-quick-panel" });
          const grid = el("div", { cls: "mf-quick-grid" });
          const items = [
            { action: "quick-card", iconName: "card", title: copy.quickCard, desc: copy.quickCardDesc },
            { action: "quick-extract", iconName: "extract", title: copy.quickExtract, desc: copy.quickExtractDesc },
            { action: "quick-new", iconName: "plus", title: copy.quickNew, desc: copy.quickNewDesc }
          ];
          for (const item of items) {
            grid.appendChild(el("button", {
              cls: "mf-quick",
              attrs: { type: "button" },
              dataset: { action: item.action }
            }, [
              el("span", { cls: "mf-quick-icon" }, [icon(item.iconName, 17)]),
              el("span", { cls: "mf-quick-title", text: item.title }),
              el("span", { cls: "mf-quick-desc", text: item.desc })
            ]));
          }
          panel.appendChild(grid);
          return panel;
        }
        function renderRecent(model2) {
          const recent = model2.recent || [];
          if (!recent.length) return null;
          const panel = simplePanel({ title: copy.recent, count: recent.length, cls: "mf-recent-panel" });
          const grid = el("div", { cls: "mf-recent" });
          for (const item of recent) {
            const buttonNode = el("button", {
              cls: "mf-quote",
              attrs: { type: "button", title: item.title || item.basename },
              dataset: { action: "open", path: item.path }
            });
            buttonNode.appendChild(el("span", { cls: "mf-quote-text", text: item.text || "（正文为空）" }));
            const meta2 = [item.sourceTitle || item.title];
            if (item.page) meta2.push(`第 ${item.page} 页`);
            buttonNode.appendChild(el("span", { cls: "mf-quote-meta", text: meta2.filter(Boolean).join(" · ") }));
            grid.appendChild(buttonNode);
          }
          panel.appendChild(grid);
          return panel;
        }
        function menuItem(iconName, label, action) {
          return el("button", {
            cls: "mf-menu-item",
            attrs: { type: "button" },
            dataset: { action }
          }, [icon(iconName, 15), el("span", { text: label })]);
        }
        function menuItemWithLabel(iconName, label, action, labelEl) {
          return el("button", {
            cls: "mf-menu-item",
            attrs: { type: "button" },
            dataset: { action }
          }, [icon(iconName, 15), labelEl]);
        }
        function toggleMenu(force) {
          menuOpen = force != null ? force : !menuOpen;
          menu.hidden = !menuOpen;
          moreButton.classList.toggle("is-active", menuOpen);
          moreButton.setAttribute("aria-expanded", String(menuOpen));
        }
        function closeMenu() {
          if (menuOpen) toggleMenu(false);
        }
        function handleClick(event) {
          const target = event.target.closest("[data-action]");
          if (!target || !root.contains(target)) return;
          const action = target.dataset.action;
          if (action === "menu") {
            event.preventDefault();
            event.stopPropagation();
            toggleMenu();
            return;
          }
          closeMenu();
          const data = { ...target.dataset };
          try {
            onAction(action, data);
          } catch (error) {
            console.error("[MemoFlow] action failed", action, error);
          }
        }
        function handleInput(event) {
          const input = event.target.closest('[data-role="search"]');
          if (!input) return;
          onAction("search", { query: input.value });
        }
        function handleChange(event) {
          const select = event.target.closest('[data-role="sort"]');
          if (!select) return;
          onAction("sort", { sort: select.value });
        }
        function handleKeydown(event) {
          if (!root.isConnected) return;
          const metaKey = event.metaKey || event.ctrlKey;
          if (metaKey && String(event.key).toLowerCase() === "k") {
            event.preventDefault();
            searchInput.focus();
            searchInput.select();
            return;
          }
          if (event.key === "Escape") {
            if (menuOpen) {
              closeMenu();
              return;
            }
            if (document.activeElement === searchInput) {
              if (searchInput.value) {
                searchInput.value = "";
                onAction("search", { query: "" });
              } else {
                searchInput.blur();
              }
            }
          }
        }
        function handleDocumentClick(event) {
          if (!menuOpen) return;
          if (menuWrap.contains(event.target)) return;
          closeMenu();
        }
        root.addEventListener("click", handleClick);
        root.addEventListener("input", handleInput);
        root.addEventListener("change", handleChange);
        document.addEventListener("keydown", handleKeydown);
        document.addEventListener("click", handleDocumentClick);
        function scrollToAnalytics() {
          const section = root.querySelector('[data-section="analytics"]');
          if (section && typeof section.scrollIntoView === "function") {
            section.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        }
        function setSearchValue(value) {
          searchInput.value = value == null ? "" : String(value);
        }
        function destroy() {
          document.removeEventListener("keydown", handleKeydown);
          document.removeEventListener("click", handleDocumentClick);
          root.remove();
        }
        return {
          root,
          update,
          updateLists,
          setLoading,
          setError,
          scrollToAnalytics,
          setSearchValue,
          destroy
        };
      }
      module.exports = { createDashboard: createDashboard2 };
    }
  });

  // src/data/demo.js
  var require_demo = __commonJS({
    "src/data/demo.js"(exports, module) {
      "use strict";
      var text = require_text();
      function addDays(today, offset) {
        const d = new Date(today.getTime());
        d.setDate(d.getDate() + offset);
        return d;
      }
      function pad(n) {
        return String(n).padStart(2, "0");
      }
      function formatDmy(date) {
        return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
      }
      function dueLabelFor(offset) {
        if (offset === 0) return "今天";
        if (offset < 0) return `逾期 ${Math.abs(offset)} 天`;
        if (offset === 1) return "明天";
        return `${offset} 天后`;
      }
      function dueToneFor(offset) {
        if (offset < 0) return "overdue";
        if (offset === 0) return "today";
        return "future";
      }
      function makeItem(today, options) {
        const offset = options.offset;
        const dueDate = offset == null ? null : addDays(today, offset);
        const type = options.type;
        return {
          path: `demo/${encodeURIComponent(options.basename)}.md`,
          basename: options.basename,
          type,
          sourceTitle: options.sourceTitle || "",
          priority: options.priority,
          interval: options.interval == null ? null : options.interval,
          aFactor: options.aFactor == null ? null : options.aFactor,
          status: options.status || "active",
          dueDate,
          dueTime: dueDate ? dueDate.getTime() : null,
          dueLabel: type === "card" ? "卡片" : dueDate ? dueLabelFor(offset) : "新素材",
          dueTitle: type === "card" ? "卡片复习由 Spaced Repetition 管理" : dueDate ? formatDmy(dueDate) : "还没有安排下次复习",
          dueTone: type === "card" ? "card" : dueDate ? dueToneFor(offset) : "new",
          isOverdue: type !== "card" && dueDate != null && offset < 0,
          hasPdf: Boolean(options.hasPdf),
          urgency: 0,
          excerpt: options.excerpt || "",
          tfile: null,
          fm: null
        };
      }
      function makeTree() {
        return [
          {
            path: "demo/tree/阅读主题",
            basename: "阅读主题",
            type: "category",
            dueCount: 9,
            hasChildren: true,
            hiddenCount: 0,
            children: [
              {
                path: "demo/tree/学会提问",
                basename: "学会提问",
                type: "source",
                dueCount: 5,
                hasChildren: true,
                hiddenCount: 0,
                children: [
                  { path: "demo/tree/学会提问 Extract 1", basename: "学会提问 Extract 1", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
                  { path: "demo/tree/学会提问 Extract 2", basename: "学会提问 Extract 2", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
                  { path: "demo/tree/学会提问 Extract 3", basename: "学会提问 Extract 3", type: "extract", dueCount: 0, children: [], hasChildren: false, hiddenCount: 0 }
                ]
              },
              {
                path: "demo/tree/如何阅读一本书",
                basename: "如何阅读一本书",
                type: "source",
                dueCount: 4,
                hasChildren: true,
                hiddenCount: 0,
                children: [
                  { path: "demo/tree/如何阅读一本书 Extract 1", basename: "如何阅读一本书 Extract 1", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
                  { path: "demo/tree/如何阅读一本书 Extract 2", basename: "如何阅读一本书 Extract 2", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 }
                ]
              }
            ]
          },
          {
            path: "demo/tree/认知科学",
            basename: "认知科学",
            type: "category",
            dueCount: 7,
            hasChildren: true,
            hiddenCount: 0,
            children: [
              {
                path: "demo/tree/深度工作",
                basename: "深度工作",
                type: "source",
                dueCount: 3,
                hasChildren: true,
                hiddenCount: 0,
                children: [
                  { path: "demo/tree/深度工作 Extract 1", basename: "深度工作 Extract 1", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
                  { path: "demo/tree/深度工作 Extract 2", basename: "深度工作 Extract 2", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 }
                ]
              },
              {
                path: "demo/tree/思考，快与慢",
                basename: "思考，快与慢",
                type: "source",
                dueCount: 4,
                hasChildren: true,
                hiddenCount: 0,
                children: [
                  { path: "demo/tree/思考，快与慢 Extract 1", basename: "思考，快与慢 Extract 1", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 },
                  { path: "demo/tree/思考，快与慢 Extract 2", basename: "思考，快与慢 Extract 2", type: "extract", dueCount: 1, children: [], hasChildren: false, hiddenCount: 0 }
                ]
              }
            ]
          }
        ];
      }
      function buildDemoModel2(todayInput, options = {}) {
        const today = todayInput instanceof Date ? new Date(todayInput.getTime()) : /* @__PURE__ */ new Date();
        today.setHours(0, 0, 0, 0);
        const isMobile = Boolean(options.isMobile);
        const queue = [
          makeItem(today, {
            basename: "学会提问 Extract 1",
            type: "extract",
            sourceTitle: "学会提问",
            priority: 8,
            offset: -2,
            interval: 3,
            aFactor: 2,
            excerpt: "海绵式思维相对被动，它并不需要你绞尽脑汁，但它的致命缺陷是：对哪些信息可以相信、哪些应该摒弃，提供不了任何判断方法。"
          }),
          makeItem(today, {
            basename: "如何阅读一本书 Extract 2",
            type: "extract",
            sourceTitle: "如何阅读一本书",
            priority: 12,
            offset: -1,
            interval: 4,
            aFactor: 2.1,
            excerpt: "分析阅读的四个问题：这本书在谈什么？作者细部说了什么、怎么说的？这本书说得有道理吗？这本书跟我有什么关系？"
          }),
          makeItem(today, {
            basename: "学会提问 Extract 4",
            type: "extract",
            sourceTitle: "学会提问",
            priority: 15,
            offset: 0,
            interval: 2,
            aFactor: 1.75,
            excerpt: "淘金式思维要求读者主动提问、与作者互动，而不是像海绵一样被动吸收。"
          }),
          makeItem(today, {
            basename: "如何阅读一本书 Extract 4",
            type: "extract",
            sourceTitle: "如何阅读一本书",
            priority: 20,
            offset: -1,
            interval: 3,
            aFactor: 2.05,
            excerpt: "在检视阅读中，速度不是目的，理解结构才是；先看骨架，再决定哪里值得慢下来。"
          }),
          makeItem(today, {
            basename: "深度工作 Extract 1",
            type: "extract",
            sourceTitle: "深度工作",
            priority: 18,
            offset: 0,
            interval: 6,
            aFactor: 1.8,
            excerpt: "深度工作是在无干扰状态下专注进行职业活动，使个人的认知能力达到极限。这种努力能够创造新价值，提升技能，而且难以复制。"
          }),
          makeItem(today, {
            basename: "思考，快与慢 Extract 1",
            type: "extract",
            sourceTitle: "思考，快与慢",
            priority: 25,
            offset: 0,
            interval: 5,
            aFactor: 2.3,
            excerpt: "系统 1 的运行是自动且快速的，几乎不需要努力；系统 2 则调动注意力来分析和解决问题，它比较慢，也更可靠。"
          }),
          makeItem(today, {
            basename: "学会提问",
            type: "source",
            sourceTitle: "阅读主题",
            priority: 51,
            offset: -4,
            interval: 8,
            aFactor: 1.33,
            hasPdf: true,
            excerpt: "批判性思维不是一味反对，而是在相信或拒绝一个观点之前，先问清楚它的事实依据、概念含义与推理过程。"
          }),
          makeItem(today, {
            basename: "如何阅读一本书",
            type: "source",
            sourceTitle: "阅读主题",
            priority: 40,
            offset: 0,
            interval: 6,
            aFactor: 1.62,
            excerpt: "阅读的层次分为基础阅读、检视阅读、分析阅读和主题阅读。真正困难的不是读完，而是带着问题读。"
          }),
          makeItem(today, {
            basename: "深度工作",
            type: "source",
            sourceTitle: "认知科学",
            priority: 30,
            offset: 1,
            interval: 9,
            aFactor: 1.45,
            excerpt: "注意力残留会让人在任务切换后仍有一部分注意力停留在上一件事上，这就是为什么频繁查看消息会让深度工作变得昂贵。"
          }),
          makeItem(today, {
            basename: "思考，快与慢 Extract 2",
            type: "extract",
            sourceTitle: "思考，快与慢",
            priority: 35,
            offset: 2,
            interval: 4,
            aFactor: 2,
            excerpt: "锚定效应：人们在做判断时，会不自觉地过度依赖最初接触到的信息，即使这个信息与当前问题毫无关系。"
          }),
          makeItem(today, {
            basename: "学会提问 Extract 2",
            type: "extract",
            sourceTitle: "学会提问",
            priority: 22,
            offset: 2,
            interval: 3,
            aFactor: 1.9,
            excerpt: "一个论证由结论和理由构成。要评价一个论证，先找到作者的结论，再看他给出的理由能不能支撑这个结论。"
          }),
          makeItem(today, {
            basename: "如何阅读一本书 Extract 1",
            type: "extract",
            sourceTitle: "如何阅读一本书",
            priority: 45,
            offset: 3,
            interval: 5,
            aFactor: 2.2,
            excerpt: "检视阅读的任务是在有限时间里抓住一本书的骨架：先看标题、序言、目录和索引，再快速通读，不要被细节拖住。"
          }),
          makeItem(today, {
            basename: "深度工作 Extract 2",
            type: "extract",
            sourceTitle: "深度工作",
            priority: 55,
            offset: 4,
            interval: 7,
            aFactor: 1.7,
            excerpt: "与其追求长时间工作，不如把注意力当成稀缺资源来管理：设定固定的深度工作时段，并像对待会议一样保护它。"
          }),
          makeItem(today, {
            basename: "思考，快与慢 Extract 3",
            type: "extract",
            sourceTitle: "思考，快与慢",
            priority: 60,
            offset: 5,
            interval: 6,
            aFactor: 2.4,
            excerpt: "后见之明偏差让我们在事情发生后觉得结果“本来就可以预料”，从而高估自己当初的判断能力。"
          }),
          makeItem(today, {
            basename: "思考，快与慢",
            type: "source",
            sourceTitle: "认知科学",
            priority: 65,
            offset: 6,
            interval: 10,
            aFactor: 1.5,
            excerpt: "我们以为自己在理性地判断，但大量判断其实来自快速、直觉、自动的系统 1。"
          }),
          makeItem(today, {
            basename: "学会提问 Extract 3",
            type: "extract",
            sourceTitle: "学会提问",
            priority: 28,
            offset: null,
            interval: null,
            aFactor: 2,
            excerpt: "描述性假设是作者没有明说、但论证必须成立的前提。找到它，往往是评价一个论证的关键一步。"
          }),
          makeItem(today, {
            basename: "如何阅读一本书 Extract 3",
            type: "extract",
            sourceTitle: "如何阅读一本书",
            priority: 32,
            offset: null,
            interval: null,
            aFactor: 1.85,
            excerpt: "主题阅读不是把几本书各读一遍，而是围绕同一个问题，让不同作者在你的问题下对话。"
          }),
          makeItem(today, {
            basename: "人类简史",
            type: "source",
            sourceTitle: "认知科学",
            priority: 70,
            offset: null,
            interval: null,
            aFactor: 1.3,
            excerpt: "智人能够大规模协作，很大程度上依赖于共同相信的虚构故事：国家、货币、公司、法律。"
          }),
          makeItem(today, {
            basename: "学会提问 - Card 1",
            type: "card",
            sourceTitle: "学会提问",
            priority: 60,
            offset: null,
            interval: null,
            aFactor: null,
            excerpt: "海绵式思维与淘金式思维的区别是什么？"
          }),
          makeItem(today, {
            basename: "深度工作 - Card 1",
            type: "card",
            sourceTitle: "深度工作",
            priority: 70,
            offset: null,
            interval: null,
            aFactor: null,
            excerpt: "什么是注意力残留？"
          })
        ];
        queue.forEach((item, index) => {
          item.urgency = 1e4 - index;
        });
        const due = queue.filter((item) => item.type !== "card" && item.dueTime != null && item.dueDate <= today).length;
        const overdue = queue.filter((item) => item.isOverdue).length;
        const todayDue = queue.filter((item) => item.type !== "card" && item.dueTime != null && item.dueDate.getTime() === today.getTime()).length;
        const newItems = queue.filter((item) => item.type !== "card" && item.dueTime == null).length;
        const cards = queue.filter((item) => item.type === "card").length;
        const reviewedToday = 16;
        const progress = due + reviewedToday === 0 ? 1 : Math.min(1, reviewedToday / (reviewedToday + due));
        const estimatedMinutes = Math.max(0, Math.round(due * 1.5 / 5) * 5);
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
            { label: "今天", shortLabel: "今天", count: due, isToday: true },
            { label: "明天", shortLabel: "明天", count: 2, isToday: false },
            { label: "周三", shortLabel: "周三", count: 3, isToday: false },
            { label: "周四", shortLabel: "周四", count: 2, isToday: false },
            { label: "周五", shortLabel: "周五", count: 2, isToday: false },
            { label: "周六", shortLabel: "周六", count: 1, isToday: false },
            { label: "周日", shortLabel: "周日", count: 2, isToday: false }
          ],
          activity: [3, 5, 8, 4, 9, 12, 6, 11, 14, 9, 16, 12, 18, 15].map((count, index, arr) => ({
            key: String(index),
            label: index === arr.length - 1 ? "今天" : text.formatShortDate(addDays(today, index - (arr.length - 1))),
            count,
            isToday: index === arr.length - 1
          })),
          streak: 12,
          reviews14d: 142,
          sources: [
            { path: "demo/source/学会提问", basename: "学会提问", type: "source", readPoint: 190, totalPages: 308, progress: 190 / 308, extractCount: 3, hasPdf: true, lastReviewed: 0, tfile: null, fm: null },
            { path: "demo/source/如何阅读一本书", basename: "如何阅读一本书", type: "source", readPoint: 87, totalPages: 424, progress: 87 / 424, extractCount: 3, hasPdf: false, lastReviewed: 0, tfile: null, fm: null },
            { path: "demo/source/深度工作", basename: "深度工作", type: "source", readPoint: 42, totalPages: 296, progress: 42 / 296, extractCount: 2, hasPdf: false, lastReviewed: 0, tfile: null, fm: null }
          ],
          srReady: true,
          recent: [
            {
              path: "demo/extract/海绵式思维",
              basename: "学会提问 Extract 1",
              title: "学会提问 Extract 1",
              sourceTitle: "学会提问",
              page: 12,
              text: "海绵式思维相对被动，它并不需要你绞尽脑汁，但它的致命缺陷是：对哪些信息可以相信、哪些应该摒弃，提供不了任何判断方法。"
            },
            {
              path: "demo/extract/分析阅读",
              basename: "如何阅读一本书 Extract 2",
              title: "如何阅读一本书 Extract 2",
              sourceTitle: "如何阅读一本书",
              page: 87,
              text: "分析阅读的四个问题：这本书在谈什么？作者细部说了什么、怎么说的？这本书说得有道理吗？这本书跟我有什么关系？"
            },
            {
              path: "demo/extract/深度工作",
              basename: "深度工作 Extract 1",
              title: "深度工作 Extract 1",
              sourceTitle: "深度工作",
              page: 42,
              text: "深度工作是在无干扰状态下专注进行职业活动，使个人的认知能力达到极限。这种努力能够创造新价值，提升技能，而且难以复制。"
            }
          ],
          demo: true,
          isMobile
        };
      }
      function buildEmptyModel2(todayInput, options = {}) {
        const today = todayInput instanceof Date ? new Date(todayInput.getTime()) : /* @__PURE__ */ new Date();
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
            const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
            return { label: index === 0 ? "今天" : `周${weekday}`, shortLabel: index === 0 ? "今天" : `周${weekday}`, count: 0, isToday: index === 0 };
          }),
          activity: Array.from({ length: 14 }, (_, index) => ({
            key: String(index),
            label: text.formatShortDate(addDays(today, index - 13)),
            count: 0,
            isToday: index === 13
          })),
          streak: 0,
          reviews14d: 0,
          sources: [],
          recent: [],
          demo: false,
          srReady: false,
          isMobile: Boolean(options.isMobile)
        };
      }
      module.exports = { buildDemoModel: buildDemoModel2, buildEmptyModel: buildEmptyModel2 };
    }
  });

  // preview/preview.js
  var { createDashboard } = require_dashboard();
  var { buildDemoModel, buildEmptyModel } = require_demo();
  var params = new URLSearchParams(window.location.search);
  var app = document.getElementById("app");
  var state = {
    query: "",
    filter: "all",
    sort: "urgency",
    demo: params.get("demo") !== "0",
    empty: params.get("empty") === "1",
    theme: params.get("theme") === "dark" ? "dark" : "light",
    narrow: params.get("narrow") === "1",
    expanded: /* @__PURE__ */ new Set(),
    collapsed: /* @__PURE__ */ new Set()
  };
  document.body.classList.toggle("theme-dark", state.theme === "dark");
  document.body.classList.toggle("mf-preview-narrow", state.narrow);
  document.body.classList.toggle("preview-bare", params.get("bare") === "1");
  var fixedWidth = Number(params.get("w"));
  if (Number.isFinite(fixedWidth) && fixedWidth > 0) {
    document.documentElement.style.setProperty("--mf-preview-width", `${fixedWidth}px`);
    document.body.classList.add("mf-preview-fixed-width");
  }
  var ui = createDashboard(app, {
    onAction: handleAction,
    isMobile: window.innerWidth < 720
  });
  function buildModel() {
    const model2 = state.empty ? buildEmptyModel(/* @__PURE__ */ new Date(), { isMobile: window.innerWidth < 720 }) : buildDemoModel(/* @__PURE__ */ new Date(), { isMobile: window.innerWidth < 720 });
    if (!state.empty) model2.demo = state.demo;
    if (!state.empty) model2.isMobile = window.innerWidth < 720;
    return model2;
  }
  var model = buildModel();
  ui.update(model, state);
  if (params.get("debug") === "1") {
    const view = document.querySelector(".mf-view");
    const hero = document.querySelector(".mf-hero-main");
    const queue = document.querySelector(".mf-queue-panel");
    const body = document.querySelector(".mf-body");
    const metrics = {
      innerWidth: window.innerWidth,
      docClientWidth: document.documentElement.clientWidth,
      viewClientWidth: view ? view.clientWidth : null,
      viewScrollWidth: view ? view.scrollWidth : null,
      bodyClientWidth: body ? body.clientWidth : null,
      bodyScrollWidth: body ? body.scrollWidth : null,
      heroWidth: hero ? Math.round(hero.getBoundingClientRect().width) : null,
      queueWidth: queue ? Math.round(queue.getBoundingClientRect().width) : null
    };
    const debug = document.createElement("pre");
    debug.id = "mf-debug";
    debug.textContent = JSON.stringify(metrics);
    debug.style.cssText = "position:fixed;left:0;top:0;z-index:9999;background:#fff;color:#000;font-size:11px;max-width:100%;white-space:pre-wrap;";
    document.body.appendChild(debug);
  }
  function refresh() {
    model = buildModel();
    ui.update(model, state);
  }
  function showToast(message) {
    let toast = document.querySelector(".preview-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "preview-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
  }
  function handleAction(action, data) {
    switch (action) {
      case "search":
        state.query = data.query || "";
        ui.updateLists(model, state);
        return;
      case "filter":
        state.filter = data.filter || "all";
        ui.updateLists(model, state);
        return;
      case "sort":
        state.sort = data.sort || "urgency";
        ui.updateLists(model, state);
        return;
      case "tree-toggle": {
        const depth = Number(data.depth) || 0;
        const set = depth === 0 ? state.collapsed : state.expanded;
        if (set.has(data.path)) set.delete(data.path);
        else set.add(data.path);
        ui.updateLists(model, state);
        return;
      }
      case "clear-filters":
        state.query = "";
        state.filter = "all";
        ui.setSearchValue("");
        ui.updateLists(model, state);
        return;
      case "demo-toggle":
        state.empty = false;
        state.demo = !state.demo;
        refresh();
        updateControls();
        return;
      case "retry":
      case "refresh":
        refresh();
        return;
      default:
        showToast(`预览模式：${action}${data.path ? ` · ${data.path.split("/").pop()}` : ""}`);
    }
  }
  function updateControls() {
    const themeButton = document.querySelector('[data-control="theme"]');
    if (themeButton) themeButton.textContent = state.theme === "dark" ? "亮色" : "暗色";
    const emptyButton = document.querySelector('[data-control="empty"]');
    if (emptyButton) emptyButton.classList.toggle("is-active", state.empty);
    const demoButton = document.querySelector('[data-control="demo"]');
    if (demoButton) demoButton.classList.toggle("is-active", state.demo && !state.empty);
    const widthButton = document.querySelector('[data-control="width"]');
    if (widthButton) widthButton.classList.toggle("is-active", state.narrow);
  }
  for (const control of document.querySelectorAll("[data-control]")) {
    control.addEventListener("click", () => {
      const name = control.dataset.control;
      if (name === "theme") {
        state.theme = state.theme === "dark" ? "light" : "dark";
        document.body.classList.toggle("theme-dark", state.theme === "dark");
      } else if (name === "empty") {
        state.empty = !state.empty;
        refresh();
      } else if (name === "demo") {
        state.demo = !state.demo;
        state.empty = false;
        refresh();
      } else if (name === "width") {
        state.narrow = !state.narrow;
        document.body.classList.toggle("mf-preview-narrow", state.narrow);
      }
      updateControls();
    });
  }
  updateControls();
})();
