/* MemoFlow 0.1.0 — paper-and-ink study console. Forked from Incremental Reading Toolkit 1.1.8 (MIT). */
"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// main.js
var require_main = __commonJS({
  "main.js"(exports2, module2) {
    "use strict";
    var {
      Plugin,
      Notice: Notice2,
      Modal,
      FuzzySuggestModal,
      TFile: TFile2,
      parseYaml,
      FileSystemAdapter,
      PluginSettingTab,
      Setting,
      ItemView,
      normalizePath
    } = require("obsidian");
    var treeCore = /* @__PURE__ */ (function() {
      function linkTargetName(value) {
        if (!value) return null;
        const s = String(value);
        const m = s.match(/\[\[([^\]\|#]+)(?:[#\|][^\]]*)?\]\]/);
        const name = (m ? m[1] : s).trim();
        return name || null;
      }
      function effectiveParent(fm) {
        if (!fm) return null;
        if (fm.tree_root === true) return null;
        return linkTargetName(fm.parent) || linkTargetName(fm.source) || null;
      }
      function siblingComparator(a, b) {
        const an = Number(a.fm && a.fm.tree_order);
        const bn = Number(b.fm && b.fm.tree_order);
        const ao = Number.isFinite(an) ? an : Infinity;
        const bo = Number.isFinite(bn) ? bn : Infinity;
        if (ao !== bo) return ao - bo;
        return a.basename.localeCompare(b.basename);
      }
      function buildTreeIndex(pages) {
        const byName = /* @__PURE__ */ new Map();
        const duplicates = /* @__PURE__ */ new Set();
        for (const p of pages) {
          const key = p.basename.toLowerCase();
          if (byName.has(key)) duplicates.add(key);
          else byName.set(key, p);
        }
        const childrenOf = /* @__PURE__ */ new Map();
        const roots = [];
        for (const p of pages) {
          const parentName = effectiveParent(p.fm);
          const key = parentName ? parentName.toLowerCase() : null;
          if (key && byName.has(key) && !duplicates.has(key)) {
            if (!childrenOf.has(key)) childrenOf.set(key, []);
            childrenOf.get(key).push(p);
          } else {
            roots.push(p);
          }
        }
        const cmp = siblingComparator;
        roots.sort(cmp);
        for (const arr of childrenOf.values()) arr.sort(cmp);
        return { pages: pages.slice(), byName, childrenOf, roots, duplicates };
      }
      function pageByPath(index, path) {
        return index.pages.find((page) => page.path === path) || null;
      }
      function flattenedVisibleChildren(index, page, keep = null, hidden = null, seen = /* @__PURE__ */ new Set()) {
        if (!page || seen.has(page.path)) return [];
        const nextSeen = new Set(seen);
        nextSeen.add(page.path);
        const children = index.childrenOf.get(page.basename.toLowerCase()) || [];
        const visible = [];
        for (const child of children) {
          if (keep && !keep.has(child.path)) continue;
          if (hidden?.has(child.path)) {
            visible.push(...flattenedVisibleChildren(index, child, keep, hidden, nextSeen));
          } else {
            visible.push(child);
          }
        }
        return visible;
      }
      function wouldCreateCycle(index, childName, newParentName) {
        if (!newParentName) return false;
        const child = childName.toLowerCase();
        let cur = newParentName.toLowerCase();
        const seen = /* @__PURE__ */ new Set();
        while (cur) {
          if (cur === child) return true;
          if (seen.has(cur)) return true;
          seen.add(cur);
          const page = index.byName.get(cur);
          if (!page) break;
          const up = effectiveParent(page.fm);
          cur = up ? up.toLowerCase() : null;
        }
        return false;
      }
      function computeReorder(siblings, movedPath, targetIndex) {
        const moved = siblings.find((s) => s.path === movedPath);
        if (!moved) return [];
        const rest = siblings.filter((s) => s.path !== movedPath);
        const idx = Math.max(0, Math.min(targetIndex, rest.length));
        rest.splice(idx, 0, moved);
        const writes = [];
        rest.forEach((s, i) => {
          const want = (i + 1) * 10;
          if (Number(s.tree_order) !== want) writes.push({ path: s.path, tree_order: want });
        });
        return writes;
      }
      return { linkTargetName, effectiveParent, siblingComparator, buildTreeIndex, pageByPath, flattenedVisibleChildren, wouldCreateCycle, computeReorder };
    })();
    var statusCore = /* @__PURE__ */ (function() {
      const RESET_SCHEDULING_FIELDS = [
        "next_review",
        "interval",
        "review_count",
        "last_reviewed",
        "a_factor",
        "last_grade",
        "last_retrievability",
        "stability",
        "difficulty",
        "ease"
      ];
      function normalizedTagList(tags) {
        if (Array.isArray(tags)) return tags.map(String).filter(Boolean);
        if (typeof tags === "string") return tags.split(/[\s,]+/).filter(Boolean);
        return [];
      }
      function sameTag(left, right) {
        return String(left || "").replace(/^#/, "").replace(/\/+$/, "") === String(right || "").replace(/^#/, "").replace(/\/+$/, "");
      }
      function managedCardDeckTag(fm, configuredDeckTag) {
        const normalize = (value) => String(value || "").replace(/^#/, "").replace(/\/+$/, "");
        const stored = normalize(fm.ir_spaced_repetition_deck_tag);
        const tags = normalizedTagList(fm.tags);
        if (stored && tags.some((tag) => sameTag(tag, stored))) return stored;
        const configured = normalize(configuredDeckTag);
        if (configured && tags.some((tag) => sameTag(tag, configured))) return configured;
        const likelyDeckTags = tags.map(normalize).filter((tag) => tag === "flashcards" || tag.startsWith("flashcards/"));
        return likelyDeckTags.length === 1 ? likelyDeckTags[0] : stored || configured;
      }
      function completeItemFrontmatter(fm, today, deckTag) {
        fm.status = "done";
        fm.date_done = today;
        fm.last_reviewed = today;
        delete fm.next_review;
        delete fm.interval;
        if (fm.type === "card" && fm.ir_spaced_repetition === true) {
          const managedDeckTag = managedCardDeckTag(fm, deckTag);
          if (managedDeckTag) {
            fm.tags = normalizedTagList(fm.tags).filter((tag) => !sameTag(tag, managedDeckTag));
            fm.ir_completed_deck_tag = managedDeckTag;
            fm.ir_spaced_repetition_deck_tag = managedDeckTag;
          }
        }
        return fm;
      }
      function resetItemFrontmatter(fm, deckTag) {
        fm.status = "active";
        delete fm.date_done;
        delete fm.date_dismissed;
        for (const field of RESET_SCHEDULING_FIELDS) delete fm[field];
        if (fm.type === "card" && fm.ir_spaced_repetition === true) {
          const restoreTag = fm.ir_completed_deck_tag || managedCardDeckTag(fm, deckTag);
          const tags = normalizedTagList(fm.tags);
          if (restoreTag && !tags.some((tag) => sameTag(tag, restoreTag))) tags.push(String(restoreTag).replace(/^#/, ""));
          fm.tags = tags;
          if (restoreTag) fm.ir_spaced_repetition_deck_tag = String(restoreTag).replace(/^#/, "").replace(/\/+$/, "");
          delete fm.ir_completed_deck_tag;
        }
        return fm;
      }
      function clearSpacedRepetitionSchedule(content) {
        return String(content || "").replace(/[ \t]*<!--SR:!?[^>]*-->/g, "").replace(/[ \t]+\n/g, "\n");
      }
      return { RESET_SCHEDULING_FIELDS, normalizedTagList, managedCardDeckTag, completeItemFrontmatter, resetItemFrontmatter, clearSpacedRepetitionSchedule };
    })();
    var spacedRepetitionCore = /* @__PURE__ */ (function() {
      function nativeCardText(value) {
        return String(value ?? "").trim().replace(/\r/g, "").replace(/\n[ \t]*\n+/g, "\n<br>\n");
      }
      function spacedRepetitionBody(format, question, answer, settings = {}) {
        const q = nativeCardText(question);
        const a = nativeCardText(answer);
        if (format === "cloze") return q + "\n";
        const separator = format === "reverse" ? settings.multilineReversedCardSeparator || "??" : settings.multilineCardSeparator || "?";
        return `${q}
${separator}
${a}
`;
      }
      return { nativeCardText, spacedRepetitionBody };
    })();
    var dateCore2 = /* @__PURE__ */ (function() {
      const SUPPORTED_DATE_FORMATS = ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"];
      function normalizeDateFormat(format) {
        return SUPPORTED_DATE_FORMATS.includes(format) ? format : "DD-MM-YYYY";
      }
      function parseDateExact(value, format = "DD-MM-YYYY") {
        if (!value) return null;
        const normalized = normalizeDateFormat(format);
        const match = String(value).trim().match(/^(\d{2}|\d{4})-(\d{2})-(\d{2}|\d{4})$/);
        if (!match) return null;
        const parts = String(value).trim().split("-").map(Number);
        let day, month, year;
        if (normalized === "DD-MM-YYYY") [day, month, year] = parts;
        else if (normalized === "MM-DD-YYYY") [month, day, year] = parts;
        else [year, month, day] = parts;
        if (year < 1e3 || day < 1 || month < 1 || month > 12) return null;
        const date = new Date(year, month - 1, day);
        date.setHours(0, 0, 0, 0);
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
        return date;
      }
      function parseDate(value, preferredFormat = "DD-MM-YYYY") {
        const preferred = normalizeDateFormat(preferredFormat);
        for (const format of [preferred, ...SUPPORTED_DATE_FORMATS.filter((f) => f !== preferred)]) {
          const parsed = parseDateExact(value, format);
          if (parsed) return parsed;
        }
        return null;
      }
      function formatDate(date, format = "DD-MM-YYYY") {
        const normalized = normalizeDateFormat(format);
        const day = String(date.getDate()).padStart(2, "0");
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const year = String(date.getFullYear()).padStart(4, "0");
        if (normalized === "MM-DD-YYYY") return `${month}-${day}-${year}`;
        if (normalized === "YYYY-MM-DD") return `${year}-${month}-${day}`;
        return `${day}-${month}-${year}`;
      }
      function reformatDate(value, fromFormat, toFormat) {
        const parsed = parseDateExact(value, fromFormat);
        return parsed ? formatDate(parsed, toFormat) : value;
      }
      return { SUPPORTED_DATE_FORMATS, normalizeDateFormat, parseDateExact, parseDate, formatDate, reformatDate };
    })();
    var topicCore = /* @__PURE__ */ (function() {
      function progressAwareAFactor(fm, settings, overrides = {}) {
        const s = settings.scheduling;
        let remaining = null;
        const pageTarget = Number(fm.page_end) > 0 ? Number(fm.page_end) : Number(fm.total_pages);
        const readPoint = overrides.readPoint ?? fm.read_point;
        const readSeconds = overrides.readPointSeconds ?? fm.read_point_seconds;
        if (pageTarget > 0) {
          const read = Math.max(0, Math.min(Number(readPoint) || 0, pageTarget));
          remaining = Math.max(1, pageTarget - read);
        } else if (Number(fm.total_seconds) > 0) {
          const read = Math.max(0, Math.min(Number(readSeconds) || 0, Number(fm.total_seconds)));
          remaining = Math.max(1, (Number(fm.total_seconds) - read) / 60);
        }
        if (remaining == null) return null;
        const af = s.initial_af_base - s.initial_af_slope * Math.log2(remaining / s.initial_af_units_divisor);
        return Math.max(s.a_factor_min, Math.min(s.a_factor_max, af));
      }
      function hasProgressAdvanced({
        previousPage = 0,
        nextPage = 0,
        previousSeconds = 0,
        nextSeconds = 0,
        previousLine = 0,
        nextLine = 0
      } = {}) {
        return Number(nextPage) > Number(previousPage) || Number(nextSeconds) > Number(previousSeconds) || Number(nextLine) > Number(previousLine);
      }
      function interleaveLearningItems(items, score = () => 0) {
        const ranked = items.slice().sort((a, b) => score(b) - score(a));
        const topics = ranked.filter((item) => item.fm?.type !== "card");
        const cards = ranked.filter((item) => item.fm?.type === "card");
        if (!topics.length || !cards.length) return ranked;
        const out = [];
        let next = score(cards[0]) > score(topics[0]) ? "card" : "topic";
        while (topics.length || cards.length) {
          const primary = next === "card" ? cards : topics;
          const fallback = next === "card" ? topics : cards;
          out.push((primary.length ? primary : fallback).shift());
          next = next === "card" ? "topic" : "card";
        }
        return out;
      }
      return { progressAwareAFactor, hasProgressAdvanced, interleaveLearningItems };
    })();
    var ROOT = "Sources/Incremental Reading";
    var SOURCES_FOLDER = `${ROOT}/Sources`;
    var EXTRACTS_FOLDER = `${ROOT}/Extracts`;
    var CARDS_FOLDER = `${ROOT}/Cards`;
    var ATTACHMENTS_FOLDER = `${ROOT}/Attachments`;
    var CATEGORIES_FOLDER = `${ROOT}/Categories`;
    var KNOWLEDGE_TREE_VIEW_TYPE = "ir-tree-view";
    var KNOWLEDGE_TREE_SIDEBAR_TYPE = "ir-tree-sidebar";
    var MAIN_DASHBOARD_VIEW_TYPE = "ir-main-dashboard";
    var PDF_VIEW_TYPE = "ir-pdf-viewer";
    var REVIEW_LOG_PATH = `${ROOT}/Review Log.md`;
    var DASHBOARD_PATH = `${ROOT}/Incremental-Reading-Dashboard.md`;
    var SPACED_REPETITION_PLUGIN_ID = "obsidian-spaced-repetition";
    var SPACED_REPETITION_REVIEW_COMMAND = `${SPACED_REPETITION_PLUGIN_ID}:srs-review-flashcards`;
    var SPACED_REPETITION_NOTE_COMMAND = `${SPACED_REPETITION_PLUGIN_ID}:srs-review-flashcards-in-note`;
    var SPACED_REPETITION_TAB_VIEW = "spaced-repetition-tab-view";
    var READ_POINT_MARKER = "📍<!--ir-readpoint-->";
    var READ_POINT_RE = /(?:📍\s*)?<!--ir-readpoint-->/g;
    var BODY_MARKER = "<!--ir-card-body-->";
    var DEFAULT_EXTRACT_HIGHLIGHT_COLOR = "#ffd166";
    var HL_CLOZE_SRC = "==((?:[^=]|=(?!=))+)==";
    var DEFAULT_SETTINGS = {
      scheduling: {
        a_factor_min: 1.05,
        a_factor_max: 5,
        progress_aware: true,
        stall_guard: true,
        quality_hold: 1,
        quality_speed_up: 0.95,
        quality_slow_down: 1.05,
        initial_af_base: 2.5,
        initial_af_slope: 0.25,
        initial_af_units_divisor: 10,
        extract_bump: 1.05
      },
      queue: {
        sidebar_enabled: true,
        default_tag_filter: "",
        sort_key: "urgency",
        mix_cards: true
      },
      inline_cards: {
        enabled: true,
        qa_regex: "^Q::\\s*(.+?)\\s*::A::\\s*(.+)$",
        cloze_regex: "\\{\\{c(\\d+)::([^}]+?)(?:::([^}]+?))?\\}\\}"
      },
      spaced_repetition: {
        flashcardTag: "flashcards/incremental-reading",
        multilineCardSeparator: "?",
        multilineReversedCardSeparator: "??"
      },
      paths: {
        sources: "Sources/Incremental Reading/Sources",
        extracts: "Sources/Incremental Reading/Extracts",
        cards: "Sources/Incremental Reading/Cards",
        attachments: "Sources/Incremental Reading/Attachments",
        categories: "Sources/Incremental Reading/Categories",
        dashboard: "Sources/Incremental Reading/Incremental-Reading-Dashboard.md",
        review_log: "Sources/Incremental Reading/Review Log.md"
      },
      misc: {
        debug: false,
        date_format: "DD-MM-YYYY",
        extract_highlight_color: DEFAULT_EXTRACT_HIGHLIGHT_COLOR
      },
      tree: {
        expanded: [],
        child_warn_threshold: 100,
        show_completed: false
      },
      session: {
        date: null,
        paths: [],
        types: {},
        readPoints: {}
      }
    };
    function normalizedExtractHighlightColor(value) {
      const color = String(value || "").trim().toLowerCase();
      return /^#[0-9a-f]{6}$/.test(color) ? color : DEFAULT_EXTRACT_HIGHLIGHT_COLOR;
    }
    function extractHighlightBackground(value) {
      const color = normalizedExtractHighlightColor(value);
      const number = Number.parseInt(color.slice(1), 16);
      return `rgba(${number >> 16}, ${number >> 8 & 255}, ${number & 255}, 0.18)`;
    }
    function excerptHighlightMarkup(value) {
      const text = String(value || "");
      if (!text || /^<mark class="ir-excerpt-text">[\s\S]*<\/mark>$/.test(text)) return text;
      return `<mark class="ir-excerpt-text">${text}</mark>`;
    }
    function configuredDateFormat(settings) {
      return dateCore2.normalizeDateFormat(settings?.misc?.date_format);
    }
    function parseDateValue(value, settings) {
      return dateCore2.parseDate(value, configuredDateFormat(settings));
    }
    function formatDateValue(date, settings) {
      return dateCore2.formatDate(date, configuredDateFormat(settings));
    }
    function todayDateString(settings) {
      return formatDateValue(todayDate(), settings);
    }
    function todayDate() {
      const d = /* @__PURE__ */ new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    }
    function futureDateString(days, settings) {
      const d = todayDate();
      d.setDate(d.getDate() + days);
      return formatDateValue(d, settings);
    }
    function daysBetween(a, b) {
      return Math.round((a - b) / 864e5);
    }
    function priorityToInterval(priority) {
      const p = Math.min(Math.max(Number(priority) || 50, 1), 100);
      return Math.max(1, Math.ceil(p * 0.15));
    }
    function urgency(fm, today, settings) {
      const pri = fm.priority ? (101 - fm.priority) * 10 : 0;
      const nr = parseDateValue(fm.next_review, settings);
      if (!nr) return pri;
      const diff = daysBetween(today, nr);
      let u = pri + diff * 2;
      if (diff >= 0) u += 5e3;
      return u;
    }
    function isDue(fm, today, settings) {
      if (!fm.next_review) return true;
      const nr = parseDateValue(fm.next_review, settings);
      if (!nr) return true;
      return nr <= today;
    }
    function isPastDue(fm, today, settings) {
      if (!fm.next_review) return false;
      const nr = parseDateValue(fm.next_review, settings);
      if (!nr) return false;
      return nr < today;
    }
    function isActiveIR(fm) {
      if (!fm) return false;
      if (fm.type !== "source" && fm.type !== "extract" && fm.type !== "card") return false;
      if (fm.status === "done" || fm.status === "container" || fm.status === "dismissed" || fm.status === "inbox") return false;
      return true;
    }
    function isQueueVisibleIR(fm) {
      if (!fm) return false;
      if (fm.type !== "source" && fm.type !== "extract" && fm.type !== "card") return false;
      return !["done", "container", "dismissed"].includes(fm.status);
    }
    function spacedRepetitionCardIsDue(content, today) {
      const dueDates = [...String(content || "").matchAll(/<!--SR:!?(\d{4}-\d{2}-\d{2})(?:,[^>]*)?-->/g)].map((match) => match[1]);
      if (!dueDates.length) return true;
      const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      return dueDates.some((date) => date <= todayString);
    }
    function spacedRepetitionScheduleSignature(content) {
      return [...String(content || "").matchAll(/<!--SR:!?[^>]*-->/g)].map((match) => match[0]).join("\n");
    }
    function savedQueueCandidates(paths, activePath, fromStart = false) {
      const queue = Array.isArray(paths) ? paths : [];
      const currentIndex = activePath ? queue.indexOf(activePath) : -1;
      return !fromStart && currentIndex >= 0 ? queue.slice(currentIndex + 1) : queue.slice();
    }
    function clampAFactor(settings, x) {
      const s = settings.scheduling;
      const n = Number(x);
      if (!Number.isFinite(n) || n <= 1) return s.a_factor_min;
      return Math.max(s.a_factor_min, Math.min(s.a_factor_max, n));
    }
    function readAFactor(settings, fm) {
      return clampAFactor(settings, fm?.a_factor);
    }
    function initialAFactor(settings, { total_pages, total_seconds } = {}) {
      const s = settings.scheduling;
      let units = null;
      if (Number(total_pages) > 0) units = Number(total_pages);
      else if (Number(total_seconds) > 0) units = Number(total_seconds) / 60;
      if (!units || units < 1) return 2;
      const af = s.initial_af_base - s.initial_af_slope * Math.log2(units / s.initial_af_units_divisor);
      return Math.max(s.a_factor_min, Math.min(2.5, af));
    }
    var round4 = (x) => Math.round(x * 1e4) / 1e4;
    function linkTarget(value) {
      if (!value) return null;
      const s = String(value);
      const m = s.match(/\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/);
      return m ? m[1].trim() : s.trim();
    }
    function linkPointsTo(value, target) {
      const t = linkTarget(value);
      return t === target;
    }
    function inlineCardId(filePath, literal) {
      let h = 2166136261;
      const s = `${filePath}
${literal}`;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = h * 16777619 >>> 0;
      }
      return h.toString(16).padStart(8, "0");
    }
    function parseInlineCards(filePath, body, settings) {
      const s = settings.inline_cards;
      if (!s.enabled) return [];
      const lines = body.split("\n");
      const out = [];
      let qa, cloze;
      try {
        qa = new RegExp(s.qa_regex);
        cloze = new RegExp(s.cloze_regex, "g");
      } catch (error) {
        throw new Error(`Invalid inline-card regular expression: ${error.message}`);
      }
      if (qa.global) throw new Error("The Q::A regular expression must not use the global flag.");
      const seen = /* @__PURE__ */ new Set();
      const uniqId = (literal) => {
        let id = inlineCardId(filePath, literal);
        let n = 1;
        while (seen.has(id)) id = inlineCardId(filePath, `${literal}#${++n}`);
        seen.add(id);
        return id;
      };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(qa);
        if (m) {
          out.push({
            id: uniqId(m[0]),
            line: i,
            type: "qa",
            question: m[1],
            answer: m[2]
          });
          continue;
        }
        for (const cm of line.matchAll(cloze)) {
          out.push({
            id: uniqId(cm[0]),
            line: i,
            type: "cloze",
            cloze_index: Number(cm[1]),
            text: cm[2],
            hint: cm[3] || null,
            full_line: line
          });
        }
        for (const hm of line.matchAll(new RegExp(HL_CLOZE_SRC, "g"))) {
          out.push({
            id: uniqId(hm[0]),
            line: i,
            type: "cloze",
            cloze_index: 1,
            text: hm[1],
            hint: null,
            full_line: line
          });
        }
      }
      return out;
    }
    var TextPromptModal = class extends Modal {
      constructor(app, title, defaultValue, resolve) {
        super(app);
        this.title = title;
        this.defaultValue = defaultValue ?? "";
        this.resolve = resolve;
        this._resolved = false;
      }
      onOpen() {
        this.titleEl.setText(this.title);
        const { contentEl } = this;
        contentEl.empty();
        const input = contentEl.createEl("input", { cls: "ir-modal-input" });
        input.type = "text";
        input.value = this.defaultValue;
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._submit(input.value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            this._cancel();
          }
        });
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        const submit = row.createEl("button", { text: "确定", cls: "mod-cta" });
        submit.addEventListener("click", () => this._submit(input.value));
        const cancel = row.createEl("button", { text: "取消" });
        cancel.addEventListener("click", () => this._cancel());
        window.setTimeout(() => {
          input.focus();
          input.select();
        }, 20);
      }
      _submit(v) {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(v);
      }
      _cancel() {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(null);
      }
      onClose() {
        this.contentEl.empty();
        if (!this._resolved) {
          this._resolved = true;
          this.resolve(null);
        }
      }
    };
    var GenericSuggestModal = class extends FuzzySuggestModal {
      constructor(app, items, displayFn, resolve, placeholder) {
        super(app);
        this.items = items;
        this.displayFn = displayFn;
        this.resolve = resolve;
        this._chose = false;
        this._chosen = null;
        this._resolved = false;
        if (placeholder) this.setPlaceholder(placeholder);
      }
      getItems() {
        return this.items;
      }
      getItemText(i) {
        return this.displayFn(i);
      }
      // Resolve immediately on selection. Earlier "defer to onClose" was a
      // workaround for chained-modal focus loss, but evidence shows Obsidian
      // calls `close()` synchronously after `onChooseItem`, so by the time the
      // promise consumer runs, the modal is already gone.
      onChooseItem(i, evt) {
        if (this._resolved) return;
        this._resolved = true;
        this.resolve(i);
      }
      onClose() {
        super.onClose?.();
        setTimeout(() => {
          if (this._resolved) return;
          this._resolved = true;
          this.resolve(null);
        }, 50);
      }
    };
    var ConfirmModal = class extends Modal {
      constructor(app, title, message, resolve) {
        super(app);
        this.title = title;
        this.message = message;
        this.resolve = resolve;
        this._resolved = false;
      }
      onOpen() {
        this.titleEl.setText(this.title);
        const { contentEl } = this;
        contentEl.empty();
        if (this.message) contentEl.createEl("p", { text: this.message });
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        const yes = row.createEl("button", { text: "确定", cls: "mod-cta" });
        yes.addEventListener("click", () => this._answer(true));
        const no = row.createEl("button", { text: "取消" });
        no.addEventListener("click", () => this._answer(false));
        const onKey = (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this._answer(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            this._answer(false);
          }
        };
        contentEl.addEventListener("keydown", onKey);
        window.setTimeout(() => yes.focus(), 20);
      }
      _answer(v) {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(v);
      }
      onClose() {
        this.contentEl.empty();
        if (!this._resolved) {
          this._resolved = true;
          this.resolve(false);
        }
      }
    };
    var LongTextModal = class extends Modal {
      constructor(app, title, defaultValue, resolve) {
        super(app);
        this.title = title;
        this.defaultValue = defaultValue ?? "";
        this.resolve = resolve;
        this._resolved = false;
      }
      onOpen() {
        this.titleEl.setText(this.title);
        const { contentEl } = this;
        contentEl.empty();
        const ta = contentEl.createEl("textarea", { cls: "ir-modal-textarea" });
        ta.value = this.defaultValue;
        const row = contentEl.createDiv({ cls: "modal-button-container" });
        const submit = row.createEl("button", { text: "确定", cls: "mod-cta" });
        submit.addEventListener("click", () => this._submit(ta.value));
        const cancel = row.createEl("button", { text: "取消" });
        cancel.addEventListener("click", () => this._cancel());
        window.setTimeout(() => ta.focus(), 20);
      }
      _submit(v) {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(v);
      }
      _cancel() {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(null);
      }
      onClose() {
        this.contentEl.empty();
        if (!this._resolved) {
          this._resolved = true;
          this.resolve(null);
        }
      }
    };
    var OcclusionModal = class extends Modal {
      constructor(app, imageSrc, resolve) {
        super(app);
        this.imageSrc = imageSrc;
        this.resolve = resolve;
        this._resolved = false;
        this.rects = [];
        this.dragStart = null;
        this.dragNow = null;
      }
      onOpen() {
        this.titleEl.setText("遮挡：拖拽绘制矩形");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("ir-occ-modal");
        contentEl.createEl("p", {
          cls: "ir-occ-help",
          text: "拖拽添加矩形；右键删除；Shift+点击设置/清除标签；在底部选择生成模式。"
        });
        const wrap = contentEl.createDiv({ cls: "ir-occ-wrap" });
        const img = wrap.createEl("img", { cls: "ir-occ-img" });
        img.src = this.imageSrc;
        img.draggable = false;
        const overlay = wrap.createDiv({ cls: "ir-occ-overlay" });
        this.wrap = wrap;
        this.overlay = overlay;
        this.img = img;
        img.addEventListener("load", () => this._renderRects());
        const localFrac = (e) => {
          const r = overlay.getBoundingClientRect();
          return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
        };
        overlay.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          this.dragStart = localFrac(e);
          this.dragNow = this.dragStart;
          this._renderRects();
        });
        window.addEventListener("mousemove", this._mouseMove = (e) => {
          if (!this.dragStart) return;
          this.dragNow = localFrac(e);
          this._renderRects();
        });
        window.addEventListener("mouseup", this._mouseUp = (e) => {
          if (!this.dragStart) return;
          const a = this.dragStart, b = this.dragNow || this.dragStart;
          const x = Math.max(0, Math.min(a.x, b.x));
          const y = Math.max(0, Math.min(a.y, b.y));
          const w = Math.min(1 - x, Math.abs(a.x - b.x));
          const h = Math.min(1 - y, Math.abs(a.y - b.y));
          this.dragStart = null;
          this.dragNow = null;
          if (w > 5e-3 && h > 5e-3) this.rects.push({ x, y, w, h });
          this._renderRects();
        });
        const buttonRow = contentEl.createDiv({ cls: "modal-button-container ir-occ-btnrow" });
        const hideOneBtn = buttonRow.createEl("button", { text: "生成：隐藏一个（N 张卡）", cls: "mod-cta" });
        hideOneBtn.title = "每个矩形生成一张卡；每张卡隐藏该矩形、显示其他区域。";
        hideOneBtn.addEventListener("click", () => this._commit("hide-one"));
        const showOneBtn = buttonRow.createEl("button", { text: "生成：只显示一个（N 张卡）" });
        showOneBtn.title = "每个矩形生成一张卡；每张卡只显示该矩形、隐藏其他区域。";
        showOneBtn.addEventListener("click", () => this._commit("show-one"));
        const clearBtn = buttonRow.createEl("button", { text: "清空" });
        clearBtn.addEventListener("click", () => {
          this.rects = [];
          this._renderRects();
        });
        const cancelBtn = buttonRow.createEl("button", { text: "取消" });
        cancelBtn.addEventListener("click", () => this._cancel());
        this.statusEl = contentEl.createDiv({ cls: "ir-occ-status" });
        this._updateStatus();
      }
      _updateStatus() {
        if (this.statusEl) this.statusEl.setText(`已绘制 ${this.rects.length} 个矩形`);
      }
      _renderRects() {
        if (!this.overlay) return;
        this.overlay.empty();
        const drawCover = (r, color, idx) => {
          const div = this.overlay.createDiv({ cls: "ir-occ-cover" });
          div.style.setProperty("--ir-x", r.x * 100 + "%");
          div.style.setProperty("--ir-y", r.y * 100 + "%");
          div.style.setProperty("--ir-w", r.w * 100 + "%");
          div.style.setProperty("--ir-h", r.h * 100 + "%");
          div.style.setProperty("--ir-cover-bg", color);
          if (idx != null) {
            const labelSuffix = r.label ? ` — "${r.label}"` : "";
            div.title = `Rect ${idx + 1}${labelSuffix} · shift+click=label · right-click=remove`;
            div.addEventListener("contextmenu", (e) => {
              e.preventDefault();
              this.rects.splice(idx, 1);
              this._renderRects();
            });
            div.addEventListener("click", async (e) => {
              if (!e.shiftKey) return;
              e.preventDefault();
              e.stopPropagation();
              const cur = this.rects[idx]?.label || "";
              const next = await askText(this.app, `矩形 ${idx + 1} 的标签（留空清除）`, cur);
              if (next === null) return;
              if (next.trim() === "") delete this.rects[idx].label;
              else this.rects[idx].label = next.trim();
              this._renderRects();
            });
            if (r.label) {
              div.createDiv({ cls: "ir-occ-label", text: r.label });
            }
          }
          return div;
        };
        this.rects.forEach((r, i) => drawCover(r, "rgba(255, 215, 0, 0.55)", i));
        if (this.dragStart && this.dragNow) {
          const a = this.dragStart, b = this.dragNow;
          const r = {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            w: Math.abs(a.x - b.x),
            h: Math.abs(a.y - b.y)
          };
          drawCover(r, "rgba(255, 100, 100, 0.40)");
        }
        this._updateStatus();
      }
      _commit(mode) {
        if (this._resolved) return;
        if (this.rects.length === 0) {
          new Notice2("请先画至少一个矩形。");
          return;
        }
        this._resolved = true;
        this.close();
        this.resolve({ rects: this.rects.slice(), mode });
      }
      _cancel() {
        if (this._resolved) return;
        this._resolved = true;
        this.close();
        this.resolve(null);
      }
      onClose() {
        if (this._mouseMove) window.removeEventListener("mousemove", this._mouseMove);
        if (this._mouseUp) window.removeEventListener("mouseup", this._mouseUp);
        this.contentEl.empty();
        if (!this._resolved) {
          this._resolved = true;
          this.resolve(null);
        }
      }
    };
    function askOcclusion(app, imageSrc) {
      return new Promise((res) => new OcclusionModal(app, imageSrc, res).open());
    }
    function askText(app, title, defaultValue = "") {
      return new Promise((res) => new TextPromptModal(app, title, defaultValue, res).open());
    }
    function pickFuzzy(app, items, displayFn, placeholder = "") {
      return new Promise((res) => new GenericSuggestModal(app, items, displayFn, res, placeholder).open());
    }
    function confirmDialog(app, title, message = "") {
      return new Promise((res) => new ConfirmModal(app, title, message, res).open());
    }
    function askLong(app, title, defaultValue = "") {
      return new Promise((res) => new LongTextModal(app, title, defaultValue, res).open());
    }
    async function pickFromList(app, displays, values, placeholder = "") {
      if (!values || values.length === 0) return null;
      const items = displays.map((d, i) => ({ d, v: values[i] }));
      const picked = await pickFuzzy(app, items, (i) => i.d, placeholder);
      return picked ? picked.v : null;
    }
    function vaultAbsPath(app, relPath) {
      const adapter = app.vault.adapter;
      if (!(adapter instanceof FileSystemAdapter)) return null;
      if (relPath) return adapter.getFullPath(normalizePath(relPath));
      const base = adapter.getBasePath();
      return base.endsWith("/") ? base : base + "/";
    }
    function getFm(app, file) {
      return file ? app.metadataCache.getFileCache(file)?.frontmatter : null;
    }
    var IR_VIEW_FRONTMATTER_FIELDS = [
      "type",
      "status",
      "priority",
      "next_review",
      "last_reviewed",
      "parent",
      "source",
      "tree_root",
      "tree_order",
      "tags",
      "checkpoints"
    ];
    function irViewSignature(app, file) {
      if (!file || file.extension !== "md") return null;
      const cache = app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm || !["category", "source", "extract", "card"].includes(fm.type)) return null;
      const selected = {};
      for (const key of IR_VIEW_FRONTMATTER_FIELDS) selected[key] = fm[key];
      const inlineTags = (cache.tags || []).map((tag) => tag.tag);
      return JSON.stringify([selected, inlineTags]);
    }
    function isViewVisible(view) {
      const el = view?.containerEl;
      if (!el?.isConnected) return false;
      return el.offsetParent !== null || typeof el.getClientRects === "function" && el.getClientRects().length > 0;
    }
    async function filterAsyncConcurrent(items, predicate, concurrency = 16) {
      const keep = new Array(items.length);
      let cursor = 0;
      const worker = async () => {
        while (cursor < items.length) {
          const index = cursor++;
          keep[index] = await predicate(items[index], index);
        }
      };
      const count = Math.min(Math.max(1, concurrency), items.length);
      await Promise.all(Array.from({ length: count }, worker));
      return items.filter((_item, index) => keep[index]);
    }
    function configuredPath(settings, key, fallback) {
      const value = String(settings?.paths?.[key] || fallback).trim();
      return normalizePath(value);
    }
    function isPathInIRCollection(settings, path) {
      const normalized = normalizePath(String(path || ""));
      return [
        configuredPath(settings, "sources", SOURCES_FOLDER),
        configuredPath(settings, "extracts", EXTRACTS_FOLDER),
        configuredPath(settings, "cards", CARDS_FOLDER),
        configuredPath(settings, "categories", CATEGORIES_FOLDER)
      ].some((folder) => normalized === folder || normalized.startsWith(folder + "/"));
    }
    function getAllIRFiles(app, settings) {
      const folders = [
        configuredPath(settings, "sources", SOURCES_FOLDER),
        configuredPath(settings, "extracts", EXTRACTS_FOLDER),
        configuredPath(settings, "cards", CARDS_FOLDER),
        configuredPath(settings, "categories", CATEGORIES_FOLDER)
      ];
      const files = /* @__PURE__ */ new Map();
      for (const folder of folders) {
        for (const file of filesInFolder(app, folder)) {
          if (file.extension === "md") files.set(file.path, file);
        }
      }
      return Array.from(files.values());
    }
    function filesInFolder(app, folderPath) {
      const root = app.vault.getAbstractFileByPath(normalizePath(folderPath));
      if (!root) return [];
      const out = [];
      const visit = (node) => {
        if (node instanceof TFile2) {
          out.push(node);
          return;
        }
        if (Array.isArray(node.children)) for (const child of node.children) visit(child);
      };
      visit(root);
      return out;
    }
    function getEditorForFile(app, file) {
      for (const leaf of app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view?.file?.path === file.path) return leaf.view.editor;
      }
      return null;
    }
    function frontmatterEndOffset(content) {
      if (!content.startsWith("---\n")) return 0;
      const second = content.indexOf("\n---\n", 4);
      return second === -1 ? 0 : second + 5;
    }
    function markerLineNumber(content) {
      const match = String(content).match(/(?:📍\s*)?<!--ir-readpoint-->/);
      if (!match) return 0;
      return (content.slice(0, match.index).match(/\n/g) || []).length + 1;
    }
    function slugifyForFolder(s) {
      return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
    }
    async function shortHashOfBytes(arrayBuffer) {
      const digest = await crypto.subtle.digest("SHA-1", arrayBuffer);
      return Array.from(new Uint8Array(digest)).slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    async function readImageFromClipboard() {
      if (!navigator.clipboard?.read) return null;
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imgType = item.types.find((t) => t.startsWith("image/"));
          if (!imgType) continue;
          const blob = await item.getType(imgType);
          const bytes = await blob.arrayBuffer();
          return { bytes, mime: imgType };
        }
      } catch (e) {
      }
      return null;
    }
    async function ensureFolder(app, path) {
      if (app.vault.getAbstractFileByPath(path)) return;
      const parts = path.split("/");
      let cur = "";
      for (const p of parts) {
        cur = cur ? `${cur}/${p}` : p;
        if (!app.vault.getAbstractFileByPath(cur)) {
          try {
            await app.vault.createFolder(cur);
          } catch (e) {
            if (!String(e?.message || "").includes("exists")) throw e;
          }
        }
      }
    }
    async function resolveSourceFromActive(app, settings) {
      const active = app.workspace.getActiveFile();
      if (!active) {
        new Notice2("没有活动文件。");
        return null;
      }
      if (active.extension === "md") {
        const fm = getFm(app, active);
        if (fm?.type === "source") return { tfile: active, fm };
        new Notice2("当前笔记不是增量阅读来源。");
        return null;
      }
      if (active.extension !== "pdf") {
        new Notice2("当前文件必须是来源笔记或 PDF。");
        return null;
      }
      const absPath = vaultAbsPath(app, active.path);
      if (!absPath) {
        new Notice2("无法解析文件系统路径。");
        return null;
      }
      const vaultRel = active.path;
      const candidates = [];
      for (const f of filesInFolder(app, configuredPath(settings, "sources", SOURCES_FOLDER))) {
        if (f.extension !== "md") continue;
        const fm = getFm(app, f);
        if (fm?.type !== "source") continue;
        const pdfPath = fm.pdf_path || fm.sioyek_path;
        const pdfVault = fm.pdf_vault_path;
        if (pdfPath && (pdfPath === absPath || pdfPath === vaultRel || typeof pdfPath === "string" && pdfPath.endsWith("/" + vaultRel)) || pdfVault && pdfVault === vaultRel) {
          candidates.push({ tfile: f, fm });
        }
      }
      if (candidates.length === 0) {
        new Notice2("No source note links to this PDF via pdf_path or pdf_vault_path.");
        return null;
      }
      if (candidates.length === 1) return candidates[0];
      let page = null;
      try {
        const eph = app.workspace.getMostRecentLeaf()?.getEphemeralState?.();
        const m = (eph?.subpath || "").match(/page=(\d+)/);
        if (m) page = parseInt(m[1], 10);
      } catch (e) {
      }
      if (page != null) {
        const inRange = candidates.find((c) => {
          const s = Number(c.fm.page_start) || null;
          const e = Number(c.fm.page_end) || null;
          return s && e && page >= s && page <= e;
        });
        if (inRange) return inRange;
      }
      return await pickFuzzy(
        app,
        candidates,
        (c) => `${c.tfile.basename}${c.fm.page_start != null && c.fm.page_end != null ? `  p.${c.fm.page_start}–${c.fm.page_end}` : ""}`,
        "选择这个 PDF 对应的来源"
      );
    }
    async function resolveSourceOrExtractFromActive(app, settings) {
      const active = app.workspace.getActiveFile();
      if (!active) {
        new Notice2("没有活动文件。");
        return null;
      }
      if (active.extension === "md") {
        const fm = getFm(app, active);
        if (fm?.type === "source" || fm?.type === "extract") {
          return { tfile: active, fm };
        }
        if (fm?.type === "card") {
          const m = String(fm.source || "").match(/\[\[([^\]|#]+)/);
          if (!m) {
            new Notice2("卡片没有来源链接。");
            return null;
          }
          const parentName = m[1].trim();
          const parentTf = app.metadataCache.getFirstLinkpathDest(parentName, active.path) || getAllIRFiles(app, settings).find((f) => f.basename === parentName);
          if (!parentTf) {
            new Notice2(`找不到父项：${parentName}`);
            return null;
          }
          const parentFm = getFm(app, parentTf);
          if (!parentFm || parentFm.type !== "source" && parentFm.type !== "extract") {
            new Notice2("卡片父项不是来源/摘录。");
            return null;
          }
          return { tfile: parentTf, fm: parentFm };
        }
        new Notice2("当前笔记不是增量阅读来源、摘录或卡片。");
        return null;
      }
      if (active.extension === "pdf") return await resolveSourceFromActive(app, settings);
      new Notice2("当前文件必须是增量阅读元素或 PDF。");
      return null;
    }
    async function resolveIRFromActive(app, settings, { allowCard = true, allowPdfFallback = true } = {}) {
      const active = app.workspace.getActiveFile();
      if (!active) {
        new Notice2("没有活动文件。");
        return null;
      }
      if (active.extension === "md") {
        const fm = getFm(app, active);
        if (!fm) {
          new Notice2("No frontmatter on active note.");
          return null;
        }
        if (fm.type !== "source" && fm.type !== "extract" && (!allowCard || fm.type !== "card")) {
          new Notice2(`Active note is not an IR ${allowCard ? "source/extract/card" : "source/extract"}.`);
          return null;
        }
        return { tfile: active, fm };
      }
      if (active.extension === "pdf" && allowPdfFallback) {
        return await resolveSourceFromActive(app, settings);
      }
      new Notice2("当前文件必须是增量阅读元素或关联 PDF。");
      return null;
    }
    function walkSubtree(app, settings, rootBasename, rootPath, { includeCards = true, rows = null } = {}) {
      const allPages = (rows || getAllIRFiles(app, settings).map((f) => ({ tfile: f, fm: getFm(app, f) }))).filter((p) => p.fm && (p.fm.type === "source" || p.fm.type === "extract" || includeCards && p.fm.type === "card"));
      const paths = /* @__PURE__ */ new Set([rootPath]);
      const frontier = [rootBasename];
      const basenameCounts = /* @__PURE__ */ new Map();
      for (const page of allPages) {
        const key = page.tfile.basename.toLowerCase();
        basenameCounts.set(key, (basenameCounts.get(key) || 0) + 1);
      }
      while (frontier.length) {
        const next = [];
        for (const name of frontier) {
          if ((basenameCounts.get(name.toLowerCase()) || 0) > 1) continue;
          for (const p of allPages) {
            if (paths.has(p.tfile.path)) continue;
            if (linkPointsTo(p.fm.parent, name) || linkPointsTo(p.fm.source, name)) {
              paths.add(p.tfile.path);
              next.push(p.tfile.basename);
            }
          }
        }
        frontier.length = 0;
        frontier.push(...next);
      }
      return Array.from(paths).map((path) => {
        const tfile = app.vault.getAbstractFileByPath(path);
        return tfile ? { tfile, fm: getFm(app, tfile) } : null;
      }).filter(Boolean);
    }
    function generateCardsFromRects(rects, mode) {
      return rects.map((_r, i) => ({ questionIndex: i }));
    }
    var IR_QUEUE_VIEW_TYPE = "ir-queue-view";
    var IRQueueView = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.filter = plugin.settings.queue.default_tag_filter || "";
        this.refreshTimer = null;
        this.contentLeaf = null;
        this.modifyTimer = null;
        this.timelineTimer = null;
        this.rowsGeneration = 0;
        this.queueRevision = 0;
        this.queueModel = null;
        this.queueModelPromise = null;
        this.timelineEl = null;
        this.activeTimelinePath = null;
        this.collectionRevision = 0;
        this.sectionLimits = /* @__PURE__ */ new Map();
        this.needsRowsRender = false;
      }
      getViewType() {
        return IR_QUEUE_VIEW_TYPE;
      }
      getDisplayText() {
        return "Reading queue";
      }
      getIcon() {
        return "list-checks";
      }
      async onOpen() {
        this.collectionRevision = this.plugin.irCollectionRevision;
        this._render();
        this.registerEvent(this.plugin.app.metadataCache.on("changed", (file) => {
          if (this.collectionRevision === this.plugin.irCollectionRevision) return;
          this.collectionRevision = this.plugin.irCollectionRevision;
          this._invalidateQueueModel();
          this._scheduleRowsRender("metadata");
          if (!this.plugin.directQueueNavigation && file.path === this.plugin.app.workspace.getActiveFile()?.path) this._refreshTimeline(true);
        }));
        this.registerEvent(this.plugin.app.vault.on("modify", (file) => {
          if (!isPathInIRCollection(this.plugin.settings, file?.path)) return;
          if (getFm(this.plugin.app, file)?.type !== "card") return;
          this._invalidateQueueModel();
          this.needsRowsRender = true;
        }));
        for (const event of ["create", "delete", "rename"]) {
          this.registerEvent(this.plugin.app.vault.on(event, (file, oldPath) => {
            const relevant = event === "rename" ? isPathInIRCollection(this.plugin.settings, file?.path) || isPathInIRCollection(this.plugin.settings, oldPath) : isPathInIRCollection(this.plugin.settings, file?.path);
            if (!relevant) return;
            this._invalidateQueueModel();
            this._scheduleRowsRender(`vault-${event}`);
          }));
        }
        this.registerEvent(this.plugin.app.workspace.on("file-open", (file) => {
          if (!this.plugin.directQueueNavigation) this._scheduleTimelineRefresh(file);
        }));
        this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => {
          if (this.plugin.directQueueNavigation) return;
          if (this.needsRowsRender && this.plugin.app.workspace.activeLeaf === this.leaf) {
            this._scheduleRowsRender("visible");
          }
        }));
        this._scheduleDateRefresh();
      }
      async onClose() {
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
        if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
        if (this.timelineTimer) window.clearTimeout(this.timelineTimer);
      }
      _invalidateQueueModel() {
        this.queueRevision++;
        this.queueModel = null;
        this.queueModelPromise = null;
      }
      _scheduleRowsRender(reason) {
        if (this.plugin.directQueueNavigation) return;
        if (this.plugin.collectionRenderDeferrals > 0) {
          this.needsRowsRender = true;
          return;
        }
        if (!isViewVisible(this)) {
          this.needsRowsRender = true;
          return;
        }
        this.needsRowsRender = false;
        if (this.modifyTimer) window.clearTimeout(this.modifyTimer);
        this.modifyTimer = window.setTimeout(() => {
          this.modifyTimer = null;
          this._renderRows(this.containerEl.children[1], reason);
        }, 150);
      }
      _scheduleDateRefresh() {
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
        const nextDay = /* @__PURE__ */ new Date();
        nextDay.setHours(24, 0, 0, 100);
        this.refreshTimer = window.setTimeout(() => {
          this._invalidateQueueModel();
          this._renderRows(this.containerEl.children[1], "date-change");
          this._scheduleDateRefresh();
        }, Math.max(1e3, nextDay.getTime() - Date.now()));
      }
      _render() {
        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("ir-queue-root");
        root.createDiv({ cls: "ir-queue-header", text: "Reading queue" });
        const filterInput = root.createEl("input", {
          cls: "ir-queue-filter",
          type: "text",
          placeholder: "Filter by tag or title…"
        });
        filterInput.value = this.filter;
        filterInput.addEventListener("input", (e) => {
          this.filter = e.target.value;
          this._renderRows(root, "filter");
        });
        this.sectionsEl = root.createDiv({ cls: "ir-queue-sections" });
        this.timelineEl = root.createDiv({ cls: "ir-queue-timeline-host" });
        this._renderRows(root, "open");
        this._refreshTimeline(true);
      }
      async _buildQueueModel() {
        const today = todayDate();
        let session = await this.plugin.readSessionSnapshot();
        if (!session) {
          const pool = await this.plugin.buildDuePool({ skipCurrent: false });
          session = this.plugin.buildInterleavedQueue(pool, today);
        }
        const sessionPaths = new Set(session.filter((row) => !row.fm?.inline_parent).map((row) => row.tfile.path));
        const groups = { overdue: [], newItems: [], active: [] };
        for (const { tfile: file, fm } of this.plugin.getIRRows()) {
          if (sessionPaths.has(file.path)) continue;
          if (!isQueueVisibleIR(fm) || fm.type === "card") continue;
          const row = { tfile: file, file, fm };
          if (fm.status === "pending" || fm.status === "inbox") groups.newItems.push(row);
          else if (!fm.next_review) groups.active.push(row);
          else if (isPastDue(fm, today, this.plugin.settings)) groups.overdue.push(row);
        }
        const sortKey = this.plugin.settings.queue.sort_key;
        const sortFn = (a, b) => {
          if (sortKey === "priority") return (a.fm.priority ?? 50) - (b.fm.priority ?? 50);
          if (sortKey === "due_date") {
            const ad = parseDateValue(a.fm.next_review, this.plugin.settings);
            const bd = parseDateValue(b.fm.next_review, this.plugin.settings);
            return (ad?.getTime() ?? Infinity) - (bd?.getTime() ?? Infinity);
          }
          return urgency(b.fm, today, this.plugin.settings) - urgency(a.fm, today, this.plugin.settings);
        };
        groups.overdue.sort(sortFn);
        groups.newItems.sort(sortFn);
        groups.active.sort(sortFn);
        return { date: todayDateString(this.plugin.settings), session, groups };
      }
      async _getQueueModel() {
        const date = todayDateString(this.plugin.settings);
        if (this.queueModel?.date === date) return this.queueModel;
        if (this.queueModel && this.queueModel.date !== date) this._invalidateQueueModel();
        if (this.queueModelPromise) return this.queueModelPromise;
        const revision = this.queueRevision;
        const promise = this._buildQueueModel();
        this.queueModelPromise = promise;
        try {
          const model = await promise;
          if (revision === this.queueRevision) this.queueModel = model;
          return model;
        } finally {
          if (this.queueModelPromise === promise) this.queueModelPromise = null;
        }
      }
      async _renderRows(root, reason = "unknown") {
        const started = window.performance?.now?.() ?? Date.now();
        const generation = ++this.rowsGeneration;
        const model = await this._getQueueModel();
        const sectionsEl = this.sectionsEl || root.querySelector(".ir-queue-sections");
        if (generation !== this.rowsGeneration || !sectionsEl.isConnected) return;
        sectionsEl.empty();
        const matchesFilter = (row) => {
          const file = row.tfile || row.file;
          return !this._filterMiss(this.plugin.app.metadataCache.getFileCache(file), file);
        };
        const sessionFiltered = model.session.filter((r) => {
          const cache = this.plugin.app.metadataCache.getFileCache(r.tfile);
          return !this._filterMiss(cache, r.tfile);
        }).map((r) => ({ ...r, file: r.tfile }));
        this._renderSection(sectionsEl, "Today's Session", sessionFiltered);
        this._renderSection(sectionsEl, "Overdue (not in session)", model.groups.overdue.filter(matchesFilter));
        this._renderSection(sectionsEl, "New", model.groups.newItems.filter(matchesFilter));
        this._renderSection(sectionsEl, "Active (no due)", model.groups.active.filter(matchesFilter));
        const elapsed = (window.performance?.now?.() ?? Date.now()) - started;
        this.plugin._dbg("queue render", { reason, elapsed_ms: Math.round(elapsed * 10) / 10 });
      }
      _filterMiss(cache, file) {
        if (!this.filter) return false;
        const f = this.filter.toLowerCase();
        const tagHit = (cache?.tags || []).some((t) => t.tag.toLowerCase().includes(f));
        const titleHit = file.basename.toLowerCase().includes(f);
        return !tagHit && !titleHit;
      }
      _renderSection(root, title, rows) {
        if (!rows.length) return;
        const sec = root.createDiv({ cls: "ir-queue-section" });
        sec.createEl("div", { cls: "ir-queue-section-title", text: `${title} (${rows.length})` });
        const limit = this.sectionLimits.get(title) || 100;
        for (const r of rows.slice(0, limit)) {
          const el = sec.createDiv({ cls: "ir-queue-row" });
          el.createSpan({ text: { source: "📖", extract: "✂️", card: "🃏" }[r.fm.type] || "•" });
          el.createSpan({ cls: "ir-queue-row-title", text: r.file.basename });
          el.createSpan({ cls: "ir-queue-row-pri", text: `p${r.fm.priority ?? "?"}` });
          el.addEventListener("click", () => this._open(r));
        }
        if (rows.length > limit) {
          const more = sec.createEl("button", {
            cls: "ir-queue-show-more",
            text: `Show ${Math.min(100, rows.length - limit)} more`
          });
          more.addEventListener("click", () => {
            this.sectionLimits.set(title, limit + 100);
            this._renderRows(this.containerEl.children[1], "show-more");
          });
        }
      }
      async _open(r) {
        if (r.fm.inline_parent) {
          await this.plugin._reviewInlineCard(r.fm.inline_parent, r.fm.id);
          this._invalidateQueueModel();
          this._renderRows(this.containerEl.children[1], "inline-review");
          return;
        }
        await this.plugin.openLearningItem({ ...r, tfile: r.file });
      }
      _refreshTimeline(force = false, file = this.plugin.app.workspace.getActiveFile()) {
        const path = file?.path || null;
        if (!force && path === this.activeTimelinePath) return;
        this.activeTimelinePath = path;
        if (this.timelineEl) this._renderTimeline(this.timelineEl, file);
      }
      _scheduleTimelineRefresh(file) {
        if (this.timelineTimer) window.clearTimeout(this.timelineTimer);
        this.timelineTimer = window.setTimeout(() => {
          this.timelineTimer = null;
          if (!this.plugin.directQueueNavigation) this._refreshTimeline(false, file);
        }, 120);
      }
      _renderTimeline(root, active = this.plugin.app.workspace.getActiveFile()) {
        root.empty();
        if (!active) return;
        const fm = this.plugin.app.metadataCache.getFileCache(active)?.frontmatter;
        if (!isActiveIR(fm)) return;
        const panel = root.createDiv({ cls: "ir-timeline-panel" });
        panel.createEl("div", { cls: "ir-queue-section-title", text: `Timeline: ${active.basename}` });
        for (const c of fm.checkpoints || []) {
          const row = panel.createDiv({ cls: "ir-timeline-row" });
          row.setText(`${c.date} L${c.line} — ${c.note}`);
          row.addEventListener("click", async () => {
            const leaf = this.plugin.app.workspace.getLeaf(false);
            await leaf.openFile(active);
            const ed = this.plugin.app.workspace.activeEditor?.editor;
            if (ed) ed.setCursor({ line: c.line, ch: 0 });
          });
        }
        const input = panel.createEl("input", { type: "text", cls: "ir-queue-filter", placeholder: "New checkpoint (Nd:: optional)" });
        input.addEventListener("keydown", async (e) => {
          if (e.key === "Enter" && input.value.trim()) {
            await this.plugin.addCheckpoint(input.value.trim());
            input.value = "";
            this._refreshTimeline(true);
          }
        });
      }
    };
    var UserGuideModal = class extends Modal {
      onOpen() {
        this.setTitle("Incremental Reading Toolkit guide");
        const root = this.contentEl;
        root.addClass("ir-guide-modal");
        root.createEl("h3", { text: "Quickstart" });
        const quick = root.createEl("ol");
        for (const text of [
          "Open an article note and run Import clipping, or create a source with New source.",
          "Run Build today's session queue once, then use Next element to move through it.",
          "Select important text and run Extract selection.",
          "Leave the cursor where you stopped, then run Grade current reading topic.",
          "Create recall material with Flashcard from clipboard.",
          "Next element opens card review automatically; the answer finishes that queue item."
        ]) quick.createEl("li", { text });
        root.createEl("h3", { text: "Recommended hotkeys" });
        root.createEl("p", { text: "Open Settings -> Hotkeys and search for Incremental Reading Toolkit. These are suggestions, not defaults." });
        const table = root.createEl("table");
        const head = table.createEl("thead").createEl("tr");
        head.createEl("th", { text: "Command" });
        head.createEl("th", { text: "Suggested hotkey" });
        const body = table.createEl("tbody");
        for (const [command, hotkey] of [
          ["Next element", "Cmd/Ctrl+Shift+J"],
          ["Grade current reading topic", "Cmd/Ctrl+Shift+Enter"],
          ["Extract selection", "Cmd/Ctrl+Shift+E"],
          ["Flashcard from clipboard", "Cmd/Ctrl+Shift+F"],
          ["Current element actions…", "Cmd/Ctrl+Shift+A"]
        ]) {
          const row = body.createEl("tr");
          row.createEl("td", { text: command });
          row.createEl("td").createEl("code", { text: hotkey });
        }
        root.createEl("h3", { text: "Daily reading loop" });
        const daily = root.createEl("ul");
        for (const text of [
          "Build today's session queue performs scheduling work; Next element opens the saved path and starts card review when needed.",
          "Extracts remain reading topics; cards are reviewed in Spaced Repetition.",
          "Moving the Markdown read-point or advancing a page/timestamp counts as progress.",
          "Use Mercy to spread overdue work and Postpone subtree to move related material together."
        ]) daily.createEl("li", { text });
        root.createEl("h3", { text: "PDFs, cards, and dates" });
        root.createEl("p", { text: "Use the Toolkit PDF viewer for vault or external PDFs. Card algorithms and grades remain in Spaced Repetition, while the mixed session alternates their card notes with reading topics." });
        root.createEl("p", { text: "Choose DD-MM-YYYY, MM-DD-YYYY, or YYYY-MM-DD in General settings. Relative schedules such as +3d work with every format." });
        root.createEl("h3", { text: "Troubleshooting" });
        const trouble = root.createEl("ul");
        for (const text of [
          "No cards in review: enable Spaced Repetition and keep #flashcards in its flashcard tags.",
          "PDF will not open: confirm pdf_path points to an existing PDF, or use pdf_vault_path for a vault file.",
          "Ambiguous tree parent: rename files that share the same basename.",
          "For the full guide, open docs/USER-GUIDE.md in the GitHub repository from the Help link."
        ]) trouble.createEl("li", { text });
      }
      onClose() {
        this.contentEl.empty();
      }
    };
    var IncrementalReadingSettingTab = class extends PluginSettingTab {
      constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
      }
      display() {
        const { containerEl } = this;
        containerEl.empty();
        this._about(containerEl);
        this._scheduling(containerEl);
        this._queue(containerEl);
        this._inlineCards(containerEl);
        this._spacedRepetition(containerEl);
        this._knowledgeTree(containerEl);
        this._paths(containerEl);
        this._misc(containerEl);
      }
      _about(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName(`Incremental Reading Toolkit ${this.plugin.manifest.version}`).setHeading();
        new Setting(sec).setName("User guide").setDesc("Open the quickstart, suggested hotkeys, daily workflow, and troubleshooting inside Obsidian.").addButton((button) => button.setButtonText("Open user guide").setCta().onClick(() => this.plugin.openUserGuide()));
        const ready = this.plugin.isSpacedRepetitionReady();
        new Setting(sec).setName("Setup status").setDesc(ready ? "Spaced Repetition is ready for card review." : "Spaced Repetition is not ready; enable it before reviewing cards.").addButton((button) => button.setButtonText("Run setup check").onClick(() => this.plugin.runSetupCheck()));
      }
      _numberSetting(section, name, description, target, key, { min, max, step = "any" } = {}) {
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName(name).setDesc(description).addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.step = String(step);
          if (min != null) text.inputEl.min = String(min);
          if (max != null) text.inputEl.max = String(max);
          text.setValue(String(target[key])).onChange((value) => {
            const number = Number(value);
            const valid = Number.isFinite(number) && (min == null || number >= min) && (max == null || number <= max);
            text.inputEl.toggleClass("is-invalid", !valid);
            if (!valid) return;
            target[key] = number;
            save();
          });
        });
      }
      _scheduling(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Reading schedule").setHeading();
        const s = this.plugin.settings.scheduling;
        const save = () => this.plugin.saveSettings();
        new Setting(sec).setName("Progress-aware A-Factor").setDesc("Adjust intervals from the pages or media time still remaining. Recommended for books, PDFs, and videos.").addToggle((t) => t.setValue(s.progress_aware).onChange((v) => {
          s.progress_aware = v;
          save();
        }));
        new Setting(sec).setName("Stall guard").setDesc("Prevent intervals from growing when the page, timestamp, or Markdown read-point does not move.").addToggle((t) => t.setValue(s.stall_guard).onChange((v) => {
          s.stall_guard = v;
          save();
        }));
        this._numberSetting(sec, "Minimum A-Factor", "Smallest interval-growth multiplier. Values just above 1 keep material in frequent rotation.", s, "a_factor_min", { min: 1.01, max: 10, step: 0.01 });
        this._numberSetting(sec, "Maximum A-Factor", "Largest interval-growth multiplier allowed for nearly finished material.", s, "a_factor_max", { min: 1.01, max: 10, step: 0.01 });
        new Setting(sec).setName("Review pace adjustments").setHeading();
        this._numberSetting(sec, "Hold multiplier", "Applied when choosing Hold. Use 1 to keep the current A-Factor.", s, "quality_hold", { min: 0.1, max: 3, step: 0.01 });
        this._numberSetting(sec, "See sooner multiplier", "Applied when choosing Speed up. Values below 1 shorten future growth.", s, "quality_speed_up", { min: 0.1, max: 3, step: 0.01 });
        this._numberSetting(sec, "Push out multiplier", "Applied when choosing Slow down. Values above 1 lengthen future growth.", s, "quality_slow_down", { min: 0.1, max: 3, step: 0.01 });
        new Setting(sec).setName("Initial interval model").setHeading();
        this._numberSetting(sec, "Base A-Factor", "Starting multiplier before source length is considered.", s, "initial_af_base", { min: 1.01, max: 10, step: 0.01 });
        this._numberSetting(sec, "Length sensitivity", "How strongly longer sources receive smaller A-Factors.", s, "initial_af_slope", { min: 0, max: 3, step: 0.01 });
        this._numberSetting(sec, "Length scale", "Pages, or minutes for media, treated as the neutral source size.", s, "initial_af_units_divisor", { min: 1, max: 1e4, step: 1 });
        this._numberSetting(sec, "Extract bump", "Multiplier applied to the parent A-Factor after creating an extract.", s, "extract_bump", { min: 0.1, max: 3, step: 0.01 });
      }
      _queue(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Queue").setHeading();
        const s = this.plugin.settings.queue;
        const save = () => this.plugin.saveSettings();
        new Setting(sec).setName("Sidebar enabled").setDesc("Allow the reading queue to open in the sidebar and refresh as notes change.").addToggle((t) => t.setValue(s.sidebar_enabled).onChange((v) => {
          s.sidebar_enabled = v;
          save();
        }));
        new Setting(sec).setName("Default tag filter").setDesc("Initial sidebar filter. Leave empty to show every scheduled topic.").addText((t) => t.setValue(s.default_tag_filter).onChange((v) => {
          s.default_tag_filter = v;
          save();
        }));
        new Setting(sec).setName("Supplementary list order").setDesc("Controls overdue, new, and unscheduled sections. Today's session keeps its scheduled order.").addDropdown((d) => {
          d.addOption("urgency", "Urgency").addOption("priority", "Priority").addOption("due_date", "Due date").setValue(s.sort_key).onChange((v) => {
            s.sort_key = v;
            save();
          });
        });
        new Setting(sec).setName("Mix cards with topics").setDesc("Alternate card notes with reading topics in the daily learning stream. Spaced Repetition still grades and schedules the cards.").addToggle((t) => t.setValue(s.mix_cards !== false).onChange((v) => {
          s.mix_cards = v;
          save();
        }));
      }
      _inlineCards(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Inline card export").setHeading();
        const s = this.plugin.settings.inline_cards;
        const save = () => this.plugin.saveSettings();
        new Setting(sec).setName("Enabled").setDesc("Allow Export inline cards to recognize question/answer, cloze, and highlighted-text forms.").addToggle((t) => t.setValue(s.enabled).onChange((v) => {
          s.enabled = v;
          save();
        }));
        new Setting(sec).setName("Q::A regex").setDesc("Advanced pattern for one-line Q::question::A::answer cards.").addText((t) => t.setValue(s.qa_regex).onChange((v) => {
          s.qa_regex = v;
          save();
        }));
        new Setting(sec).setName("Cloze regex").setDesc("Advanced pattern for {{c1::answer::hint}} cards.").addText((t) => t.setValue(s.cloze_regex).onChange((v) => {
          s.cloze_regex = v;
          save();
        }));
      }
      _spacedRepetition(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Spaced Repetition").setHeading();
        const s = this.plugin.settings.spaced_repetition;
        const save = () => this.plugin.saveSettings();
        new Setting(sec).setName("Dependency").setDesc(this.plugin.isSpacedRepetitionReady() ? "Ready. Card review commands will open Spaced Repetition." : "Not ready. Install and enable the Spaced Repetition community plugin.");
        new Setting(sec).setName("Flashcard deck tag").setDesc("Match a flashcard tag configured in Spaced Repetition. Do not include the leading #.").addText((t) => t.setValue(s.flashcardTag).onChange((v) => {
          s.flashcardTag = v.replace(/^#/, "").trim() || "flashcards/incremental-reading";
          save();
        }));
        new Setting(sec).setName("Multiline card separator").setDesc("Match the multiline separator configured in Spaced Repetition.").addText((t) => t.setValue(s.multilineCardSeparator).onChange((v) => {
          s.multilineCardSeparator = v.trim() || "?";
          save();
        }));
        new Setting(sec).setName("Bidirectional card separator").setDesc("Match the multiline reversed separator configured in Spaced Repetition.").addText((t) => t.setValue(s.multilineReversedCardSeparator).onChange((v) => {
          s.multilineReversedCardSeparator = v.trim() || "??";
          save();
        }));
      }
      _knowledgeTree(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Knowledge tree").setHeading();
        this._numberSetting(
          sec,
          "Large branch warning",
          "Highlight a category child count after it exceeds this number.",
          this.plugin.settings.tree,
          "child_warn_threshold",
          { min: 1, max: 1e5, step: 1 }
        );
        new Setting(sec).setName("Show completed material").setDesc("Include done and dismissed topics in the knowledge tree.").addToggle((t) => t.setValue(this.plugin.settings.tree.show_completed).onChange((v) => {
          this.plugin.settings.tree.show_completed = v;
          this.plugin.saveSettings();
          this.plugin._refreshTreeViews();
        }));
      }
      _paths(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("Paths").setHeading();
        const s = this.plugin.settings.paths;
        const save = () => {
          this.plugin._invalidateIRCollection(true);
          return this.plugin.saveSettings();
        };
        const paths = [
          ["sources", "Sources folder", "Source notes and local video files."],
          ["extracts", "Extracts folder", "Passages scheduled as separate reading topics."],
          ["cards", "Cards folder", "Markdown cards consumed by Spaced Repetition."],
          ["attachments", "Attachments folder", "Clipboard images and visual-learning assets."],
          ["categories", "Categories folder", "Knowledge-tree category notes."],
          ["dashboard", "Dashboard note", "Optional session snapshot and dashboard note path."],
          ["review_log", "Review log", "Markdown table containing completed topic reviews."]
        ];
        for (const [key, name, description] of paths) {
          new Setting(sec).setName(name).setDesc(description).addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.paths[key]).setValue(s[key] || DEFAULT_SETTINGS.paths[key]).onChange((v) => {
            s[key] = v.trim() || DEFAULT_SETTINGS.paths[key];
            save();
          })).addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip(`Reset ${name.toLowerCase()}`).onClick(async () => {
            s[key] = DEFAULT_SETTINGS.paths[key];
            await save();
            this.display();
          }));
        }
      }
      _misc(root) {
        const sec = root.createDiv({ cls: "ir-settings-section" });
        new Setting(sec).setName("General").setHeading();
        const s = this.plugin.settings.misc;
        const save = () => this.plugin.saveSettings();
        new Setting(sec).setName("Date format").setDesc("Used for scheduling fields, prompts, checkpoints, and the review log.").addDropdown((d) => {
          for (const format of dateCore2.SUPPORTED_DATE_FORMATS) d.addOption(format, format);
          d.setValue(configuredDateFormat(this.plugin.settings)).onChange(async (value) => {
            const previous = configuredDateFormat(this.plugin.settings);
            if (previous === value) return;
            try {
              const changed = await this.plugin.migrateDateFormat(previous, value);
              s.date_format = value;
              await save();
              new Notice2(`日期格式已切换为 ${value}；迁移了 ${changed} 个已存日期。`);
            } catch (error) {
              new Notice2(`日期迁移失败：${error.message}`);
            }
          });
        });
        new Setting(sec).setName("Extract highlight colour").setDesc("Accent used for extracted source passages and extract notes in editing and reading views.").addColorPicker((picker) => picker.setValue(normalizedExtractHighlightColor(s.extract_highlight_color)).onChange(async (value) => {
          s.extract_highlight_color = normalizedExtractHighlightColor(value);
          await save();
          this.plugin._refreshExcerptViews();
        })).addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip("Reset extract highlight colour").onClick(async () => {
          s.extract_highlight_color = DEFAULT_EXTRACT_HIGHLIGHT_COLOR;
          await save();
          this.plugin._refreshExcerptViews();
          this.display();
        }));
        new Setting(sec).setName("Diagnostics").setHeading();
        new Setting(sec).setName("Debug logging").setDesc("Write additional details to the developer console. Keep disabled during normal use.").addToggle((t) => t.setValue(s.debug).onChange((v) => {
          s.debug = v;
          save();
        }));
      }
    };
    var TREE_ICONS = { category: "📁", source: "📖", extract: "✂️", card: "🃏" };
    var MainDashboardView = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.timer = null;
        this.collectionRevision = 0;
        this.renderGeneration = 0;
        this.scrollToStatsOnRender = false;
        this.needsRender = false;
      }
      getViewType() {
        return MAIN_DASHBOARD_VIEW_TYPE;
      }
      getDisplayText() {
        return "Learning dashboard";
      }
      getIcon() {
        return "layout-dashboard";
      }
      async onOpen() {
        this.collectionRevision = this.plugin.irCollectionRevision;
        this.render();
        this.registerEvent(this.plugin.app.metadataCache.on("changed", (file) => {
          if (this.collectionRevision === this.plugin.irCollectionRevision) return;
          this.collectionRevision = this.plugin.irCollectionRevision;
          this._requestRender();
        }));
        this.registerEvent(this.plugin.app.vault.on("modify", (file) => {
          if (!isPathInIRCollection(this.plugin.settings, file?.path)) return;
          if (getFm(this.plugin.app, file)?.type !== "card") return;
          this.needsRender = true;
        }));
        for (const event of ["create", "delete", "rename"]) {
          this.registerEvent(this.plugin.app.vault.on(event, (file, oldPath) => {
            const relevant = event === "rename" ? isPathInIRCollection(this.plugin.settings, file?.path) || isPathInIRCollection(this.plugin.settings, oldPath) : isPathInIRCollection(this.plugin.settings, file?.path);
            if (!relevant) return;
            this.collectionRevision = this.plugin.irCollectionRevision;
            this._requestRender();
          }));
        }
        this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => {
          if (this.plugin.directQueueNavigation) return;
          if (this.needsRender && this.plugin.app.workspace.activeLeaf === this.leaf) this._requestRender();
        }));
      }
      async onClose() {
        if (this.timer) window.clearTimeout(this.timer);
      }
      _requestRender() {
        if (this.plugin.directQueueNavigation) return;
        if (this.plugin.collectionRenderDeferrals > 0) {
          this.needsRender = true;
          return;
        }
        if (!isViewVisible(this)) {
          this.needsRender = true;
          return;
        }
        this.needsRender = false;
        if (this.timer) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          this.render();
        }, 250);
      }
      _metric(parent, value, label, tone = "") {
        const card = parent.createDiv({ cls: `ir-dashboard-metric ${tone}`.trim() });
        card.createDiv({ cls: "ir-dashboard-metric-value", text: String(value) });
        card.createDiv({ cls: "ir-dashboard-metric-label", text: label });
      }
      _activityChart(parent, days) {
        const max = Math.max(1, ...days.map((day) => day.count));
        const chart = parent.createDiv({ cls: "ir-dashboard-activity-chart" });
        chart.setAttribute("role", "img");
        chart.setAttribute("aria-label", `Topic reviews over the last ${days.length} days`);
        for (const [index, day] of days.entries()) {
          const column = chart.createDiv({ cls: "ir-dashboard-activity-column" });
          const value = column.createDiv({ cls: "ir-dashboard-activity-value", text: String(day.count) });
          value.toggleClass("is-zero", day.count === 0);
          const track = column.createDiv({ cls: "ir-dashboard-activity-track" });
          const bar = track.createDiv({ cls: "ir-dashboard-activity-bar" });
          bar.style.height = `${day.count ? Math.max(8, day.count / max * 100) : 2}%`;
          bar.title = `${day.label}: ${day.count} review${day.count === 1 ? "" : "s"}`;
          const label = column.createDiv({
            cls: "ir-dashboard-activity-label",
            text: index === days.length - 1 ? "Today" : index % 2 === 0 ? day.shortLabel : ""
          });
          label.title = day.label;
        }
      }
      _distributionChart(parent, rows) {
        const max = Math.max(1, ...rows.map((row) => row.value));
        const chart = parent.createDiv({ cls: "ir-dashboard-distribution" });
        for (const row of rows) {
          const item = chart.createDiv({ cls: "ir-dashboard-distribution-row" });
          const heading = item.createDiv({ cls: "ir-dashboard-distribution-heading" });
          heading.createSpan({ text: row.label });
          heading.createSpan({ text: String(row.value) });
          const track = item.createDiv({ cls: "ir-dashboard-distribution-track" });
          const bar = track.createDiv({ cls: `ir-dashboard-distribution-bar ${row.tone || ""}`.trim() });
          bar.style.width = `${row.value ? Math.max(3, row.value / max * 100) : 0}%`;
        }
      }
      async render() {
        this.needsRender = false;
        const generation = ++this.renderGeneration;
        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("ir-dashboard-root");
        const today = todayDate();
        const rows = this.plugin.getIRRows();
        const topics = rows.filter((row) => ["source", "extract"].includes(row.fm.type));
        const active = topics.filter((row) => isActiveIR(row.fm));
        const cards = rows.filter((row) => row.fm.type === "card");
        const due = active.filter((row) => isDue(row.fm, today, this.plugin.settings));
        const overdue = active.filter((row) => isPastDue(row.fm, today, this.plugin.settings));
        const reviewed = topics.filter((row) => row.fm.last_reviewed === todayDateString(this.plugin.settings));
        const activity = [];
        const activityByDate = /* @__PURE__ */ new Map();
        for (let offset = 13; offset >= 0; offset--) {
          const date = new Date(today.getTime());
          date.setDate(date.getDate() - offset);
          const key = formatDateValue(date, this.plugin.settings);
          const item = {
            key,
            label: date.toLocaleDateString(void 0, { weekday: "short", day: "numeric", month: "short" }),
            shortLabel: date.toLocaleDateString(void 0, { day: "numeric", month: "short" }),
            count: 0
          };
          activity.push(item);
          activityByDate.set(key, item);
        }
        let lifetimeReviews = 0;
        const logFile = this.plugin.app.vault.getAbstractFileByPath(this.plugin.reviewLogPath());
        if (logFile instanceof TFile2) {
          try {
            const log = await this.plugin.app.vault.cachedRead(logFile);
            if (generation !== this.renderGeneration) return;
            for (const line of log.split("\n")) {
              const firstCell = line.match(/^\|\s*([^|]+?)\s*\|/)?.[1];
              const date = parseDateValue(firstCell, this.plugin.settings);
              if (!date) continue;
              lifetimeReviews++;
              const bucket = activityByDate.get(formatDateValue(date, this.plugin.settings));
              if (bucket) bucket.count++;
            }
          } catch (error) {
            this.plugin._dbg("Could not read review log for dashboard", error);
          }
        }
        if (lifetimeReviews === 0) {
          for (const row of topics) {
            const date = parseDateValue(row.fm.last_reviewed, this.plugin.settings);
            const bucket = date && activityByDate.get(formatDateValue(date, this.plugin.settings));
            if (bucket) bucket.count++;
            lifetimeReviews += Math.max(0, Number(row.fm.review_count) || 0);
          }
        }
        const reviewsToday = activity[activity.length - 1].count || reviewed.length;
        const reviewsThisWeek = activity.slice(-7).reduce((sum, day) => sum + day.count, 0);
        const unscheduled = active.filter((row) => !row.fm.next_review).length;
        const dueToday = active.filter((row) => {
          const date = parseDateValue(row.fm.next_review, this.plugin.settings);
          return date && date.getTime() === today.getTime();
        }).length;
        const upcoming = active.filter((row) => {
          const date = parseDateValue(row.fm.next_review, this.plugin.settings);
          return date && date > today;
        }).length;
        const head = root.createDiv({ cls: "ir-dashboard-head" });
        const title = head.createDiv();
        title.createEl("h1", { text: "Incremental learning" });
        title.createEl("p", { text: `${today.toLocaleDateString(void 0, { weekday: "long", day: "numeric", month: "long" })} · mixed topics and cards` });
        const actions = head.createDiv({ cls: "ir-dashboard-actions" });
        for (const [label, action, cta] of [
          ["Start mixed session", () => this.plugin.buildSessionQueue({ openFirst: true }), true],
          ["Review cards", () => this.plugin.reviewCards(), false],
          ["Knowledge tree", () => this.plugin._activateKnowledgeTree(), false]
        ]) {
          const button = actions.createEl("button", { text: label });
          if (cta) button.addClass("mod-cta");
          button.onclick = action;
        }
        const metrics = root.createDiv({ cls: "ir-dashboard-metrics" });
        this._metric(metrics, due.length, "Due topics", due.length ? "is-warning" : "");
        this._metric(metrics, overdue.length, "Overdue", overdue.length ? "is-danger" : "");
        this._metric(metrics, reviewsToday, "Reviewed today", "is-success");
        this._metric(metrics, reviewsThisWeek, "Reviews · 7 days");
        this._metric(metrics, cards.length, "Card notes");
        this._metric(metrics, active.length, "Active topics");
        const grid = root.createDiv({ cls: "ir-dashboard-grid" });
        const sessionPanel = grid.createDiv({ cls: "ir-dashboard-panel" });
        sessionPanel.createEl("h2", { text: "Next mixed session" });
        const savedSession = await this.plugin.readSessionSnapshot();
        const session = savedSession || this.plugin.buildInterleavedQueue(await this.plugin.buildDuePool({ skipCurrent: false }), today);
        if (generation !== this.renderGeneration) return;
        if (!session.length) sessionPanel.createEl("p", { text: "Nothing due — you are caught up." });
        for (const row of session.slice(0, 12)) {
          const item = sessionPanel.createDiv({ cls: "ir-dashboard-session-row" });
          item.createSpan({ text: TREE_ICONS[row.fm.type] || "•" });
          item.createSpan({ cls: "ir-dashboard-session-title", text: row.tfile.basename });
          item.createSpan({ cls: "ir-dashboard-session-kind", text: row.fm.type });
          item.onclick = () => this.plugin.openLearningItem(row);
        }
        const health = grid.createDiv({ cls: "ir-dashboard-panel" });
        health.createEl("h2", { text: "Collection health" });
        const statusCounts = /* @__PURE__ */ new Map();
        for (const row of topics) statusCounts.set(row.fm.status || "active", (statusCounts.get(row.fm.status || "active") || 0) + 1);
        for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
          const line = health.createDiv({ cls: "ir-dashboard-health-row" });
          line.createSpan({ text: status });
          line.createSpan({ text: String(count) });
        }
        health.createEl("p", { cls: "ir-dashboard-note", text: "Topic intervals use progress-aware A-Factors. Card due dates and grades remain owned by Spaced Repetition." });
        const analytics = root.createDiv({ cls: "ir-dashboard-analytics" });
        analytics.createEl("h2", { text: "Learning analytics" });
        const analyticsGrid = analytics.createDiv({ cls: "ir-dashboard-analytics-grid" });
        const activityPanel = analyticsGrid.createDiv({ cls: "ir-dashboard-panel ir-dashboard-panel-wide" });
        const activityHead = activityPanel.createDiv({ cls: "ir-dashboard-chart-head" });
        activityHead.createEl("h3", { text: "Review activity" });
        activityHead.createSpan({ text: `${reviewsThisWeek} this week · ${lifetimeReviews} lifetime` });
        this._activityChart(activityPanel, activity);
        const workloadPanel = analyticsGrid.createDiv({ cls: "ir-dashboard-panel" });
        workloadPanel.createEl("h3", { text: "Queue workload" });
        this._distributionChart(workloadPanel, [
          { label: "Overdue", value: overdue.length, tone: "is-danger" },
          { label: "Due today", value: dueToday, tone: "is-warning" },
          { label: "Unscheduled", value: unscheduled, tone: "is-accent" },
          { label: "Upcoming", value: upcoming, tone: "is-success" }
        ]);
        const mixPanel = analyticsGrid.createDiv({ cls: "ir-dashboard-panel" });
        mixPanel.createEl("h3", { text: "Collection mix" });
        this._distributionChart(mixPanel, [
          { label: "Sources", value: topics.filter((row) => row.fm.type === "source").length, tone: "is-accent" },
          { label: "Extracts", value: topics.filter((row) => row.fm.type === "extract").length, tone: "is-warning" },
          { label: "Card notes", value: cards.length, tone: "is-success" }
        ]);
        mixPanel.createEl("p", { cls: "ir-dashboard-note", text: "Card review history remains available in the Spaced Repetition plugin." });
        if (this.scrollToStatsOnRender) {
          this.scrollToStatsOnRender = false;
          window.setTimeout(() => analytics.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
        }
      }
    };
    var PdfViewerView = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.state = {};
      }
      getViewType() {
        return PDF_VIEW_TYPE;
      }
      getDisplayText() {
        return this.state.title ? `PDF: ${this.state.title}` : "PDF reader";
      }
      getIcon() {
        return "file-text";
      }
      async setState(state) {
        this.state = { ...state };
        this.render();
      }
      getState() {
        return this.state;
      }
      async onOpen() {
        this.render();
      }
      render() {
        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("ir-pdf-root");
        if (!this.state.url) {
          root.createEl("p", { text: "Open a PDF source to begin." });
          return;
        }
        const bar = root.createDiv({ cls: "ir-pdf-toolbar" });
        bar.createSpan({ cls: "ir-pdf-title", text: this.state.title || "PDF" });
        bar.createSpan({ text: "Page" });
        const page = bar.createEl("input", { type: "number", cls: "ir-pdf-page" });
        page.min = "1";
        page.value = String(this.state.page || 1);
        const frame = root.createEl("iframe", { cls: "ir-pdf-frame", attr: { title: this.state.title || "PDF viewer" } });
        const load = () => {
          this.state.page = Math.max(1, Number(page.value) || 1);
          frame.src = `${this.state.url}#page=${this.state.page}&view=FitH`;
        };
        page.onchange = load;
        const save = bar.createEl("button", { text: "Save read point" });
        save.onclick = async () => {
          if (this.state.sourcePath) {
            const source = this.plugin.app.vault.getAbstractFileByPath(this.state.sourcePath);
            if (source) await this.plugin.app.fileManager.processFrontMatter(source, (fm) => {
              fm.read_point = Math.max(1, Number(page.value) || 1);
            });
          }
          new Notice2(`PDF read point saved at page ${Math.max(1, Number(page.value) || 1)}`);
        };
        load();
      }
    };
    var KnowledgeTreeView = class extends ItemView {
      constructor(leaf, plugin, mode) {
        super(leaf);
        this.plugin = plugin;
        this.mode = mode || "main";
        this.filter = "";
        this.typeFilter = "all";
        this._match = null;
        this.index = null;
        this.refreshTimer = null;
        this.collectionRevision = 0;
        this.needsRender = false;
        this.selectedPaths = /* @__PURE__ */ new Set();
        this.renderedSelectablePaths = [];
        this.lastSelectedPath = null;
      }
      getViewType() {
        return this.mode === "sidebar" ? KNOWLEDGE_TREE_SIDEBAR_TYPE : KNOWLEDGE_TREE_VIEW_TYPE;
      }
      getDisplayText() {
        return "Knowledge tree";
      }
      getIcon() {
        return "folder-tree";
      }
      async onOpen() {
        this.collectionRevision = this.plugin.irCollectionRevision;
        this._render();
        this.registerEvent(this.plugin.app.metadataCache.on("changed", (file) => {
          if (this.collectionRevision === this.plugin.irCollectionRevision) return;
          this.collectionRevision = this.plugin.irCollectionRevision;
          this._requestBodyRender();
        }));
        for (const event of ["create", "delete", "rename"]) {
          this.registerEvent(this.plugin.app.vault.on(event, (file, oldPath) => {
            const relevant = event === "rename" ? isPathInIRCollection(this.plugin.settings, file?.path) || isPathInIRCollection(this.plugin.settings, oldPath) : isPathInIRCollection(this.plugin.settings, file?.path);
            if (!relevant) return;
            this.collectionRevision = this.plugin.irCollectionRevision;
            this._requestBodyRender();
          }));
        }
        this.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => {
          if (this.plugin.directQueueNavigation) return;
          if (this.needsRender && this.plugin.app.workspace.activeLeaf === this.leaf) this._requestBodyRender();
        }));
      }
      async onClose() {
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
      }
      _requestBodyRender() {
        if (this.plugin.directQueueNavigation) return;
        if (this.plugin.collectionRenderDeferrals > 0) {
          this.needsRender = true;
          return;
        }
        if (!isViewVisible(this)) {
          this.needsRender = true;
          return;
        }
        this.needsRender = false;
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          this.refreshTimer = null;
          this._renderBody();
        }, 300);
      }
      // Full render: rebuilds toolbar + body. Used on open and cross-view refresh.
      // Internal updates (filter typing, expand, drag, edits) call _renderBody only, so
      // the filter <input> is not recreated mid-typing (which would drop focus).
      _render() {
        const root = this.containerEl.children[1];
        root.empty();
        root.addClass("ir-tree-root");
        root.toggleClass("ir-tree-main", this.mode === "main");
        root.toggleClass("ir-tree-compact", this.mode === "sidebar");
        const bar = root.createDiv({ cls: "ir-tree-toolbar" });
        if (this.mode === "main") {
          const b1 = bar.createEl("button", { text: "+ Category" });
          b1.onclick = async () => {
            await this.plugin.createCategory();
            this._renderBody();
          };
          const b2 = bar.createEl("button", { text: "Expand all" });
          b2.onclick = () => {
            this._setExpandAll(true);
            this._renderBody();
          };
          const b3 = bar.createEl("button", { text: "Collapse all" });
          b3.onclick = () => {
            this._setExpandAll(false);
            this._renderBody();
          };
          const refresh = bar.createEl("button", { text: "Refresh" });
          refresh.onclick = () => this._renderBody();
        }
        const fi = bar.createEl("input", { cls: "ir-tree-filter", type: "text", placeholder: "Filter by title or tag…" });
        fi.value = this.filter;
        fi.oninput = (e) => {
          this.filter = e.target.value;
          this._renderBody();
        };
        if (this.mode === "main") {
          const type = bar.createEl("select", { cls: "ir-tree-type-filter" });
          for (const [value, label] of [["all", "All types"], ["category", "Categories"], ["source", "Sources"], ["extract", "Extracts"], ["card", "Cards"]]) type.createEl("option", { value, text: label });
          type.value = this.typeFilter;
          type.onchange = () => {
            this.typeFilter = type.value;
            this._renderBody();
          };
        }
        if (this.mode === "main") {
          this._bulkBar = root.createDiv({ cls: "ir-tree-bulk" });
          this._renderBulkBar();
        }
        this._bodyEl = root.createDiv({ cls: "ir-tree-body" });
        if (this.mode === "main") {
          this._bodyEl.addEventListener("dragover", (e) => {
            e.preventDefault();
          });
          this._bodyEl.addEventListener("drop", async (e) => {
            const src = e.dataTransfer.getData("text/ir-path");
            if (src) {
              await this.plugin.reparent(src, null);
              this._renderBody();
            }
          });
        }
        this._renderBody();
      }
      _renderBody() {
        this.needsRender = false;
        if (!this._bodyEl) {
          this._render();
          return;
        }
        this._bodyEl.empty();
        this.index = this.plugin.buildTreeIndex();
        const currentPaths = new Set(this.index.pages.map((page) => page.path));
        for (const path of this.selectedPaths) {
          if (!currentPaths.has(path)) this.selectedPaths.delete(path);
        }
        this.renderedSelectablePaths = [];
        if (this.mode === "main") this._renderSummary();
        this._computeFilter();
        const catRoots = this.index.roots.filter((p) => p.fm.type === "category" && !treeCore.effectiveParent(p.fm));
        const loose = this.index.roots.filter((p) => !(p.fm.type === "category" && !treeCore.effectiveParent(p.fm)));
        for (const p of catRoots) this._renderNode(this._bodyEl, p, 0);
        this._renderUnfiled(this._bodyEl, loose);
        const renderedPaths = new Set(this.renderedSelectablePaths);
        for (const path of this.selectedPaths) {
          if (!renderedPaths.has(path)) this.selectedPaths.delete(path);
        }
        if (this.lastSelectedPath && !this.selectedPaths.has(this.lastSelectedPath)) this.lastSelectedPath = null;
        this._renderBulkBar();
      }
      _computeFilter() {
        const f = this.filter.trim().toLowerCase();
        const constrained = !!f || this.typeFilter !== "all" || !this.plugin.settings.tree.show_completed;
        if (!constrained) {
          this._match = null;
          return;
        }
        const matches = (p) => {
          if (this.typeFilter !== "all" && p.fm.type !== this.typeFilter) return false;
          if (!this.plugin.settings.tree.show_completed && ["done", "dismissed"].includes(p.fm.status)) return false;
          if (!f || p.basename.toLowerCase().includes(f)) return true;
          const tags = p.fm && p.fm.tags;
          const tagStr = Array.isArray(tags) ? tags.join(" ") : String(tags || "");
          return tagStr.toLowerCase().includes(f);
        };
        const keep = /* @__PURE__ */ new Set();
        const hiddenCompleted = /* @__PURE__ */ new Set();
        if (!this.plugin.settings.tree.show_completed) {
          for (const page of this.index.pages) {
            if (["done", "dismissed"].includes(page.fm.status)) hiddenCompleted.add(page.path);
          }
        }
        for (const p of this.index.pages) {
          if (!matches(p)) continue;
          let cur = p;
          const guard = /* @__PURE__ */ new Set();
          while (cur) {
            keep.add(cur.path);
            const up = treeCore.effectiveParent(cur.fm);
            if (!up) break;
            const next = this.index.byName.get(up.toLowerCase());
            if (!next || guard.has(next.path)) break;
            guard.add(next.path);
            cur = next;
          }
        }
        this._match = { keep, hiddenCompleted, forceExpand: !!f || this.typeFilter !== "all" };
      }
      _renderSummary() {
        let summary = this._bodyEl.previousElementSibling;
        if (!summary || !summary.hasClass?.("ir-tree-summary")) summary = this._bodyEl.parentElement.createDiv({ cls: "ir-tree-summary" });
        this._bodyEl.parentElement.insertBefore(summary, this._bodyEl);
        summary.empty();
        const counts = { category: 0, source: 0, extract: 0, card: 0 };
        for (const page of this.index.pages) {
          if (!this.plugin.settings.tree.show_completed && ["done", "dismissed"].includes(page.fm.status)) continue;
          counts[page.fm.type] = (counts[page.fm.type] || 0) + 1;
        }
        for (const [type, label] of [["category", "categories"], ["source", "sources"], ["extract", "extracts"], ["card", "cards"]]) {
          const chip = summary.createEl("button", { text: `${TREE_ICONS[type]} ${counts[type]} ${label}` });
          chip.title = `Show ${label}`;
          chip.onclick = () => {
            this.typeFilter = this.typeFilter === type ? "all" : type;
            this._render();
          };
        }
      }
      _renderBulkBar() {
        if (!this._bulkBar) return;
        const count = this.selectedPaths.size;
        this._bulkBar.empty();
        this._bulkBar.toggleClass("is-active", count > 0);
        this._bulkBar.createSpan({ cls: "ir-tree-bulk-count", text: `${count} selected` });
        const rendered = this.renderedSelectablePaths;
        const allVisibleSelected = rendered.length > 0 && rendered.every((path) => this.selectedPaths.has(path));
        const visible = this._bulkBar.createEl("button", { text: allVisibleSelected ? "Unselect visible" : "Select visible" });
        visible.type = "button";
        visible.disabled = rendered.length === 0;
        visible.onclick = () => {
          for (const path of rendered) {
            if (allVisibleSelected) this.selectedPaths.delete(path);
            else this.selectedPaths.add(path);
          }
          this.lastSelectedPath = null;
          this._renderBody();
        };
        const done = this._bulkBar.createEl("button", { text: "Done" });
        done.type = "button";
        done.disabled = count === 0;
        done.title = "Mark selected sources, extracts, and cards done";
        done.onclick = () => this._runBulkAction("done");
        const reset = this._bulkBar.createEl("button", { text: "Reset" });
        reset.type = "button";
        reset.disabled = count === 0;
        reset.title = "Make selected items active and clear their scheduling history";
        reset.onclick = () => this._runBulkAction("reset");
        const clear = this._bulkBar.createEl("button", { text: "清空" });
        clear.type = "button";
        clear.disabled = count === 0;
        clear.onclick = () => {
          this.selectedPaths.clear();
          this.lastSelectedPath = null;
          this._renderBody();
        };
      }
      async _runBulkAction(action) {
        const paths = [...this.selectedPaths];
        if (!paths.length) return;
        const changed = action === "done" ? await this.plugin.markPathsDone(paths) : await this.plugin.resetPaths(paths);
        if (!changed) return;
        this.selectedPaths.clear();
        this.lastSelectedPath = null;
        this._renderBody();
      }
      _toggleSelected(path, { range = false } = {}) {
        if (range && this.lastSelectedPath) {
          const from = this.renderedSelectablePaths.indexOf(this.lastSelectedPath);
          const to = this.renderedSelectablePaths.indexOf(path);
          if (from >= 0 && to >= 0) {
            const shouldSelect = !this.selectedPaths.has(path);
            for (const candidate of this.renderedSelectablePaths.slice(Math.min(from, to), Math.max(from, to) + 1)) {
              if (shouldSelect) this.selectedPaths.add(candidate);
              else this.selectedPaths.delete(candidate);
            }
          }
        } else if (this.selectedPaths.has(path)) this.selectedPaths.delete(path);
        else this.selectedPaths.add(path);
        this.lastSelectedPath = path;
        this._renderBody();
      }
      _renderNode(parentEl, page, depth) {
        if (depth > 50) return;
        if (this._match && !this._match.keep.has(page.path)) return;
        if (this._match?.hiddenCompleted.has(page.path)) {
          const promoted = treeCore.flattenedVisibleChildren(
            this.index,
            page,
            this._match.keep,
            this._match.hiddenCompleted
          );
          for (const child of promoted) this._renderNode(parentEl, child, depth);
          return;
        }
        const key = page.path;
        const children = treeCore.flattenedVisibleChildren(
          this.index,
          page,
          this._match?.keep || null,
          this._match?.hiddenCompleted || null
        );
        const hasChildren = children.length > 0;
        const expanded = !!this._match?.forceExpand || this.plugin.isExpanded(key);
        const row = parentEl.createDiv({ cls: "ir-tree-row" });
        row.dataset.irPath = page.path;
        row.style.setProperty("--ir-tree-depth", String(depth));
        const tw = row.createSpan({ cls: "ir-tree-twisty", text: hasChildren ? expanded ? "▼" : "▶" : "" });
        if (hasChildren) tw.onclick = (e) => {
          e.stopPropagation();
          this.plugin.toggleExpanded(key);
          this._renderBody();
        };
        const selectable = this.mode === "main" && ["source", "extract", "card"].includes(page.fm.type);
        if (selectable) {
          this.renderedSelectablePaths.push(page.path);
          const checkbox = row.createEl("input", { cls: "ir-tree-select", type: "checkbox" });
          checkbox.checked = this.selectedPaths.has(page.path);
          checkbox.draggable = false;
          checkbox.setAttribute("aria-label", `Select ${page.basename}`);
          checkbox.onpointerdown = (event) => event.stopPropagation();
          checkbox.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            this._toggleSelected(page.path, { range: event.shiftKey });
          };
          row.toggleClass("is-selected", checkbox.checked);
        }
        row.createSpan({ cls: "ir-tree-icon", text: TREE_ICONS[page.fm.type] || "•" });
        row.createSpan({ cls: "ir-tree-title", text: page.basename });
        const parentName = treeCore.effectiveParent(page.fm);
        if (parentName && !this.index.byName.has(parentName.toLowerCase())) {
          const w = row.createSpan({ cls: "ir-tree-warn", text: "⚠" });
          w.title = `找不到父项：${parentName}`;
        }
        if (this.mode === "main") {
          if (page.fm.type !== "category") {
            row.createSpan({ cls: "ir-tree-pri", text: `p${page.fm.priority ?? "?"}` });
          }
          if (hasChildren) {
            const cc = row.createSpan({ cls: "ir-tree-count", text: String(children.length) });
            if (children.length > this.plugin.settings.tree.child_warn_threshold) cc.addClass("ir-tree-count-warn");
          }
          const status = row.createSpan({ cls: `ir-tree-status is-${page.fm.status || "active"}`, text: page.fm.status || "active" });
          status.title = page.fm.next_review ? `Next review: ${page.fm.next_review}` : "No review date";
          this._attachDrag(row, page);
          this._attachActions(row, page);
        }
        row.tabIndex = 0;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-expanded", hasChildren ? String(expanded) : "false");
        row.setAttribute("aria-selected", String(this.selectedPaths.has(page.path)));
        row.onclick = (event) => {
          if (event.target.closest("button, input, .ir-tree-twisty")) return;
          if (selectable && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            this._toggleSelected(page.path, { range: event.shiftKey });
            return;
          }
          this._openPage(page);
        };
        row.onkeydown = (event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            this._openPage(page);
          }
          if (hasChildren && event.key === "ArrowRight" && !expanded) {
            event.preventDefault();
            this.plugin.toggleExpanded(key);
            this._renderBody();
          }
          if (hasChildren && event.key === "ArrowLeft" && expanded) {
            event.preventDefault();
            this.plugin.toggleExpanded(key);
            this._renderBody();
          }
        };
        if (expanded && hasChildren) {
          for (const c of children) this._renderNode(parentEl, c, depth + 1);
        }
      }
      _renderUnfiled(body, loose) {
        const kept = this._match ? loose.filter((p) => this._match.keep.has(p.path)) : loose;
        const visible = [];
        for (const page of kept) {
          if (this._match?.hiddenCompleted.has(page.path)) {
            visible.push(...treeCore.flattenedVisibleChildren(
              this.index,
              page,
              this._match.keep,
              this._match.hiddenCompleted
            ));
          } else visible.push(page);
        }
        if (!visible.length) return;
        const key = "::unfiled::";
        const expanded = !!this._match?.forceExpand || this.plugin.isExpanded(key);
        const row = body.createDiv({ cls: "ir-tree-row ir-tree-unfiled" });
        const tw = row.createSpan({ cls: "ir-tree-twisty", text: expanded ? "▼" : "▶" });
        tw.onclick = (e) => {
          e.stopPropagation();
          this.plugin.toggleExpanded(key);
          this._renderBody();
        };
        row.createSpan({ cls: "ir-tree-icon", text: "📥" });
        row.createSpan({ cls: "ir-tree-title", text: `Unfiled (${visible.length})` });
        if (expanded) for (const p of visible) this._renderNode(body, p, 1);
      }
      _setExpandAll(on) {
        if (!on) {
          this.plugin.settings.tree.expanded = [];
          this.plugin.saveSettings();
          return;
        }
        const keys = ["::unfiled::"];
        for (const p of this.index.pages) {
          if ((this.index.childrenOf.get(p.basename.toLowerCase()) || []).length) keys.push(p.path);
        }
        this.plugin.settings.tree.expanded = keys;
        this.plugin.saveSettings();
      }
      async _openPage(page) {
        let leaf = this.contentLeaf;
        if (!leaf || !leaf.view) {
          leaf = this.plugin.app.workspace.getLeaf("tab");
          this.contentLeaf = leaf;
        }
        await leaf.openFile(page.tfile, { active: true });
        this.plugin.app.workspace.revealLeaf(leaf);
        if (page.fm.type === "source") {
          this.plugin.app.commands.executeCommandById(`${this.plugin.manifest.id}:jump-to-read-point`);
        }
      }
      _attachDrag(row, page) {
        row.draggable = true;
        row.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/ir-path", page.path);
          e.dataTransfer.effectAllowed = "move";
        });
        if (page.fm.type === "card") return;
        row.addEventListener("dragover", (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.addClass("ir-tree-drop");
        });
        row.addEventListener("dragleave", () => row.removeClass("ir-tree-drop"));
        row.addEventListener("drop", async (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.removeClass("ir-tree-drop");
          const src = e.dataTransfer.getData("text/ir-path");
          if (!src || src === page.path) return;
          await this.plugin.reparent(src, page.basename);
          this._renderBody();
        });
      }
      _attachActions(row, page) {
        const actions = row.createDiv({ cls: "ir-tree-actions" });
        actions.addEventListener("pointerdown", (event) => event.stopPropagation());
        actions.addEventListener("click", (event) => event.stopPropagation());
        const move = actions.createEl("button", { text: "Move" });
        move.type = "button";
        move.draggable = false;
        move.title = "Move under another node";
        move.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.plugin.reparentPath(page.path);
          this._renderBody();
        };
        const up = actions.createEl("button", { text: "↑" });
        up.type = "button";
        up.draggable = false;
        up.title = "Move up";
        up.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.plugin.reorderSibling(page.path, -1);
          this._renderBody();
        };
        const down = actions.createEl("button", { text: "↓" });
        down.type = "button";
        down.draggable = false;
        down.title = "Move down";
        down.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.plugin.reorderSibling(page.path, 1);
          this._renderBody();
        };
        const ren = actions.createEl("button", { text: "✎" });
        ren.type = "button";
        ren.draggable = false;
        ren.title = "Rename";
        ren.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          await this.plugin.renameTreeNode(page.path);
          this._renderBody();
        };
        if (["source", "extract", "card"].includes(page.fm.type)) {
          if (page.fm.status !== "done") {
            const done = actions.createEl("button", { text: "✓" });
            done.type = "button";
            done.draggable = false;
            done.title = "Mark done";
            done.onclick = async (e) => {
              e.preventDefault();
              e.stopPropagation();
              await this.plugin.markPathsDone([page.path]);
              this._renderBody();
            };
          }
          const reset = actions.createEl("button", { text: "↺" });
          reset.type = "button";
          reset.draggable = false;
          reset.title = "Reset scheduling and make active";
          reset.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.plugin.resetPaths([page.path]);
            this._renderBody();
          };
        }
        if (page.fm.type !== "card") {
          const dis = actions.createEl("button", { text: "✕" });
          dis.type = "button";
          dis.draggable = false;
          dis.title = "Dismiss";
          dis.onclick = async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await this.plugin.dismissTreeNode(page.path);
            this._renderBody();
          };
        }
      }
    };
    var IncrementalReadingPlugin = class extends Plugin {
      async onload() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          this.settings[key] = Object.assign({}, DEFAULT_SETTINGS[key], this.settings[key] || {});
        }
        this.settings.session.types = { ...this.settings.session.types || {} };
        this.settings.session.readPoints = { ...this.settings.session.readPoints || {} };
        this.cardDueCache = /* @__PURE__ */ new Map();
        this.cardScheduleSignatures = /* @__PURE__ */ new Map();
        this.irFilesCache = null;
        this.irRowsCache = null;
        this.irMetadataSignatures = /* @__PURE__ */ new Map();
        this.irCollectionRevision = 0;
        this.collectionRenderDeferrals = 0;
        this.directQueueNavigation = false;
        this.directQueueNavigationDepth = 0;
        this.pendingSpacedRepetitionReview = null;
        this.spacedRepetitionCloseGeneration = 0;
        this.spacedRepetitionCloseAttempt = 0;
        this.sessionSaveTimer = null;
        this.treeIndexCache = null;
        this.duePoolCache = null;
        this.registerEvent(this.app.metadataCache.on("changed", (file) => {
          this._refreshExcerptViews(file);
          if (!isPathInIRCollection(this.settings, file.path)) return;
          const next = irViewSignature(this.app, file);
          const previous = this.irMetadataSignatures.get(file.path) ?? null;
          if (next === previous) return;
          if (next === null) this.irMetadataSignatures.delete(file.path);
          else this.irMetadataSignatures.set(file.path, next);
          this.irRowsCache = null;
          this.treeIndexCache = null;
          this.duePoolCache = null;
          this.irCollectionRevision++;
        }));
        this.registerEvent(this.app.vault.on("modify", (file) => {
          const pending = this.pendingSpacedRepetitionReview;
          if (pending?.path === file.path && pending.expiresAt > Date.now()) {
            this._confirmSpacedRepetitionReview(file, pending);
          }
          if (!isPathInIRCollection(this.settings, file.path)) return;
          this.cardDueCache.delete(file.path);
          this.cardScheduleSignatures.delete(file.path);
          if (getFm(this.app, file)?.type === "card") this.duePoolCache = null;
        }));
        this.registerEvent(this.app.vault.on("create", (file) => {
          if (isPathInIRCollection(this.settings, file?.path)) this._invalidateIRCollection(true);
        }));
        this.registerEvent(this.app.vault.on("delete", (file) => {
          this.cardDueCache.delete(file.path);
          this.cardScheduleSignatures.delete(file.path);
          if (this.pendingSpacedRepetitionReview?.path === file.path) this.pendingSpacedRepetitionReview = null;
          if (isPathInIRCollection(this.settings, file?.path)) this._invalidateIRCollection(true);
        }));
        this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
          this.cardDueCache.delete(oldPath);
          this.cardDueCache.delete(file.path);
          this.cardScheduleSignatures.delete(oldPath);
          this.cardScheduleSignatures.delete(file.path);
          if (this.pendingSpacedRepetitionReview?.path === oldPath) this.pendingSpacedRepetitionReview.path = file.path;
          if (isPathInIRCollection(this.settings, oldPath) || isPathInIRCollection(this.settings, file?.path)) this._invalidateIRCollection(true);
        }));
        await this.saveData(this.settings);
        this.addSettingTab(new IncrementalReadingSettingTab(this.app, this));
        this.registerView(IR_QUEUE_VIEW_TYPE, (leaf) => new IRQueueView(leaf, this));
        this.registerView(KNOWLEDGE_TREE_VIEW_TYPE, (leaf) => new KnowledgeTreeView(leaf, this, "main"));
        this.registerView(KNOWLEDGE_TREE_SIDEBAR_TYPE, (leaf) => new KnowledgeTreeView(leaf, this, "sidebar"));
        this.registerView(MAIN_DASHBOARD_VIEW_TYPE, (leaf) => new MainDashboardView(leaf, this));
        this.registerView(PDF_VIEW_TYPE, (leaf) => new PdfViewerView(leaf, this));
        this.registerEvent(this.app.workspace.on("file-open", () => this._refreshExcerptViews()));
        this.registerEvent(this.app.workspace.on("layout-change", () => this._refreshExcerptViews()));
        const cmd = (id, name, callback) => this.addCommand({ id, name, callback });
        this.registerMarkdownCodeBlockProcessor("ir-occlusion", (source, el, ctx) => {
          let data;
          try {
            data = parseYaml(source) || {};
          } catch (e) {
            el.createEl("div", { text: `[ir-occlusion] yaml parse error: ${e.message}` });
            return;
          }
          if (!data.image || !Array.isArray(data.rects) || data.rects.length === 0) {
            el.createEl("div", { text: "[ir-occlusion] missing image or rects" });
            return;
          }
          const mode = data.mode || "hide-one";
          const qIdx = Number.isFinite(data.question_index) ? data.question_index : 0;
          const tf = this.app.vault.getAbstractFileByPath(data.image) || this.app.metadataCache.getFirstLinkpathDest(data.image, ctx.sourcePath);
          if (!tf) {
            el.createEl("div", { text: `[ir-occlusion] image not found: ${data.image}` });
            return;
          }
          const src = this.app.vault.adapter.getResourcePath(tf.path);
          const wrap = el.createDiv({ cls: "ir-occ-wrap" });
          const img = wrap.createEl("img", { cls: "ir-occ-img-fluid" });
          img.src = src;
          img.draggable = false;
          const overlay = wrap.createDiv({ cls: "ir-occ-overlay ir-occ-overlay-static" });
          const isHidden = (i) => qIdx === -1 ? true : mode === "hide-one" ? i === qIdx : i !== qIdx;
          const covers = data.rects.map((r, i) => {
            const d = overlay.createDiv({ cls: "ir-occ-cover ir-occ-cover-plain" });
            d.style.setProperty("--ir-x", r.x * 100 + "%");
            d.style.setProperty("--ir-y", r.y * 100 + "%");
            d.style.setProperty("--ir-w", r.w * 100 + "%");
            d.style.setProperty("--ir-h", r.h * 100 + "%");
            const hidden = isHidden(i);
            if (hidden) d.addClass("ir-occ-cover-hidden");
            if (i === qIdx) d.addClass("ir-occ-cover-current");
            if (r.label) d.title = r.label;
            return { div: d, hidden };
          });
          const btnRow = el.createDiv({ cls: "ir-occ-btn-row" });
          const btn = btnRow.createEl("button", { text: "Show answer" });
          let revealed = false;
          btn.addEventListener("click", () => {
            revealed = !revealed;
            overlay.toggleClass("ir-occ-revealed", revealed);
            btn.setText(revealed ? "Hide Answer" : "Show Answer");
          });
        });
        cmd("build-session-queue", "Build today's session queue", () => this.buildSessionQueue());
        cmd("next-element", "Next element", () => this.nextElement());
        cmd("end-session", "Grade current reading topic", () => this.gradeCurrent());
        cmd("extract-selection", "Extract selection", () => this.extractSelection());
        cmd("flashcard-clipboard", "Flashcard from clipboard", () => this.flashcardClipboard());
        cmd("capture-more", "Capture or create…", () => this.captureOrCreate());
        cmd("current-actions", "Current element actions…", () => this.currentElementActions());
        cmd("open-toolkit-view", "Open Toolkit view…", () => this.openToolkitView());
        cmd("advanced-tools", "Advanced tools…", () => this.advancedTools());
        this.app.workspace.onLayoutReady(() => {
          this._refreshExcerptViews();
          const count = this._legacyCardFiles().length;
          if (count) new Notice2(`MemoFlow：发现 ${count} 张旧版卡片。请打开「高级工具」并选择「迁移旧卡片到 SR」。`, 1e4);
        });
      }
      onunload() {
        this._clearExcerptViews();
        if (!this.sessionSaveTimer) return;
        window.clearTimeout(this.sessionSaveTimer);
        this.sessionSaveTimer = null;
        this.saveData(this.settings).catch((error) => console.error("[IR] final session persistence failed", error));
      }
      _refreshExcerptViews(file = null) {
        const color = normalizedExtractHighlightColor(this.settings?.misc?.extract_highlight_color);
        const background = extractHighlightBackground(color);
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (!view?.contentEl || file && view.file?.path !== file.path) continue;
          const isExtract = getFm(this.app, view.file)?.type === "extract";
          view.contentEl.toggleClass("ir-extract-view", isExtract);
          view.contentEl.style.setProperty("--ir-extract-highlight-color", color);
          view.contentEl.style.setProperty("--ir-extract-highlight-background", background);
        }
      }
      _clearExcerptViews() {
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const el = leaf.view?.contentEl;
          if (!el) continue;
          el.removeClass("ir-extract-view");
          el.style.removeProperty("--ir-extract-highlight-color");
          el.style.removeProperty("--ir-extract-highlight-background");
        }
      }
      async _runActionMenu(title, entries) {
        const picked = await pickFromList(
          this.app,
          entries.map((entry) => entry.label),
          entries,
          title
        );
        if (picked) return picked.run();
      }
      captureOrCreate() {
        return this._runActionMenu("Capture or create", [
          { label: "New source", run: () => this.newSource() },
          { label: "Import clipping (active note)", run: () => this.importClipping() },
          { label: "Extract from clipboard (PDF-aware)", run: () => this.extractClipboard() },
          { label: "Flashcard: name this image", run: () => this.flashcardImageName() },
          { label: "Image extract from clipboard", run: () => this.imageExtractClipboard() },
          { label: "Occlusion: create cards from image", run: () => this.occlusionCreate() }
        ]);
      }
      currentElementActions() {
        return this._runActionMenu("Current element actions", [
          { label: "Done", run: () => this.markDone() },
          { label: "Reset", run: () => this.resetCurrent() },
          { label: "Dismiss", run: () => this.dismiss() },
          { label: "Postpone", run: () => this.postpone() },
          { label: "Schedule (manual date)", run: () => this.schedule() },
          { label: "Set priority", run: () => this.setPriority() },
          { label: "Boost priority", run: () => this.boost() },
          { label: "Open parent", run: () => this.openParent() },
          { label: "Open PDF (Toolkit viewer)", run: () => this.openPdf() },
          { label: "Toggle read-point", run: () => this.toggleReadPoint() },
          { label: "Jump to read-point", run: () => this.jumpToReadPoint() },
          { label: "Add timeline checkpoint", run: () => this.addCheckpoint() }
        ]);
      }
      openToolkitView() {
        return this._runActionMenu("Open Toolkit view", [
          { label: "Dashboard", run: () => this.openDashboard() },
          { label: "Stats and analytics", run: () => this.openDashboard("stats") },
          { label: "Reading queue sidebar", run: () => this._activateQueueView() },
          { label: "Knowledge tree", run: () => this._activateKnowledgeTree() },
          { label: "Knowledge tree sidebar", run: () => this._activateKnowledgeTreeSidebar() },
          { label: "User guide", run: () => this.openUserGuide() }
        ]);
      }
      advancedTools() {
        return this._runActionMenu("Advanced tools", [
          { label: "Subset review", run: () => this.subsetReview() },
          { label: "Mercy (spread overdue)", run: () => this.mercy() },
          { label: "Postpone subtree", run: () => this.postponeSubtree() },
          { label: "Split article on H2 headings", run: () => this.splitArticle() },
          { label: "Split book into chapters", run: () => this.splitBook() },
          { label: "New category", run: async () => {
            await this.createCategory();
            this._refreshTreeViews();
          } },
          { label: "Move active element under…", run: async () => {
            await this.reparentActive();
            this._refreshTreeViews();
          } },
          { label: "Export inline cards to Spaced Repetition", run: () => this.seedInlineCards() },
          { label: "Migrate legacy cards to Spaced Repetition", run: () => this.migrateLegacyCards() },
          { label: "Performance diagnostics", run: () => this.performanceDiagnostics() }
        ]);
      }
      sourcesFolder() {
        return configuredPath(this.settings, "sources", SOURCES_FOLDER);
      }
      extractsFolder() {
        return configuredPath(this.settings, "extracts", EXTRACTS_FOLDER);
      }
      cardsFolder() {
        return configuredPath(this.settings, "cards", CARDS_FOLDER);
      }
      attachmentsFolder() {
        return configuredPath(this.settings, "attachments", ATTACHMENTS_FOLDER);
      }
      categoriesFolder() {
        return configuredPath(this.settings, "categories", CATEGORIES_FOLDER);
      }
      dashboardPath() {
        return configuredPath(this.settings, "dashboard", DASHBOARD_PATH);
      }
      reviewLogPath() {
        return configuredPath(this.settings, "review_log", REVIEW_LOG_PATH);
      }
      _nativeCardText(value) {
        return spacedRepetitionCore.nativeCardText(value);
      }
      _spacedRepetitionSettings() {
        return this.settings.spaced_repetition || DEFAULT_SETTINGS.spaced_repetition;
      }
      _spacedRepetitionDeckTag() {
        const configured = this._spacedRepetitionSettings().flashcardTag;
        return String(configured || "flashcards/incremental-reading").replace(/^#/, "").replace(/\/+$/, "");
      }
      _spacedRepetitionBody(format, question, answer) {
        return spacedRepetitionCore.spacedRepetitionBody(
          format,
          question,
          answer,
          this._spacedRepetitionSettings()
        );
      }
      async _createSpacedRepetitionCard(parentFile, { format, question, answer = "", extraFrontmatter = [] }) {
        const folder = this.cardsFolder();
        await ensureFolder(this.app, folder);
        const parentTitle = parentFile.basename;
        const safeParent = slugifyForFolder(parentTitle) || "Untitled";
        const existing = filesInFolder(this.app, folder).filter((f) => f.extension === "md" && f.basename.startsWith(safeParent + " - Card"));
        let cardNum = existing.length + 1;
        let name = `${safeParent} - Card ${cardNum}`;
        while (this.app.vault.getAbstractFileByPath(`${folder}/${name}.md`)) {
          name = `${safeParent} - Card ${++cardNum}`;
        }
        const fm = [
          "---",
          "type: card",
          `source: ${JSON.stringify(`[[${parentTitle}]]`)}`,
          `date_added: ${todayDateString(this.settings)}`,
          `card_format: ${format}`,
          "ir_spaced_repetition: true",
          `ir_spaced_repetition_deck_tag: ${JSON.stringify(this._spacedRepetitionDeckTag())}`,
          ...extraFrontmatter,
          "tags:",
          "  - incremental-reading",
          "  - ir/card",
          `  - ${this._spacedRepetitionDeckTag()}`,
          "---",
          ""
        ];
        const file = await this.app.vault.create(
          `${folder}/${name}.md`,
          fm.join("\n") + this._spacedRepetitionBody(format, question, answer)
        );
        return { file, name };
      }
      _legacyCardFiles() {
        return filesInFolder(this.app, this.cardsFolder()).filter((file) => {
          if (file.extension !== "md") return false;
          const fm = getFm(this.app, file);
          const tags = Array.isArray(fm?.tags) ? fm.tags.map(String) : typeof fm?.tags === "string" ? fm.tags.split(/[\s,]+/).filter(Boolean) : [];
          const deckTag = this._spacedRepetitionDeckTag();
          return fm?.type === "card" && fm.ir_spaced_repetition !== true && !tags.some((tag) => tag.replace(/^#/, "") === deckTag);
        });
      }
      async migrateLegacyCards() {
        const files = this._legacyCardFiles();
        if (!files.length) {
          new Notice2("没有需要迁移的旧版卡片。");
          return;
        }
        const ok = await confirmDialog(
          this.app,
          `迁移 ${files.length} 张旧版卡片？`,
          "卡片内容会转换为 Spaced Repetition 语法；IR 排期字段会被移除。"
        );
        if (!ok) return;
        let migrated = 0, skipped = 0;
        for (const file of files) {
          const fm = getFm(this.app, file) || {};
          const content = await this.app.vault.read(file);
          const body = content.slice(frontmatterEndOffset(content)).replace(/^\s*<div style="height: 90vh;"><\/div>\s*/, "").replace(BODY_MARKER, "").trim();
          let format = fm.card_format || "basic";
          let question = body, answer = "";
          if (format === "occlusion") {
            answer = fm.occlusion_image ? `![[${fm.occlusion_image}]]` : "";
          } else if (format === "cloze") {
            const selected = Math.max(1, Number(fm.cloze_index) || 1);
            let index = 0;
            question = body.replace(new RegExp(HL_CLOZE_SRC, "g"), (match, text) => {
              index++;
              return index === selected ? match : text;
            });
          } else {
            const marker = /\n> \[!answer\]- Answer\s*\n/;
            const parts = body.split(marker);
            if (parts.length < 2) {
              skipped++;
              continue;
            }
            question = parts.shift().trim();
            answer = parts.join("\n").split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim();
            format = "basic";
          }
          await this.app.fileManager.processFrontMatter(file, (next) => {
            if (typeof next.tags === "string") next.tags = next.tags.split(/[\s,]+/).filter(Boolean);
            if (!Array.isArray(next.tags)) next.tags = [];
            const wasDone = next.status === "done";
            const deckTag = this._spacedRepetitionDeckTag();
            for (const tag of ["incremental-reading", "ir/card", ...wasDone ? [] : [deckTag]]) {
              if (!next.tags.includes(tag)) next.tags.push(tag);
            }
            next.ir_spaced_repetition = true;
            next.ir_spaced_repetition_deck_tag = deckTag;
            if (wasDone) next.ir_completed_deck_tag = deckTag;
            next.card_format = format;
            for (const key of [
              ...wasDone ? [] : ["status"],
              "priority",
              "next_review",
              "interval",
              "review_count",
              ...wasDone ? [] : ["last_reviewed"],
              "last_grade",
              "last_retrievability",
              "stability",
              "difficulty",
              "cssclasses"
            ]) delete next[key];
          });
          await this.app.vault.process(
            file,
            (current) => current.slice(0, frontmatterEndOffset(current)) + this._spacedRepetitionBody(format, question, answer)
          );
          migrated++;
        }
        new Notice2(`Migrated ${migrated} card${migrated === 1 ? "" : "s"} to Spaced Repetition${skipped ? `; skipped ${skipped}` : ""}.`);
      }
      reviewCards() {
        if (!this.app.commands.executeCommandById(SPACED_REPETITION_REVIEW_COMMAND)) {
          new Notice2("Spaced Repetition 仍在启动；请重启 Obsidian 后再试。");
        }
      }
      async reviewCardsInNote(file = this.app.workspace.getActiveFile()) {
        const active = file;
        const generation = ++this.spacedRepetitionCloseGeneration;
        let baseline = active ? this.cardScheduleSignatures.get(active.path) : null;
        if (active) {
          if (baseline == null) {
            try {
              baseline = spacedRepetitionScheduleSignature(await this.app.vault.cachedRead(active));
            } catch (error) {
              console.error("[IR] could not read Spaced Repetition baseline", error);
              baseline = "";
            }
          }
        }
        this.pendingSpacedRepetitionReview = active ? { path: active.path, baseline, reviewed: false, expiresAt: Date.now() + 10 * 60 * 1e3, generation, verifying: false } : null;
        if (!this.app.commands.executeCommandById(SPACED_REPETITION_NOTE_COMMAND)) {
          this.pendingSpacedRepetitionReview = null;
          new Notice2("请打开卡片笔记，等 Spaced Repetition 初始化后再试。");
        }
      }
      async _confirmSpacedRepetitionReview(file, pending) {
        if (pending.verifying) return;
        pending.verifying = true;
        try {
          const content = await this.app.vault.cachedRead(file);
          if (this.pendingSpacedRepetitionReview?.generation !== pending.generation) return;
          const signature = spacedRepetitionScheduleSignature(content);
          if (signature === pending.baseline) return;
          pending.baseline = signature;
          pending.reviewed = true;
          this._closeSpacedRepetitionDeckMenuWhenReady(pending.generation);
        } catch (error) {
          console.error("[IR] could not verify Spaced Repetition review", error);
        } finally {
          if (this.pendingSpacedRepetitionReview?.generation === pending.generation) pending.verifying = false;
        }
      }
      _closeSpacedRepetitionDeckMenuWhenReady(generation) {
        const attempt = ++this.spacedRepetitionCloseAttempt;
        const deadline = Date.now() + 5e3;
        const check = () => {
          if (generation !== this.spacedRepetitionCloseGeneration || attempt !== this.spacedRepetitionCloseAttempt) return;
          const tabLeaves = this.app.workspace.getLeavesOfType(SPACED_REPETITION_TAB_VIEW);
          const modal = activeDocument.querySelector("#sr-modal-view");
          if (!tabLeaves.length && !modal) return;
          const deckMenu = activeDocument.querySelector(".sr-deck-container:not(.sr-is-hidden)");
          if (deckMenu) {
            const pending = this.pendingSpacedRepetitionReview?.generation === generation ? this.pendingSpacedRepetitionReview : null;
            for (const leaf of tabLeaves) leaf.detach();
            const closeButton = (modal?.closest(".modal-container") || modal)?.querySelector(".modal-close-button");
            closeButton?.click();
            if (pending?.reviewed) this.consumeSessionItem(pending.path, { background: true });
            if (pending) this.pendingSpacedRepetitionReview = null;
            this.spacedRepetitionCloseGeneration++;
            if (pending?.reviewed) new Notice2("卡片已复习；准备好后点「下一项」。");
            return;
          }
          if (Date.now() < deadline) window.setTimeout(check, 50);
        };
        window.setTimeout(check, 50);
      }
      openUserGuide() {
        new UserGuideModal(this.app).open();
      }
      isSpacedRepetitionReady() {
        const commands = this.app.commands.listCommands?.() || [];
        const ids = new Set(commands.map((command) => command.id));
        return ids.has(SPACED_REPETITION_REVIEW_COMMAND) && ids.has(SPACED_REPETITION_NOTE_COMMAND);
      }
      runSetupCheck() {
        const issues = [];
        const notes = [];
        if (!this.isSpacedRepetitionReady()) issues.push("Enable Spaced Repetition for card review.");
        const vaultPaths = [
          ["Sources", this.sourcesFolder()],
          ["Extracts", this.extractsFolder()],
          ["Cards", this.cardsFolder()],
          ["Attachments", this.attachmentsFolder()],
          ["Categories", this.categoriesFolder()]
        ];
        const normalized = vaultPaths.map(([, path]) => path.toLowerCase());
        if (new Set(normalized).size !== normalized.length) issues.push("Vault folders must use distinct paths.");
        if (!(Number(this.settings.scheduling.a_factor_min) > 1)) issues.push("A-Factor minimum must be greater than 1.");
        if (!(Number(this.settings.scheduling.a_factor_max) >= Number(this.settings.scheduling.a_factor_min))) {
          issues.push("A-Factor maximum must be at least the minimum.");
        }
        if (this._spacedRepetitionSettings().multilineCardSeparator === this._spacedRepetitionSettings().multilineReversedCardSeparator) {
          issues.push("Basic and bidirectional card separators must differ.");
        }
        try {
          const inline = this.settings.inline_cards;
          const qa = new RegExp(inline.qa_regex);
          new RegExp(inline.cloze_regex, "g");
          if (qa.global) issues.push("The inline Q::A regular expression must not use the global flag.");
        } catch (error) {
          issues.push(`Inline-card regular expression is invalid: ${error.message}`);
        }
        if (issues.length) {
          new Notice2(`环境检查需要处理：
- ${issues.join("\n- ")}`, 12e3);
          return false;
        }
        const detail = notes.length ? `
${notes.join("\n")}` : "";
        new Notice2(`环境就绪。日期格式：${configuredDateFormat(this.settings)}；Spaced Repetition 可用。${detail}`, 8e3);
        return true;
      }
      async saveSettings() {
        await this.saveData(this.settings);
      }
      async migrateDateFormat(fromFormat, toFormat) {
        const keys = ["next_review", "last_reviewed", "date_added", "date_done", "date_dismissed", "today_session_date"];
        const files = new Map(this.getIRFiles().map((file) => [file.path, file]));
        const dashboard = this.app.vault.getAbstractFileByPath(this.dashboardPath());
        if (dashboard instanceof TFile2) files.set(dashboard.path, dashboard);
        let changed = 0;
        for (const file of files.values()) {
          if (!getFm(this.app, file)) continue;
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            for (const key of keys) {
              if (!fm[key]) continue;
              const next = dateCore2.reformatDate(fm[key], fromFormat, toFormat);
              if (next !== fm[key]) {
                fm[key] = next;
                changed++;
              }
            }
            if (Array.isArray(fm.checkpoints)) {
              for (const checkpoint of fm.checkpoints) {
                if (!checkpoint?.date) continue;
                const next = dateCore2.reformatDate(checkpoint.date, fromFormat, toFormat);
                if (next !== checkpoint.date) {
                  checkpoint.date = next;
                  changed++;
                }
              }
            }
          });
        }
        const logFile = this.app.vault.getAbstractFileByPath(this.reviewLogPath());
        if (logFile instanceof TFile2) {
          await this.app.vault.process(logFile, (content) => content.split("\n").map((line) => {
            const match = line.match(/^(\|\s*)([^|]+?)(\s*\|)/);
            if (!match) return line;
            const value = match[2].trim();
            const next = dateCore2.reformatDate(value, fromFormat, toFormat);
            if (next === value) return line;
            changed++;
            return match[1] + next + match[3] + line.slice(match[0].length);
          }).join("\n"));
        }
        return changed;
      }
      // Debug logging — silent unless the user enables it in settings. Keeps the
      // default console clean (Obsidian guideline: only errors by default).
      _dbg(...args) {
        if (this.settings?.misc?.debug) console.log("[Incremental Reading Toolkit]", ...args);
      }
      _invalidateIRCollection(filesChanged = false) {
        if (filesChanged) {
          this.irFilesCache = null;
          this.irMetadataSignatures.clear();
        }
        this.irRowsCache = null;
        this.treeIndexCache = null;
        this.duePoolCache = null;
        this.irCollectionRevision++;
      }
      getIRFiles() {
        if (!this.irFilesCache) this.irFilesCache = getAllIRFiles(this.app, this.settings);
        return this.irFilesCache;
      }
      getIRRows() {
        if (!this.irRowsCache) {
          this.irRowsCache = this.getIRFiles().map((tfile) => ({
            tfile,
            file: tfile,
            fm: getFm(this.app, tfile)
          })).filter((row) => row.fm);
          for (const row of this.irRowsCache) {
            this.irMetadataSignatures.set(row.tfile.path, irViewSignature(this.app, row.tfile));
          }
        }
        return this.irRowsCache;
      }
      async _cardIsDue(file, today) {
        const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const key = `${dateKey}:${file.stat?.mtime || 0}:${file.stat?.size || 0}`;
        const cached = this.cardDueCache.get(file.path);
        if (cached?.key === key) return cached.promise;
        const promise = this.app.vault.cachedRead(file).then((content) => {
          this.cardScheduleSignatures.set(file.path, spacedRepetitionScheduleSignature(content));
          return spacedRepetitionCardIsDue(content, today);
        });
        this.cardDueCache.set(file.path, { key, promise });
        try {
          return await promise;
        } catch (error) {
          if (this.cardDueCache.get(file.path)?.promise === promise) this.cardDueCache.delete(file.path);
          throw error;
        }
      }
      // ---- Next / Random -----------------------------------------------------
      async buildDuePool({ skipCurrent = true } = {}) {
        const today = todayDate();
        const active = this.app.workspace.getActiveFile();
        const dateKey = todayDateString(this.settings);
        const mixCards = this.settings.queue.mix_cards !== false;
        const srReady = mixCards && this.isSpacedRepetitionReady();
        const key = `${dateKey}:${this.irCollectionRevision}:${mixCards}:${srReady}`;
        if (this.duePoolCache?.key !== key) {
          const promise = (async () => {
            const candidates = [];
            for (const { tfile: f, fm } of this.getIRRows()) {
              if (!isActiveIR(fm)) continue;
              if (fm.type === "card") {
                if (!srReady) continue;
              } else if (!isDue(fm, today, this.settings)) continue;
              candidates.push({ tfile: f, fm });
            }
            return filterAsyncConcurrent(candidates, async (item) => {
              if (item.fm.type !== "card") return true;
              return this._cardIsDue(item.tfile, today);
            });
          })();
          this.duePoolCache = { key, promise };
          promise.catch(() => {
            if (this.duePoolCache?.promise === promise) this.duePoolCache = null;
          });
        }
        const pool = await this.duePoolCache.promise;
        return skipCurrent && active ? pool.filter((item) => item.tfile.path !== active.path) : pool.slice();
      }
      // Read the dashboard's session snapshot (path list persisted as
      // `today_session_paths`). Returns active, not-reviewed-today items in
      // snapshot order. Null if no fresh snapshot exists.
      async readSessionSnapshot() {
        const todayStr = todayDateString(this.settings);
        let paths = null;
        if (this.settings.session?.date === todayStr && Array.isArray(this.settings.session.paths)) {
          paths = this.settings.session.paths;
        } else {
          const dash = this.app.vault.getAbstractFileByPath(this.dashboardPath());
          const fm = dash ? getFm(this.app, dash) : null;
          if (fm?.today_session_date === todayStr && Array.isArray(fm.today_session_paths)) paths = fm.today_session_paths;
        }
        if (paths === null) return null;
        const today = todayDate();
        const candidates = [];
        const seen = /* @__PURE__ */ new Set();
        for (const p of paths) {
          if (seen.has(p)) continue;
          seen.add(p);
          const tf = this.app.vault.getAbstractFileByPath(p);
          if (!tf) continue;
          const f = getFm(this.app, tf);
          if (!isActiveIR(f)) continue;
          if (f.last_reviewed === todayStr) continue;
          if (f.type === "card") {
            if (this.settings.queue.mix_cards === false || !this.isSpacedRepetitionReady()) continue;
          } else if (!isDue(f, today, this.settings)) continue;
          candidates.push({ tfile: tf, fm: f });
        }
        return filterAsyncConcurrent(candidates, async (item) => {
          if (item.fm.type !== "card") return true;
          return this._cardIsDue(item.tfile, today);
        });
      }
      async persistSessionSnapshot(queue) {
        const paths = queue.map((q) => q.tfile?.path).filter(Boolean);
        const types = Object.fromEntries(queue.filter((item) => item.tfile?.path && item.fm?.type).map((item) => [item.tfile.path, item.fm.type]));
        const readPoints = Object.fromEntries(queue.filter((item) => item.tfile?.path && Number(item.fm?.read_point_line) > 0).map((item) => [item.tfile.path, Number(item.fm.read_point_line)]));
        this.settings.session = { date: todayDateString(this.settings), paths, types, readPoints };
        await this.saveSettings();
        const dash = this.app.vault.getAbstractFileByPath(this.dashboardPath());
        if (!dash) return;
        try {
          await this.app.fileManager.processFrontMatter(dash, (fm) => {
            fm.today_session_paths = paths;
            fm.today_session_date = todayDateString(this.settings);
          });
        } catch (e) {
          console.error("[IR] persistSessionSnapshot failed", e);
        }
      }
      buildInterleavedQueue(pool, today) {
        if (this.settings.queue.mix_cards === false) {
          return pool.filter((item) => item.fm.type !== "card").sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
        }
        return topicCore.interleaveLearningItems(pool, (item) => urgency(item.fm, today, this.settings));
      }
      async consumeSessionItem(path, { background = false } = {}) {
        if (this.settings.session?.date !== todayDateString(this.settings)) return;
        this.settings.session.paths = (this.settings.session.paths || []).filter((value) => value !== path);
        if (this.settings.session.types) delete this.settings.session.types[path];
        if (this.settings.session.readPoints) delete this.settings.session.readPoints[path];
        if (!background) return this.saveSettings();
        this._scheduleSessionSave();
      }
      _scheduleSessionSave() {
        if (this.sessionSaveTimer) window.clearTimeout(this.sessionSaveTimer);
        this.sessionSaveTimer = window.setTimeout(() => {
          this.sessionSaveTimer = null;
          this.saveData(this.settings).catch((error) => console.error("[IR] background session persistence failed", error));
        }, 1500);
      }
      async _withDeferredCollectionRenders(callback, { flush = true } = {}) {
        this.collectionRenderDeferrals++;
        try {
          return await callback();
        } finally {
          this.collectionRenderDeferrals--;
          if (this.collectionRenderDeferrals === 0 && flush) this._flushDeferredCollectionRenders();
        }
      }
      _flushDeferredCollectionRenders() {
        for (const leaf of this.app.workspace.getLeavesOfType(IR_QUEUE_VIEW_TYPE)) {
          const view = leaf.view;
          if (view?.needsRowsRender) view._scheduleRowsRender("grade-complete");
        }
        for (const leaf of this.app.workspace.getLeavesOfType(MAIN_DASHBOARD_VIEW_TYPE)) {
          if (leaf.view?.needsRender) leaf.view._requestRender();
        }
        for (const type of [KNOWLEDGE_TREE_VIEW_TYPE, KNOWLEDGE_TREE_SIDEBAR_TYPE]) {
          for (const leaf of this.app.workspace.getLeavesOfType(type)) {
            if (leaf.view?.needsRender) leaf.view._requestBodyRender();
          }
        }
      }
      _markCollectionViewsStale({ queue = true, dashboard = true, tree = false } = {}) {
        if (queue) {
          for (const leaf of this.app.workspace.getLeavesOfType(IR_QUEUE_VIEW_TYPE)) {
            leaf.view?._invalidateQueueModel?.();
            if (leaf.view) leaf.view.needsRowsRender = true;
          }
        }
        if (dashboard) {
          for (const leaf of this.app.workspace.getLeavesOfType(MAIN_DASHBOARD_VIEW_TYPE)) {
            if (leaf.view) leaf.view.needsRender = true;
          }
        }
        if (tree) {
          for (const type of [KNOWLEDGE_TREE_VIEW_TYPE, KNOWLEDGE_TREE_SIDEBAR_TYPE]) {
            for (const leaf of this.app.workspace.getLeavesOfType(type)) {
              if (leaf.view) leaf.view.needsRender = true;
            }
          }
        }
      }
      async openLearningItem(item) {
        if (!item?.tfile) return;
        await this._openLearningFile(item.tfile, item.fm.type, item.fm.read_point_line);
      }
      async _openLearningFile(file, type, readPointLine = 0) {
        this.directQueueNavigationDepth++;
        this.directQueueNavigation = true;
        try {
          await this.app.workspace.getLeaf(false).openFile(file);
          window.setTimeout(() => {
            if (this.app.workspace.getActiveFile()?.path !== file.path) return;
            if (type === "card") this.reviewCardsInNote(file);
            else if (type === "source" && Number(readPointLine) > 0) {
              const editor = getEditorForFile(this.app, file);
              const line = Math.max(0, Number(readPointLine) - 1);
              editor?.setCursor({ line, ch: 0 });
              editor?.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
            }
          }, 60);
        } finally {
          window.setTimeout(() => {
            this.directQueueNavigationDepth = Math.max(0, this.directQueueNavigationDepth - 1);
            this.directQueueNavigation = this.directQueueNavigationDepth > 0;
          }, 1e3);
        }
      }
      async buildSessionQueue({ openFirst = false } = {}) {
        const pool = await this.buildDuePool({ skipCurrent: false });
        const queue = this.buildInterleavedQueue(pool, todayDate());
        await this.persistSessionSnapshot(queue);
        this._markCollectionViewsStale();
        this._flushDeferredCollectionRenders();
        if (!queue.length) {
          new Notice2("✨ 没有到期项，已清空。");
          return;
        }
        new Notice2(`已构建今日学习队列，共 ${queue.length} 项。`);
        if (openFirst) await this.nextElement({ fromStart: true });
      }
      async nextElement({ fromStart = false } = {}) {
        const session = this.settings.session;
        if (session?.date !== todayDateString(this.settings) || !Array.isArray(session.paths)) {
          new Notice2("今天没有已保存的队列；请先运行「构建今日学习队列」。");
          return;
        }
        const activePath = this.app.workspace.getActiveFile()?.path;
        const candidates = savedQueueCandidates(session.paths, activePath, fromStart);
        const next = candidates.map((path) => this.app.vault.getAbstractFileByPath(path)).find((file) => file instanceof TFile2);
        if (!next) {
          new Notice2("✨ 已清空。");
          return;
        }
        const nextType = session.types?.[next.path] || getFm(this.app, next)?.type;
        const readPointLine = session.readPoints?.[next.path] || 0;
        return this._openLearningFile(next, nextType, readPointLine);
      }
      async randomDue() {
        const pool = await this.buildDuePool();
        if (pool.length === 0) {
          new Notice2("✨ 没有到期项，已清空。");
          return;
        }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        await this.openLearningItem(pick);
        const action = pick.fm.type === "card" ? "🃏 Review" : pick.fm.type === "source" ? "📖 Read" : "📝 Process";
        new Notice2(`🎲 ${action}：${pick.tfile.basename} · P${pick.fm.priority ?? "—"}（${pool.length} 项到期中的 1 项）`);
      }
      async gradeCurrent() {
        return this._withDeferredCollectionRenders(async () => {
          const active = this.app.workspace.getActiveFile();
          if (getFm(this.app, active)?.type === "card") {
            new Notice2("卡片在 Spaced Repetition 接受评分后自动完成。");
            return false;
          }
          const graded = await this.endSession();
          if (graded) {
            if (active) this.consumeSessionItem(active.path, { background: true });
            new Notice2("已评阅；准备好后点「下一项」。");
          }
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          return graded;
        }, { flush: false });
      }
      // ---- End Session (A-Factor topics; cards delegate to Spaced Repetition) -
      async endSession() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("请先打开一个增量阅读来源或摘录。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm || fm.type !== "source" && fm.type !== "extract") {
          new Notice2("当前笔记不是阅读主题；卡片由 Spaced Repetition 自动评分。");
          return;
        }
        const today = todayDateString(this.settings);
        return await this._gradeTopic(active, fm, today);
      }
      async _gradeTopic(file, fm, today) {
        let newReadPoint = fm.read_point;
        let newReadPointSeconds = fm.read_point_seconds;
        let previousReadPointLine = Number(fm.read_point_line) || 0;
        let newReadPointLine = previousReadPointLine;
        const isVideo = fm.type === "source" && (fm.source_type === "youtube" || fm.source_type === "video" || fm.read_point_seconds != null);
        if (fm.type === "source" && fm.read_point != null && !isVideo) {
          const rp = await askText(this.app, "读到的页码", String(fm.read_point));
          if (rp === null) return;
          if (!/^[1-9]\d*$/.test(rp.trim())) {
            new Notice2("请输入正整数页码。");
            return;
          }
          newReadPoint = Number(rp);
        } else if (isVideo) {
          const cur = formatSeconds(Number(fm.read_point_seconds) || 0);
          const raw = await askText(this.app, "读到的位置（mm:ss 或 hh:mm:ss）", cur);
          if (raw === null) return;
          const parsed = parseTimeInput(raw);
          if (parsed == null) {
            new Notice2("无效的时间戳，请使用 mm:ss 或 hh:mm:ss。");
            return;
          }
          newReadPointSeconds = parsed;
        }
        const isMarkdownSource = fm.type === "source" && !fm.total_pages && !fm.pdf_path && !fm.pdf_vault_path && !fm.sioyek_path;
        if (isMarkdownSource) {
          const currentContent = await this.app.vault.cachedRead(file);
          if (!previousReadPointLine) previousReadPointLine = markerLineNumber(currentContent);
          if (!newReadPointLine) newReadPointLine = previousReadPointLine;
          const editor = getEditorForFile(this.app, file);
          const cursor = editor?.getCursor?.();
          if (editor && cursor) {
            const updateMarker = await confirmDialog(this.app, `把 📍 更新到第 ${cursor.line + 1} 行？`);
            if (updateMarker) {
              newReadPointLine = cursor.line + 1;
              await this.app.vault.process(file, (content) => {
                const fmEnd = frontmatterEndOffset(content);
                const lines = content.split("\n");
                let insertAt = 0;
                for (let i = 0; i < cursor.line; i++) insertAt += lines[i].length + 1;
                if (insertAt < fmEnd) insertAt = fmEnd;
                let stripped = content;
                const existing = [...content.matchAll(READ_POINT_RE)];
                if (existing.length) {
                  for (const m of existing.reverse()) {
                    stripped = stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length);
                    if (m.index < insertAt) insertAt -= m[0].length;
                  }
                }
                return stripped.slice(0, insertAt) + READ_POINT_MARKER + stripped.slice(insertAt);
              });
              new Notice2(`📍 已移动到第 ${cursor.line + 1} 行`);
            }
          }
        }
        const priority = fm.priority ?? 50;
        const s = this.settings.scheduling;
        const prevReadPoint = Number(fm.read_point) || 0;
        const prevReadSeconds = Number(fm.read_point_seconds) || 0;
        const priorAFactor = readAFactor(this.settings, fm);
        const progressAF = s.progress_aware ? topicCore.progressAwareAFactor(fm, this.settings, {
          readPoint: newReadPoint,
          readPointSeconds: newReadPointSeconds
        }) : null;
        const baseAF = progressAF != null ? progressAF : priorAFactor;
        const qualityFactor = await pickFromList(
          this.app,
          [
            "保持（不变）",
            `提前复习（×${s.quality_speed_up}，更早看到）`,
            `推后复习（×${s.quality_slow_down}，推后看到）`
          ],
          [s.quality_hold, s.quality_speed_up, s.quality_slow_down],
          "这次阅读感觉如何？"
        );
        if (qualityFactor == null) return;
        const aFactor = clampAFactor(this.settings, baseAF * qualityFactor);
        const priorReps = fm.review_count ?? 0;
        const reviewCount = priorReps + 1;
        const isFirstRep = priorReps === 0 || !(Number(fm.interval) > 0);
        let interval = isFirstRep ? priorityToInterval(priority) : Math.max(1, Math.round(Number(fm.interval) * aFactor));
        if (s.stall_guard && !isFirstRep) {
          const advanced = topicCore.hasProgressAdvanced({
            previousPage: prevReadPoint,
            nextPage: newReadPoint ?? prevReadPoint,
            previousSeconds: prevReadSeconds,
            nextSeconds: newReadPointSeconds ?? prevReadSeconds,
            previousLine: previousReadPointLine,
            nextLine: newReadPointLine
          });
          if (!advanced) interval = Math.min(interval, Number(fm.interval) || interval);
        }
        const nextReview = futureDateString(interval, this.settings);
        let markedDone = false;
        const chapterEnd = Number(fm.page_end) || null;
        const bookEnd = Number(fm.total_pages) || null;
        const target = chapterEnd || bookEnd;
        const vidTarget = Number(fm.total_seconds) || null;
        const reachedPages = fm.type === "source" && target && newReadPoint != null && newReadPoint >= target;
        const reachedVideo = isVideo && vidTarget && newReadPointSeconds != null && newReadPointSeconds >= vidTarget;
        if (reachedPages || reachedVideo) {
          const unit = reachedVideo ? "video" : chapterEnd ? "chapter" : "source";
          markedDone = await confirmDialog(this.app, `把 ${unit} 标记为完成？`);
        }
        await this.app.fileManager.processFrontMatter(file, (fmw) => {
          fmw.interval = interval;
          fmw.review_count = reviewCount;
          fmw.next_review = nextReview;
          fmw.last_reviewed = today;
          fmw.a_factor = round4(aFactor);
          if (newReadPoint !== void 0 && newReadPoint !== null) fmw.read_point = newReadPoint;
          if (newReadPointSeconds !== void 0 && newReadPointSeconds !== null) fmw.read_point_seconds = newReadPointSeconds;
          if (newReadPointLine > 0) fmw.read_point_line = newReadPointLine;
          if (markedDone) statusCore.completeItemFrontmatter(fmw, today, this._spacedRepetitionDeckTag());
          else if (fmw.status === "inbox" || fmw.status === "pending") fmw.status = "active";
          for (const k of ["stability", "difficulty", "last_grade", "last_retrievability", "ease"]) {
            if (fmw[k] !== void 0) delete fmw[k];
          }
        });
        const logFile = this.app.vault.getAbstractFileByPath(this.reviewLogPath());
        if (logFile) {
          const elapsedDays = (() => {
            const lr = parseDateValue(fm.last_reviewed, this.settings);
            const tdy = parseDateValue(today, this.settings);
            return lr && tdy ? Math.max(0, Math.round((tdy - lr) / 864e5)) : 0;
          })();
          const row = `| ${today} | [[${file.basename}]] | ${fm.type} | — | ${elapsedDays} |  |  |  | ${round4(priorAFactor)} | ${round4(aFactor)} |
`;
          this.app.vault.append(logFile, row).catch((error) => console.error("[IR] background review-log append failed", error));
        }
        const typeLabel = fm.type === "source" ? "来源" : "摘录";
        if (markedDone) {
          this.consumeSessionItem(file.path, { background: true });
          new Notice2(`${typeLabel}已标记完成，未来复习已清除。`);
        } else {
          new Notice2(`${typeLabel}：P${priority} a=${round4(aFactor)} → ${interval} 天后复习（${nextReview}）`);
        }
        return true;
      }
      // Adaptive A-Factor tuning per SM canon. Multiplies a_factor by `factor`,
      // clamped to [settings.a_factor_min, settings.a_factor_max], persists to
      // frontmatter, and returns { from, to } when the value actually moved.
      async _bumpAFactor(file, fm, factor) {
        if (!fm || fm.type !== "source" && fm.type !== "extract") return null;
        const cur = readAFactor(this.settings, fm);
        const next = clampAFactor(this.settings, cur * factor);
        if (Math.abs(next - cur) < 5e-3) return null;
        await this.app.fileManager.processFrontMatter(file, (fmw) => {
          fmw.a_factor = round4(next);
        });
        return { from: round4(cur), to: round4(next) };
      }
      // ---- Sidebar queue + checkpoints ---------------------------------------
      async _activateQueueView() {
        if (!this.settings.queue.sidebar_enabled) {
          new Notice2("阅读队列侧栏已禁用，请到 MemoFlow 设置中开启。");
          return;
        }
        const leaves = this.app.workspace.getLeavesOfType(IR_QUEUE_VIEW_TYPE);
        if (leaves.length) {
          this.app.workspace.revealLeaf(leaves[0]);
          return;
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf.setViewState({ type: IR_QUEUE_VIEW_TYPE });
        this.app.workspace.revealLeaf(leaf);
      }
      async _activateKnowledgeTree() {
        const existing = this.app.workspace.getLeavesOfType(KNOWLEDGE_TREE_VIEW_TYPE);
        if (existing.length) {
          this.app.workspace.revealLeaf(existing[0]);
          return;
        }
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: KNOWLEDGE_TREE_VIEW_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
      async _activateKnowledgeTreeSidebar() {
        const existing = this.app.workspace.getLeavesOfType(KNOWLEDGE_TREE_SIDEBAR_TYPE);
        if (existing.length) {
          this.app.workspace.revealLeaf(existing[0]);
          return;
        }
        const leaf = this.app.workspace.getLeftLeaf(false);
        await leaf.setViewState({ type: KNOWLEDGE_TREE_SIDEBAR_TYPE, active: true });
        this.app.workspace.revealLeaf(leaf);
      }
      _refreshTreeViews() {
        for (const t of [KNOWLEDGE_TREE_VIEW_TYPE, KNOWLEDGE_TREE_SIDEBAR_TYPE]) {
          for (const leaf of this.app.workspace.getLeavesOfType(t)) {
            const v = leaf.view;
            if (v && typeof v._renderBody === "function") v._renderBody();
            else if (v && typeof v._render === "function") v._render();
          }
        }
      }
      isExpanded(key) {
        return (this.settings.tree.expanded || []).includes(key);
      }
      toggleExpanded(key) {
        const arr = this.settings.tree.expanded || (this.settings.tree.expanded = []);
        const i = arr.indexOf(key);
        if (i >= 0) arr.splice(i, 1);
        else arr.push(key);
        this.saveSettings();
      }
      // Build the tree index from every IR element. Duplicate basenames stay visible
      // as roots and cannot be used as parents until the user gives them unique names.
      buildTreeIndex() {
        if (this.treeIndexCache?.revision === this.irCollectionRevision) return this.treeIndexCache.index;
        const pages = [];
        for (const { tfile: f, fm } of this.getIRRows()) {
          const t = fm.type;
          if (t !== "category" && t !== "source" && t !== "extract" && t !== "card") continue;
          pages.push({ path: f.path, basename: f.basename, fm, tfile: f });
        }
        const index = treeCore.buildTreeIndex(pages);
        this.treeIndexCache = { revision: this.irCollectionRevision, index };
        return index;
      }
      async createCategory(parentName = null) {
        const name = await askText(this.app, "分类名称", "");
        if (!name) return null;
        const safe = slugifyForFolder(name);
        if (!safe) {
          new Notice2("分类名称无效");
          return null;
        }
        await ensureFolder(this.app, this.categoriesFolder());
        const path = `${this.categoriesFolder()}/${safe}.md`;
        if (this.app.vault.getAbstractFileByPath(path)) {
          new Notice2("分类已存在");
          return null;
        }
        const fm = ["---", "type: category"];
        if (parentName) fm.push(`parent: ${JSON.stringify(`[[${parentName}]]`)}`);
        fm.push("tree_order: 0", "tags:", "  - incremental-reading", "  - ir/category", "---", "", `# ${name}`, "");
        const file = await this.app.vault.create(path, fm.join("\n"));
        new Notice2(`已创建分类：${name}`);
        return file;
      }
      async reparent(childPath, newParentName) {
        const child = this.app.vault.getAbstractFileByPath(childPath);
        if (!child) {
          new Notice2("找不到节点");
          return;
        }
        const idx = this.buildTreeIndex();
        if (newParentName && idx.duplicates.has(newParentName.toLowerCase())) {
          new Notice2(`拒绝：有多个节点都叫「${newParentName}」`);
          return;
        }
        if (newParentName && treeCore.wouldCreateCycle(idx, child.basename, newParentName)) {
          new Notice2("拒绝：会形成循环");
          return;
        }
        await this.app.fileManager.processFrontMatter(child, (fm) => {
          if (newParentName) {
            fm.parent = `[[${newParentName}]]`;
            delete fm.tree_root;
          } else {
            delete fm.parent;
            fm.tree_root = true;
          }
        });
        new Notice2(newParentName ? `已移动到「${newParentName}」下` : "已移动到顶层");
        this._refreshTreeViews();
      }
      async reparentActive() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("没有活动的 Markdown 元素");
          return;
        }
        return await this.reparentPath(active.path);
      }
      async reparentPath(path) {
        const active = this.app.vault.getAbstractFileByPath(path);
        if (!active || active.extension !== "md") {
          new Notice2("找不到知识树节点");
          return false;
        }
        const fm = getFm(this.app, active);
        if (!fm || !["category", "source", "extract", "card"].includes(fm.type)) {
          new Notice2("节点不是增量阅读元素");
          return false;
        }
        const idx = this.buildTreeIndex();
        const candidates = idx.pages.filter((p) => p.fm.type !== "card" && p.path !== active.path && !idx.duplicates.has(p.basename.toLowerCase()));
        const displays = candidates.map((p) => `${TREE_ICONS[p.fm.type] || "•"} ${p.basename}`);
        const values = candidates.map((p) => p.basename);
        displays.unshift("⤴ (top level / Unfiled)");
        values.unshift("::root::");
        const picked = await pickFromList(this.app, displays, values, "移动到…");
        if (picked == null) return false;
        await this.reparent(active.path, picked === "::root::" ? null : picked);
        return true;
      }
      async reorderSibling(path, dir) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f) return;
        const idx = this.buildTreeIndex();
        const page = treeCore.pageByPath(idx, path);
        if (!page) {
          new Notice2("找不到知识树节点");
          return false;
        }
        const parentName = treeCore.effectiveParent(page.fm);
        let siblings;
        if (parentName) {
          siblings = idx.childrenOf.get(parentName.toLowerCase()) || [];
        } else {
          const isCatRoot = (p) => p.fm.type === "category" && !treeCore.effectiveParent(p.fm);
          const movedIsCatRoot = isCatRoot(page);
          siblings = idx.roots.filter((p) => isCatRoot(p) === movedIsCatRoot);
        }
        const order = siblings.map((s) => ({ path: s.path, tree_order: s.fm && s.fm.tree_order }));
        const curIdx = order.findIndex((s) => s.path === path);
        if (curIdx < 0) {
          new Notice2("无法在兄弟节点中定位该节点");
          return false;
        }
        const targetIndex = curIdx + dir;
        if (targetIndex < 0 || targetIndex >= order.length) {
          new Notice2(dir < 0 ? "已经是第一个兄弟节点" : "已经是最后一个兄弟节点");
          return false;
        }
        const writes = treeCore.computeReorder(order, path, targetIndex);
        for (const w of writes) {
          const tf = this.app.vault.getAbstractFileByPath(w.path);
          if (tf) await this.app.fileManager.processFrontMatter(tf, (fm) => {
            fm.tree_order = w.tree_order;
          });
        }
        this._refreshTreeViews();
        return true;
      }
      async renameTreeNode(path) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f) return;
        const next = await askText(this.app, "新名称", f.basename);
        if (!next || next === f.basename) return;
        const safe = slugifyForFolder(next);
        if (!safe) {
          new Notice2("名称无效");
          return;
        }
        const dir = f.parent ? f.parent.path : "";
        const newPath = (dir ? dir + "/" : "") + safe + ".md";
        if (this.app.vault.getAbstractFileByPath(newPath)) {
          new Notice2("同名文件已存在");
          return;
        }
        await this.app.fileManager.renameFile(f, newPath);
        new Notice2(`已重命名为 ${safe}`);
        this._refreshTreeViews();
      }
      async dismissTreeNode(path) {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (!f) return;
        if (getFm(this.app, f)?.type === "card") {
          new Notice2("卡片复习状态由 Spaced Repetition 管理。");
          return;
        }
        const ok = await confirmDialog(
          this.app,
          `移出「${f.basename}」？`,
          "设为 dismissed（保留在树中，移出复习队列）。"
        );
        if (!ok) return;
        await this.app.fileManager.processFrontMatter(f, (fm) => {
          fm.status = "dismissed";
        });
        new Notice2("已移出队列");
        this._refreshTreeViews();
      }
      async markPathsDone(paths, { confirm = true } = {}) {
        const files = [...new Set(paths || [])].map((path) => this.app.vault.getAbstractFileByPath(path)).filter((file) => file instanceof TFile2 && ["source", "extract", "card"].includes(getFm(this.app, file)?.type));
        const pending = files.filter((file) => getFm(this.app, file)?.status !== "done");
        if (!pending.length) {
          new Notice2("选中的项目都已完成。");
          return 0;
        }
        if (confirm) {
          const label = pending.length === 1 ? `"${pending[0].basename}"` : `${pending.length} selected items`;
          const ok = await confirmDialog(
            this.app,
            `把 ${label} 标记为完成？`,
            "未来的复习日期会被清除；卡片也会离开 Spaced Repetition deck。"
          );
          if (!ok) return 0;
        }
        const today = todayDateString(this.settings);
        const deckTag = this._spacedRepetitionDeckTag();
        for (const file of pending) {
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            statusCore.completeItemFrontmatter(fm, today, deckTag);
          });
          this.cardDueCache.delete(file.path);
          this.cardScheduleSignatures.delete(file.path);
          if (this.pendingSpacedRepetitionReview?.path === file.path) this.pendingSpacedRepetitionReview = null;
          this.consumeSessionItem(file.path, { background: true });
        }
        this._invalidateIRCollection();
        this._refreshTreeViews();
        new Notice2(`已把 ${pending.length} 项标记完成，未来复习已清除。`);
        return pending.length;
      }
      async resetPaths(paths, { confirm = true } = {}) {
        const files = [...new Set(paths || [])].map((path) => this.app.vault.getAbstractFileByPath(path)).filter((file) => file instanceof TFile2 && ["source", "extract", "card"].includes(getFm(this.app, file)?.type));
        if (!files.length) {
          new Notice2("没有可重置的选中项。");
          return 0;
        }
        if (confirm) {
          const label = files.length === 1 ? `"${files[0].basename}"` : `${files.length} selected items`;
          const ok = await confirmDialog(
            this.app,
            `重置 ${label}？`,
            "设为 active 并清除排期历史；卡片会作为新卡回到 Spaced Repetition deck。"
          );
          if (!ok) return 0;
        }
        const deckTag = this._spacedRepetitionDeckTag();
        for (const file of files) {
          const isCard = getFm(this.app, file)?.type === "card";
          await this.app.fileManager.processFrontMatter(file, (fm) => {
            statusCore.resetItemFrontmatter(fm, deckTag);
          });
          if (isCard) {
            await this.app.vault.process(file, (content) => statusCore.clearSpacedRepetitionSchedule(content));
            this.cardDueCache.delete(file.path);
            this.cardScheduleSignatures.delete(file.path);
          }
        }
        this._invalidateIRCollection();
        this._refreshTreeViews();
        new Notice2(`已重置 ${files.length} 项。`);
        return files.length;
      }
      async seedInlineCards() {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
          new Notice2("没有活动文件");
          return;
        }
        const cache = this.app.metadataCache.getFileCache(active);
        const fm = cache?.frontmatter;
        if (!fm || fm.type !== "source" && fm.type !== "extract") {
          new Notice2("当前文件不是来源/摘录");
          return;
        }
        const body = await this.app.vault.cachedRead(active);
        let parsed;
        try {
          parsed = parseInlineCards(active.path, body, this.settings);
        } catch (error) {
          new Notice2(error.message, 8e3);
          return;
        }
        if (!parsed.length) {
          new Notice2("没有找到内联卡片");
          return;
        }
        const grouped = /* @__PURE__ */ new Map();
        for (const card of parsed) {
          const key = card.type === "qa" ? card.id : inlineCardId(active.path, `line:${card.line}:${card.full_line}`);
          if (!grouped.has(key)) grouped.set(key, card);
        }
        const existingIds = /* @__PURE__ */ new Set();
        for (const file of filesInFolder(this.app, this.cardsFolder())) {
          if (file.extension !== "md") continue;
          const id = getFm(this.app, file)?.ir_inline_id;
          if (id) existingIds.add(String(id));
        }
        let created = 0;
        const clozeRegex = new RegExp(this.settings.inline_cards.cloze_regex, "g");
        for (const [id, card] of grouped) {
          if (existingIds.has(id)) continue;
          let format = card.type === "qa" ? "basic" : "cloze";
          let question = card.question;
          let answer = card.answer || "";
          if (format === "cloze") {
            question = card.full_line.replace(
              clozeRegex,
              (_match, _index, text, hint) => `==${text}==${hint ? `^[${hint}]` : ""}`
            );
          }
          await this._createSpacedRepetitionCard(active, {
            format,
            question,
            answer,
            extraFrontmatter: [`ir_inline_id: ${JSON.stringify(id)}`]
          });
          existingIds.add(id);
          created++;
        }
        new Notice2(created ? `已导出 ${created} 张内联卡片到 Spaced Repetition` : "所有内联卡片都已导出");
      }
      async addCheckpoint(noteOverride) {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
          new Notice2("没有活动文件");
          return;
        }
        const cache = this.app.metadataCache.getFileCache(active);
        if (!isActiveIR(cache?.frontmatter) || cache.frontmatter.type === "card") {
          new Notice2("检查点只适用于来源和摘录。");
          return;
        }
        let note = noteOverride;
        if (note == null) {
          note = await new Promise((resolve) => {
            new TextPromptModal(this.app, "检查点备注（前缀 Nd:: 可覆盖间隔）", "", resolve).open();
          });
        }
        if (note == null) return;
        const editor = this.app.workspace.activeEditor?.editor;
        const line = editor ? editor.getCursor().line : 0;
        let interval = null;
        let cleanNote = note;
        const m = note.match(/^(\d+)d::\s*(.*)$/);
        if (m) {
          interval = Number(m[1]);
          cleanNote = m[2];
        }
        await this.app.fileManager.processFrontMatter(active, (fm) => {
          fm.checkpoints = fm.checkpoints || [];
          fm.checkpoints.push({
            date: todayDateString(this.settings),
            line,
            note: cleanNote,
            ...fm.type === "source" && fm.read_point_seconds != null ? { read_point_seconds: fm.read_point_seconds } : {}
          });
          if (interval != null) {
            fm.interval = interval;
            fm.next_review = futureDateString(interval, this.settings);
          }
        });
        new Notice2(interval != null ? `检查点已保存，${interval} 天后复习` : "检查点已保存");
      }
      // ---- Done / Dismiss / Postpone / Schedule ------------------------------
      async markDone() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: true, allowPdfFallback: true });
        if (!r) return;
        const { tfile, fm } = r;
        if (fm.status === "done") {
          new Notice2("已经完成。");
          return;
        }
        await this.markPathsDone([tfile.path]);
      }
      async resetCurrent() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: true, allowPdfFallback: true });
        if (!r) return;
        await this.resetPaths([r.tfile.path]);
      }
      async dismiss() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
        if (!r) return;
        const { tfile, fm } = r;
        if (fm.status === "dismissed") {
          new Notice2("已经移出队列。");
          return;
        }
        await this.app.fileManager.processFrontMatter(tfile, (fmw) => {
          fmw.status = "dismissed";
          fmw.date_dismissed = todayDateString(this.settings);
        });
        new Notice2("已移出队列；把 status 设为 active 可恢复。");
      }
      async postpone() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
        if (!r) return;
        const choice = await pickFromList(
          this.app,
          ["明天（+1 天）", "+3 天", "+1 周", "+2 周"],
          [1, 3, 7, 14],
          "延后多久？"
        );
        if (!choice) return;
        const newDate = futureDateString(choice, this.settings);
        await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
          fmw.next_review = newDate;
          fmw.interval = choice;
        });
        new Notice2(`已延后 +${choice} 天 · 下次复习：${newDate}`);
      }
      async schedule() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
        if (!r) return;
        const cur = r.fm.next_review || "(unscheduled)";
        const dateFormat = configuredDateFormat(this.settings);
        const raw = await askText(this.app, `排期（${dateFormat} 或 +N/-N 天；当前：${cur}）`, "");
        if (!raw || raw.trim() === "") return;
        const input = raw.trim();
        let newDate = null;
        const offset = input.match(/^([+-]?)(\d+)\s*d?$/i);
        if (offset) {
          const sign = offset[1] === "-" ? -1 : 1;
          newDate = futureDateString(sign * parseInt(offset[2], 10), this.settings);
        } else {
          const parsed = dateCore2.parseDateExact(input, dateFormat);
          if (!parsed) {
            new Notice2(`无效的 ${dateFormat} 日期：${input}`);
            return;
          }
          newDate = formatDateValue(parsed, this.settings);
        }
        const newParsed = parseDateValue(newDate, this.settings);
        const newInterval = newParsed ? Math.max(1, Math.round((newParsed - todayDate()) / 864e5)) : null;
        await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
          fmw.next_review = newDate;
          if (newInterval != null) fmw.interval = newInterval;
        });
        new Notice2(`已排期：${cur} → ${newDate}`);
      }
      // ---- Set Priority / Boost ---------------------------------------------
      async setPriority() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
        if (!r) return;
        const cur = r.fm.priority ?? 50;
        const raw = await askText(this.app, "新优先级（1–100，1 最高）", String(cur));
        if (raw === null) return;
        if (!/^\d+$/.test(raw.trim())) {
          new Notice2("无效优先级：请输入 1–100 的整数。");
          return;
        }
        const p = Number(raw);
        if (!Number.isInteger(p) || p < 1 || p > 100) {
          new Notice2("无效优先级：请输入 1–100 的整数。");
          return;
        }
        await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
          fmw.priority = p;
        });
        new Notice2(`优先级 → ${p}（下次复习不变，由 A-Factor 驱动）`);
      }
      async boost() {
        const r = await resolveIRFromActive(this.app, this.settings, { allowCard: false, allowPdfFallback: true });
        if (!r) return;
        const amount = await pickFromList(
          this.app,
          ["小（-5）", "中（-15）", "大（-30）", "自定义"],
          [5, 15, 30, "custom"],
          "提升幅度"
        );
        if (!amount) return;
        let delta;
        if (amount === "custom") {
          const raw = await askText(this.app, "提升幅度（1–99）", "10");
          if (!raw) return;
          if (!/^\d+$/.test(raw.trim())) {
            new Notice2("无效数量。");
            return;
          }
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 1 || n > 99) {
            new Notice2("无效数量。");
            return;
          }
          delta = n;
        } else {
          delta = amount;
        }
        const cascade = await confirmDialog(this.app, "是否把提升级联到整个子树？");
        const orig = r.fm.priority ?? 50;
        const newPri = Math.max(1, orig - delta);
        await this.app.fileManager.processFrontMatter(r.tfile, (fmw) => {
          if (fmw.boost_from == null) fmw.boost_from = orig;
          fmw.priority = newPri;
        });
        let cascaded = 0;
        if (cascade) {
          const subtree = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path, { rows: this.getIRRows() });
          for (const p of subtree) {
            if (p.tfile.path === r.tfile.path) continue;
            if (p.fm.type === "card") continue;
            const childOrig = p.fm.priority ?? 50;
            const childNew = Math.max(1, childOrig - delta);
            if (childNew !== childOrig) {
              await this.app.fileManager.processFrontMatter(p.tfile, (fmw) => {
                if (fmw.boost_from == null) fmw.boost_from = childOrig;
                fmw.priority = childNew;
              });
              cascaded++;
            }
          }
        }
        const cmsg = cascade ? ` + ${cascaded} descendant${cascaded === 1 ? "" : "s"}` : "";
        new Notice2(`已提升：${orig} → ${newPri}${cmsg}；已保留 boost_from。`);
      }
      // ---- Subset Review / Mercy / Postpone Subtree --------------------------
      async subsetReview() {
        const r = await resolveSourceFromActive(this.app, this.settings);
        if (!r) return;
        const filter = await pickFromList(
          this.app,
          ["全部主题", "仅到期/逾期"],
          ["all", "due"],
          "按什么筛选子树？"
        );
        if (!filter) return;
        const today = todayDate();
        let subset = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path, {
          includeCards: false,
          rows: this.getIRRows()
        }).filter((p) => p.tfile.path !== r.tfile.path);
        if (filter === "due") subset = subset.filter((p) => isDue(p.fm, today, this.settings));
        subset = subset.filter((p) => p.fm.status !== "done" && p.fm.status !== "container" && p.fm.status !== "dismissed");
        if (subset.length === 0) {
          new Notice2(`没有匹配的后代。`);
          return;
        }
        subset.sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
        const statusIcon = (fm) => {
          const nr = parseDateValue(fm.next_review, this.settings);
          if (!nr) return "⚪";
          const off = daysBetween(today, nr);
          return off > 0 ? "🔴" : off === 0 ? "🟡" : "🟢";
        };
        const picked = await pickFuzzy(
          this.app,
          subset,
          (p) => {
            const t = p.fm.type === "source" ? "📖" : "📝";
            return `${t} ${statusIcon(p.fm)} p${p.fm.priority ?? "—"} u${urgency(p.fm, today, this.settings).toFixed(0)}  ${p.tfile.basename}`;
          },
          `子集（${r.tfile.basename}）`
        );
        if (!picked) return;
        await this.app.workspace.getLeaf(false).openFile(picked.tfile);
      }
      async mercy() {
        const choice = await pickFromList(
          this.app,
          ["3 天", "7 天", "14 天", "30 天"],
          [3, 7, 14, 30],
          "摊平窗口"
        );
        if (!choice) return;
        const today = todayDate();
        const overdue = [];
        for (const { tfile: f, fm } of this.getIRRows()) {
          if (!isActiveIR(fm) || fm.type === "card") continue;
          if (!isPastDue(fm, today, this.settings)) continue;
          overdue.push({ tfile: f, fm });
        }
        if (overdue.length === 0) {
          new Notice2("当前没有逾期主题。");
          return;
        }
        overdue.sort((a, b) => urgency(b.fm, today, this.settings) - urgency(a.fm, today, this.settings));
        let updated = 0;
        for (let rank = 0; rank < overdue.length; rank++) {
          const off = Math.floor(rank * choice / overdue.length);
          const d = new Date(today.getTime());
          d.setDate(d.getDate() + off);
          const newDate = formatDateValue(d, this.settings);
          await this.app.fileManager.processFrontMatter(overdue[rank].tfile, (fmw) => {
            fmw.next_review = newDate;
            fmw.interval = Math.max(1, off);
          });
          updated++;
        }
        new Notice2(`Mercy：${updated} 个逾期主题已摊平到 ${choice} 天。`);
      }
      async postponeSubtree() {
        const r = await resolveSourceFromActive(this.app, this.settings);
        if (!r) return;
        const choice = await pickFromList(
          this.app,
          ["+1 天", "+3 天", "+1 周", "+2 周", "+1 个月"],
          [1, 3, 7, 14, 30],
          "推迟子树多久？"
        );
        if (!choice) return;
        const subtree = walkSubtree(this.app, this.settings, r.tfile.basename, r.tfile.path, { rows: this.getIRRows() });
        let postponed = 0;
        for (const p of subtree) {
          const fm = p.fm;
          if (fm.type === "card") continue;
          if (fm.status === "done" || fm.status === "container" || fm.status === "dismissed") continue;
          let baseDate = todayDateString(this.settings);
          if (fm.next_review) {
            const candidate = parseDateValue(fm.next_review, this.settings);
            if (candidate && candidate > todayDate()) baseDate = fm.next_review;
          }
          const baseObj = parseDateValue(baseDate, this.settings) || todayDate();
          baseObj.setDate(baseObj.getDate() + choice);
          const newDate = formatDateValue(baseObj, this.settings);
          await this.app.fileManager.processFrontMatter(p.tfile, (fmw) => {
            fmw.next_review = newDate;
          });
          postponed++;
        }
        new Notice2(`子树已推迟 +${choice} 天 · ${postponed} 项。`);
      }
      // ---- Extract / Flashcard ------------------------------------------------
      async extractClipboard() {
        await this._createExtract(true);
      }
      async extractSelection() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("摘录选中内容需要打开一个 Markdown 来源。");
          return;
        }
        const fm = getFm(this.app, active);
        if (fm?.type !== "source") {
          new Notice2("请在来源笔记中运行。");
          return;
        }
        const editor = getEditorForFile(this.app, active);
        const selection = editor?.getSelection?.() || "";
        if (!selection.trim()) {
          new Notice2("没有选中文字。");
          return;
        }
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        const selectedText = selection.trim();
        const created = await this._writeExtract(active, fm, selectedText);
        if (!created) return;
        if (editor.getRange(from, to).trim() !== selectedText) {
          new Notice2("摘录已创建，但来源在标记前发生变化，未能高亮。");
          return;
        }
        editor.replaceRange(excerptHighlightMarkup(editor.getRange(from, to)), from, to);
      }
      async _createExtract(fromClipboard) {
        const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
        if (!r) return;
        let clip = "";
        try {
          clip = (await navigator.clipboard.readText()).trim();
        } catch (e) {
          new Notice2("无法读取剪贴板。");
          return;
        }
        if (!clip) {
          new Notice2("剪贴板为空。");
          return;
        }
        await this._writeExtract(r.tfile, r.fm, clip);
      }
      async _writeExtract(sourceFile, fm, body) {
        const sourceTitle = sourceFile.basename;
        const safeSourceTitle = slugifyForFolder(sourceTitle) || "Untitled";
        const extractsFolder = this.extractsFolder();
        await ensureFolder(this.app, extractsFolder);
        const priority = fm.priority ?? 50;
        const today = todayDateString(this.settings);
        const existing = filesInFolder(this.app, extractsFolder).filter((f) => f.extension === "md" && f.basename.startsWith(safeSourceTitle + " - Extract"));
        let n = existing.length + 1;
        let name = `${safeSourceTitle} - Extract ${n}`;
        while (this.app.vault.getAbstractFileByPath(`${extractsFolder}/${name}.md`)) {
          name = `${safeSourceTitle} - Extract ${++n}`;
        }
        const autoInterval = priorityToInterval(priority);
        const customStr = await askText(this.app, `首次间隔天数（留空自动：${autoInterval} 天）`, "");
        if (customStr === null) return false;
        if (customStr.trim() && !/^[1-9]\d*$/.test(customStr.trim())) {
          new Notice2("无效间隔：请输入正整数天数。");
          return false;
        }
        const interval = customStr.trim() ? Number(customStr) : autoInterval;
        const nextReview = futureDateString(interval, this.settings);
        const content = `---
type: extract
source: ${JSON.stringify(`[[${sourceTitle}]]`)}
status: pending
priority: ${priority}
next_review: ${nextReview}
interval: ${interval}
a_factor: 2.0
review_count: 0
last_reviewed:
date_added: ${today}
tags:
  - incremental-reading
  - ir/extract
---

${body}
`;
        const path = `${extractsFolder}/${name}.md`;
        if (this.app.vault.getAbstractFileByPath(path)) {
          new Notice2(`摘录已存在：${path}`);
          return false;
        }
        await this.app.vault.create(path, content);
        const decayCap = Math.min(100, priority + 30);
        const newPri = Math.min(decayCap, priority + 1);
        if (newPri !== priority) {
          await this.app.fileManager.processFrontMatter(sourceFile, (fmw) => {
            fmw.priority = newPri;
          });
        }
        const bump = await this._bumpAFactor(sourceFile, fm, this.settings.scheduling.extract_bump);
        const bumpMsg = bump ? ` · a ${bump.from}→${bump.to}` : "";
        new Notice2(`摘录：${name} · 优先级 ${priority}→${newPri} · ${interval} 天后复习（${nextReview}）${bumpMsg}`);
        return true;
      }
      async flashcardClipboard() {
        this._dbg("flashcardClipboard start");
        const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
        if (!r) return;
        const parentFile = r.tfile;
        const fm = r.fm;
        const imgClip = await readImageFromClipboard();
        if (imgClip) {
          return await this._flashcardFromImage(parentFile, fm, { imgClip });
        }
        let clip = "";
        try {
          clip = (await navigator.clipboard.readText()).trim();
        } catch (e) {
          new Notice2("无法读取剪贴板。");
          return;
        }
        if (!clip) {
          new Notice2("剪贴板为空（没有文字或图片）。");
          return;
        }
        this._dbg("flashcard: clip length", clip.length, "inline-match", /^[^\n]+::[^\n]+$/.test(clip));
        const parentTitle = parentFile.basename;
        let cardFormat = null, questionText = null, answerText = null;
        const COLON = ":";
        const inlineRe = new RegExp(`^[^\\n]+${COLON}${COLON}[^\\n]+$`);
        if (inlineRe.test(clip) && !clip.includes("\n")) {
          const parts = clip.split(COLON + COLON);
          questionText = parts[0].trim();
          answerText = parts.slice(1).join(COLON + COLON).trim();
          cardFormat = "basic";
        } else if (/\n\?\n/.test(clip)) {
          const parts = clip.split(/\n\?\n/);
          questionText = parts[0].trim();
          answerText = parts.slice(1).join("\n?\n").trim();
          cardFormat = "basic";
        } else {
          cardFormat = await pickFromList(
            this.app,
            [
              "Cloze 填空（Wozniak 规则 5，推荐）",
              "基础问答（问题 + 隐藏答案）",
              "基础双向（词汇对）"
            ],
            ["cloze", "basic", "reverse"],
            "卡片类型"
          );
          this._dbg("flashcard: cardFormat =", JSON.stringify(cardFormat));
          if (!cardFormat) return;
          if (cardFormat === "cloze") {
            this._dbg("flashcard: about to open cloze keyword prompt");
            const kw = await askText(this.app, "要挖空的词（逗号分隔；留空手动编辑）", "");
            this._dbg("flashcard: kw returned =", JSON.stringify(kw));
            if (kw === null) return;
            let text = clip;
            const keywords = kw.split(",").map((w) => w.trim()).filter(Boolean);
            const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (keywords.length) {
              const missing = [];
              for (const w of keywords) {
                const re = new RegExp(`\\b${escape(w)}\\b`);
                if (!re.test(text)) {
                  missing.push(w);
                  continue;
                }
                text = text.replace(re, `==${w}==`);
              }
              if (missing.length === keywords.length) {
                const edited = await askText(this.app, "编辑文本——用 ==标记== 包住要挖空的词", clip);
                if (!edited) return;
                text = edited;
              }
            } else {
              const edited = await askText(this.app, "编辑文本——用 ==标记== 包住要挖空的词", clip);
              if (!edited) return;
              text = edited;
            }
            if (!new RegExp(HL_CLOZE_SRC).test(text)) {
              new Notice2("没有 ==标记==，已中止。");
              return;
            }
            questionText = text;
          } else {
            answerText = await askText(this.app, "答案（规则 4：尽量短）", "");
            if (!answerText || !answerText.trim()) return;
            questionText = clip.replace(/\n+/g, " ");
            answerText = answerText.trim();
          }
        }
        if (cardFormat !== "cloze") {
          const prefix = await askText(this.app, "上下文标签（可选，例如 'bioch:'，规则 16）", "");
          if (prefix === null) return;
          if (prefix.trim()) {
            const pfx = prefix.trim().replace(/:?\s*$/, ":");
            questionText = `${pfx} ${questionText}`;
          }
        }
        const created = await this._createSpacedRepetitionCard(parentFile, {
          format: cardFormat,
          question: questionText,
          answer: answerText
        });
        const kind = cardFormat === "reverse" ? "双向卡片" : cardFormat === "cloze" ? "Cloze 卡片" : "卡片";
        new Notice2(`${kind}已创建到 Spaced Repetition：${created.name}`);
      }
      // Build a basic image-based flashcard (image is the question, user supplies
      // text answer). Image saved into the parent's attachment folder, embedded
      // via vault-relative wikilink. Pass either { imgClip } (binary from clipboard)
      // or { vaultPath } (existing image already in vault). skipCaption=true omits
      // the caption prompt — used for the pure "name this image" flashcard type.
      async _flashcardFromImage(parentFile, fm, { imgClip, vaultPath, skipCaption } = {}) {
        const parentTitle = parentFile.basename;
        let imgPath;
        if (imgClip) {
          const ext = imgClip.mime === "image/jpeg" ? "jpg" : imgClip.mime === "image/webp" ? "webp" : "png";
          const attachDir = `${this.attachmentsFolder()}/${slugifyForFolder(parentTitle)}`;
          await ensureFolder(this.app, attachDir);
          const hash = await shortHashOfBytes(imgClip.bytes);
          imgPath = `${attachDir}/img-${hash}.${ext}`;
          if (!this.app.vault.getAbstractFileByPath(imgPath)) {
            await this.app.vault.createBinary(imgPath, imgClip.bytes);
          }
        } else if (vaultPath) {
          imgPath = vaultPath;
        } else {
          new Notice2("没有提供图片。");
          return;
        }
        let caption = "";
        if (!skipCaption) {
          caption = await askText(this.app, "问题说明（可选，显示在图片上方）", "");
          if (caption === null) return;
        }
        const answer = await askText(this.app, "答案——说出这是什么", "");
        if (answer === null || !answer.trim()) {
          new Notice2("必须填写答案。");
          return;
        }
        const questionText = caption && caption.trim() ? `${caption.trim()}
![[${imgPath}]]` : `![[${imgPath}]]`;
        const answerText = answer.trim();
        const created = await this._createSpacedRepetitionCard(parentFile, {
          format: "basic",
          question: questionText,
          answer: answerText
        });
        new Notice2(`图片卡片已创建到 Spaced Repetition：${created.name}`);
      }
      // "Name this image" flashcard: image is the only thing on the front,
      // user types the name on the back. Pulls image from clipboard if present,
      // otherwise picks from the parent's embedded images or attachment folder.
      async flashcardImageName() {
        const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
        if (!r) return;
        const imgClip = await readImageFromClipboard();
        if (imgClip) {
          return await this._flashcardFromImage(r.tfile, r.fm, { imgClip, skipCaption: true });
        }
        const fileContent = await this.app.vault.read(r.tfile);
        const linkRe = /!\[\[([^\]|#]+\.(?:png|jpe?g|webp|gif))(?:[#|][^\]]*)?\]\]/gi;
        const linked = Array.from(fileContent.matchAll(linkRe)).map((m) => m[1].trim());
        const parentBase = r.fm.type === "source" ? r.tfile.basename : (() => {
          const link = String(r.fm.source || "").match(/\[\[([^\]|#]+)/);
          return link ? link[1] : r.tfile.basename;
        })();
        const attachDir = `${this.attachmentsFolder()}/${slugifyForFolder(parentBase)}`;
        const folderFiles = filesInFolder(this.app, attachDir).filter((f) => f.path.startsWith(attachDir + "/") && /\.(png|jpe?g|webp|gif)$/i.test(f.name));
        const candidates = /* @__PURE__ */ new Map();
        for (const path of linked) {
          const tf = this.app.vault.getAbstractFileByPath(path) || this.app.metadataCache.getFirstLinkpathDest(path, r.tfile.path);
          if (tf) candidates.set(tf.path, tf);
        }
        for (const f of folderFiles) candidates.set(f.path, f);
        const list = Array.from(candidates.values());
        if (list.length === 0) {
          new Notice2("剪贴板没有图片，这篇笔记也没有链接图片。");
          return;
        }
        const picked = list.length === 1 ? list[0] : await pickFuzzy(this.app, list, (f) => f.path, "选择要命名的图片");
        if (!picked) return;
        return await this._flashcardFromImage(r.tfile, r.fm, { vaultPath: picked.path, skipCaption: true });
      }
      // ---- Image extract / Occlusion (visual learning) -----------------------
      async imageExtractClipboard() {
        const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
        if (!r) return;
        const sourceFolder = slugifyForFolder(r.tfile.basename);
        const attachDir = `${this.attachmentsFolder()}/${sourceFolder}`;
        let bytes = null, ext = null;
        const img = await readImageFromClipboard();
        if (img) {
          bytes = img.bytes;
          ext = img.mime === "image/jpeg" ? "jpg" : img.mime === "image/webp" ? "webp" : "png";
        } else {
          let clipText = "";
          try {
            clipText = (await navigator.clipboard.readText()).trim();
          } catch (e) {
          }
          const wikilinkMatch = clipText.match(/!\[\[([^\]|#]+\.(?:png|jpe?g|webp|gif))(?:[#|][^\]]*)?\]\]/i);
          const mdLinkMatch = clipText.match(/!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|webp|gif))\)/i);
          const linkPath = wikilinkMatch?.[1] || mdLinkMatch?.[1] || null;
          if (!linkPath) {
            new Notice2('No image on clipboard. With PDF++: enable "Rectangular selection" + "Auto-copy", drag rect, then run this command.');
            return;
          }
          const sourceTf = this.app.vault.getAbstractFileByPath(linkPath) || this.app.metadataCache.getFirstLinkpathDest(linkPath, r.tfile.path);
          if (!sourceTf) {
            new Notice2(`Vault 中找不到图片：${linkPath}`);
            return;
          }
          bytes = await this.app.vault.readBinary(sourceTf);
          ext = (sourceTf.extension || "png").toLowerCase();
          if (ext === "jpeg") ext = "jpg";
        }
        await ensureFolder(this.app, attachDir);
        const hash = await shortHashOfBytes(bytes);
        const imgPath = `${attachDir}/img-${hash}.${ext}`;
        if (!this.app.vault.getAbstractFileByPath(imgPath)) {
          await this.app.vault.createBinary(imgPath, bytes);
        }
        const caption = await askText(this.app, "说明（可选，作为摘录正文）", "");
        if (caption === null) return;
        const body = caption.trim() ? `![[${imgPath}]]

${caption.trim()}` : `![[${imgPath}]]`;
        await this._writeExtract(r.tfile, r.fm, body);
      }
      async occlusionCreate() {
        const r = await resolveSourceOrExtractFromActive(this.app, this.settings);
        if (!r) return;
        const fileContent = await this.app.vault.read(r.tfile);
        const linkRe = /!\[\[([^\]|#]+\.(?:png|jpg|jpeg|webp|gif))(?:[#|][^\]]*)?\]\]/gi;
        const linked = [];
        let m;
        while (m = linkRe.exec(fileContent)) linked.push(m[1].trim());
        let imgVaultPath = null;
        if (linked.length === 1) {
          imgVaultPath = linked[0];
        } else if (linked.length > 1) {
          imgVaultPath = await pickFromList(this.app, linked, linked, "选择要遮挡的图片");
          if (!imgVaultPath) return;
        } else {
          const parentBase = r.fm.type === "source" ? r.tfile.basename : (() => {
            const link = String(r.fm.source || "").match(/\[\[([^\]|#]+)/);
            return link ? link[1] : r.tfile.basename;
          })();
          const dir = `${this.attachmentsFolder()}/${slugifyForFolder(parentBase)}`;
          const folder = this.app.vault.getAbstractFileByPath(dir);
          if (!folder) {
            new Notice2("这个来源没有图片。请先用「图片摘录」或嵌入一张图片。");
            return;
          }
          const files = filesInFolder(this.app, dir).filter((f) => f.path.startsWith(dir + "/") && /\.(png|jpe?g|webp|gif)$/i.test(f.name));
          if (files.length === 0) {
            new Notice2("附件文件夹里没有图片。");
            return;
          }
          const picked = await pickFuzzy(this.app, files, (f) => f.name, "选择图片");
          if (!picked) return;
          imgVaultPath = picked.path;
        }
        const tf = this.app.vault.getAbstractFileByPath(imgVaultPath) || this.app.metadataCache.getFirstLinkpathDest(imgVaultPath, r.tfile.path);
        if (!tf) {
          new Notice2(`找不到图片：${imgVaultPath}`);
          return;
        }
        const resolvedPath = tf.path;
        const src = this.app.vault.adapter.getResourcePath(resolvedPath);
        const result = await askOcclusion(this.app, src);
        if (!result) return;
        const cardSpecs = generateCardsFromRects(result.rects, result.mode);
        if (!cardSpecs || cardSpecs.length === 0) {
          new Notice2("没有生成卡片。");
          return;
        }
        let written = 0;
        const yamlRects = result.rects.map((rect) => {
          const base = `x: ${round4(rect.x)}, y: ${round4(rect.y)}, w: ${round4(rect.w)}, h: ${round4(rect.h)}`;
          const label = rect.label ? `, label: "${String(rect.label).replace(/"/g, '\\"')}"` : "";
          return `  - {${base}${label}}`;
        }).join("\n");
        for (const spec of cardSpecs) {
          const question = `\`\`\`ir-occlusion
image: ${JSON.stringify(resolvedPath)}
mode: ${result.mode}
question_index: ${spec.questionIndex}
rects:
` + yamlRects + "\n```\n";
          await this._createSpacedRepetitionCard(r.tfile, {
            format: "occlusion",
            question,
            answer: `![[${resolvedPath}]]`,
            extraFrontmatter: [
              `occlusion_image: ${JSON.stringify(resolvedPath)}`,
              `occlusion_mode: ${result.mode}`,
              `occlusion_question_index: ${spec.questionIndex}`
            ]
          });
          written++;
        }
        new Notice2(`遮挡：从 ${result.rects.length} 个矩形生成了 ${written} 张 SR 卡片`);
      }
      // ---- New source / Import clipping --------------------------------------
      async newSource() {
        const title = await askText(this.app, "来源标题", "");
        if (!title) return;
        const sourceType = await pickFromList(
          this.app,
          ["书籍", "文章", "PDF", "YouTube 视频", "本地视频"],
          ["book", "article", "pdf", "youtube", "video"],
          "来源类型"
        );
        if (!sourceType) return;
        const priStr = await askText(this.app, "优先级（1–100，1 最高）", "50");
        if (priStr === null) return;
        if (!/^\d+$/.test(priStr.trim())) {
          new Notice2("无效优先级：请输入 1–100 的整数。");
          return;
        }
        const pNum = Number(priStr);
        if (!Number.isInteger(pNum) || pNum < 1 || pNum > 100) {
          new Notice2("无效优先级：请输入 1–100 的整数。");
          return;
        }
        const today = todayDateString(this.settings);
        const interval = priorityToInterval(pNum);
        const nextReview = futureDateString(interval, this.settings);
        let pdf_path = null, total_pages = null, read_point = null, source_url = null;
        let video_id = null, video_url = null, video_path = null, author = null;
        let read_point_seconds = null, total_seconds = null;
        if (sourceType === "book" || sourceType === "pdf") {
          pdf_path = await askText(this.app, "PDF 路径（Vault 相对或绝对）", "");
          if (pdf_path) pdf_path = pdf_path.replace(/^['"]|['"]$/g, "");
          const pages = await askText(this.app, "总页数", "");
          if (pages === null) return;
          if (pages.trim() && !/^[1-9]\d*$/.test(pages.trim())) {
            new Notice2("无效总页数：请输入正整数。");
            return;
          }
          total_pages = pages.trim() ? Number(pages) : null;
          read_point = 1;
        } else if (sourceType === "article") {
          source_url = await askText(this.app, "来源 URL（可选）", "") || null;
        } else if (sourceType === "youtube") {
          video_url = await askText(this.app, "YouTube 链接", "");
          if (!video_url) {
            new Notice2("必须填写 YouTube 链接。");
            return;
          }
          const m = video_url.match(/(?:youtu\.be\/|v=|embed\/)([\w-]{11})/);
          if (!m) {
            new Notice2("YouTube 链接无效。");
            return;
          }
          video_id = m[1];
          author = await askText(this.app, "作者 / 频道（可选）", "") || null;
          const dur = await askText(this.app, "总时长 mm:ss 或 hh:mm:ss（可选）", "");
          if (dur === null) return;
          total_seconds = parseTimeInput(dur);
          if (dur.trim() && total_seconds == null) {
            new Notice2("无效时长，请使用 mm:ss 或 hh:mm:ss。");
            return;
          }
          read_point_seconds = 0;
        } else if (sourceType === "video") {
          const videosFolder = `${this.sourcesFolder()}/Videos`;
          const videos = filesInFolder(this.app, videosFolder).filter((f2) => f2.path.startsWith(videosFolder + "/") && /\.(mp4|webm|mov|mkv)$/i.test(f2.name)).sort((a, b) => a.name.localeCompare(b.name));
          if (videos.length === 0) {
            new Notice2(`请先把视频放到 ${videosFolder}/。`);
            return;
          }
          const picked = await pickFuzzy(this.app, videos, (v) => v.name, "选择视频文件");
          if (!picked) return;
          video_path = picked.path;
          author = await askText(this.app, "作者（可选）", "") || null;
          const dur = await askText(this.app, "总时长 mm:ss 或 hh:mm:ss（可选）", "");
          if (dur === null) return;
          total_seconds = parseTimeInput(dur);
          if (dur.trim() && total_seconds == null) {
            new Notice2("无效时长，请使用 mm:ss 或 hh:mm:ss。");
            return;
          }
          read_point_seconds = 0;
        }
        const holdInInbox = await confirmDialog(this.app, "先放入收件箱？（否则按排期进入队列。）");
        const status = holdInInbox ? "inbox" : "active";
        const aFactorInit = round4(initialAFactor(this.settings, { total_pages, total_seconds }));
        const fmLines = [
          "---",
          "type: source",
          `source_type: ${sourceType}`,
          `status: ${status}`,
          `priority: ${pNum}`,
          `next_review: ${nextReview}`,
          `interval: ${interval}`,
          `a_factor: ${aFactorInit}`,
          "review_count: 0",
          "last_reviewed:"
        ];
        if (read_point !== null) fmLines.push(`read_point: ${read_point}`);
        if (total_pages !== null) fmLines.push(`total_pages: ${total_pages}`);
        if (pdf_path) fmLines.push(`pdf_path: ${JSON.stringify(pdf_path)}`);
        if (source_url) fmLines.push(`source_url: ${JSON.stringify(source_url)}`);
        if (video_url) fmLines.push(`video_url: ${JSON.stringify(video_url)}`);
        if (video_id) fmLines.push(`video_id: ${JSON.stringify(video_id)}`);
        if (video_path) fmLines.push(`video_path: ${JSON.stringify(video_path)}`);
        if (read_point_seconds !== null) fmLines.push(`read_point_seconds: ${read_point_seconds}`);
        if (total_seconds !== null) fmLines.push(`total_seconds: ${total_seconds}`);
        if (author) fmLines.push(`author: ${JSON.stringify(author)}`);
        fmLines.push(`date_added: ${today}`);
        fmLines.push("tags:");
        fmLines.push("  - incremental-reading");
        fmLines.push("  - ir/source");
        fmLines.push("---");
        let body = `
# ${title}

`;
        if (sourceType === "book" || sourceType === "pdf") {
          body += `> [!tip] Open in viewer
> Run **Incremental Reading Toolkit: Open PDF (Toolkit viewer)**. Vault and external PDFs are supported.

`;
        } else if (sourceType === "youtube") {
          body += `<iframe width="640" height="360" src="https://www.youtube.com/embed/${video_id}?start=${read_point_seconds}" frameborder="0" allowfullscreen></iframe>

`;
        } else if (sourceType === "video") {
          body += `![[${video_path}]]

`;
        }
        body += `## Reading Notes


## Extracts

`;
        const safeTitle = slugifyForFolder(title);
        if (!safeTitle) {
          new Notice2("来源标题不包含有效文件名。");
          return;
        }
        const sourcesFolder = this.sourcesFolder();
        await ensureFolder(this.app, sourcesFolder);
        const path = `${sourcesFolder}/${safeTitle}.md`;
        if (this.app.vault.getAbstractFileByPath(path)) {
          new Notice2(`已存在：${path}`);
          return;
        }
        const f = await this.app.vault.create(path, fmLines.join("\n") + body);
        await this.app.workspace.getLeaf(false).openFile(f);
        new Notice2(`已创建 ${title}（${status}），A-Factor=${aFactorInit}`);
      }
      async importClipping() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("请先打开一篇剪藏笔记。");
          return;
        }
        const existing = getFm(this.app, active);
        if (existing?.type === "source") {
          new Notice2("这篇笔记已经是增量阅读来源。");
          return;
        }
        const priStr = await askText(this.app, "优先级（1–100，1 最高）", "50");
        if (priStr === null) return;
        if (!/^\d+$/.test(priStr.trim())) {
          new Notice2("无效优先级。");
          return;
        }
        const p = Number(priStr);
        if (!Number.isInteger(p) || p < 1 || p > 100) {
          new Notice2("无效优先级。");
          return;
        }
        const today = todayDateString(this.settings);
        const interval = priorityToInterval(p);
        const nextReview = futureDateString(interval, this.settings);
        const hold = await confirmDialog(this.app, "先放入收件箱？（否则直接激活。）");
        const initialStatus = hold ? "inbox" : "active";
        const aFactorInit = round4(initialAFactor(this.settings, {
          total_pages: Number(existing?.total_pages) || null,
          total_seconds: Number(existing?.total_seconds) || null
        }));
        const sourcesFolder = this.sourcesFolder();
        await ensureFolder(this.app, sourcesFolder);
        const baseName = slugifyForFolder(active.basename) || "Untitled";
        let newPath = `${sourcesFolder}/${baseName}.md`;
        let suffix = 2;
        while (active.path !== newPath && this.app.vault.getAbstractFileByPath(newPath)) {
          newPath = `${sourcesFolder}/${baseName} ${suffix++}.md`;
        }
        if (active.path !== newPath) await this.app.fileManager.renameFile(active, newPath);
        await this.app.fileManager.processFrontMatter(active, (fm) => {
          fm.type = "source";
          fm.source_type = "article";
          fm.status = initialStatus;
          fm.priority = p;
          fm.next_review = nextReview;
          fm.interval = interval;
          fm.a_factor = aFactorInit;
          fm.review_count = 0;
          fm.last_reviewed = null;
          fm.read_point = null;
          fm.total_pages = null;
          fm.sioyek_path = null;
          fm.pdf_path = null;
          for (const k of ["ease", "stability", "difficulty", "last_grade", "last_retrievability"]) {
            if (fm[k] !== void 0) delete fm[k];
          }
          if (!fm.source_url && fm.source) fm.source_url = fm.source;
          fm.date_added = today;
          if (typeof fm.tags === "string") fm.tags = fm.tags.split(/[\s,]+/).filter(Boolean);
          if (!Array.isArray(fm.tags)) fm.tags = [];
          if (!fm.tags.includes("incremental-reading")) fm.tags.push("incremental-reading");
          if (!fm.tags.includes("ir/source")) fm.tags.push("ir/source");
        });
        new Notice2(`已导入（${initialStatus}）· P${p} · ${interval} 天后复习`);
      }
      // ---- Navigation --------------------------------------------------------
      async openDashboard(section = null) {
        let leaf = this.app.workspace.getLeavesOfType(MAIN_DASHBOARD_VIEW_TYPE)[0];
        if (!leaf) {
          leaf = this.app.workspace.getLeaf("tab");
          await leaf.setViewState({ type: MAIN_DASHBOARD_VIEW_TYPE, active: true });
        }
        this.app.workspace.revealLeaf(leaf);
        if (section === "stats" && leaf.view instanceof MainDashboardView) {
          leaf.view.scrollToStatsOnRender = true;
          await leaf.view.render();
        }
      }
      async openParent() {
        const active = this.app.workspace.getActiveFile();
        if (!active) {
          new Notice2("没有活动文件。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm) {
          new Notice2("没有 frontmatter。");
          return;
        }
        if (fm.type !== "source" && fm.type !== "extract" && fm.type !== "card") {
          new Notice2("这不是增量阅读元素。");
          return;
        }
        const parentName = fm.type === "card" || fm.type === "extract" ? linkTarget(fm.source) : linkTarget(fm.parent);
        if (!parentName) {
          new Notice2("没有父项链接。");
          return;
        }
        const parent = this.app.metadataCache.getFirstLinkpathDest(parentName, active.path);
        if (!parent) {
          new Notice2(`找不到父项「${parentName}」。`);
          return;
        }
        await this.app.workspace.getLeaf(false).openFile(parent);
        new Notice2(`↑ ${parent.basename}`);
      }
      async openPdf() {
        const r = await resolveSourceFromActive(this.app, this.settings);
        if (!r) return;
        const fm = r.fm;
        const configured = fm.pdf_vault_path || fm.pdf_path || fm.sioyek_path;
        if (!configured) {
          new Notice2("没有设置 pdf_path 或 pdf_vault_path。");
          return;
        }
        const rawPath = String(configured);
        const ext = (rawPath.split(".").pop() || "").toLowerCase();
        if (ext === "epub") {
          new Notice2("Obsidian 查看器不支持 Epub。");
          return;
        }
        if (ext !== "pdf") {
          new Notice2(`不支持的扩展名 .${ext}`);
          return;
        }
        const vaultBase = vaultAbsPath(this.app, "");
        const rel = rawPath.startsWith(vaultBase) ? rawPath.slice(vaultBase.length) : rawPath.replace(/^\/+/, "");
        const vaultFile = this.app.vault.getAbstractFileByPath(rel);
        let url;
        if (vaultFile instanceof TFile2) url = this.app.vault.getResourcePath(vaultFile);
        else {
          const absolute = rawPath.startsWith("/") ? rawPath : vaultAbsPath(this.app, rawPath);
          const fs = require("fs");
          if (!fs.existsSync(absolute)) {
            new Notice2(`找不到 PDF：${rawPath}`);
            return;
          }
          url = require("url").pathToFileURL(absolute).href;
        }
        const ps = Number(fm.page_start) || null, pe = Number(fm.page_end) || null, rp = Number(fm.read_point) || null;
        let page = rp && ps && pe ? Math.max(ps, Math.min(rp, pe)) : rp || ps || 1;
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.setViewState({ type: PDF_VIEW_TYPE, active: true, state: { url, page, title: r.tfile.basename, sourcePath: r.tfile.path } });
        this.app.workspace.revealLeaf(leaf);
      }
      async toggleReadPoint() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("请打开一个 Markdown 来源。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm || fm.type !== "source") {
          new Notice2("这不是增量阅读来源。");
          return;
        }
        if (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path) {
          new Notice2("PDF 来源——请用「打开 PDF」。");
          return;
        }
        const editor = getEditorForFile(this.app, active);
        const cursor = editor?.getCursor?.();
        if (!editor || !cursor) {
          new Notice2("没有编辑器光标。");
          return;
        }
        const content = editor.getValue();
        READ_POINT_RE.lastIndex = 0;
        const hasMarker = READ_POINT_RE.test(content);
        let action;
        if (hasMarker) {
          action = await pickFromList(
            this.app,
            [`把 📍 移到第 ${cursor.line + 1} 行`, "清除 📍 标记"],
            ["move", "clear"],
            "📍 已设置"
          );
        } else {
          action = await pickFromList(
            this.app,
            [`在第 ${cursor.line + 1} 行设置 📍`],
            ["set"],
            "📍 标记"
          );
        }
        if (!action) return;
        await this.app.vault.process(active, (text) => {
          let stripped = text;
          const ms = [...text.matchAll(READ_POINT_RE)];
          for (const m of ms.reverse()) {
            stripped = stripped.slice(0, m.index) + stripped.slice(m.index + m[0].length);
          }
          if (action === "clear") return stripped;
          const fmEnd = frontmatterEndOffset(stripped);
          const lines = stripped.split("\n");
          let insertAt = 0;
          for (let i = 0; i < cursor.line; i++) insertAt += lines[i].length + 1;
          if (insertAt < fmEnd) insertAt = fmEnd;
          return stripped.slice(0, insertAt) + READ_POINT_MARKER + stripped.slice(insertAt);
        });
        await this.app.fileManager.processFrontMatter(active, (next) => {
          if (action === "clear") delete next.read_point_line;
          else next.read_point_line = cursor.line + 1;
        });
        new Notice2(action === "clear" ? "📍 已清除。" : `📍 已在第 ${cursor.line + 1} 行设置`);
      }
      async jumpToReadPoint({ silent = false } = {}) {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          if (!silent) new Notice2("这不是 Markdown 来源。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm || fm.type !== "source") {
          if (!silent) new Notice2("这不是增量阅读来源。");
          return;
        }
        if (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path) {
          if (!silent) new Notice2("PDF——请用「打开 PDF」。");
          return;
        }
        const openEditor = getEditorForFile(this.app, active);
        let line = Math.max(0, (Number(fm.read_point_line) || 0) - 1);
        let ch = 0;
        if (!fm.read_point_line) {
          const content = openEditor?.getValue?.() ?? await this.app.vault.cachedRead(active);
          const m = content.match(/(?:📍\s*)?<!--ir-readpoint-->/);
          if (!m) {
            if (!silent) new Notice2("没有 📍 阅读点。");
            return;
          }
          const before = content.slice(0, m.index);
          line = (before.match(/\n/g) || []).length;
          ch = m.index - (before.lastIndexOf("\n") + 1);
        }
        let leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => l.view?.file?.path === active.path);
        if (!leaf) {
          leaf = this.app.workspace.getLeaf(false);
          await leaf.openFile(active);
        }
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        const editor = leaf.view?.editor;
        if (editor) {
          editor.setCursor({ line, ch });
          editor.scrollIntoView({ from: { line, ch }, to: { line, ch } }, true);
          if (!silent) new Notice2(`已跳到 📍（第 ${line + 1} 行）`);
        } else if (!silent) new Notice2("编辑器不可用。");
      }
      // ---- Stats -------------------------------------------------------------
      async stats() {
        await this.openDashboard("stats");
      }
      async performanceDiagnostics() {
        const now = () => window.performance?.now?.() ?? Date.now();
        let started = now();
        const files = getAllIRFiles(this.app, this.settings);
        const scanMs = now() - started;
        started = now();
        const rows = files.map((tfile) => ({ tfile, fm: getFm(this.app, tfile) })).filter((row) => row.fm);
        for (const row of rows) irViewSignature(this.app, row.tfile);
        const metadataMs = now() - started;
        started = now();
        treeCore.buildTreeIndex(rows.filter((row) => ["category", "source", "extract", "card"].includes(row.fm.type)).map((row) => ({ path: row.tfile.path, basename: row.tfile.basename, fm: row.fm, tfile: row.tfile })));
        const treeMs = now() - started;
        this.duePoolCache = null;
        this.cardDueCache.clear();
        started = now();
        const due = await this.buildDuePool({ skipCurrent: false });
        const dueMs = now() - started;
        const cards = rows.filter((row) => row.fm.type === "card").length;
        const result = {
          files: files.length,
          cards,
          due: due.length,
          folder_scan_ms: Math.round(scanMs * 10) / 10,
          metadata_ms: Math.round(metadataMs * 10) / 10,
          tree_index_ms: Math.round(treeMs * 10) / 10,
          due_pool_ms: Math.round(dueMs * 10) / 10
        };
        console.info("[Incremental Reading Toolkit] performance diagnostics", result);
        new Notice2([
          `IR 诊断 · ${result.files} 个文件（${result.cards} 张卡片）`,
          `文件夹扫描 ${result.folder_scan_ms}ms · 元数据 ${result.metadata_ms}ms`,
          `知识树索引 ${result.tree_index_ms}ms · 到期池 ${result.due_pool_ms}ms`,
          "完整细节已写入开发者控制台。"
        ].join("\n"), 15e3);
        return result;
      }
      // ---- Splits ------------------------------------------------------------
      async splitArticle() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("请打开一个来源笔记。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm || fm.type !== "source") {
          new Notice2("这不是来源。");
          return;
        }
        if (fm.source_type !== "article") {
          new Notice2("Articles only — books use Split Book.");
          return;
        }
        if (fm.status === "container") {
          new Notice2("已经拆分。");
          return;
        }
        const content = await this.app.vault.read(active);
        const fmEnd = content.indexOf("\n---", 3);
        const body = fmEnd !== -1 ? content.slice(fmEnd + 4) : content;
        const headings = [...body.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1].trim(), index: m.index }));
        if (headings.length === 0) {
          new Notice2("没有找到 H2 标题。");
          return;
        }
        const confirmed = await askLong(
          this.app,
          "要拆分的标题（删除行即跳过）",
          headings.map((h) => h.title).join("\n")
        );
        if (!confirmed || confirmed.trim() === "") return;
        const titles = new Set(confirmed.split("\n").map((s) => s.trim()).filter(Boolean));
        const selected = headings.filter((h) => titles.has(h.title));
        if (selected.length === 0) return;
        const today = todayDateString(this.settings);
        const parentTitle = active.basename;
        const priority = fm.priority ?? 50;
        const baseInterval = priorityToInterval(priority);
        const folder = active.parent.path;
        const links = [];
        for (let i = 0; i < selected.length; i++) {
          const h = selected[i];
          const next = headings[headings.indexOf(h) + 1];
          const sectionBody = body.slice(h.index, next ? next.index : body.length).trimEnd();
          const interval = baseInterval + i;
          const nextReview = futureDateString(interval, this.settings);
          const noteTitle = slugifyForFolder(`${parentTitle} - ${h.title}`) || `${parentTitle} - Section ${i + 1}`;
          const noteContent = `---
type: source
source_type: article
status: active
parent: ${JSON.stringify(`[[${parentTitle}]]`)}
priority: ${priority}
next_review: ${nextReview}
interval: ${interval}
a_factor: 2.0
review_count: 0
last_reviewed:
date_added: ${today}
tags:
  - incremental-reading
  - ir/source
  - ir/sub-topic
---

${sectionBody}
`;
          const p = `${folder}/${noteTitle}.md`;
          if (!this.app.vault.getAbstractFileByPath(p)) {
            await this.app.vault.create(p, noteContent);
          }
          links.push(`- [[${noteTitle}]]`);
        }
        const subSection = `
## Sub-topics

${links.join("\n")}
`;
        const bodyWithoutOld = content.replace(/\n## Sub-topics[\s\S]*?(?=\n## |$)/, "");
        await this.app.vault.process(active, () => bodyWithoutOld + subSection);
        await this.app.fileManager.processFrontMatter(active, (fmw) => {
          fmw.status = "container";
        });
        new Notice2(`已拆分为 ${selected.length} 个子主题。`);
      }
      async splitBook() {
        const active = this.app.workspace.getActiveFile();
        if (!active || active.extension !== "md") {
          new Notice2("请打开一个书籍来源笔记。");
          return;
        }
        const fm = getFm(this.app, active);
        if (!fm || fm.type !== "source") {
          new Notice2("这不是来源。");
          return;
        }
        if (fm.status === "container") {
          new Notice2("已经是容器。");
          return;
        }
        if (fm.source_type !== "book" && fm.source_type !== "pdf") {
          const cont = await confirmDialog(this.app, "不是书籍/PDF，仍要继续吗？");
          if (!cont) return;
        }
        const toc = await askLong(
          this.app,
          "Paste chapter list (one per line): '起始-结束: 标题' or '起始: 标题'",
          ""
        );
        if (!toc) return;
        const lines = toc.split("\n").map((l) => l.trim()).filter(Boolean);
        if (!lines.length) {
          new Notice2("请至少输入一个章节。");
          return;
        }
        const chapters = [];
        for (const line of lines) {
          const m = line.match(/^(\d+)\s*(?:[-–—]\s*(\d+))?\s*[:：]\s*(.+)$/);
          if (!m) {
            new Notice2(`无法解析：「${line}」`);
            return;
          }
          const title = m[3].trim();
          if (!title) {
            new Notice2(`缺少章节标题：「${line}」`);
            return;
          }
          chapters.push({ start: Number(m[1]), end: m[2] ? Number(m[2]) : null, title });
        }
        for (let i = 0; i < chapters.length; i++) {
          if (chapters[i].end == null) {
            chapters[i].end = i + 1 < chapters.length ? chapters[i + 1].start - 1 : fm.total_pages ?? chapters[i].start;
          }
        }
        const totalPages = Number(fm.total_pages) > 0 ? Number(fm.total_pages) : null;
        for (let i = 0; i < chapters.length; i++) {
          const chapter = chapters[i];
          const previous = chapters[i - 1];
          if (chapter.start < 1 || chapter.end < chapter.start) {
            new Notice2(`「${chapter.title}」的页码范围无效。`);
            return;
          }
          if (previous && chapter.start <= previous.end) {
            new Notice2(`「${chapter.title}」附近的章节范围重叠或顺序不对。`);
            return;
          }
          if (totalPages && chapter.end > totalPages) {
            new Notice2(`「${chapter.title}」超出了来源的 ${totalPages} 页。`);
            return;
          }
        }
        const parentTitle = active.basename;
        const priority = fm.priority ?? 50;
        const baseInterval = priorityToInterval(priority);
        const sourceType = fm.source_type ?? "book";
        const pdfPath = fm.pdf_path ?? fm.pdf_vault_path ?? fm.sioyek_path ?? null;
        const dateAdded = fm.date_added ?? todayDateString(this.settings);
        const folder = this.sourcesFolder();
        await ensureFolder(this.app, folder);
        let created = 0;
        const skipped = [];
        for (let i = 0; i < chapters.length; i++) {
          const ch = chapters[i];
          const num = String(i + 1).padStart(2, "0");
          const safeTitle = slugifyForFolder(ch.title) || `Chapter ${i + 1}`;
          const name = slugifyForFolder(`${parentTitle} - Ch${num} ${safeTitle}`);
          const path = `${folder}/${name}.md`;
          if (this.app.vault.getAbstractFileByPath(path)) {
            skipped.push(name);
            continue;
          }
          const chInterval = baseInterval + i;
          const chNext = futureDateString(chInterval, this.settings);
          const chPages = ch.end != null && ch.start != null ? Math.max(1, ch.end - ch.start + 1) : null;
          const chAFactor = round4(initialAFactor(this.settings, { total_pages: chPages }));
          const content = `---
type: source
source_type: ${sourceType}
status: active
priority: ${priority}
parent: ${JSON.stringify(`[[${parentTitle}]]`)}
chapter_num: ${i + 1}
next_review: ${chNext}
interval: ${chInterval}
a_factor: ${chAFactor}
review_count: 0
last_reviewed:
read_point: ${ch.start}
page_start: ${ch.start}
page_end: ${ch.end}
total_pages: ${totalPages}
pdf_path: ${pdfPath ? JSON.stringify(pdfPath) : ""}
date_added: ${dateAdded}
tags:
  - incremental-reading
  - ir/source
  - ir/chapter
---

# ${ch.title}

> [!tip] Parent
> [[${parentTitle}]] — pages ${ch.start}–${ch.end} (${ch.end - ch.start + 1}p)

## Notes


## Extracts

`;
          await this.app.vault.create(path, content);
          created++;
        }
        await this.app.fileManager.processFrontMatter(active, (fmw) => {
          fmw.status = "container";
          fmw.next_review = null;
        });
        await this.app.vault.process(active, (cur) => {
          if (cur.includes("## Chapters")) return cur;
          const list = chapters.map((ch, i) => {
            const num = String(i + 1).padStart(2, "0");
            const safeTitle = slugifyForFolder(ch.title) || `Chapter ${i + 1}`;
            const name = slugifyForFolder(`${parentTitle} - Ch${num} ${safeTitle}`);
            return `- [[${name}]] (p.${ch.start}–${ch.end})`;
          }).join("\n");
          return cur.trimEnd() + `

## Chapters

${list}
`;
        });
        const skipMsg = skipped.length ? ` | Skipped ${skipped.length} (already exist)` : "";
        new Notice2(`拆分完成：${created} 个章节。${skipMsg}`);
      }
    };
    function formatSeconds(s) {
      const sec = Math.max(0, Math.floor(Number(s) || 0));
      const h = Math.floor(sec / 3600);
      const m = Math.floor(sec % 3600 / 60);
      const ss = sec % 60;
      const pad = (n) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
    }
    function parseTimeInput(input) {
      if (input == null) return null;
      const s = String(input).trim();
      if (s === "") return null;
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      const parts = s.split(":").map((p) => p.trim());
      if (!parts.every((p) => /^\d+$/.test(p))) return null;
      if (parts.length === 2) {
        const [minutes, seconds] = parts.map(Number);
        return seconds < 60 ? minutes * 60 + seconds : null;
      }
      if (parts.length === 3) {
        const [hours, minutes, seconds] = parts.map(Number);
        return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : null;
      }
      return null;
    }
    module2.exports = IncrementalReadingPlugin;
  }
});

// date-core.js
var require_date_core = __commonJS({
  "date-core.js"(exports2, module2) {
    "use strict";
    var SUPPORTED_DATE_FORMATS = ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"];
    function normalizeDateFormat(format) {
      return SUPPORTED_DATE_FORMATS.includes(format) ? format : "DD-MM-YYYY";
    }
    function parseDateExact(value, format = "DD-MM-YYYY") {
      if (!value) return null;
      const normalized = normalizeDateFormat(format);
      const match = String(value).trim().match(/^(\d{2}|\d{4})-(\d{2})-(\d{2}|\d{4})$/);
      if (!match) return null;
      const parts = String(value).trim().split("-").map(Number);
      let day, month, year;
      if (normalized === "DD-MM-YYYY") [day, month, year] = parts;
      else if (normalized === "MM-DD-YYYY") [month, day, year] = parts;
      else [year, month, day] = parts;
      if (year < 1e3 || day < 1 || month < 1 || month > 12) return null;
      const date = new Date(year, month - 1, day);
      date.setHours(0, 0, 0, 0);
      if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
      return date;
    }
    function parseDate(value, preferredFormat = "DD-MM-YYYY") {
      const preferred = normalizeDateFormat(preferredFormat);
      for (const format of [preferred, ...SUPPORTED_DATE_FORMATS.filter((f) => f !== preferred)]) {
        const parsed = parseDateExact(value, format);
        if (parsed) return parsed;
      }
      return null;
    }
    function formatDate(date, format = "DD-MM-YYYY") {
      const normalized = normalizeDateFormat(format);
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = String(date.getFullYear()).padStart(4, "0");
      if (normalized === "MM-DD-YYYY") return `${month}-${day}-${year}`;
      if (normalized === "YYYY-MM-DD") return `${year}-${month}-${day}`;
      return `${day}-${month}-${year}`;
    }
    function reformatDate(value, fromFormat, toFormat) {
      const parsed = parseDateExact(value, fromFormat);
      return parsed ? formatDate(parsed, toFormat) : value;
    }
    module2.exports = {
      SUPPORTED_DATE_FORMATS,
      normalizeDateFormat,
      parseDateExact,
      parseDate,
      formatDate,
      reformatDate
    };
  }
});

// src/data/extract.js
var require_extract = __commonJS({
  "src/data/extract.js"(exports2, module2) {
    "use strict";
    function pad(value) {
      return String(value).padStart(2, "0");
    }
    function timestampTitle(date = /* @__PURE__ */ new Date()) {
      const d = date instanceof Date ? date : new Date(date);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    }
    function parsePdfSelection(text) {
      const source = String(text == null ? "" : text);
      const link = source.match(/\[\[([^\]|#]+)#page=(\d+)([^\]|]*)(?:\|[^\]]*)?\]\]/);
      if (link) {
        return {
          target: link[1].trim(),
          page: Number(link[2]),
          params: link[3] || ""
        };
      }
      const page = source.match(/#page=(\d+)/);
      if (page) return { target: null, page: Number(page[1]), params: "" };
      return { target: null, page: null, params: "" };
    }
    function buildCitation({ sourceTitle, pdfPath = null, page = null, params = "" }) {
      const title = String(sourceTitle || "来源");
      const target = pdfPath ? String(pdfPath) : title;
      const suffix = page ? `#page=${page}${params || ""}` : "";
      const label = page ? `${title} · p.${page}` : title;
      return `[[${target}${suffix}|${label}]]`;
    }
    function cleanExtractBody(body) {
      let text = String(body == null ? "" : body).replace(/\r\n/g, "\n").trim();
      const lines = text.split("\n");
      const firstIndex = lines.findIndex((line) => line.trim());
      if (firstIndex < 0) return "";
      const first = lines[firstIndex].trim();
      if (/^>\s*\[![^\]]+\]/.test(first)) {
        return lines.slice(firstIndex + 1).map((line) => line.replace(/^>\s?/, "")).filter((line) => !/^来源[:：]/.test(line.trim())).join("\n").trim();
      }
      return text;
    }
    function buildExtractContent({
      sourceTitle,
      body,
      priority,
      interval,
      nextReview,
      dateAdded,
      page = null,
      citation
    }) {
      const lines = [
        "---",
        "type: extract",
        `source: ${JSON.stringify(`[[${sourceTitle}]]`)}`,
        "status: pending",
        `priority: ${priority}`,
        `next_review: ${nextReview}`,
        `interval: ${interval}`,
        "a_factor: 2.0",
        "review_count: 0",
        "last_reviewed:",
        `date_added: ${dateAdded}`
      ];
      if (page != null) lines.push(`page: ${page}`);
      lines.push("tags:", "  - incremental-reading", "  - ir/extract", "---", "");
      const text = cleanExtractBody(body);
      const footer = citation ? `

---

**来源**：${citation}` : "";
      lines.splice(lines.indexOf("tags:"), 0, "cssclasses:", "  - memoflow-extract");
      return lines.join("\n") + text + footer + "\n";
    }
    module2.exports = { timestampTitle, parsePdfSelection, buildCitation, buildExtractContent, cleanExtractBody };
  }
});

// src/data/pdf-page.js
var require_pdf_page = __commonJS({
  "src/data/pdf-page.js"(exports2, module2) {
    "use strict";
    function currentPageNumber(view) {
      const viewer = view?.viewer?.child?.pdfViewer || view?.viewer?.pdfViewer || view?.pdfViewer || null;
      const page = Number(viewer?.currentPageNumber || viewer?._location?.pageNumber);
      return page > 0 ? page : null;
    }
    module2.exports = { currentPageNumber };
  }
});

// src/ui/icons.js
var require_icons = __commonJS({
  "src/ui/icons.js"(exports2, module2) {
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
    module2.exports = { ICONS, createIcon };
  }
});

// src/ui/copy.js
var require_copy = __commonJS({
  "src/ui/copy.js"(exports2, module2) {
    "use strict";
    module2.exports = {
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
  "src/ui/components.js"(exports2, module2) {
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
    module2.exports = {
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
  "src/data/text.js"(exports2, module2) {
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
    module2.exports = {
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
  "src/ui/dashboard.js"(exports2, module2) {
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
    function createDashboard(container, { onAction = () => {
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
      function updateHeader(model) {
        dateEl.textContent = model.dateLabel || "";
        demoPill.hidden = !model.demo;
        banner.hidden = !model.demo;
        demoLabel.textContent = model.demo ? copy.menuDemoOff : copy.menuDemoOn;
        if (document.activeElement !== searchInput) {
          searchInput.value = currentState?.query || "";
        }
        root.classList.toggle("mf-mobile", Boolean(model.isMobile || isMobile));
      }
      function update(model, state) {
        currentModel = model;
        currentState = state;
        updateHeader(model);
        renderBody(model, state);
        closeMenu();
      }
      function updateLists(model, state) {
        currentModel = model;
        currentState = state;
        renderBody(model, state);
      }
      function renderBody(model, state) {
        body.textContent = "";
        body.appendChild(renderHero(model, state));
        body.appendChild(renderMain(model, state));
      }
      function renderHero(model, state) {
        const counts = model.counts || {};
        const due = Number(counts.due) || 0;
        const newItems = Number(counts.newItems) || 0;
        const title = due > 0 ? `今天还有 ${due} 项` : newItems > 0 ? "今天没有到期项" : copy.todayDone;
        const subParts = [];
        if (due > 0) subParts.push(copy.estimated(text.formatMinutes(model.estimatedMinutes)));
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
          renderStats(model),
          el("div", { cls: "mf-actions" }, [
            button({ label: copy.start, iconName: "play", variant: "primary", action: "start", className: "mf-btn-lg" }),
            button({ label: copy.openQueue, iconName: "layers", variant: "secondary", action: "queue" }),
            button({ label: copy.cardReview, iconName: "card", variant: "secondary", action: "card-review", title: "只复习问答 / Cloze 卡片" }),
            button({ label: copy.overload, iconName: "calendar", variant: "ghost", action: "overload", title: "摊平逾期主题" })
          ])
        ]);
        const ringWrap = el("div", { cls: "mf-hero-ring" }, [ring(model.progress, { size: 136, stroke: 9 })]);
        const hero = el("section", { cls: "mf-card mf-hero-main" }, [copyCol, ringWrap]);
        const next = renderNext(model, state);
        return el("div", { cls: "mf-hero-grid" }, [hero, next]);
      }
      function renderStats(model) {
        const counts = model.counts || {};
        const cardsDue = Number(counts.cardsDue) || 0;
        const stats = [
          { label: "逾期", value: counts.overdue || 0, tone: counts.overdue ? "danger" : "", title: `${counts.overdue || 0} 项逾期` },
          { label: "今日到期", value: counts.todayDue || 0, tone: counts.todayDue ? "amber" : "", title: `${counts.todayDue || 0} 项今天到期` },
          { label: "新素材", value: counts.newItems || 0, tone: "", title: `${counts.newItems || 0} 条新素材` },
          model.srReady ? { label: "卡片待复习", value: cardsDue, tone: cardsDue ? "amber" : "", title: `共 ${counts.cards || 0} 张卡片` } : { label: "卡片（需 SR）", value: "—", tone: "", title: "安装并启用 Spaced Repetition 后可复习卡片" }
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
      function renderNext(model, state) {
        const item = model.hero && model.hero.primary;
        if (!item) {
          return el("aside", { cls: "mf-card mf-next-card is-empty" }, [
            el("div", { cls: "mf-eyebrow", text: copy.nextUp }),
            el("h2", { cls: "mf-next-title", text: copy.todayDone }),
            el("p", { cls: "mf-next-excerpt", text: "去读一点新东西，或者先看看示例布局。" }),
            el("div", { cls: "mf-next-actions" }, [
              model.demo ? button({ label: copy.openQueue, iconName: "layers", variant: "secondary", action: "queue" }) : button({ label: copy.enterDemo, iconName: "spark", variant: "secondary", action: "demo-toggle" })
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
      function renderMain(model, state) {
        const left = el("div", { cls: "mf-main-col" }, [renderQueue(model, state)]);
        const recent = renderRecent(model, state);
        if (recent) left.appendChild(recent);
        left.appendChild(renderQuickActions());
        const rail = el("aside", { cls: "mf-rail" }, [
          renderRhythm(model),
          renderForecast(model),
          renderTree(model, state),
          renderSources(model)
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
      function filterQueue(queue, state) {
        const query = String(state.query || "").trim().toLowerCase();
        let list = (queue || []).slice();
        if (state.filter === "source" || state.filter === "extract" || state.filter === "card") {
          list = list.filter((item) => item.type === state.filter);
        } else if (state.filter === "overdue") {
          list = list.filter((item) => item.isOverdue);
        }
        if (query) {
          list = list.filter((item) => {
            const haystack = [item.basename, item.sourceTitle, typeLabel(item.type)].join(" ").toLowerCase();
            return haystack.includes(query);
          });
        }
        if (state.sort === "priority") {
          list.sort((a, b) => {
            const ap = a.priority == null ? 999 : a.priority;
            const bp = b.priority == null ? 999 : b.priority;
            return ap - bp || String(a.basename).localeCompare(String(b.basename), "zh-CN");
          });
        } else if (state.sort === "due") {
          list.sort((a, b) => {
            const at = a.dueTime == null ? Infinity : a.dueTime;
            const bt = b.dueTime == null ? Infinity : b.dueTime;
            return at - bt || String(a.basename).localeCompare(String(b.basename), "zh-CN");
          });
        }
        return list;
      }
      function renderQueue(model, state) {
        const queue = model.queue || [];
        const filtered = filterQueue(queue, state);
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
            cls: `mf-chip${state.filter === id ? " is-active" : ""}`,
            attrs: { type: "button" },
            dataset: { action: "filter", filter: id }
          }, [el("span", { text: label }), count ? el("span", { cls: "mf-chip-count", text: String(count) }) : null]));
        }
        const sort = el("select", { cls: "mf-sort", attrs: { "data-role": "sort", "aria-label": "队列排序" } });
        for (const [value, label] of [["urgency", copy.sortUrgency], ["priority", copy.sortPriority], ["due", copy.sortDue]]) {
          const option = el("option", { text: label, attrs: { value } });
          if (state.sort === value) option.selected = true;
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
            actions: model.demo ? [] : [button({ label: copy.enterDemo, variant: "secondary", action: "demo-toggle" })]
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
          if ((state.filter !== "all" || String(state.query || "").trim()) && filtered.length) {
            foot.appendChild(button({
              label: copy.reviewFiltered(filtered.length),
              iconName: "play",
              variant: "secondary",
              action: "review-filtered",
              data: {
                paths: JSON.stringify(filtered.map((item) => item.path).filter(Boolean)),
                label: state.filter === "overdue" ? "逾期筛选" : "队列筛选"
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
      function renderRhythm(model) {
        const panel = el("section", { cls: "mf-card mf-panel mf-rhythm-panel", dataset: { section: "analytics" } });
        panel.appendChild(el("div", { cls: "mf-panel-head" }, [panelHeading(copy.rhythm)]));
        const top = el("div", { cls: "mf-rhythm-top" });
        const streak = Number(model.streak) || 0;
        const reviews = Number(model.reviews14d) || 0;
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
          panel.appendChild(el("div", { cls: "mf-activity" }, [barChart(model.activity || [], { showValues: false, label: "近 14 天复习活动" })]));
        } else {
          panel.appendChild(el("p", { cls: "mf-panel-note", text: copy.rhythmEmpty }));
          panel.appendChild(el("div", { cls: "mf-activity is-muted" }, [barChart(model.activity || [], { showValues: false, label: "近 14 天复习活动" })]));
        }
        return panel;
      }
      function renderForecast(model) {
        const items = model.forecast || [];
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
      function renderTree(model, state) {
        const query = String(state.query || "").trim().toLowerCase();
        const nodes = filterTreeNodes(model.tree || [], query);
        const total = countTreeNodes(model.tree || []);
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
          const isExpanded = forceOpen || (depth === 0 ? !state.collapsed?.has(node.path) : Boolean(state.expanded?.has(node.path)));
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
      function renderSources(model) {
        const sources = model.sources || [];
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
      function renderRecent(model) {
        const recent = model.recent || [];
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
    module2.exports = { createDashboard };
  }
});

// tree-core.js
var require_tree_core = __commonJS({
  "tree-core.js"(exports2, module2) {
    "use strict";
    function linkTargetName(value) {
      if (!value) return null;
      const s = String(value);
      const m = s.match(/\[\[([^\]\|#]+)(?:[#\|][^\]]*)?\]\]/);
      const name = (m ? m[1] : s).trim();
      return name || null;
    }
    function effectiveParent(fm) {
      if (!fm) return null;
      if (fm.tree_root === true) return null;
      return linkTargetName(fm.parent) || linkTargetName(fm.source) || null;
    }
    function siblingComparator(a, b) {
      const an = Number(a.fm && a.fm.tree_order);
      const bn = Number(b.fm && b.fm.tree_order);
      const ao = Number.isFinite(an) ? an : Infinity;
      const bo = Number.isFinite(bn) ? bn : Infinity;
      if (ao !== bo) return ao - bo;
      return a.basename.localeCompare(b.basename);
    }
    function buildTreeIndex(pages) {
      const byName = /* @__PURE__ */ new Map();
      const duplicates = /* @__PURE__ */ new Set();
      for (const p of pages) {
        const key = p.basename.toLowerCase();
        if (byName.has(key)) duplicates.add(key);
        else byName.set(key, p);
      }
      const childrenOf = /* @__PURE__ */ new Map();
      const roots = [];
      for (const p of pages) {
        const parentName = effectiveParent(p.fm);
        const key = parentName ? parentName.toLowerCase() : null;
        if (key && byName.has(key) && !duplicates.has(key)) {
          if (!childrenOf.has(key)) childrenOf.set(key, []);
          childrenOf.get(key).push(p);
        } else {
          roots.push(p);
        }
      }
      const cmp = siblingComparator;
      roots.sort(cmp);
      for (const arr of childrenOf.values()) arr.sort(cmp);
      return { pages: pages.slice(), byName, childrenOf, roots, duplicates };
    }
    function pageByPath(index, path) {
      return index.pages.find((page) => page.path === path) || null;
    }
    function flattenedVisibleChildren(index, page, keep = null, hidden = null, seen = /* @__PURE__ */ new Set()) {
      if (!page || seen.has(page.path)) return [];
      const nextSeen = new Set(seen);
      nextSeen.add(page.path);
      const children = index.childrenOf.get(page.basename.toLowerCase()) || [];
      const visible = [];
      for (const child of children) {
        if (keep && !keep.has(child.path)) continue;
        if (hidden?.has(child.path)) {
          visible.push(...flattenedVisibleChildren(index, child, keep, hidden, nextSeen));
        } else {
          visible.push(child);
        }
      }
      return visible;
    }
    function wouldCreateCycle(index, childName, newParentName) {
      if (!newParentName) return false;
      const child = childName.toLowerCase();
      let cur = newParentName.toLowerCase();
      const seen = /* @__PURE__ */ new Set();
      while (cur) {
        if (cur === child) return true;
        if (seen.has(cur)) return true;
        seen.add(cur);
        const page = index.byName.get(cur);
        if (!page) break;
        const up = effectiveParent(page.fm);
        cur = up ? up.toLowerCase() : null;
      }
      return false;
    }
    function computeReorder(siblings, movedPath, targetIndex) {
      const moved = siblings.find((s) => s.path === movedPath);
      if (!moved) return [];
      const rest = siblings.filter((s) => s.path !== movedPath);
      const idx = Math.max(0, Math.min(targetIndex, rest.length));
      rest.splice(idx, 0, moved);
      const writes = [];
      rest.forEach((s, i) => {
        const want = (i + 1) * 10;
        if (Number(s.tree_order) !== want) writes.push({ path: s.path, tree_order: want });
      });
      return writes;
    }
    module2.exports = { linkTargetName, effectiveParent, siblingComparator, buildTreeIndex, pageByPath, flattenedVisibleChildren, wouldCreateCycle, computeReorder };
  }
});

// src/data/selectors.js
var require_selectors = __commonJS({
  "src/data/selectors.js"(exports2, module2) {
    "use strict";
    var dateCore2 = require_date_core();
    var treeCore = require_tree_core();
    var text = require_text();
    var DONE_STATUSES = /* @__PURE__ */ new Set(["done", "container", "dismissed"]);
    function configuredDateFormat(settings) {
      return dateCore2.normalizeDateFormat(settings && settings.misc && settings.misc.date_format);
    }
    function parseDateValue(value, settings) {
      return dateCore2.parseDate(value, configuredDateFormat(settings));
    }
    function formatDateValue(date, settings) {
      return dateCore2.formatDate(date, configuredDateFormat(settings));
    }
    function todayDate(now = /* @__PURE__ */ new Date()) {
      const d = new Date(now.getTime());
      d.setHours(0, 0, 0, 0);
      return d;
    }
    function isTracked(fm) {
      if (!fm) return false;
      if (!["source", "extract", "card"].includes(fm.type)) return false;
      return !DONE_STATUSES.has(fm.status);
    }
    function isTopic(fm) {
      return Boolean(fm) && (fm.type === "source" || fm.type === "extract");
    }
    function isCard(fm) {
      return Boolean(fm) && fm.type === "card";
    }
    function hasSchedule(fm, settings) {
      return Boolean(fm && parseDateValue(fm.next_review, settings));
    }
    function isDue(fm, today, settings) {
      if (!isTopic(fm)) return false;
      const due = parseDateValue(fm && fm.next_review, settings);
      return Boolean(due && due.getTime() <= today.getTime());
    }
    function isOverdue(fm, today, settings) {
      if (!isTopic(fm)) return false;
      const due = parseDateValue(fm && fm.next_review, settings);
      return Boolean(due && due.getTime() < today.getTime());
    }
    function priorityNumber(fm) {
      const n = Number(fm && fm.priority);
      return Number.isFinite(n) ? n : null;
    }
    function urgency(fm, today, settings) {
      const pri = priorityNumber(fm) == null ? 0 : (101 - priorityNumber(fm)) * 10;
      const due = parseDateValue(fm && fm.next_review, settings);
      if (!due) return pri;
      const diff = text.daysBetween(today, due);
      let value = pri + diff * 2;
      if (diff >= 0) value += 5e3;
      return value;
    }
    function dueMeta(fm, today, settings) {
      if (isCard(fm)) {
        return {
          dueDate: null,
          dueTime: null,
          dueLabel: "卡片",
          dueTitle: "卡片复习由 Spaced Repetition 管理",
          dueTone: "card",
          isOverdue: false
        };
      }
      const dueDate = parseDateValue(fm && fm.next_review, settings);
      if (!dueDate) {
        const isNew = !DONE_STATUSES.has(fm && fm.status);
        return {
          dueDate: null,
          dueTime: null,
          dueLabel: isNew ? "新素材" : "未排期",
          dueTitle: "还没有安排下次复习",
          dueTone: isNew ? "new" : "muted",
          isOverdue: false
        };
      }
      const diff = text.daysBetween(dueDate, today);
      return {
        dueDate,
        dueTime: dueDate.getTime(),
        dueLabel: text.formatRelativeDay(dueDate, today),
        dueTitle: formatDateValue(dueDate, settings),
        dueTone: diff < 0 ? "overdue" : diff === 0 ? "today" : "future",
        isOverdue: diff < 0
      };
    }
    function sourceTitleFor(fm) {
      return treeCore.linkTargetName(fm && fm.source || fm && fm.parent) || "";
    }
    function queueItem(row, today, settings) {
      const fm = row && row.fm;
      if (!isTracked(fm)) return null;
      if (!isTopic(fm) && !isCard(fm)) return null;
      const due = dueMeta(fm, today, settings);
      return {
        path: row.tfile ? row.tfile.path : row.path || "",
        basename: row.tfile ? row.tfile.basename : row.basename || "",
        type: fm.type,
        sourceTitle: sourceTitleFor(fm),
        priority: priorityNumber(fm),
        interval: Number(fm.interval) > 0 ? Number(fm.interval) : null,
        aFactor: Number(fm.a_factor) > 0 ? Number(fm.a_factor) : null,
        status: fm.status || "",
        dueDate: due.dueDate,
        dueTime: due.dueTime,
        dueLabel: due.dueLabel,
        dueTitle: due.dueTitle,
        dueTone: due.dueTone,
        isOverdue: due.isOverdue,
        hasPdf: Boolean(fm.pdf_vault_path || fm.pdf_path),
        urgency: urgency(fm, today, settings),
        tfile: row.tfile || null,
        fm
      };
    }
    function buildQueue(rows, today, settings) {
      const items = [];
      for (const row of rows || []) {
        const item = queueItem(row, today, settings);
        if (item) items.push(item);
      }
      items.sort((a, b) => {
        if (b.urgency !== a.urgency) return b.urgency - a.urgency;
        const ap = a.priority == null ? 101 : a.priority;
        const bp = b.priority == null ? 101 : b.priority;
        if (ap !== bp) return ap - bp;
        return a.basename.localeCompare(b.basename, "zh-CN");
      });
      return items;
    }
    function buildCounts(rows, today, settings) {
      let due = 0;
      let overdue = 0;
      let todayDue = 0;
      let newItems = 0;
      let cards = 0;
      let reviewedToday = 0;
      for (const row of rows || []) {
        const fm = row && row.fm;
        if (!isTracked(fm)) continue;
        if (isCard(fm)) {
          cards++;
        } else if (isTopic(fm)) {
          const scheduled = parseDateValue(fm.next_review, settings);
          if (!scheduled) newItems++;
          else {
            const diff = text.daysBetween(scheduled, today);
            if (diff < 0) {
              due++;
              overdue++;
            } else if (diff === 0) {
              due++;
              todayDue++;
            }
          }
        }
        const reviewed = parseDateValue(fm.last_reviewed, settings);
        if (reviewed && reviewed.getTime() === today.getTime()) reviewedToday++;
      }
      return { due, overdue, todayDue, newItems, cards, reviewedToday };
    }
    function buildForecast(rows, today, settings, days = 7) {
      const counts = new Array(days).fill(0);
      for (const row of rows || []) {
        const fm = row && row.fm;
        if (!isTopic(fm) || !isTracked(fm)) continue;
        const scheduled = parseDateValue(fm.next_review, settings);
        if (!scheduled) continue;
        let offset = text.daysBetween(scheduled, today);
        if (offset < 0) offset = 0;
        if (offset >= days) continue;
        counts[offset]++;
      }
      return counts.map((count, index) => {
        const date = new Date(today.getTime());
        date.setDate(date.getDate() + index);
        const weekday = ["日", "一", "二", "三", "四", "五", "六"][date.getDay()];
        return {
          label: index === 0 ? "今天" : `周${weekday}`,
          shortLabel: index === 0 ? "今天" : `周${weekday}`,
          count,
          isToday: index === 0
        };
      });
    }
    function parseReviewLog(content, settings) {
      const entries = [];
      const lines = String(content || "").split("\n");
      for (const line of lines) {
        const match = line.match(/^\|\s*([^|]+?)\s*\|/);
        if (!match) continue;
        const value = match[1].trim();
        if (!value || value === "Date" || /^-+$/.test(value)) continue;
        const date = parseDateValue(value, settings);
        if (!date) continue;
        entries.push({ date, key: dateCore2.formatDate(date, "YYYY-MM-DD") });
      }
      return entries;
    }
    function buildActivity(entries, today, days = 14) {
      const counts = /* @__PURE__ */ new Map();
      for (const entry of entries || []) {
        counts.set(entry.key, (counts.get(entry.key) || 0) + 1);
      }
      const items = [];
      let total = 0;
      for (let offset = days - 1; offset >= 0; offset--) {
        const date = new Date(today.getTime());
        date.setDate(date.getDate() - offset);
        const key = dateCore2.formatDate(date, "YYYY-MM-DD");
        const count = counts.get(key) || 0;
        total += count;
        items.push({
          key,
          label: offset === 0 ? "今天" : text.formatShortDate(date),
          count,
          isToday: offset === 0
        });
      }
      return { items, total };
    }
    function computeStreak(entries, today) {
      const keys = new Set((entries || []).map((entry) => entry.key));
      if (!keys.size) return 0;
      let cursor = new Date(today.getTime());
      let cursorKey = dateCore2.formatDate(cursor, "YYYY-MM-DD");
      if (!keys.has(cursorKey)) {
        cursor.setDate(cursor.getDate() - 1);
        cursorKey = dateCore2.formatDate(cursor, "YYYY-MM-DD");
        if (!keys.has(cursorKey)) return 0;
      }
      let streak = 0;
      while (keys.has(cursorKey) && streak < 4e3) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
        cursorKey = dateCore2.formatDate(cursor, "YYYY-MM-DD");
      }
      return streak;
    }
    function buildSources(rows, settings) {
      const extractCount = /* @__PURE__ */ new Map();
      for (const row of rows || []) {
        const fm = row && row.fm;
        if (!fm || fm.type !== "extract") continue;
        const source = treeCore.linkTargetName(fm.source || fm.parent);
        if (!source) continue;
        const key = source.toLowerCase();
        extractCount.set(key, (extractCount.get(key) || 0) + 1);
      }
      const sources = [];
      for (const row of rows || []) {
        const fm = row && row.fm;
        if (!fm || fm.type !== "source" || !isTracked(fm)) continue;
        const totalPages = Number(fm.total_pages) > 0 ? Math.floor(Number(fm.total_pages)) : null;
        const readPoint = Number(fm.read_point) > 0 ? Math.floor(Number(fm.read_point)) : totalPages ? 1 : null;
        const progress = totalPages && readPoint ? Math.min(1, Math.max(0, readPoint / totalPages)) : 0;
        const last = parseDateValue(fm.last_reviewed || fm.date_added, settings);
        sources.push({
          path: row.tfile ? row.tfile.path : "",
          basename: row.tfile ? row.tfile.basename : "",
          type: "source",
          readPoint,
          totalPages,
          progress,
          extractCount: extractCount.get(String(row.tfile ? row.tfile.basename : "").toLowerCase()) || 0,
          hasPdf: Boolean(fm.pdf_vault_path || fm.pdf_path),
          lastReviewed: last ? last.getTime() : 0,
          tfile: row.tfile || null,
          fm
        });
      }
      sources.sort((a, b) => {
        if (a.hasPdf !== b.hasPdf) return a.hasPdf ? -1 : 1;
        if (b.lastReviewed !== a.lastReviewed) return b.lastReviewed - a.lastReviewed;
        if (b.progress !== a.progress) return b.progress - a.progress;
        return a.basename.localeCompare(b.basename, "zh-CN");
      });
      return sources.slice(0, 3);
    }
    function buildTree(index, today, settings, limit = 8) {
      if (!index || !Array.isArray(index.roots)) return [];
      const memo = /* @__PURE__ */ new Map();
      const visiting = /* @__PURE__ */ new Set();
      function aggregateDue(page) {
        if (!page || !page.path) return 0;
        if (memo.has(page.path)) return memo.get(page.path);
        if (visiting.has(page.path)) return 0;
        visiting.add(page.path);
        let count = isTopic(page.fm) && isDue(page.fm, today, settings) ? 1 : 0;
        const children = index.childrenOf.get(String(page.basename).toLowerCase()) || [];
        for (const child of children) count += aggregateDue(child);
        visiting.delete(page.path);
        memo.set(page.path, count);
        return count;
      }
      function buildNode(page, depth, seen2) {
        if (!page || seen2.has(page.path)) return null;
        const nextSeen = new Set(seen2);
        nextSeen.add(page.path);
        const allChildren = (index.childrenOf.get(String(page.basename).toLowerCase()) || []).filter((child) => !nextSeen.has(child.path));
        const visibleChildren = [];
        if (depth < 2) {
          for (const child of allChildren.slice(0, limit)) {
            const built = buildNode(child, depth + 1, nextSeen);
            if (built) visibleChildren.push(built);
          }
        }
        return {
          path: page.path,
          basename: page.basename,
          type: page.fm && page.fm.type ? page.fm.type : "source",
          dueCount: aggregateDue(page),
          children: visibleChildren,
          hasChildren: allChildren.length > 0,
          hiddenCount: Math.max(0, allChildren.length - visibleChildren.length),
          tfile: page.tfile || null,
          fm: page.fm || null
        };
      }
      const seen = /* @__PURE__ */ new Set();
      const nodes = [];
      for (const root of index.roots) {
        const node = buildNode(root, 0, seen);
        if (node) nodes.push(node);
      }
      return nodes;
    }
    module2.exports = {
      DONE_STATUSES,
      configuredDateFormat,
      parseDateValue,
      formatDateValue,
      todayDate,
      isTracked,
      isTopic,
      isCard,
      hasSchedule,
      isDue,
      isOverdue,
      priorityNumber,
      urgency,
      dueMeta,
      queueItem,
      buildQueue,
      buildCounts,
      buildForecast,
      parseReviewLog,
      buildActivity,
      computeStreak,
      buildSources,
      buildTree
    };
  }
});

// src/data/demo.js
var require_demo = __commonJS({
  "src/data/demo.js"(exports2, module2) {
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
    function buildDemoModel(todayInput, options = {}) {
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
    function buildEmptyModel(todayInput, options = {}) {
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
    module2.exports = { buildDemoModel, buildEmptyModel };
  }
});

// src/data/model.js
var require_model = __commonJS({
  "src/data/model.js"(exports2, module2) {
    "use strict";
    var dateCore2 = require_date_core();
    var selectors = require_selectors();
    var text = require_text();
    var { buildDemoModel } = require_demo();
    function readText(plugin, file, cache) {
      if (!file || !plugin?.app?.vault?.cachedRead) return Promise.resolve("");
      if (cache.has(file.path)) return cache.get(file.path);
      const promise = plugin.app.vault.cachedRead(file).catch(() => "");
      cache.set(file.path, promise);
      return promise;
    }
    function sortRecentExtracts(rows, today, settings) {
      return (rows || []).filter((row) => row?.fm?.type === "extract" && selectors.isTracked(row.fm)).map((row) => {
        const added = selectors.parseDateValue(row.fm.date_added, settings);
        const reviewed = selectors.parseDateValue(row.fm.last_reviewed, settings);
        return { row, score: (added ? added.getTime() : 0) + (reviewed ? reviewed.getTime() / 1e3 : 0) };
      }).sort((a, b) => b.score - a.score || String(a.row.tfile?.basename || "").localeCompare(String(b.row.tfile?.basename || ""), "zh-CN")).slice(0, 3).map((entry) => entry.row);
    }
    function pageForExtract(fm) {
      for (const key of ["page", "read_point", "page_start"]) {
        const n = Number(fm && fm[key]);
        if (Number.isFinite(n) && n > 0) return Math.floor(n);
      }
      return null;
    }
    async function readReviewLog(plugin) {
      try {
        const path = plugin?.reviewLogPath?.();
        if (!path || !plugin?.app?.vault) return "";
        const file = plugin.app.vault.getAbstractFileByPath(path);
        if (!file || file.extension !== "md") return "";
        const content = await plugin.app.vault.cachedRead(file);
        return String(content || "");
      } catch (error) {
        console.warn("[MemoFlow] could not read review log", error);
        return "";
      }
    }
    async function buildModel({ plugin, isMobile = false, demo = false, today: todayInput = /* @__PURE__ */ new Date() } = {}) {
      const today = selectors.todayDate(todayInput);
      if (demo) return buildDemoModel(today, { isMobile });
      const settings = plugin && plugin.settings || {};
      const rows = (plugin && typeof plugin.getIRRows === "function" ? plugin.getIRRows() : []) || [];
      const counts = selectors.buildCounts(rows, today, settings);
      const srReady = Boolean(plugin && typeof plugin.isSpacedRepetitionReady === "function" && plugin.isSpacedRepetitionReady());
      let cardsDue = 0;
      if (srReady && typeof plugin._cardIsDue === "function") {
        const cardRows = rows.filter((row) => row?.fm?.type === "card" && selectors.isTracked(row.fm)).slice(0, 500);
        const flags = await Promise.all(cardRows.map(async (row) => {
          try {
            return await plugin._cardIsDue(row.tfile, today);
          } catch {
            return false;
          }
        }));
        cardsDue = flags.filter(Boolean).length;
      }
      counts.cardsDue = cardsDue;
      const queue = selectors.buildQueue(rows, today, settings);
      const tree = plugin && typeof plugin.buildTreeIndex === "function" ? selectors.buildTree(plugin.buildTreeIndex(), today, settings) : [];
      const sources = selectors.buildSources(rows, settings);
      const forecast = selectors.buildForecast(rows, today, settings, 7);
      const rawLog = await readReviewLog(plugin);
      const logTail = rawLog ? rawLog.split("\n").slice(-5e3).join("\n") : "";
      const entries = selectors.parseReviewLog(logTail, settings);
      const activityResult = selectors.buildActivity(entries, today, 14);
      const streak = selectors.computeStreak(entries, today);
      const todayKey = dateCore2.formatDate(today, "YYYY-MM-DD");
      const reviewsTodayFromLog = entries.filter((entry) => entry.key === todayKey).length;
      counts.reviewedToday = Math.max(counts.reviewedToday, reviewsTodayFromLog);
      const cache = /* @__PURE__ */ new Map();
      const primary = queue.find((item) => item.type !== "card") || queue[0] || null;
      if (primary && primary.tfile && primary.type !== "card") {
        const content = await readText(plugin, primary.tfile, cache);
        primary.excerpt = text.extractExcerpt(content, 180);
      }
      const recentRows = sortRecentExtracts(rows, today, settings);
      const recent = [];
      for (const row of recentRows) {
        const content = await readText(plugin, row.tfile, cache);
        const sourceName = row.fm && row.fm.source ? String(row.fm.source) : "";
        recent.push({
          path: row.tfile ? row.tfile.path : "",
          basename: row.tfile ? row.tfile.basename : "",
          title: row.tfile ? row.tfile.basename : "",
          sourceTitle: sourceName.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0],
          page: pageForExtract(row.fm),
          text: text.extractExcerpt(content, 150),
          tfile: row.tfile || null,
          fm: row.fm || null
        });
      }
      const totalForProgress = counts.reviewedToday + counts.due;
      const progress = totalForProgress <= 0 ? 1 : Math.min(1, counts.reviewedToday / totalForProgress);
      const estimatedMinutes = counts.due <= 0 ? 0 : Math.max(5, Math.round(counts.due * 1.5 / 5) * 5);
      return {
        today,
        dateLabel: text.formatDateLabel(today),
        counts,
        progress,
        estimatedMinutes,
        hero: { primary },
        queue,
        tree,
        forecast,
        activity: activityResult.items,
        streak,
        reviews14d: activityResult.total,
        sources,
        recent,
        demo: false,
        srReady,
        isMobile
      };
    }
    module2.exports = { buildModel };
  }
});

// src/views/dashboard-view.js
var require_dashboard_view = __commonJS({
  "src/views/dashboard-view.js"(exports2, module2) {
    "use strict";
    var { ItemView, Notice: Notice2, Platform: Platform2 } = require("obsidian");
    var { createDashboard } = require_dashboard();
    var { buildModel } = require_model();
    var { buildDemoModel } = require_demo();
    var copy = require_copy();
    var VIEW_TYPE2 = "memoflow-dashboard";
    var MemoFlowDashboardView2 = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.ui = null;
        this.model = null;
        this.state = {
          query: "",
          filter: "all",
          sort: "urgency",
          demo: false,
          expanded: /* @__PURE__ */ new Set(),
          collapsed: /* @__PURE__ */ new Set()
        };
        this.refreshTimer = null;
        this.midnightTimer = null;
        this.collectionRevision = -1;
        this.needsRender = false;
      }
      getViewType() {
        return VIEW_TYPE2;
      }
      getDisplayText() {
        return "MemoFlow";
      }
      getIcon() {
        return "layout-dashboard";
      }
      async onOpen() {
        this.contentEl.addClass("mf-view-host");
        this.contentEl.style.padding = "0";
        this.ui = createDashboard(this.contentEl, {
          onAction: (action, data) => this.handleAction(action, data),
          isMobile: Platform2.isMobile
        });
        this.ui.setLoading();
        this.collectionRevision = this.plugin.irCollectionRevision;
        await this.refresh({ initial: true });
        this.registerEvent(this.app.metadataCache.on("changed", () => {
          if (this.plugin.irCollectionRevision === this.collectionRevision) return;
          this.collectionRevision = this.plugin.irCollectionRevision;
          this.scheduleRefresh("metadata");
        }));
        for (const event of ["create", "delete", "rename"]) {
          this.registerEvent(this.app.vault.on(event, () => this.scheduleRefresh(`vault-${event}`)));
        }
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
          if (this.needsRender && this.isVisible()) this.scheduleRefresh("visible");
        }));
        this.scheduleMidnightRefresh();
      }
      async onClose() {
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
        if (this.midnightTimer) window.clearTimeout(this.midnightTimer);
        this.refreshTimer = null;
        this.midnightTimer = null;
        if (this.ui) {
          this.ui.destroy();
          this.ui = null;
        }
      }
      isVisible() {
        const el = this.containerEl;
        if (!el || !el.isConnected) return false;
        return el.offsetParent !== null || typeof el.getClientRects === "function" && el.getClientRects().length > 0;
      }
      scheduleRefresh(reason) {
        if (!this.isVisible() && reason !== "initial") {
          this.needsRender = true;
          return;
        }
        this.needsRender = false;
        if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          this.refreshTimer = null;
          this.refresh();
        }, 250);
      }
      scheduleMidnightRefresh() {
        if (this.midnightTimer) window.clearTimeout(this.midnightTimer);
        const now = /* @__PURE__ */ new Date();
        const next = new Date(now.getTime());
        next.setHours(24, 0, 0, 100);
        this.midnightTimer = window.setTimeout(() => {
          this.midnightTimer = null;
          this.refresh();
          this.scheduleMidnightRefresh();
        }, Math.max(1e3, next.getTime() - now.getTime()));
      }
      async refresh({ initial = false } = {}) {
        if (!this.ui) return;
        this.needsRender = false;
        if (initial) this.ui.setLoading();
        try {
          const model = this.state.demo ? buildDemoModel(/* @__PURE__ */ new Date(), { isMobile: Platform2.isMobile }) : await buildModel({ plugin: this.plugin, isMobile: Platform2.isMobile });
          this.model = model;
          this.ui.update(model, this.state);
        } catch (error) {
          console.error("[MemoFlow] failed to build dashboard model", error);
          this.ui.setError(error && error.message ? error.message : "无法读取增量阅读数据。");
        }
      }
      async handleAction(action, data = {}) {
        const isDemo = this.state.demo;
        switch (action) {
          case "search":
            this.state.query = data.query || "";
            if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
            return;
          case "filter":
            this.state.filter = data.filter || "all";
            if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
            return;
          case "sort":
            this.state.sort = data.sort || "urgency";
            if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
            return;
          case "tree-toggle": {
            const depth = Number(data.depth) || 0;
            const set = depth === 0 ? this.state.collapsed : this.state.expanded;
            if (set.has(data.path)) set.delete(data.path);
            else set.add(data.path);
            if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
            return;
          }
          case "clear-filters":
            this.state.query = "";
            this.state.filter = "all";
            this.ui?.setSearchValue("");
            if (this.model && this.ui) this.ui.updateLists(this.model, this.state);
            return;
          case "demo-toggle":
          case "retry":
          case "refresh":
            if (action === "demo-toggle") this.state.demo = !this.state.demo;
            await this.refresh();
            return;
          default:
            break;
        }
        if (isDemo) {
          new Notice2(copy.demoAction);
          return;
        }
        switch (action) {
          case "start":
            if (typeof this.plugin.startLearning === "function") {
              await this.plugin.startLearning();
            } else if (typeof this.plugin.buildSessionQueue === "function") {
              await this.plugin.buildSessionQueue({ openFirst: true });
            }
            return;
          case "queue":
          case "more-queue":
            if (typeof this.plugin._activateQueueView === "function") await this.plugin._activateQueueView();
            return;
          case "review-cards":
            if (typeof this.plugin.reviewCards === "function") this.plugin.reviewCards();
            return;
          case "card-review":
            if (typeof this.plugin.openCardReview === "function") await this.plugin.openCardReview();
            return;
          case "overload":
            if (typeof this.plugin.openOverloadDialog === "function") await this.plugin.openOverloadDialog();
            return;
          case "queue-priority": {
            if (!data.path) return;
            const file = this.app.vault.getAbstractFileByPath(data.path);
            if (!file) {
              new Notice2("找不到这条阅读项。");
              return;
            }
            if (typeof this.plugin.openPriorityDialog === "function") {
              await this.plugin.openPriorityDialog(file, {
                onApplied: () => this.refresh({ initial: false })
              });
            }
            return;
          }
          case "review-filtered": {
            let paths = [];
            try {
              paths = JSON.parse(data.paths || "[]");
            } catch {
              paths = [];
            }
            if (!paths.length) {
              new Notice2("当前筛选没有可复习项目。");
              return;
            }
            if (typeof this.plugin.buildSubsetSession === "function") {
              await this.plugin.buildSubsetSession(paths, { openFirst: true, label: data.label || "筛选" });
            }
            return;
          }
          case "tree":
          case "tree-full":
            if (typeof this.plugin._activateKnowledgeTree === "function") await this.plugin._activateKnowledgeTree();
            return;
          case "guide":
            if (typeof this.plugin.openUserGuide === "function") this.plugin.openUserGuide();
            return;
          case "quick-card":
            if (typeof this.plugin.flashcardClipboard === "function") await this.plugin.flashcardClipboard();
            return;
          case "quick-extract":
            if (typeof this.plugin.createTimestampExtract === "function") {
              await this.plugin.createTimestampExtract({ fromSelection: true });
            } else if (typeof this.plugin.extractSelection === "function") {
              await this.plugin.extractSelection();
            }
            return;
          case "quick-new":
            if (typeof this.plugin.captureOrCreate === "function") await this.plugin.captureOrCreate();
            return;
          case "open":
            await this.openPath(data.path);
            return;
          case "open-note":
            await this.openNote(data.path);
            return;
          case "open-pdf":
            await this.openPdf(data.path);
            return;
          default:
            return;
        }
      }
      findQueueItem(path) {
        if (!this.model || !path) return null;
        const pools = [
          this.model.queue || [],
          this.model.recent || [],
          this.model.sources || []
        ];
        for (const pool of pools) {
          const found = pool.find((item) => item.path === path);
          if (found) return found;
        }
        return null;
      }
      findRow(path) {
        if (!path) return null;
        return (this.plugin.getIRRows() || []).find((row) => row.tfile && row.tfile.path === path) || null;
      }
      async openPath(path) {
        if (!path) return;
        const item = this.findQueueItem(path);
        if (item && item.tfile && item.fm && typeof this.plugin.openLearningItem === "function") {
          await this.plugin.openLearningItem({ tfile: item.tfile, fm: item.fm });
          return;
        }
        const row = this.findRow(path);
        if (row && typeof this.plugin.openLearningItem === "function") {
          await this.plugin.openLearningItem(row);
          return;
        }
        await this.openNote(path);
      }
      async openNote(path) {
        if (!path) return;
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
          new Notice2("找不到对应笔记。");
          return;
        }
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
      async openPdf(path) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!file) {
          new Notice2("找不到对应来源笔记。");
          return;
        }
        if (typeof this.plugin.openPdfForSource === "function") {
          await this.plugin.openPdfForSource(file);
          return;
        }
        await this.openNote(path);
        if (typeof this.plugin.openPdf === "function") await this.plugin.openPdf();
      }
      scrollToSection(section) {
        if (section === "analytics" && this.ui) this.ui.scrollToAnalytics();
      }
    };
    module2.exports = { VIEW_TYPE: VIEW_TYPE2, MemoFlowDashboardView: MemoFlowDashboardView2 };
  }
});

// src/views/review-view.js
var require_review_view = __commonJS({
  "src/views/review-view.js"(exports2, module2) {
    "use strict";
    var { ItemView, Notice: Notice2, MarkdownRenderer, TFile: TFile2 } = require("obsidian");
    var REVIEW_VIEW_TYPE2 = "memoflow-review";
    var sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    function el(tag, { cls = "", text = "", attrs = null } = {}, children = []) {
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
      const source = String(content || "");
      if (!source.startsWith("---")) return source;
      const end = source.indexOf("\n---", 3);
      if (end === -1) return source;
      return source.slice(end + 4).replace(/^\n+/, "");
    }
    var MemoFlowReviewView2 = class extends ItemView {
      constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.mode = "learn";
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
        return REVIEW_VIEW_TYPE2;
      }
      getDisplayText() {
        return "MemoFlow 学习";
      }
      getIcon() {
        return "book";
      }
      async onOpen() {
        this.contentEl.addClass("mf-review-view");
        const config = this.plugin._reviewConfig || null;
        this.plugin._reviewConfig = null;
        if (config) {
          this.mode = config.mode === "cards" ? "cards" : "learn";
          this.paths = Array.isArray(config.paths) ? config.paths.slice() : [];
          this.index = 0;
        } else {
          this.mode = "learn";
          await this.loadSession();
        }
        await this.render();
      }
      async configure({ mode = "learn", paths = [] } = {}) {
        this._closeSR();
        this.mode = mode === "cards" ? "cards" : "learn";
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
        const today = typeof plugin._todayKey === "function" ? plugin._todayKey() : null;
        if (!session || today && session.date !== today || !Array.isArray(session.paths) || !session.paths.length) {
          if (typeof plugin.buildSessionQueue === "function") {
            try {
              await plugin.buildSessionQueue({ openFirst: false });
            } catch (error) {
              console.error("[MemoFlow] review session build failed", error);
            }
          }
          session = plugin.settings?.session;
        }
        this.paths = Array.isArray(session?.paths) ? session.paths.slice() : [];
        this.index = 0;
      }
      _header(panel) {
        const total = Math.max(1, this.paths.length);
        const position = Math.min(this.index + 1, total);
        const head = el("div", { cls: "mf-rv-header" }, [
          el("div", { cls: "mf-rv-brand" }, [
            el("span", { cls: "mf-rv-pill", text: "MemoFlow" }),
            el("strong", { text: this.mode === "cards" ? "卡片复习" : "开始学习" })
          ]),
          el("div", { cls: "mf-rv-progress" }, [
            el("span", { text: `${position} / ${total}` }),
            el("button", {
              cls: "mf-rv-close",
              text: "✕",
              attrs: { type: "button", title: "关闭学习页" }
            })
          ])
        ]);
        head.querySelector(".mf-rv-close")?.addEventListener("click", () => {
          this._closeSR();
          this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE2);
        });
        panel.appendChild(head);
      }
      async render() {
        const token = ++this.token;
        this.busy = false;
        this.answerShown = false;
        const root = this.contentEl;
        root.empty();
        const shell = el("div", { cls: "mf-rv-shell" });
        this._header(shell);
        root.appendChild(shell);
        if (!this.paths.length) {
          shell.appendChild(this._emptyState(
            this.mode === "cards" ? "今天没有到期卡片" : "今天没有可学习项",
            this.mode === "cards" ? "Spaced Repetition 里暂时没有到期卡片。" : "先构建今日学习队列，或回到总览。"
          ));
          return;
        }
        if (this.index >= this.paths.length) {
          shell.appendChild(this._emptyState(
            this.mode === "cards" ? "卡片复习完成" : "今天的学习完成",
            "队列已走到末尾。关闭后可以回到总览查看统计。"
          ));
          return;
        }
        const path = this.paths[this.index];
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile2)) {
          this.index += 1;
          if (this.index >= this.paths.length) return this.render();
          return this.render();
        }
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const type = this.plugin.settings?.session?.types?.[path] || fm?.type;
        if (type === "card") await this._renderCard(shell, file, fm, token);
        else await this._renderTopic(shell, file, fm, token);
      }
      _emptyState(title, text) {
        const wrap = el("div", { cls: "mf-rv-panel mf-rv-empty" }, [
          el("h2", { text: title }),
          el("p", { text })
        ]);
        const actions = el("div", { cls: "mf-rv-actions", style: "justify-content:center" });
        const dashboard = el("button", { cls: "mf-rv-btn is-primary", text: "打开 MemoFlow 总览", attrs: { type: "button" } });
        dashboard.addEventListener("click", () => this.plugin.openMemoFlow());
        actions.appendChild(dashboard);
        if (!this.paths.length && this.mode !== "cards") {
          const build = el("button", { cls: "mf-rv-btn", text: "构建今日队列", attrs: { type: "button" } });
          build.addEventListener("click", async () => {
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
        const button = el("button", {
          cls: `mf-rv-btn${primary ? " is-primary" : ""}${subtle ? " is-subtle" : ""}`,
          text: label,
          attrs: { type: "button" }
        });
        button.addEventListener("click", async () => {
          if (this.busy) return;
          this.busy = true;
          button.disabled = true;
          try {
            await handler();
          } catch (error) {
            console.error("[MemoFlow] unified review action failed", error);
            new Notice2(`复习操作失败：${error.message || "未知错误"}。可返回原笔记后重试。`, 7e3);
            button.disabled = false;
            this.busy = false;
          }
        });
        return button;
      }
      async _renderTopic(shell, file, fm, token) {
        const content = await this.app.vault.cachedRead(file).catch(() => "");
        if (token !== this.token) return;
        const panel = el("div", { cls: "mf-rv-panel" });
        const meta = el("div", { cls: "mf-rv-meta" }, [
          el("span", { cls: "mf-rv-type", text: fm?.type === "source" ? "阅读主题" : "摘录" }),
          el("span", { cls: "mf-rv-pill", text: `P${Number(fm?.priority) || 50}` }),
          fm?.read_point ? el("span", { cls: "mf-rv-pill", text: `p.${fm.read_point}${fm.total_pages ? ` / ${fm.total_pages}` : ""}` }) : null,
          fm?.source ? el("span", { text: `来源：${String(fm.source).replace(/^\[\[|\]\]$/g, "").split("|")[0]}` }) : null
        ]);
        panel.appendChild(meta);
        panel.appendChild(el("h1", { cls: "mf-rv-title", text: file.basename }));
        const contentEl = el("div", { cls: "mf-rv-content" });
        panel.appendChild(contentEl);
        try {
          await MarkdownRenderer.render(this.app, stripFrontmatter(content), contentEl, file.path, this);
        } catch {
          contentEl.textContent = stripFrontmatter(content);
        }
        const actions = el("div", { cls: "mf-rv-actions" });
        const isExtract = fm?.type === "extract";
        actions.appendChild(this._actionButton(isExtract ? "完成并下一项" : "评阅并下一项", async () => {
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
        actions.appendChild(this._actionButton("跳过", async () => {
          this.index += 1;
          await this.render();
        }));
        actions.appendChild(this._actionButton("打开原笔记", async () => {
          this.busy = false;
          await this.app.workspace.getLeaf(false).openFile(file);
        }, { subtle: true }));
        panel.appendChild(actions);
        shell.appendChild(panel);
      }
      async _renderCard(shell, file, fm, token) {
        const panel = el("div", { cls: "mf-rv-panel" });
        panel.appendChild(el("div", { cls: "mf-rv-meta" }, [
          el("span", { cls: "mf-rv-type", text: "问答卡片" }),
          el("span", { cls: "mf-rv-pill", text: fm?.source ? String(fm.source).replace(/^\[\[|\]\]$/g, "").split("|")[0] : "卡片" })
        ]));
        const stage = el("div", { cls: "mf-rv-card-stage" }, [
          el("div", { cls: "mf-rv-card-kicker", text: "先回忆，再显示答案" })
        ]);
        panel.appendChild(stage);
        shell.appendChild(panel);
        const status = el("p", { cls: "mf-rv-note", text: "正在准备卡片…" });
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
          stage.appendChild(el("p", { cls: "mf-rv-note", text: "这个卡片没有可用的 Spaced Repetition 会话。仍可打开原笔记，或用「复习此卡」在 SR 中评分。" }));
          const actions2 = el("div", { cls: "mf-rv-actions" });
          actions2.appendChild(this._actionButton("跳过", async () => {
            this.index += 1;
            await this.render();
          }));
          actions2.appendChild(this._actionButton("打开原笔记", async () => {
            this.busy = false;
            await this.app.workspace.getLeaf(false).openFile(file);
          }, { subtle: true }));
          panel.appendChild(actions2);
          return;
        }
        status.remove();
        stage.empty?.();
        stage.appendChild(el("div", { cls: "mf-rv-card-kicker", text: "先回忆，再显示答案" }));
        const front = el("div", { cls: "mf-rv-card-face" });
        const back = el("div", { cls: "mf-rv-card-face is-answer" });
        back.hidden = true;
        stage.append(front, back);
        await this._renderCardFace(front, card.front);
        if (token !== this.token) return;
        const actions = el("div", { cls: "mf-rv-actions" });
        const reveal = this._actionButton("显示答案", async () => {
          reveal.remove();
          await this._renderCardFace(back, card.back);
          back.hidden = false;
          this.answerShown = true;
          stage.appendChild(this._gradeRow(file, card));
          this.busy = false;
        }, { primary: true });
        actions.appendChild(reveal);
        actions.appendChild(this._actionButton("跳过", async () => {
          this._closeSR();
          this.index += 1;
          await this.render();
        }, { subtle: true }));
        actions.appendChild(this._actionButton("打开原笔记", async () => {
          this.busy = false;
          await this.app.workspace.getLeaf(false).openFile(file);
        }, { subtle: true }));
        panel.appendChild(actions);
      }
      _gradeRow(file, card) {
        const labels = [
          ["记得", "较熟", 1],
          ["较难", "吃力", 2],
          ["重来", "忘了", 3],
          ["简单", "很熟", 0]
        ];
        const row = el("div", { cls: "mf-rv-grade" });
        for (const [label, hint, response] of labels) {
          const button = el("button", { attrs: { type: "button" } }, [
            el("strong", { text: label }),
            el("span", { text: hint })
          ]);
          button.addEventListener("click", async () => {
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
          await MarkdownRenderer.render(this.app, String(markdown || ""), target, "", this);
        } catch {
          target.textContent = String(markdown || "");
        }
      }
      async _openSRForCard(file) {
        this._closeSR();
        const sr = this.app["plugins"]?.plugins?.["obsidian-spaced-repetition"];
        if (!sr || typeof this.plugin.reviewCardsInNote !== "function") return null;
        if (sr.manifest?.version && sr.manifest.version !== "1.15.4") {
          console.warn("[MemoFlow] Spaced Repetition version is not the tested 1.15.4:", sr.manifest.version);
        }
        const noteLeaf = this.app.workspace.getLeaf("tab");
        this.srNoteLeaf = noteLeaf;
        try {
          await noteLeaf.openFile(file);
          this.app.workspace.setActiveLeaf(noteLeaf, { focus: true });
          await this.plugin.reviewCardsInNote(file);
        } catch (error) {
          console.error("[MemoFlow] Spaced Repetition review could not start", error);
          try {
            noteLeaf.detach();
          } catch (detachError) {
          }
          this.srNoteLeaf = null;
          this._closeSR();
          new Notice2("Spaced Repetition 未能启动，已退回卡片笔记。可重载 Obsidian 后再试。", 6e3);
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
        const modal = [...document.querySelectorAll(".modal-container")].find((node) => node.querySelector(".sr-container"));
        if (modal) {
          modal.classList.add("mf-sr-hidden");
          modal.style.display = "none";
          this.srModal = modal;
        }
        this.srContent = contentManager;
        this.srCard = card;
        if (this.srNoteLeaf) {
          try {
            this.srNoteLeaf.detach();
          } catch (error) {
          }
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
          console.error("[MemoFlow] unified card grade failed", error);
          new Notice2("卡片评分失败，已回退到原笔记；可点「复习此卡」。");
          this._closeSR();
          this.busy = false;
          await this.render();
        }
      }
      _closeSR() {
        try {
          this.srContent?.close?.();
        } catch (error) {
        }
        if (this.srModal) {
          this.srModal.remove();
          this.srModal = null;
        }
        document.querySelectorAll(".modal-container.mf-sr-hidden").forEach((node) => node.remove());
        this.srContent = null;
        this.srCard = null;
        if (this.srNoteLeaf) {
          try {
            this.srNoteLeaf.detach();
          } catch (error) {
          }
          this.srNoteLeaf = null;
        }
        if (this.leaf && this.app.workspace.activeLeaf !== this.leaf) {
          this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
        }
      }
    };
    module2.exports = { REVIEW_VIEW_TYPE: REVIEW_VIEW_TYPE2, MemoFlowReviewView: MemoFlowReviewView2 };
  }
});

// src/views/settings-tab.js
var require_settings_tab = __commonJS({
  "src/views/settings-tab.js"(exports2, module2) {
    "use strict";
    var { PluginSettingTab, Setting, Notice: Notice2 } = require("obsidian");
    var dateCore2 = require_date_core();
    var PATH_DEFAULTS = {
      sources: "Sources/Incremental Reading/Sources",
      extracts: "Sources/Incremental Reading/Extracts",
      cards: "Sources/Incremental Reading/Cards",
      attachments: "Sources/Incremental Reading/Attachments",
      categories: "Sources/Incremental Reading/Categories",
      dashboard: "Sources/Incremental Reading/Incremental-Reading-Dashboard.md",
      review_log: "Sources/Incremental Reading/Review Log.md"
    };
    var DEFAULT_HIGHLIGHT = "#ffd166";
    var DATE_LABELS = {
      "DD-MM-YYYY": "DD-MM-YYYY（日-月-年）",
      "MM-DD-YYYY": "MM-DD-YYYY（月-日-年）",
      "YYYY-MM-DD": "YYYY-MM-DD（年-月-日）"
    };
    function configuredDateFormat(settings) {
      return dateCore2.normalizeDateFormat(settings?.misc?.date_format);
    }
    function normalizeColor(value) {
      const candidate = String(value || "").trim();
      if (/^#[0-9a-f]{6}$/i.test(candidate)) return candidate.toLowerCase();
      if (/^#[0-9a-f]{3}$/i.test(candidate)) {
        return `#${candidate.slice(1).split("").map((char) => char + char).join("")}`.toLowerCase();
      }
      return DEFAULT_HIGHLIGHT;
    }
    var MemoFlowSettingTab2 = class extends PluginSettingTab {
      constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
      }
      display() {
        const { containerEl } = this;
        containerEl.empty();
        this._about(containerEl);
        this._scheduling(containerEl);
        this._queue(containerEl);
        this._inlineCards(containerEl);
        this._spacedRepetition(containerEl);
        this._knowledgeTree(containerEl);
        this._paths(containerEl);
        this._misc(containerEl);
      }
      _about(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName(`MemoFlow ${this.plugin.manifest.version}`).setDesc("个人自用版 · 作者：三斤的多多 / DeepSeek。基于 Incremental Reading Toolkit 1.1.8（MIT）构建，保留上游阅读引擎。").setHeading();
        new Setting(section).setName("使用指南").setDesc("在 Obsidian 内打开快捷上手、建议快捷键、每日流程与故障排查。").addButton((button) => button.setButtonText("打开使用指南").setCta().onClick(() => this.plugin.openUserGuide()));
        const ready = this.plugin.isSpacedRepetitionReady();
        new Setting(section).setName("环境状态").setDesc(ready ? "Spaced Repetition 已就绪，可以复习卡片。" : "尚未检测到 Spaced Repetition；复习卡片前请先安装并启用它。").addButton((button) => button.setButtonText("运行环境检查").onClick(() => this._runSetupCheck()));
      }
      _numberSetting(section, name, description, target, key, { min, max, step = "any" } = {}) {
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName(name).setDesc(description).addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.step = String(step);
          if (min != null) text.inputEl.min = String(min);
          if (max != null) text.inputEl.max = String(max);
          text.setValue(String(target[key])).onChange((value) => {
            const number = Number(value);
            const valid = Number.isFinite(number) && (min == null || number >= min) && (max == null || number <= max);
            text.inputEl.toggleClass("is-invalid", !valid);
            if (!valid) return;
            target[key] = number;
            save();
          });
        });
      }
      _scheduling(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("阅读排程").setHeading();
        const settings = this.plugin.settings.scheduling;
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName("进度感知 A-Factor").setDesc("根据剩余页数或视频时长调整间隔。书籍、PDF、视频建议开启。").addToggle((toggle) => toggle.setValue(settings.progress_aware).onChange((value) => {
          settings.progress_aware = value;
          save();
        }));
        new Setting(section).setName("停滞保护").setDesc("当页码、时间戳或 Markdown 阅读点没有前进时，不再扩大间隔。").addToggle((toggle) => toggle.setValue(settings.stall_guard).onChange((value) => {
          settings.stall_guard = value;
          save();
        }));
        this._numberSetting(section, "A-Factor 最小值", "最小的间隔增长倍率；略高于 1 可以让材料保持较高出现频率。", settings, "a_factor_min", { min: 1.01, max: 10, step: 0.01 });
        this._numberSetting(section, "A-Factor 最大值", "接近读完的材料允许的最大间隔增长倍率。", settings, "a_factor_max", { min: 1.01, max: 10, step: 0.01 });
        new Setting(section).setName("复习节奏调整").setHeading();
        this._numberSetting(section, "保持倍率", "选择“保持”时应用的倍率；设为 1 表示维持当前 A-Factor。", settings, "quality_hold", { min: 0.1, max: 3, step: 0.01 });
        this._numberSetting(section, "提前复习倍率", "选择“提前”时应用的倍率；小于 1 会缩短后续增长。", settings, "quality_speed_up", { min: 0.1, max: 3, step: 0.01 });
        this._numberSetting(section, "推后复习倍率", "选择“推后”时应用的倍率；大于 1 会拉长后续增长。", settings, "quality_slow_down", { min: 0.1, max: 3, step: 0.01 });
        new Setting(section).setName("初始间隔模型").setHeading();
        this._numberSetting(section, "基础 A-Factor", "考虑来源长度之前使用的起始倍率。", settings, "initial_af_base", { min: 1.01, max: 10, step: 0.01 });
        this._numberSetting(section, "长度敏感度", "来源越长，初始 A-Factor 越小的程度。", settings, "initial_af_slope", { min: 0, max: 3, step: 0.01 });
        this._numberSetting(section, "长度基准", "视为“中性来源大小”的页数或媒体分钟数。", settings, "initial_af_units_divisor", { min: 1, max: 1e4, step: 1 });
        this._numberSetting(section, "摘录加成", "创建摘录后，对父来源 A-Factor 应用的倍率。", settings, "extract_bump", { min: 0.1, max: 3, step: 0.01 });
        new Setting(section).setName("过载与 Mercy").setHeading();
        const misc = this.plugin.settings.misc;
        if (misc.overload_threshold == null) misc.overload_threshold = 10;
        new Setting(section).setName("自动过载（Mercy）").setDesc("开始今日学习前，如果逾期阅读主题超过阈值，自动按 7 天摊平。默认关闭。").addToggle((toggle) => toggle.setValue(Boolean(misc.auto_overload)).onChange((value) => {
          misc.auto_overload = value;
          save();
        }));
        this._numberSetting(section, "自动过载阈值", "逾期主题超过这个数量时触发自动 Mercy。", misc, "overload_threshold", { min: 1, max: 1e3, step: 1 });
      }
      _queue(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("队列").setHeading();
        const settings = this.plugin.settings.queue;
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName("启用阅读队列侧栏").setDesc("允许阅读队列在侧栏打开，并随笔记变化刷新。").addToggle((toggle) => toggle.setValue(settings.sidebar_enabled).onChange((value) => {
          settings.sidebar_enabled = value;
          save();
        }));
        new Setting(section).setName("默认标签过滤").setDesc("侧栏的初始过滤条件。留空表示显示全部已排期主题。").addText((text) => text.setValue(settings.default_tag_filter).onChange((value) => {
          settings.default_tag_filter = value;
          save();
        }));
        new Setting(section).setName("补充列表排序").setDesc("控制逾期、新素材和未排期分区；今日会话仍保持自己的排期顺序。").addDropdown((dropdown) => {
          dropdown.addOption("urgency", "紧急度").addOption("priority", "优先级").addOption("due_date", "到期日").setValue(settings.sort_key).onChange((value) => {
            settings.sort_key = value;
            save();
          });
        });
        new Setting(section).setName("卡片与阅读主题混合").setDesc("在每日学习流中交替出现卡片与阅读主题；卡片评分仍由 Spaced Repetition 负责。").addToggle((toggle) => toggle.setValue(settings.mix_cards !== false).onChange((value) => {
          settings.mix_cards = value;
          save();
        }));
      }
      _inlineCards(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("内联卡片导出").setHeading();
        const settings = this.plugin.settings.inline_cards;
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName("启用").setDesc("允许“导出内联卡片”识别问答、填空和高亮文本形式。").addToggle((toggle) => toggle.setValue(settings.enabled).onChange((value) => {
          settings.enabled = value;
          save();
        }));
        new Setting(section).setName("Q::A 正则").setDesc("用于单行 Q::问题::A::答案 卡片的高级匹配规则。").addText((text) => text.setValue(settings.qa_regex).onChange((value) => {
          settings.qa_regex = value;
          save();
        }));
        new Setting(section).setName("填空正则").setDesc("用于 {{c1::答案::提示}} 卡片的高级匹配规则。").addText((text) => text.setValue(settings.cloze_regex).onChange((value) => {
          settings.cloze_regex = value;
          save();
        }));
      }
      _spacedRepetition(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("间隔重复（Spaced Repetition）").setHeading();
        const settings = this.plugin.settings.spaced_repetition;
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName("依赖状态").setDesc(this.plugin.isSpacedRepetitionReady() ? "已就绪；卡片复习命令会打开 Spaced Repetition。" : "未就绪；请安装并启用 Spaced Repetition 社区插件。");
        new Setting(section).setName("卡片 deck 标签").setDesc("与 Spaced Repetition 中配置的 flashcard 标签保持一致；不要包含开头的 #。").addText((text) => text.setValue(settings.flashcardTag).onChange((value) => {
          settings.flashcardTag = value.replace(/^#/, "").trim() || "flashcards/incremental-reading";
          save();
        }));
        new Setting(section).setName("多行卡片分隔符").setDesc("与 Spaced Repetition 的多行卡片分隔符一致。").addText((text) => text.setValue(settings.multilineCardSeparator).onChange((value) => {
          settings.multilineCardSeparator = value.trim() || "?";
          save();
        }));
        new Setting(section).setName("双向卡片分隔符").setDesc("与 Spaced Repetition 的多行双向分隔符一致。").addText((text) => text.setValue(settings.multilineReversedCardSeparator).onChange((value) => {
          settings.multilineReversedCardSeparator = value.trim() || "??";
          save();
        }));
      }
      _knowledgeTree(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("知识树").setHeading();
        this._numberSetting(
          section,
          "大分支提醒阈值",
          "当分类子项数量超过此值时，在知识树中高亮提醒。",
          this.plugin.settings.tree,
          "child_warn_threshold",
          { min: 1, max: 1e5, step: 1 }
        );
        new Setting(section).setName("显示已完成内容").setDesc("在知识树中显示已完成和已移出队列的主题。").addToggle((toggle) => toggle.setValue(this.plugin.settings.tree.show_completed).onChange((value) => {
          this.plugin.settings.tree.show_completed = value;
          this.plugin.saveSettings();
          this.plugin._refreshTreeViews();
        }));
      }
      _paths(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("路径").setHeading();
        const settings = this.plugin.settings.paths;
        const save = () => {
          this.plugin._invalidateIRCollection(true);
          return this.plugin.saveSettings();
        };
        const paths = [
          ["sources", "来源文件夹", "来源笔记与本地视频文件。"],
          ["extracts", "摘录文件夹", "作为独立阅读主题排期的段落。"],
          ["cards", "卡片文件夹", "供 Spaced Repetition 使用的 Markdown 卡片。"],
          ["attachments", "附件文件夹", "剪贴板图片与视觉学习素材。"],
          ["categories", "分类文件夹", "知识树分类笔记。"],
          ["dashboard", "总览笔记", "可选的会话快照与总览笔记路径。"],
          ["review_log", "复习日志", "记录已完成主题复习的 Markdown 表格。"]
        ];
        for (const [key, name, description] of paths) {
          new Setting(section).setName(name).setDesc(description).addText((text) => text.setPlaceholder(PATH_DEFAULTS[key]).setValue(settings[key] || PATH_DEFAULTS[key]).onChange((value) => {
            settings[key] = value.trim() || PATH_DEFAULTS[key];
            save();
          })).addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip(`重置${name}`).onClick(async () => {
            settings[key] = PATH_DEFAULTS[key];
            await save();
            this.display();
          }));
        }
      }
      _misc(root) {
        const section = root.createDiv({ cls: "ir-settings-section" });
        new Setting(section).setName("通用").setHeading();
        const settings = this.plugin.settings.misc;
        const save = () => this.plugin.saveSettings();
        new Setting(section).setName("日期格式").setDesc("用于排期字段、提示、检查点和复习日志。").addDropdown((dropdown) => {
          for (const format of dateCore2.SUPPORTED_DATE_FORMATS) {
            dropdown.addOption(format, DATE_LABELS[format] || format);
          }
          dropdown.setValue(configuredDateFormat(this.plugin.settings)).onChange(async (value) => {
            const previous = configuredDateFormat(this.plugin.settings);
            if (previous === value) return;
            try {
              const changed = await this.plugin.migrateDateFormat(previous, value);
              settings.date_format = value;
              await save();
              new Notice2(`日期格式已切换为 ${value}；迁移了 ${changed} 个已存日期。`);
            } catch (error) {
              new Notice2(`日期迁移失败：${error.message}`);
            }
          });
        });
        new Setting(section).setName("摘录高亮颜色").setDesc("编辑视图与阅读视图中摘录片段和摘录笔记的强调色。").addColorPicker((picker) => picker.setValue(normalizeColor(settings.extract_highlight_color)).onChange(async (value) => {
          settings.extract_highlight_color = normalizeColor(value);
          await save();
          this.plugin._refreshExcerptViews();
        })).addExtraButton((button) => button.setIcon("rotate-ccw").setTooltip("重置摘录高亮颜色").onClick(async () => {
          settings.extract_highlight_color = DEFAULT_HIGHLIGHT;
          await save();
          this.plugin._refreshExcerptViews();
          this.display();
        }));
        new Setting(section).setName("诊断").setHeading();
        new Setting(section).setName("调试日志").setDesc("把额外细节写入开发者控制台；日常使用请保持关闭。").addToggle((toggle) => toggle.setValue(settings.debug).onChange((value) => {
          settings.debug = value;
          save();
        }));
      }
      _runSetupCheck() {
        const plugin = this.plugin;
        const issues = [];
        const notes = [];
        if (!plugin.isSpacedRepetitionReady()) {
          issues.push("未检测到可用的 Spaced Repetition 插件；请先安装并启用。");
        } else {
          notes.push("Spaced Repetition 已就绪。");
        }
        const folders = [
          ["sources", "来源文件夹"],
          ["extracts", "摘录文件夹"],
          ["cards", "卡片文件夹"],
          ["categories", "分类文件夹"]
        ];
        for (const [key, label] of folders) {
          const path = plugin.settings.paths?.[key];
          if (!path || !plugin.app.vault.getAbstractFileByPath(path)) {
            issues.push(`${label}不存在：${path || "(未设置)"}`);
          }
        }
        if (!dateCore2.SUPPORTED_DATE_FORMATS.includes(configuredDateFormat(plugin.settings))) {
          issues.push("日期格式不在支持范围内。");
        }
        for (const [label, source] of [
          ["Q::A 正则", plugin.settings.inline_cards?.qa_regex],
          ["填空正则", plugin.settings.inline_cards?.cloze_regex]
        ]) {
          try {
            new RegExp(String(source || ""));
          } catch (error) {
            issues.push(`${label}无法编译：${error.message}`);
          }
        }
        const lines = ["MemoFlow 环境检查"];
        if (issues.length === 0) {
          lines.push("✅ 一切就绪。");
          lines.push(...notes);
        } else {
          lines.push("⚠️ 需要处理：");
          for (const issue of issues) lines.push(`- ${issue}`);
        }
        new Notice2(lines.join("\n"), 1e4);
      }
    };
    module2.exports = { MemoFlowSettingTab: MemoFlowSettingTab2, PATH_DEFAULTS };
  }
});

// src/data/card.js
var require_card = __commonJS({
  "src/data/card.js"(exports2, module2) {
    "use strict";
    var text = require_text();
    function normalizeCardInput({ format = "basic", question = "", answer = "" } = {}) {
      const normalizedFormat = format === "cloze" || format === "reverse" ? format : "basic";
      return {
        format: normalizedFormat,
        question: String(question == null ? "" : question).replace(/\r\n/g, "\n").trim(),
        answer: String(answer == null ? "" : answer).replace(/\r\n/g, "\n").trim()
      };
    }
    function convertAnkiCloze(question) {
      return String(question || "").replace(
        /\{\{c(\d+)::([\s\S]*?)(?:::(.*?))?\}\}/g,
        (_match, seq, answer, hint) => `==${seq};;${String(answer).trim()}${hint ? `;;${String(hint).trim()}` : ""}==`
      );
    }
    function hasClozeMarker(question) {
      return /==[^=\n]+==/.test(convertAnkiCloze(question));
    }
    function countClozeCards(question) {
      const normalized = convertAnkiCloze(question);
      const sequences = /* @__PURE__ */ new Set();
      for (const match of normalized.matchAll(/==(\d+);;/g)) sequences.add(Number(match[1]));
      if (!sequences.size && /==[^=\n]+==/.test(normalized)) return 1;
      return sequences.size;
    }
    function validateCardInput(input) {
      const value = normalizeCardInput(input);
      if (!value.question) {
        return { ok: false, message: "问题 / 正文不能为空。", value };
      }
      if (value.format === "cloze") {
        value.question = convertAnkiCloze(value.question);
        if (!hasClozeMarker(value.question)) {
          return { ok: false, message: "Cloze 卡片需要用 {{c1::答案}} 或 ==关键词== 标出至少一处填空。", value };
        }
        value.answer = "";
        return { ok: true, value };
      }
      if (!value.answer) {
        return { ok: false, message: "基础问答/双向卡片需要填写答案。", value };
      }
      return { ok: true, value };
    }
    function buildCardPrefill(body, selection = "", maxLength = 400) {
      const selected = String(selection == null ? "" : selection).trim();
      if (selected) return selected.slice(0, Math.max(20, Number(maxLength) || 400)).trim();
      const stripped = text.stripMarkdown(body);
      return stripped.slice(0, Math.max(20, Number(maxLength) || 400)).trim();
    }
    module2.exports = { normalizeCardInput, validateCardInput, buildCardPrefill, hasClozeMarker, convertAnkiCloze, countClozeCards };
  }
});

// src/views/card-modal.js
var require_card_modal = __commonJS({
  "src/views/card-modal.js"(exports2, module2) {
    "use strict";
    var { Modal, Setting, Notice: Notice2 } = require("obsidian");
    var cardCore2 = require_card();
    var MemoFlowCardModal2 = class extends Modal {
      constructor(app, { parentFile, prefill, onSubmit } = {}) {
        super(app);
        this.parentFile = parentFile;
        this.prefill = prefill || { question: "", answer: "" };
        this.onSubmit = onSubmit;
        this.format = "basic";
        this.answerWrap = null;
        this.answerEl = null;
        this.hintEl = null;
        this.questionEl = null;
        this.clozeTools = null;
        this.clozeCountEl = null;
        this.submitted = false;
      }
      onOpen() {
        this.titleEl.setText("从当前摘录制卡");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("mf-card-modal");
        contentEl.createDiv({
          cls: "mf-card-modal-info",
          text: `父笔记：${this.parentFile?.basename || "未命名"} · 卡片会进入 Spaced Repetition 的复习队列`
        });
        new Setting(contentEl).setName("卡片类型").setDesc("基础问答：问题 / 答案；双向问答：正反两张；Cloze：用 {{c1::答案}}、{{c2::答案::提示}} 或 ==关键词== 标出挖空。").addDropdown((dropdown) => dropdown.addOption("basic", "基础问答").addOption("reverse", "双向问答").addOption("cloze", "Cloze 填空").setValue("basic").onChange((value) => {
          this.format = value;
          this._syncFormat();
        }));
        const questionWrap = contentEl.createDiv({ cls: "mf-card-modal-row" });
        questionWrap.createDiv({ cls: "mf-card-modal-label", text: "问题 / 正文" });
        this.questionEl = questionWrap.createEl("textarea", {
          cls: "mf-card-textarea",
          attr: { rows: "5", placeholder: "写下问题；Cloze 模式可写 {{c1::答案}} / {{c2::答案::提示}}，或 ==关键词==。" }
        });
        this.questionEl.value = this.prefill.question || "";
        this.answerWrap = contentEl.createDiv({ cls: "mf-card-modal-row" });
        this.answerWrap.createDiv({ cls: "mf-card-modal-label", text: "答案" });
        this.answerEl = this.answerWrap.createEl("textarea", {
          cls: "mf-card-textarea",
          attr: { rows: "4", placeholder: "写下答案；基础问答必填。" }
        });
        this.answerEl.value = this.prefill.answer || "";
        this.clozeTools = contentEl.createDiv({ cls: "mf-cloze-tools" });
        this.clozeTools.createSpan({ cls: "mf-card-modal-label", text: "插入挖空：" });
        for (const number of [1, 2, 3]) {
          const button = this.clozeTools.createEl("button", {
            text: `C${number}`,
            attr: { type: "button", title: `把选中文字包成 C${number} 挖空` }
          });
          button.addEventListener("click", () => this._insertCloze(number));
        }
        this.clozeCountEl = this.clozeTools.createSpan({ cls: "mf-cloze-count" });
        this.hintEl = contentEl.createDiv({
          cls: "mf-card-modal-hint",
          text: "Cloze：用 {{c1::答案}} 标记挖空；C1/C2/C3 会生成不同卡片。双向问答会生成正反两张卡。"
        });
        this.questionEl.addEventListener("input", () => this._updateClozeTools());
        const more = contentEl.createDiv({ cls: "mf-card-more-types" });
        more.createDiv({
          cls: "mf-card-modal-label",
          text: "更多卡片类型（沿用上游流程）"
        });
        const moreRow = more.createDiv({ cls: "mf-card-more-row" });
        const addUpstream = (label, method, title) => {
          const button = moreRow.createEl("button", { text: label, attr: { type: "button", title } });
          button.addEventListener("click", () => {
            const plugin = this.app["plugins"]?.plugins?.["memoflow"];
            if (!plugin || typeof plugin[method] !== "function") return;
            this.close();
            window.setTimeout(() => plugin[method](), 0);
          });
        };
        addUpstream("图片卡", "flashcardImageName", "从剪贴板/当前来源图片制卡");
        addUpstream("图片遮挡", "occlusionCreate", "为图片创建遮挡卡");
        more.createDiv({
          cls: "mf-card-modal-hint",
          text: "图片卡和遮挡卡使用上游的图片选择/遮挡编辑器；它们仍会进入同一个 SR deck。"
        });
        const actions = contentEl.createDiv({ cls: "mf-card-modal-actions" });
        const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
        cancel.addEventListener("click", () => this.close());
        const create = actions.createEl("button", { text: "创建卡片", cls: "mod-cta", attr: { type: "button" } });
        create.addEventListener("click", () => this._submit());
        this._syncFormat();
        window.setTimeout(() => {
          this.questionEl?.focus();
          this.questionEl?.setSelectionRange(this.questionEl.value.length, this.questionEl.value.length);
        }, 20);
      }
      _syncFormat() {
        const cloze = this.format === "cloze";
        if (this.answerWrap) this.answerWrap.style.display = cloze ? "none" : "";
        if (this.answerEl) this.answerEl.disabled = cloze;
        if (this.clozeTools) this.clozeTools.style.display = cloze ? "" : "none";
        if (this.hintEl) {
          this.hintEl.textContent = cloze ? "用 {{c1::答案}}、{{c2::答案::提示}} 或 ==关键词== 标记；保存后会变成 SR 的多挖空卡。" : this.format === "reverse" ? "双向问答会写成“问题 ?? 答案”的 Spaced Repetition 卡片，正反都会出题。" : "基础问答会写成“问题 ? 答案”的 Spaced Repetition 卡片。";
        }
        this._updateClozeTools();
      }
      _insertCloze(number) {
        if (!this.questionEl) return;
        const start = this.questionEl.selectionStart ?? this.questionEl.value.length;
        const end = this.questionEl.selectionEnd ?? start;
        const selected = this.questionEl.value.slice(start, end).trim();
        const marker = `{{c${number}::${selected || "答案"}}}`;
        this.questionEl.setRangeText(marker, start, end, "end");
        this.questionEl.focus();
        this._updateClozeTools();
      }
      _updateClozeTools() {
        if (!this.clozeCountEl) return;
        if (this.format !== "cloze") return;
        const count = cardCore2.countClozeCards(this.questionEl?.value || "");
        this.clozeCountEl.textContent = count ? `检测到 ${count} 张挖空卡片` : "还没有挖空标记";
      }
      _submit() {
        if (this.submitted) return;
        const result = cardCore2.validateCardInput({
          format: this.format,
          question: this.questionEl?.value || "",
          answer: this.answerEl?.value || ""
        });
        if (!result.ok) {
          new Notice2(result.message, 6e3);
          if (result.value.format === "cloze") this.questionEl?.focus();
          else if (!result.value.answer) this.answerEl?.focus();
          else this.questionEl?.focus();
          return;
        }
        this.submitted = true;
        this.close();
        Promise.resolve(this.onSubmit?.(result.value)).catch((error) => {
          console.error("[MemoFlow] card creation failed", error);
          new Notice2(`制卡失败：${error.message || "未知错误"}。请检查父笔记和卡片文件夹。`, 7e3);
        });
      }
      onClose() {
        this.contentEl.empty();
      }
    };
    module2.exports = { MemoFlowCardModal: MemoFlowCardModal2 };
  }
});

// src/data/priority.js
var require_priority = __commonJS({
  "src/data/priority.js"(exports2, module2) {
    "use strict";
    var DEFAULT_PRIORITY = 50;
    function isValidPriority(value) {
      const number = Number(value);
      return Number.isInteger(number) && number >= 1 && number <= 100;
    }
    function normalizePriority(value, fallback = DEFAULT_PRIORITY) {
      return isValidPriority(value) ? Number(value) : fallback;
    }
    function boostPriority(current, delta) {
      const amount = Math.abs(Math.trunc(Number(delta) || 0));
      return Math.max(1, normalizePriority(current) - amount);
    }
    module2.exports = { DEFAULT_PRIORITY, isValidPriority, normalizePriority, boostPriority };
  }
});

// src/views/priority-modal.js
var require_priority_modal = __commonJS({
  "src/views/priority-modal.js"(exports2, module2) {
    "use strict";
    var { Modal, Notice: Notice2 } = require("obsidian");
    var { isValidPriority, normalizePriority } = require_priority();
    var MemoFlowPriorityModal2 = class extends Modal {
      constructor(app, { file, current, onApply } = {}) {
        super(app);
        this.file = file;
        this.current = normalizePriority(current);
        this.onApply = onApply;
        this.submitted = false;
        this.inputEl = null;
      }
      onOpen() {
        this.titleEl.setText("设置优先级");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("mf-priority-modal");
        contentEl.createDiv({
          cls: "mf-card-modal-info",
          text: `当前 P${this.current} · P1 最高，P100 最低。卡片不参与主题优先级。`
        });
        const row = contentEl.createDiv({ cls: "mf-priority-current" });
        row.createSpan({ cls: "mf-priority-badge", text: `P${this.current}` });
        row.createSpan({ text: this.file?.basename || "" });
        const inputWrap = contentEl.createDiv({ cls: "mf-card-modal-row" });
        inputWrap.createDiv({ cls: "mf-card-modal-label", text: "新优先级（1–100）" });
        this.inputEl = inputWrap.createEl("input", {
          cls: "mf-priority-input",
          attr: { type: "number", min: "1", max: "100", step: "1" }
        });
        this.inputEl.value = String(this.current);
        const quick = contentEl.createDiv({ cls: "mf-priority-quick" });
        for (const value of [1, 5, 10, 20, 30, 50, 70, 100]) {
          const button = quick.createEl("button", { text: `P${value}`, attr: { type: "button" } });
          button.addEventListener("click", () => {
            this.inputEl.value = String(value);
            this.inputEl.focus();
          });
        }
        const boost = contentEl.createDiv({ cls: "mf-priority-boost" });
        boost.createSpan({ cls: "mf-card-modal-label", text: "快速提升：" });
        for (const delta of [5, 15, 30]) {
          const button = boost.createEl("button", { text: `提升 ${delta}`, attr: { type: "button" } });
          button.addEventListener("click", () => this._applyBoost(delta));
        }
        const actions = contentEl.createDiv({ cls: "mf-card-modal-actions" });
        const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
        cancel.addEventListener("click", () => this.close());
        const save = actions.createEl("button", { text: "保存", cls: "mod-cta", attr: { type: "button" } });
        save.addEventListener("click", () => this._submit());
        window.setTimeout(() => {
          this.inputEl?.focus();
          this.inputEl?.select();
        }, 20);
      }
      _submit() {
        if (this.submitted) return;
        const value = Number(this.inputEl?.value);
        if (!isValidPriority(value)) {
          new Notice2("优先级必须是 1–100 之间的整数。", 6e3);
          this.inputEl?.focus();
          return;
        }
        this.submitted = true;
        this.close();
        Promise.resolve(this.onApply?.({ priority: value })).catch((error) => {
          console.error("[MemoFlow] priority update failed", error);
          new Notice2(`优先级保存失败：${error.message || "未知错误"}。可关闭后重试。`, 6e3);
        });
      }
      _applyBoost(delta) {
        if (this.submitted) return;
        this.submitted = true;
        this.close();
        Promise.resolve(this.onApply?.({ boost: delta })).catch((error) => {
          console.error("[MemoFlow] priority boost failed", error);
          new Notice2(`优先级保存失败：${error.message || "未知错误"}。可关闭后重试。`, 6e3);
        });
      }
      onClose() {
        this.contentEl.empty();
      }
    };
    module2.exports = { MemoFlowPriorityModal: MemoFlowPriorityModal2 };
  }
});

// src/views/overload-modal.js
var require_overload_modal = __commonJS({
  "src/views/overload-modal.js"(exports2, module2) {
    "use strict";
    var { Modal } = require("obsidian");
    var MemoFlowOverloadModal2 = class extends Modal {
      constructor(app, { overdueCount = 0, onChoose } = {}) {
        super(app);
        this.overdueCount = overdueCount;
        this.onChoose = onChoose;
        this.chosen = false;
      }
      onOpen() {
        this.titleEl.setText("过载处理");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("mf-overload-modal");
        contentEl.createDiv({
          cls: "mf-card-modal-info",
          text: `当前有 ${this.overdueCount} 个逾期阅读主题。Mercy 会把它们摊平到未来几天，卡片不参与。`
        });
        const grid = contentEl.createDiv({ cls: "mf-overload-options" });
        for (const days of [3, 7, 14, 30]) {
          const button = grid.createEl("button", {
            attr: { type: "button" }
          });
          button.createSpan({ cls: "mf-overload-days", text: `未来 ${days} 天` });
          button.createSpan({ cls: "mf-overload-hint", text: days === 3 ? "适合轻度积压" : days === 30 ? "适合长假后" : "把逾期均匀摊开" });
          button.addEventListener("click", () => {
            if (this.chosen) return;
            this.chosen = true;
            this.close();
            Promise.resolve(this.onChoose?.(days)).catch((error) => console.error("[MemoFlow] overload failed", error));
          });
        }
        const actions = contentEl.createDiv({ cls: "mf-card-modal-actions" });
        const cancel = actions.createEl("button", { text: "先不处理", attr: { type: "button" } });
        cancel.addEventListener("click", () => this.close());
      }
      onClose() {
        this.contentEl.empty();
      }
    };
    module2.exports = { MemoFlowOverloadModal: MemoFlowOverloadModal2 };
  }
});

// src/views/user-guide-modal.js
var require_user_guide_modal = __commonJS({
  "src/views/user-guide-modal.js"(exports2, module2) {
    "use strict";
    var { Modal } = require("obsidian");
    var MemoFlowUserGuideModal2 = class extends Modal {
      onOpen() {
        this.titleEl.setText("MemoFlow 使用指南");
        const root = this.contentEl;
        root.empty();
        root.addClass("mf-guide-modal");
        const section = (title, children) => {
          root.createEl("h3", { text: title });
          for (const child of children) {
            if (typeof child === "string") root.createEl("p", { text: child });
            else root.appendChild(child);
          }
        };
        const list = (items) => {
          const ul = root.createEl("ul");
          for (const item of items) ul.createEl("li", { text: item });
          return ul;
        };
        section("快速开始", [
          "打开一条来源/摘录，点阅读条上的「评阅并下一项」；摘录用「完成并下一项」。",
          "需要摘录时，选中文字后运行「生成时间戳摘录（选中 / 剪贴板）」，或点总览的「摘录选中 / 剪贴板」。",
          "需要制卡时，在摘录阅读条点「制卡」；基础问答和 ==Cloze== 都支持。",
          "卡片复习交给 Spaced Repetition：卡片阅读条点「复习此卡」。"
        ]);
        section("每日流程", [
          list([
            "总览 →「开始今日学习」：构建今日混合 session（主题 + 卡片）。",
            "来源：读一小段，记录页码，评阅并进入下一项。",
            "摘录：处理完点「完成并下一项」；需要时先「制卡」。",
            "卡片：在 Spaced Repetition 中显示答案、评分；SR 负责下次复习日期。",
            "过载：总览「过载处理」→ Mercy，或设置里开启自动过载。"
          ])
        ]);
        section("优先级与子集复习", [
          "阅读条和总览队列的 P 数字都可点击；P1 最高，P100 最低。",
          "队列按类型 / 逾期 / 搜索筛选后，底部「复习筛选（N）」只把当前筛选结果组成 session。"
        ]);
        section("PDF、阅读点与摘录", [
          "来源有 PDF 时，阅读条显示 p.N / 总页数；点页码打开阅读点。",
          "「评阅并下一项」会问读到的页码，写入 read_point 并更新排程。",
          "时间戳摘录会带 `**来源**：[[...pdf#page=N|...]]`；点击可回 PDF。"
        ]);
        section("推荐快捷键", [
          "命令面板搜索中文命令即可；原有命令 ID 不变，旧快捷键继续有效。"
        ]);
        section("故障排查", [
          list([
            "卡片不能复习：确认 Spaced Repetition 已启用，且 deck tag 为 flashcards/incremental-reading。",
            "PDF 打不开：确认 pdf_path 或 pdf_vault_path 指向 Vault 内/外真实存在的 PDF。",
            "没有到期项：检查 next_review 和状态；或运行「构建今日学习队列」。",
            "详细复现：见 docs/WORKFLOW-TEST.md；SR 安装见 docs/SR-SETUP.md。"
          ])
        ]);
        root.createEl("p", {
          cls: "mf-guide-footnote",
          text: "MemoFlow 个人自用版 · 作者：三斤的多多 / DeepSeek。保留 Incremental Reading Toolkit 的调度引擎；卡片评分与下次日期由 Spaced Repetition 负责。"
        });
      }
      onClose() {
        this.contentEl.empty();
      }
    };
    module2.exports = { MemoFlowUserGuideModal: MemoFlowUserGuideModal2 };
  }
});

// src/views/extract-open-modal.js
var require_extract_open_modal = __commonJS({
  "src/views/extract-open-modal.js"(exports2, module2) {
    "use strict";
    var { Modal } = require("obsidian");
    var ExtractOpenModal2 = class extends Modal {
      constructor(app, { file, onOpenFile } = {}) {
        super(app);
        this.file = file;
        this.onOpenFile = onOpenFile;
      }
      onOpen() {
        this.titleEl.setText("摘录已生成");
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("mf-extract-open-modal");
        contentEl.createDiv({
          cls: "mf-extract-open-path",
          text: this.file?.path || ""
        });
        contentEl.createDiv({
          cls: "mf-highlight-confirm-meta",
          text: "要现在打开这条摘录吗？"
        });
        const actions = contentEl.createDiv({ cls: "mf-highlight-confirm-actions" });
        const stay = actions.createEl("button", { text: "留在当前", attr: { type: "button" } });
        stay.addEventListener("click", () => this.close());
        const open = actions.createEl("button", {
          text: "在新标签页打开",
          cls: "mod-cta",
          attr: { type: "button" }
        });
        open.addEventListener("click", async () => {
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
    };
    module2.exports = { ExtractOpenModal: ExtractOpenModal2 };
  }
});

// src/views/confirm-modal.js
var require_confirm_modal = __commonJS({
  "src/views/confirm-modal.js"(exports2, module2) {
    "use strict";
    var { Modal } = require("obsidian");
    var ConfirmActionModal2 = class extends Modal {
      constructor(app, { title, body, confirmText = "确定", onConfirm, onCancel } = {}) {
        super(app);
        this.title = title || "确认操作";
        this.body = body || "";
        this.confirmText = confirmText;
        this.onConfirm = onConfirm;
        this.onCancel = onCancel;
        this.settled = false;
      }
      onOpen() {
        this.titleEl.setText(this.title);
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("mf-confirm-action");
        contentEl.createDiv({ cls: "mf-confirm-action-body", text: this.body });
        const actions = contentEl.createDiv({ cls: "mf-highlight-confirm-actions" });
        const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
        cancel.addEventListener("click", () => this._finish(false));
        const confirm = actions.createEl("button", {
          text: this.confirmText,
          cls: "mod-warning",
          attr: { type: "button" }
        });
        confirm.addEventListener("click", () => this._finish(true));
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
    };
    module2.exports = { ConfirmActionModal: ConfirmActionModal2 };
  }
});

// src/i18n/zh.js
var require_zh = __commonJS({
  "src/i18n/zh.js"(exports2, module2) {
    "use strict";
    var COMMAND_NAMES2 = {
      "build-session-queue": "构建今日学习队列",
      "next-element": "下一项",
      "end-session": "评阅当前阅读项",
      "extract-selection": "从选中内容摘录",
      "flashcard-clipboard": "从剪贴板制卡",
      "capture-more": "采集或新建…",
      "current-actions": "当前阅读项操作…",
      "open-toolkit-view": "打开 MemoFlow 视图…",
      "advanced-tools": "高级工具…"
    };
    var MENU_LABELS2 = {
      captureTitle: "采集或新建",
      capture: [
        "新来源",
        "导入剪藏（当前笔记）",
        "从剪贴板摘录（PDF 感知）",
        "为图片命名制卡",
        "从剪贴板提取图片",
        "图片遮挡制卡"
      ],
      currentTitle: "当前阅读项操作",
      current: [
        "完成",
        "重置",
        "移出队列",
        "延后",
        "手动排期",
        "设置优先级",
        "提升优先级",
        "打开父项",
        "打开 PDF",
        "切换阅读点",
        "跳转阅读点",
        "添加时间线检查点"
      ],
      toolkitTitle: "打开 MemoFlow 视图",
      toolkit: [
        "MemoFlow 总览",
        "统计与分析",
        "阅读队列侧栏",
        "知识树",
        "知识树侧栏",
        "使用指南"
      ],
      advancedTitle: "高级工具",
      advanced: [
        "子集复习",
        "Mercy（摊平逾期）",
        "推迟子树",
        "按 H2 拆分文章",
        "按章节拆分书籍",
        "新建分类",
        "移动当前项到…",
        "导出内联卡片到 SR",
        "迁移旧卡片到 SR",
        "性能诊断"
      ]
    };
    module2.exports = { COMMAND_NAMES: COMMAND_NAMES2, MENU_LABELS: MENU_LABELS2 };
  }
});

// src/platform/pdf.js
var require_pdf = __commonJS({
  "src/platform/pdf.js"(exports2, module2) {
    "use strict";
    function cleanPath(value) {
      let s = String(value == null ? "" : value).trim();
      if (!s) return "";
      s = s.replace(/^\[\[/, "").replace(/\]\]$/, "");
      s = s.split("|")[0];
      s = s.split("#")[0];
      return s.trim().replace(/^\/+/, "");
    }
    function positiveInt(value) {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
    function targetPage(fm) {
      const start = positiveInt(fm && fm.page_start);
      const end = positiveInt(fm && fm.page_end);
      const readPoint = positiveInt(fm && fm.read_point);
      let page = readPoint || start || 1;
      if (start && end && end >= start) page = Math.max(start, Math.min(page, end));
      return page;
    }
    function resolveMobilePdfTarget2(fm, hasVaultFile) {
      if (!fm || typeof hasVaultFile !== "function") {
        return { ok: false, code: "no-source", message: "当前文件不是 Incremental Reading 来源笔记。" };
      }
      const candidates = [cleanPath(fm.pdf_vault_path), cleanPath(fm.pdf_path)].filter(Boolean);
      if (!candidates.length) {
        return { ok: false, code: "no-path", message: "来源没有设置 PDF 路径。" };
      }
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (hasVaultFile(candidate)) {
          return { ok: true, path: candidate, page: targetPage(fm) };
        }
      }
      return {
        ok: false,
        code: "external",
        message: "移动端仅支持 Vault 内 PDF。请在来源里设置 pdf_vault_path（Vault 相对路径）。"
      };
    }
    module2.exports = { cleanPath, targetPage, resolveMobilePdfTarget: resolveMobilePdfTarget2 };
  }
});

// src/main.js
var { Platform, Notice, MarkdownView, TFile } = require("obsidian");
var BasePlugin = require_main();
var dateCore = require_date_core();
var extractCore = require_extract();
var pdfPage = require_pdf_page();
var { VIEW_TYPE, MemoFlowDashboardView } = require_dashboard_view();
var { REVIEW_VIEW_TYPE, MemoFlowReviewView } = require_review_view();
var { MemoFlowSettingTab } = require_settings_tab();
var { MemoFlowCardModal } = require_card_modal();
var { MemoFlowPriorityModal } = require_priority_modal();
var { MemoFlowOverloadModal } = require_overload_modal();
var { MemoFlowUserGuideModal } = require_user_guide_modal();
var { ExtractOpenModal } = require_extract_open_modal();
var { ConfirmActionModal } = require_confirm_modal();
var priorityCore = require_priority();
var cardCore = require_card();
var { COMMAND_NAMES, MENU_LABELS } = require_zh();
var { resolveMobilePdfTarget } = require_pdf();
var READER_TYPES = /* @__PURE__ */ new Set(["source", "extract", "card"]);
var MemoFlowPlugin = class extends BasePlugin {
  async onload() {
    await super.onload();
    this.registerView(VIEW_TYPE, (leaf) => new MemoFlowDashboardView(leaf, this));
    this.registerView(REVIEW_VIEW_TYPE, (leaf) => new MemoFlowReviewView(leaf, this));
    this.addRibbonIcon("layout-dashboard", "MemoFlow：学习面板", () => this.openMemoFlow());
    this.addCommand({
      id: "open-memoflow",
      name: "打开 MemoFlow 学习面板",
      callback: () => this.openMemoFlow()
    });
    this.addCommand({
      id: "memoflow-reading-actions",
      name: "当前阅读操作…",
      callback: () => this.openReadingActionMenu()
    });
    this.addCommand({
      id: "memoflow-timestamp-extract",
      name: "生成时间戳摘录（选中 / 剪贴板）",
      callback: () => this.createTimestampExtract({ fromSelection: true })
    });
    this.addCommand({
      id: "memoflow-create-card",
      name: "从当前摘录制卡",
      callback: () => this.openCardDialog()
    });
    this.addCommand({
      id: "memoflow-unified-review",
      name: "开始学习",
      callback: () => this.startLearning()
    });
    this.addCommand({
      id: "memoflow-card-review",
      name: "卡片复习",
      callback: () => this.openCardReview()
    });
    this.addCommand({
      id: "memoflow-clipboard-extract",
      name: "从剪贴板生成摘录",
      callback: () => this.clipboardExtract()
    });
    this._applyChineseCommandNames();
    this.registerEvent(this.app.workspace.on("file-open", () => this._syncReadingSurface()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this._syncReadingSurface()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this._syncReadingSurface()));
    this.app.workspace.onLayoutReady(() => this._syncReadingSurface());
  }
  addSettingTab(tab) {
    if (this.__mfChineseSettingsTab) return super.addSettingTab(tab);
    this.__mfChineseSettingsTab = true;
    return super.addSettingTab(new MemoFlowSettingTab(this.app, this));
  }
  isSpacedRepetitionReady() {
    const commands = this.app.commands?.commands || {};
    return Boolean(
      commands["obsidian-spaced-repetition:srs-review-flashcards"] && commands["obsidian-spaced-repetition:srs-review-flashcards-in-note"]
    );
  }
  reviewCards() {
    if (!this.isSpacedRepetitionReady()) {
      new Notice("需要先安装并启用 Spaced Repetition 才能复习卡片。");
      return;
    }
    return super.reviewCards();
  }
  async reviewCardsInNote(file = this.app.workspace.getActiveFile()) {
    if (!this.isSpacedRepetitionReady()) {
      new Notice("需要先安装并启用 Spaced Repetition 才能复习卡片。");
      return;
    }
    return super.reviewCardsInNote(file);
  }
  _applyChineseCommandNames() {
    const prefix = `${this.manifest.id}:`;
    const commands = this.app.commands?.commands;
    if (!commands) return;
    for (const [id, name] of Object.entries(COMMAND_NAMES)) {
      const command = commands[`${prefix}${id}`];
      if (command) command.name = name;
    }
    for (const [id, command] of Object.entries(commands)) {
      if (!id.startsWith(prefix) || !command) continue;
      command.name = String(command.name || "").replace(/^MemoFlow:\s*/, "");
    }
  }
  captureOrCreate() {
    return this._runActionMenu(MENU_LABELS.captureTitle, [
      { label: MENU_LABELS.capture[0], run: () => this.newSource() },
      { label: MENU_LABELS.capture[1], run: () => this.importClipping() },
      { label: MENU_LABELS.capture[2], run: () => this.extractClipboard() },
      { label: MENU_LABELS.capture[3], run: () => this.flashcardImageName() },
      { label: MENU_LABELS.capture[4], run: () => this.imageExtractClipboard() },
      { label: MENU_LABELS.capture[5], run: () => this.occlusionCreate() }
    ]);
  }
  currentElementActions() {
    return this._runActionMenu(MENU_LABELS.currentTitle, [
      { label: MENU_LABELS.current[0], run: () => this.markDone() },
      { label: MENU_LABELS.current[1], run: () => this.resetCurrent() },
      { label: MENU_LABELS.current[2], run: () => this.dismiss() },
      { label: MENU_LABELS.current[3], run: () => this.postpone() },
      { label: MENU_LABELS.current[4], run: () => this.schedule() },
      { label: MENU_LABELS.current[5], run: () => this.setPriority() },
      { label: MENU_LABELS.current[6], run: () => this.boost() },
      { label: MENU_LABELS.current[7], run: () => this.openParent() },
      { label: MENU_LABELS.current[8], run: () => this.openPdf() },
      { label: MENU_LABELS.current[9], run: () => this.toggleReadPoint() },
      { label: MENU_LABELS.current[10], run: () => this.jumpToReadPoint() },
      { label: MENU_LABELS.current[11], run: () => this.addCheckpoint() }
    ]);
  }
  openToolkitView() {
    return this._runActionMenu(MENU_LABELS.toolkitTitle, [
      { label: MENU_LABELS.toolkit[0], run: () => this.openDashboard() },
      { label: MENU_LABELS.toolkit[1], run: () => this.openDashboard("stats") },
      { label: MENU_LABELS.toolkit[2], run: () => this._activateQueueView() },
      { label: MENU_LABELS.toolkit[3], run: () => this._activateKnowledgeTree() },
      { label: MENU_LABELS.toolkit[4], run: () => this._activateKnowledgeTreeSidebar() },
      { label: MENU_LABELS.toolkit[5], run: () => this.openUserGuide() }
    ]);
  }
  advancedTools() {
    return this._runActionMenu(MENU_LABELS.advancedTitle, [
      { label: MENU_LABELS.advanced[0], run: () => this.subsetReview() },
      { label: MENU_LABELS.advanced[1], run: () => this.mercy() },
      { label: MENU_LABELS.advanced[2], run: () => this.postponeSubtree() },
      { label: MENU_LABELS.advanced[3], run: () => this.splitArticle() },
      { label: MENU_LABELS.advanced[4], run: () => this.splitBook() },
      { label: MENU_LABELS.advanced[5], run: async () => {
        await this.createCategory();
        this._refreshTreeViews();
      } },
      { label: MENU_LABELS.advanced[6], run: async () => {
        await this.reparentActive();
        this._refreshTreeViews();
      } },
      { label: MENU_LABELS.advanced[7], run: () => this.seedInlineCards() },
      { label: MENU_LABELS.advanced[8], run: () => this.migrateLegacyCards() },
      { label: MENU_LABELS.advanced[9], run: () => this.performanceDiagnostics() }
    ]);
  }
  async onunload() {
    this.app.workspace.detachLeavesOfType(REVIEW_VIEW_TYPE);
    this._closeReadingPopover?.();
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view?.__mfReadingAction) {
        view.__mfReadingAction.remove?.();
        view.__mfReadingAction = null;
      }
      view?.contentEl?.querySelector(":scope > .mf-reading-bar")?.remove();
    }
    if (typeof super.onunload === "function") await super.onunload();
  }
  async openMemoFlow() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  // Upstream commands and menus call this method; route them to the new page.
  async openDashboard(section = null) {
    const leaf = await this.openMemoFlow();
    if (section === "stats" && leaf?.view?.scrollToSection) {
      leaf.view.scrollToSection("analytics");
    }
  }
  _pdfFileForSource(fm) {
    if (!fm) return null;
    for (const raw of [fm.pdf_vault_path, fm.pdf_path]) {
      if (!raw) continue;
      const clean = String(raw).replace(/^['"]|['"]$/g, "").split("#")[0].replace(/^\/+/, "");
      const file = this.app.vault.getAbstractFileByPath(clean);
      if (file instanceof TFile && file.extension === "pdf") return file;
    }
    return null;
  }
  _findSourceForPdf(pdfFile) {
    if (!pdfFile || pdfFile.extension !== "pdf") return null;
    return this.getIRRows().find((row) => {
      if (row.fm?.type !== "source") return false;
      const target = this._pdfFileForSource(row.fm);
      return target?.path === pdfFile.path;
    }) || null;
  }
  async openPdf() {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "pdf") {
      const source = this._findSourceForPdf(active);
      if (source) return this.openPdfForSource(source.tfile);
      new Notice("没有来源笔记链接到这个 PDF。");
      return;
    }
    if (active?.extension === "md") return this.openPdfForSource(active);
    new Notice("请先打开来源笔记或对应的 PDF。");
  }
  async openPdfForSource(file) {
    if (!file) return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== "source") {
      new Notice("当前文件不是 Incremental Reading 来源笔记。");
      return;
    }
    const pdf = this._pdfFileForSource(fm);
    if (!pdf) {
      new Notice("Obsidian 原生 PDF 阅读器需要 Vault 内 PDF；请设置 pdf_vault_path。");
      return;
    }
    const page = Math.max(1, Number(fm.read_point) || 1);
    try {
      await this.app.workspace.openLinkText(`${pdf.path}#page=${page}`, file.path, false);
    } catch (error) {
      console.error("[MemoFlow] could not open native PDF", error);
      new Notice(`打开 PDF 失败：${error.message || "未知错误"}。确认 PDF 仍在 Vault 内，或检查 pdf_vault_path。`, 7e3);
    }
  }
  // A restored sidebar leaf can outlive a plugin reload and be materialised as
  // a generic markdown view. Upstream assumes every ir-queue-view leaf is an
  // IRQueueView; guard that so session navigation is not blocked by a stale
  // layout entry.
  _flushDeferredCollectionRenders() {
    for (const leaf of this.app.workspace.getLeavesOfType("ir-queue-view")) {
      const view = leaf.view;
      if (view?.needsRowsRender && typeof view._scheduleRowsRender === "function") {
        view._scheduleRowsRender("grade-complete");
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType("ir-main-dashboard")) {
      const view = leaf.view;
      if (view?.needsRender && typeof view._requestRender === "function") view._requestRender();
    }
    for (const type of ["ir-tree-view", "ir-tree-sidebar"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const view = leaf.view;
        if (view?.needsRender && typeof view._requestBodyRender === "function") view._requestBodyRender();
      }
    }
  }
  // ---------------------------------------------------------------------------
  // Reading session bar / header action
  // ---------------------------------------------------------------------------
  _todayKey() {
    return dateCore.formatDate(/* @__PURE__ */ new Date(), dateCore.normalizeDateFormat(this.settings?.misc?.date_format));
  }
  _sessionInfo(path) {
    const session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths)) return null;
    const index = session.paths.indexOf(path);
    if (index < 0) return null;
    const file = this._fileByPath(path);
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    return {
      index: index + 1,
      total: session.paths.length,
      type: session.types?.[path] || fm?.type || ""
    };
  }
  _fileByPath(path) {
    return path ? this.app.vault.getAbstractFileByPath(path) : null;
  }
  _nextSessionTarget(currentPath) {
    const session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths)) return null;
    const index = session.paths.indexOf(currentPath);
    if (index < 0) return null;
    for (let i = index + 1; i < session.paths.length; i++) {
      const path = session.paths[i];
      const file = this._fileByPath(path);
      if (!(file instanceof TFile)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return {
        file,
        type: session.types?.[path] || fm?.type || "source",
        readPoint: Number(session.readPoints?.[path]) || Number(fm?.read_point_line) || 0
      };
    }
    return null;
  }
  async _activateReadingFile(file) {
    const leaf = this.app.workspace.getLeavesOfType("markdown").find((candidate) => candidate.view?.file?.path === file.path);
    if (leaf) {
      if (typeof this.app.workspace.setActiveLeaf === "function") {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  async _openLearningFile(file, type, readPointLine = 0) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (fm?.type === "source" && this._pdfFileForSource(fm)) {
      await this.openPdfForSource(file);
      return;
    }
    const result = await super._openLearningFile(file, type, readPointLine);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const leaf = this.app.workspace.getLeavesOfType("markdown").find((candidate) => candidate.view?.file?.path === file.path);
    if (leaf) {
      if (typeof this.app.workspace.setActiveLeaf === "function") {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }
      this.app.workspace.revealLeaf(leaf);
    }
    return result;
  }
  async _openNextSessionTarget(target) {
    if (!target) {
      new Notice("今日队列已清空。");
      return;
    }
    if (typeof this._openLearningFile === "function") {
      await this._openLearningFile(target.file, target.type, target.readPoint);
    }
  }
  async _postponeReadingFile(file, days) {
    const fmt = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const base = /* @__PURE__ */ new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + days);
    const next = dateCore.formatDate(base, fmt);
    await this.app.fileManager.processFrontMatter(file, (fmWriter) => {
      fmWriter.next_review = next;
      fmWriter.interval = days;
    });
    new Notice(`已延后 ${days} 天 · 下次：${next}`);
  }
  _confirmDestructive(title, body, confirmText = "确认") {
    return new Promise((resolve) => {
      new ConfirmActionModal(this.app, {
        title,
        body,
        confirmText,
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      }).open();
    });
  }
  async _runReadingAction(action, file, data = {}) {
    if (!file) return;
    if (this.app.workspace.getActiveFile()?.extension !== "pdf") {
      await this._activateReadingFile(file);
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !READER_TYPES.has(fm.type)) {
      new Notice("当前笔记不是 Incremental Reading 阅读项。");
      return;
    }
    const next = this._nextSessionTarget(file.path);
    try {
      switch (action) {
        case "start-session":
          await this.buildSessionQueue({ openFirst: true });
          return;
        case "review-card":
          if (fm.type === "card") {
            if (typeof this.reviewCardsInNote === "function") await this.reviewCardsInNote(file);
            else new Notice("卡片复习需要 Spaced Repetition 插件。");
          }
          return;
        case "create-card":
          await this.openCardDialog(file);
          return;
        case "clipboard-extract":
          await this.clipboardExtract(file);
          return;
        case "priority":
          await this.openPriorityDialog(file);
          return;
        case "open-pdf":
          await this.openPdfForSource(file);
          return;
        case "complete":
          if (fm.type === "card") {
            new Notice("卡片复习由 Spaced Repetition 管理；用「下一项」继续。");
            return;
          }
          if (fm.type === "extract") {
            await this.markPathsDone([file.path], { confirm: false });
          } else {
            const graded = await this._gradeTopic(file, fm, this._todayKey());
            if (!graded) return;
          }
          await this._openNextSessionTarget(next);
          return;
        case "skip":
          await this.nextElement();
          return;
        case "postpone":
          await this._postponeReadingFile(file, Math.max(1, Number(data.days) || 1));
          await this.consumeSessionItem(file.path);
          await this._openNextSessionTarget(next);
          return;
        case "dismiss":
          if (!await this._confirmDestructive(
            "移出队列？",
            `「${file.basename}」会被标记为 dismissed，并从今日队列移除。笔记不会删除。`,
            "移出队列"
          )) return;
          if (this.app.workspace.getActiveFile()?.path !== file.path) {
            await this.app.fileManager.processFrontMatter(file, (fmw) => {
              fmw.status = "dismissed";
            });
            new Notice("已移出队列。");
          } else {
            await this.dismiss();
          }
          await this.consumeSessionItem(file.path);
          await this._openNextSessionTarget(next);
          return;
        case "mark-done":
          if (!await this._confirmDestructive(
            "仅标记完成？",
            `「${file.basename}」会被标记为 done，并清除后续复习排期。笔记不会删除。`,
            "标记完成"
          )) return;
          await this.markPathsDone([file.path], { confirm: false });
          await this._openNextSessionTarget(next);
          return;
        case "dashboard":
          await this.openMemoFlow();
          return;
        default:
          return;
      }
    } catch (error) {
      console.error("[MemoFlow] reading action failed", action, error);
      new Notice(`${{ complete: "完成阅读", skip: "下一项", postpone: "延后", dismiss: "移出队列", "mark-done": "标记完成", "clipboard-extract": "剪贴摘录", "create-card": "制卡", priority: "设置优先级", "open-pdf": "打开 PDF" }[action] || "操作"}失败：${error.message || "未知错误"}。可重试；仍失败时打开原笔记或重载 Obsidian。`, 8e3);
    } finally {
      this._syncReadingSurface();
    }
  }
  async openReadingActionMenu(event, fileOverride = null) {
    const file = fileOverride || this.app.workspace.getActiveFile();
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    if (!file || !fm || !READER_TYPES.has(fm.type)) {
      new Notice("打开一个 Incremental Reading 阅读项后再试。");
      return;
    }
    this._openReadingPopover(event, file);
  }
  _closeReadingPopover() {
    if (this._mfReadingPopover) this._mfReadingPopover.remove();
    this._mfReadingPopover = null;
    if (this._mfPopClick) document.removeEventListener("click", this._mfPopClick, true);
    if (this._mfPopKey) document.removeEventListener("keydown", this._mfPopKey, true);
    this._mfPopClick = null;
    this._mfPopKey = null;
  }
  _openReadingPopover(event, file, { delayOnly = false } = {}) {
    this._closeReadingPopover();
    const fm = file ? this.app.metadataCache.getFileCache(file)?.frontmatter : null;
    if (!file || !fm || !READER_TYPES.has(fm.type)) return;
    const session = this._sessionInfo(file.path);
    const popover = document.createElement("div");
    popover.className = "mf-reading-popover";
    popover.setAttribute("role", "menu");
    const add = (label, action, data = null, className = "") => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `mf-reading-popover-item${className ? ` ${className}` : ""}`;
      item.textContent = label;
      item.addEventListener("click", (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        this._closeReadingPopover();
        this._runReadingAction(action, file, data || {});
      });
      popover.appendChild(item);
    };
    const separator = () => {
      const line = document.createElement("div");
      line.className = "mf-reading-popover-sep";
      popover.appendChild(line);
    };
    if (delayOnly) {
      add("延后 1 天", "postpone", { days: 1 });
      add("延后 3 天", "postpone", { days: 3 });
      add("延后 7 天", "postpone", { days: 7 });
    } else if (fm.type === "card") {
      if (session) add("下一项", "skip", null, "is-primary");
      else add("开始今日学习", "start-session", null, "is-primary");
      add("复习此卡", "review-card");
      separator();
      add("打开 MemoFlow 总览", "dashboard");
    } else {
      if (session) {
        add(fm.type === "extract" ? "完成并下一项" : "评阅并下一项", "complete", null, "is-primary");
        add("跳过（保留在队列）", "skip");
      } else {
        add("开始今日学习", "start-session", null, "is-primary");
      }
      if (this.app.workspace.getActiveFile()?.extension !== "pdf") {
        add("从当前摘录制卡", "create-card");
      }
      separator();
      add("设置优先级…", "priority");
      if (fm.type === "source" && (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path)) {
        add("打开 PDF 阅读点", "open-pdf");
      }
      add("延后 1 天", "postpone", { days: 1 });
      add("延后 3 天", "postpone", { days: 3 });
      add("延后 7 天", "postpone", { days: 7 });
      add("移出队列", "dismiss");
      add("仅标记完成", "mark-done");
      separator();
      add("打开 MemoFlow 总览", "dashboard");
    }
    document.body.appendChild(popover);
    const target = event?.currentTarget || event?.target;
    const rect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    const width = popover.offsetWidth || 200;
    const height = popover.offsetHeight || 0;
    const x = rect ? rect.left : Math.max(16, window.innerWidth / 2 - width / 2);
    const y = rect ? rect.bottom + 6 : 120;
    popover.style.left = `${Math.min(Math.max(8, x), window.innerWidth - width - 8)}px`;
    popover.style.top = `${Math.min(Math.max(8, y), window.innerHeight - height - 8)}px`;
    this._mfReadingPopover = popover;
    const closeOnClick = (clickEvent) => {
      if (!popover.contains(clickEvent.target)) this._closeReadingPopover();
    };
    const closeOnKey = (keyEvent) => {
      if (keyEvent.key === "Escape") this._closeReadingPopover();
    };
    this._mfPopClick = closeOnClick;
    this._mfPopKey = closeOnKey;
    window.setTimeout(() => {
      if (!this._mfReadingPopover) return;
      document.addEventListener("click", closeOnClick, true);
      document.addEventListener("keydown", closeOnKey, true);
    }, 0);
  }
  _buildReadingBar(file, fm, info) {
    const bar = document.createElement("div");
    bar.className = "mf-reading-bar";
    bar.dataset.path = file.path;
    bar.dataset.session = `${info.index}/${info.total}`;
    const main = document.createElement("div");
    main.className = "mf-rb-main";
    const dot = document.createElement("span");
    dot.className = "mf-rb-dot";
    const label = document.createElement("span");
    label.className = "mf-rb-label";
    label.textContent = `今日队列 · ${info.index} / ${info.total}`;
    const sep = document.createElement("span");
    sep.className = "mf-rb-sep";
    const type = document.createElement("span");
    type.className = "mf-rb-type mf-stage";
    type.textContent = fm.type === "source" ? "阅读" : fm.type === "card" ? "卡片" : "摘录";
    const hint = document.createElement("span");
    hint.className = "mf-rb-hint";
    hint.textContent = fm.type === "card" ? "卡片由 Spaced Repetition 评分，完成后点下一项" : fm.type === "extract" ? "处理完就完成并进入下一项" : "读到这里就评阅并进入下一项";
    main.append(dot, label, sep, type, hint);
    if (fm.type !== "card") {
      const priority = document.createElement("button");
      priority.type = "button";
      priority.className = "mf-rb-priority";
      priority.textContent = `P${priorityCore.normalizePriority(fm.priority)}`;
      priority.title = "设置优先级";
      priority.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openPriorityDialog(file);
      });
      main.appendChild(priority);
    }
    if (fm.type === "source" && (fm.total_pages || fm.pdf_path || fm.pdf_vault_path || fm.sioyek_path)) {
      const page = document.createElement("button");
      page.type = "button";
      page.className = "mf-rb-page";
      const current = Number(fm.read_point) || 1;
      page.textContent = `p.${current}${fm.total_pages ? ` / ${fm.total_pages}` : ""}`;
      page.title = "打开 PDF 阅读点";
      page.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openPdfForSource(file);
      });
      main.appendChild(page);
    }
    const actions = document.createElement("div");
    actions.className = "mf-rb-actions";
    const addButton = (text, action = null, variant = "", data = null) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mf-rb-btn${variant ? ` ${variant}` : ""}`;
      button.textContent = text;
      if (action) {
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this._runReadingAction(action, file, data || {});
        });
      }
      actions.appendChild(button);
      return button;
    };
    if (fm.type === "card") {
      addButton("下一项", "skip", "is-primary");
      addButton("复习此卡", "review-card");
      const cardDisabled = (text, title) => {
        const button = addButton(text);
        button.disabled = true;
        button.classList.add("is-disabled");
        button.title = title;
      };
      cardDisabled("制卡", "问答卡片不适用；请在摘录/来源中制卡");
      cardDisabled("完成", "问答卡片由 Spaced Repetition 评分");
    } else {
      addButton(fm.type === "extract" ? "完成并下一项" : "评阅并下一项", "complete", "is-primary");
      addButton("跳过", "skip");
      addButton("制卡", "create-card");
      const postpone = addButton("延后");
      postpone.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this._openReadingPopover(event, file, { delayOnly: true });
      });
      addButton("移出队列", "dismiss", "is-subtle");
    }
    bar.append(main, actions);
    return bar;
  }
  _syncReadingSurface() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        const contentEl = view?.contentEl;
        const file = view?.file;
        if (!contentEl || !(file instanceof TFile)) continue;
        const existing = contentEl.querySelector(":scope > .mf-reading-bar");
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        const info = fm && READER_TYPES.has(fm.type) ? this._sessionInfo(file.path) : null;
        if (!info) {
          existing?.remove();
          continue;
        }
        existing?.remove();
        contentEl.prepend(this._buildReadingBar(file, fm, info));
      }
      this._syncReadingHeaderActions();
      this._syncPdfHeaderActions();
    } catch (error) {
      console.error("[MemoFlow] could not sync reading surface", error);
    }
  }
  _syncReadingHeaderActions() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (!view || typeof view.addAction !== "function") continue;
        const fm = view.file ? this.app.metadataCache.getFileCache(view.file)?.frontmatter : null;
        const isTopic = Boolean(fm && READER_TYPES.has(fm.type));
        if (isTopic && !view.__mfReadingAction) {
          view.__mfReadingAction = view.addAction("list-checks", "MemoFlow 阅读操作", (event) => this.openReadingActionMenu(event));
        } else if (!isTopic && view.__mfReadingAction) {
          view.__mfReadingAction.remove?.();
          view.__mfReadingAction = null;
        }
      }
    } catch (error) {
      console.error("[MemoFlow] could not sync reading header action", error);
    }
  }
  _syncPdfHeaderActions() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
        const view = leaf.view;
        const contentEl = view?.contentEl;
        const pdfFile = view?.file;
        if (!contentEl || !pdfFile || pdfFile.extension !== "pdf") continue;
        contentEl.querySelector(":scope > .mf-pdf-bar")?.remove();
        const source = this._findSourceForPdf(pdfFile);
        if (!source) continue;
        const bar = this._buildPdfActionBar(view, source.tfile, source.fm);
        const toolbar = contentEl.querySelector(":scope > .pdf-toolbar");
        contentEl.insertBefore(bar, toolbar?.nextSibling || contentEl.firstChild);
      }
    } catch (error) {
      console.error("[MemoFlow] could not sync PDF reading actions", error);
    }
  }
  _buildPdfActionBar(view, file, fm) {
    const bar = document.createElement("div");
    bar.className = "mf-pdf-bar";
    bar.dataset.path = file.path;
    const stage = document.createElement("span");
    stage.className = "mf-pdf-stage mf-stage";
    stage.textContent = "阅读";
    bar.appendChild(stage);
    const addButton = (label, action, { primary = false, disabled = false, title = "" } = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `mf-pdf-btn${primary ? " is-primary" : ""}`;
      button.textContent = label;
      if (title) button.title = title;
      button.disabled = disabled;
      if (!disabled) {
        button.addEventListener("click", (event) => {
          if (action === "more") this.openReadingActionMenu(event, file);
          else this._runReadingAction(action, file);
        });
      }
      bar.appendChild(button);
      return button;
    };
    addButton("剪贴摘录", "clipboard-extract", {
      title: "复制 PDF 文字后，在后台生成摘录（平板 fallback）"
    });
    addButton("制卡", "create-card", {
      disabled: true,
      title: "阅读 PDF 阶段先剪贴摘录；有摘录后再制卡"
    });
    addButton(fm.type === "extract" ? "完成并下一项" : "完成阅读", "complete", { primary: true });
    addButton("下一项", "skip");
    addButton("更多", "more");
    return bar;
  }
  _activePdfPageNumber(sourceFile = null) {
    let pdfPath = null;
    if (sourceFile) {
      const fm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
      pdfPath = this._pdfFileForSource(fm)?.path || null;
    } else {
      const active = this.app.workspace.getActiveFile();
      if (active?.extension === "pdf") pdfPath = active.path;
    }
    if (!pdfPath) return null;
    const view = this.app.workspace.getLeavesOfType("pdf").map((leaf) => leaf.view).find((candidate) => candidate?.file?.path === pdfPath);
    return pdfPage.currentPageNumber(view);
  }
  async clipboardExtract(sourceFile = null) {
    const pageFallback = this._activePdfPageNumber(sourceFile);
    const created = await this.createTimestampExtract({ sourceFile, pageFallback, fromSelection: false, open: false });
    if (created) this._promptOpenExtract(created);
    return created;
  }
  _promptOpenExtract(file) {
    new ExtractOpenModal(this.app, {
      file,
      onOpenFile: async (target) => {
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(target);
      }
    }).open();
  }
  async buildSubsetSession(paths, { openFirst = true, label = "筛选" } = {}) {
    const queue = [];
    const seen = /* @__PURE__ */ new Set();
    for (const path of Array.isArray(paths) ? paths : []) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const tfile = this.app.vault.getAbstractFileByPath(path);
      if (!(tfile instanceof TFile)) continue;
      const fm = this.app.metadataCache.getFileCache(tfile)?.frontmatter;
      if (!fm || fm.type !== "source" && fm.type !== "extract" && fm.type !== "card") continue;
      queue.push({ tfile, fm });
    }
    if (!queue.length) {
      new Notice("筛选结果里没有可复习的阅读项。");
      return;
    }
    await this.persistSessionSnapshot(queue);
    this._markCollectionViewsStale();
    this._flushDeferredCollectionRenders();
    new Notice(`已建立「${label}」复习会话 · ${queue.length} 项`, 6e3);
    if (openFirst) await this.nextElement({ fromStart: true });
  }
  async buildSessionQueue(options = {}) {
    await this._maybeAutoOverload();
    return super.buildSessionQueue(options);
  }
  async _maybeAutoOverload() {
    if (!this.settings?.misc?.auto_overload) return;
    const threshold = Math.max(1, Number(this.settings.misc.overload_threshold) || 10);
    const overdue = this._overdueTopics();
    if (overdue.length <= threshold) return;
    await this.spreadOverdue(overdue, 7);
    new Notice(`自动过载：${overdue.length} 个逾期主题已按 7 天摊平。`, 7e3);
  }
  openUserGuide() {
    new MemoFlowUserGuideModal(this.app).open();
  }
  async _openReviewView(mode, paths) {
    const leaf = this.app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    if (leaf?.view?.configure) {
      await leaf.view.configure({ mode, paths });
      this.app.workspace.revealLeaf(leaf);
      return;
    }
    this._reviewConfig = { mode, paths };
    const nextLeaf = this.app.workspace.getLeaf("tab");
    await nextLeaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(nextLeaf);
  }
  async startLearning() {
    await this.buildSessionQueue({ openFirst: true });
  }
  async openUnifiedReview() {
    let session = this.settings?.session;
    if (!session || session.date !== this._todayKey() || !Array.isArray(session.paths) || !session.paths.length) {
      await this.buildSessionQueue({ openFirst: false });
      session = this.settings?.session;
      if (!session || !Array.isArray(session.paths) || !session.paths.length) return;
    }
    await this._openReviewView("learn", session.paths.slice());
  }
  async openCardReview() {
    if (!this.isSpacedRepetitionReady()) {
      new Notice("需要先安装并启用 Spaced Repetition 才能复习卡片。");
      return;
    }
    const pool = await this.buildDuePool({ skipCurrent: false });
    let paths = pool.filter((item) => item.fm?.type === "card" && item.tfile).map((item) => item.tfile.path);
    if (!paths.length) {
      const today = /* @__PURE__ */ new Date();
      today.setHours(0, 0, 0, 0);
      const rows = this.getIRRows().filter((row) => row.fm?.type === "card" && row.tfile && row.fm.status !== "done" && row.fm.status !== "dismissed").slice(0, 500);
      const due = await Promise.all(rows.map(async (row) => {
        try {
          return await this._cardIsDue(row.tfile, today);
        } catch {
          return false;
        }
      }));
      paths = rows.filter((row, index) => due[index]).map((row) => row.tfile.path);
    }
    if (!paths.length) {
      new Notice("今天没有到期卡片。");
      return;
    }
    await this._openReviewView("cards", paths);
  }
  async openPriorityDialog(file = this.app.workspace.getActiveFile(), { onApplied = null } = {}) {
    if (!file || file.extension !== "md") {
      new Notice("请先打开来源或摘录笔记。");
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== "source" && fm.type !== "extract") {
      new Notice("只能给来源或摘录设置优先级。");
      return;
    }
    const current = priorityCore.normalizePriority(fm.priority);
    new MemoFlowPriorityModal(this.app, {
      file,
      current,
      onApply: async (result) => {
        const original = priorityCore.normalizePriority(fm.priority);
        const next = result.boost ? priorityCore.boostPriority(original, result.boost) : priorityCore.normalizePriority(result.priority, original);
        if (next === original) {
          new Notice(`优先级保持 P${original}。`);
          return;
        }
        await this.app.fileManager.processFrontMatter(file, (fmw) => {
          if (result.boost && fmw.boost_from == null) fmw.boost_from = original;
          fmw.priority = next;
        });
        fm.priority = next;
        new Notice(`优先级 P${original} → P${next}`);
        if (typeof this._invalidateIRCollection === "function") this._invalidateIRCollection(true);
        await this._syncReadingSurface();
        await onApplied?.();
      }
    }).open();
  }
  _overdueTopics() {
    const format = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const today = /* @__PURE__ */ new Date();
    today.setHours(0, 0, 0, 0);
    return this.getIRRows().filter((row) => {
      const fm = row.fm;
      if (!fm || fm.type === "card") return false;
      if (fm.status === "done" || fm.status === "container" || fm.status === "dismissed" || fm.status === "inbox") return false;
      const date = dateCore.parseDate(fm.next_review, format);
      return Boolean(date && date < today);
    });
  }
  async openOverloadDialog() {
    const overdue = this._overdueTopics();
    if (!overdue.length) {
      new Notice("当前没有逾期阅读主题。");
      return;
    }
    new MemoFlowOverloadModal(this.app, {
      overdueCount: overdue.length,
      onChoose: (days) => this.spreadOverdue(overdue, days)
    }).open();
  }
  async spreadOverdue(overdueRows, days) {
    const format = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const today = /* @__PURE__ */ new Date();
    today.setHours(0, 0, 0, 0);
    const rows = overdueRows.slice().sort((a, b) => {
      const pa = Number(a.fm.priority) || 50;
      const pb = Number(b.fm.priority) || 50;
      if (pa !== pb) return pa - pb;
      return String(a.fm.next_review || "").localeCompare(String(b.fm.next_review || ""));
    });
    let updated = 0;
    for (let rank = 0; rank < rows.length; rank++) {
      const offset = Math.floor(rank * days / rows.length);
      const date = new Date(today.getTime());
      date.setDate(date.getDate() + offset);
      const nextReview = dateCore.formatDate(date, format);
      await this.app.fileManager.processFrontMatter(rows[rank].tfile, (fmw) => {
        fmw.next_review = nextReview;
        fmw.interval = Math.max(1, offset);
      });
      updated++;
    }
    new Notice(`Mercy：${updated} 个逾期主题摊平到未来 ${days} 天。`, 7e3);
    if (typeof this._invalidateIRCollection === "function") this._invalidateIRCollection(true);
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      await leaf.view?.refresh?.();
    }
  }
  async openCardDialog(file = this.app.workspace.getActiveFile()) {
    if (!file || file.extension !== "md") {
      new Notice("请先打开来源或摘录笔记再制卡。");
      return;
    }
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || fm.type !== "source" && fm.type !== "extract") {
      new Notice("只能从来源或摘录制卡。");
      return;
    }
    const body = await this.app.vault.cachedRead(file).catch(() => "");
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const selection = activeView?.file?.path === file.path ? activeView.editor?.getSelection?.() || "" : "";
    const prefill = { question: cardCore.buildCardPrefill(body, selection, 400), answer: "" };
    new MemoFlowCardModal(this.app, {
      parentFile: file,
      prefill,
      onSubmit: async (value) => {
        const created = await this._createSpacedRepetitionCard(file, {
          format: value.format,
          question: value.question,
          answer: value.answer
        });
        const srReady = this.isSpacedRepetitionReady();
        new Notice(`卡片已创建：${created.name}${srReady ? "" : "（启用 Spaced Repetition 后才能复习）"}`, 6e3);
        if (typeof this._invalidateIRCollection === "function") this._invalidateIRCollection(true);
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(created.file);
        await this._syncReadingSurface();
      }
    }).open();
  }
  // ---------------------------------------------------------------------------
  // Timestamped extract with a citation back to the PDF page
  // ---------------------------------------------------------------------------
  _resolveExtractSource(active) {
    if (!active) return null;
    if (active.extension === "md") {
      const fm = this.app.metadataCache.getFileCache(active)?.frontmatter;
      if (fm?.type === "source") return { file: active, fm };
      if (fm?.type === "extract") {
        const link = String(fm.source || fm.parent || "");
        const name = link.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0].split("#")[0].trim();
        const dest = name ? this.app.metadataCache.getFirstLinkpathDest(name, active.path) : null;
        if (dest instanceof TFile) {
          const destFm = this.app.metadataCache.getFileCache(dest)?.frontmatter;
          if (destFm?.type === "source") return { file: dest, fm: destFm };
        }
      }
      return null;
    }
    if (active.extension === "pdf") {
      for (const row of this.getIRRows()) {
        const fm = row.fm;
        if (!fm || fm.type !== "source") continue;
        const candidates = [fm.pdf_vault_path, fm.pdf_path].filter(Boolean).map((value) => String(value).replace(/^\/+/, "").split("#")[0]);
        if (candidates.some((path) => path === active.path || active.path.endsWith("/" + path))) {
          return { file: row.tfile, fm };
        }
      }
    }
    return null;
  }
  _selectionOrClipboard(fromSelection) {
    if (fromSelection) {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      const selected = view?.editor?.getSelection?.() || "";
      if (selected.trim()) return selected.trim();
    }
    return null;
  }
  async _ensureVaultFolder(folder) {
    if (this._fileByPath(folder)) return;
    const parts = String(folder).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this._fileByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch (error) {
          if (!this._fileByPath(current)) throw error;
        }
      }
    }
  }
  async createTimestampExtract({ fromSelection = true, text = null, sourceFile = null, page = null, pageFallback = null, open = true } = {}) {
    const active = this.app.workspace.getActiveFile();
    let source = null;
    if (sourceFile) {
      const fm = this.app.metadataCache.getFileCache(sourceFile)?.frontmatter;
      if (fm && (fm.type === "source" || fm.type === "extract")) source = { file: sourceFile, fm };
    } else {
      source = this._resolveExtractSource(active);
    }
    if (!source) {
      new Notice("请先打开 Incremental Reading 来源或摘录，或对应的 PDF。");
      return null;
    }
    let body = text != null ? String(text) : this._selectionOrClipboard(fromSelection);
    if (!body) {
      try {
        body = (await navigator.clipboard.readText()).trim();
      } catch (error) {
        new Notice("无法读取剪贴板。");
        return null;
      }
    }
    body = String(body || "").trim();
    if (!body) {
      new Notice("剪贴板为空，也没有选中文字。");
      return null;
    }
    const parsed = extractCore.parsePdfSelection(body);
    let pdfPath = null;
    if (parsed.target && this._fileByPath(parsed.target)) pdfPath = parsed.target;
    if (!pdfPath) {
      for (const candidate of [source.fm.pdf_vault_path, source.fm.pdf_path]) {
        const path2 = candidate ? String(candidate).replace(/^\/+/, "").split("#")[0] : "";
        if (path2 && this._fileByPath(path2)) {
          pdfPath = path2;
          break;
        }
      }
    }
    const resolvedPage = Number(page) > 0 ? Number(page) : parsed.page || (Number(pageFallback) > 0 ? Number(pageFallback) : null) || (Number(source.fm.read_point) > 0 ? Number(source.fm.read_point) : null);
    const citation = extractCore.buildCitation({
      sourceTitle: source.file.basename,
      pdfPath,
      page: resolvedPage,
      params: parsed.params
    });
    const folder = this.extractsFolder();
    await this._ensureVaultFolder(folder);
    const baseTitle = extractCore.timestampTitle(/* @__PURE__ */ new Date());
    let name = baseTitle;
    let suffix = 1;
    while (this._fileByPath(`${folder}/${name}.md`)) name = `${baseTitle} ${++suffix}`;
    const path = `${folder}/${name}.md`;
    const priority = Math.min(100, Math.max(1, Number(source.fm.priority) || 50));
    const interval = Math.max(1, Math.ceil(priority * 0.15));
    const fmt = dateCore.normalizeDateFormat(this.settings?.misc?.date_format);
    const nextDate = /* @__PURE__ */ new Date();
    nextDate.setHours(0, 0, 0, 0);
    nextDate.setDate(nextDate.getDate() + interval);
    const content = extractCore.buildExtractContent({
      sourceTitle: source.file.basename,
      body,
      priority,
      interval,
      nextReview: dateCore.formatDate(nextDate, fmt),
      dateAdded: this._todayKey(),
      page: resolvedPage,
      citation
    });
    let created;
    try {
      created = await this.app.vault.create(path, content);
    } catch (error) {
      console.error("[MemoFlow] could not create timestamp extract", error);
      new Notice(`生成摘录失败：${error.message || "未知错误"}。请检查 Vault 写入权限和摘录文件夹。`, 7e3);
      return null;
    }
    try {
      await this.app.fileManager.processFrontMatter(source.file, (fmWriter) => {
        const current = Number(fmWriter.priority) || 50;
        fmWriter.priority = Math.min(100, current + 1);
      });
      if (typeof this._bumpAFactor === "function") {
        await this._bumpAFactor(source.file, source.fm, this.settings?.scheduling?.extract_bump || 1.05);
      }
    } catch (error) {
      console.error("[MemoFlow] extract created, but source bump failed", error);
    }
    if (typeof this._invalidateIRCollection === "function") this._invalidateIRCollection(true);
    new Notice(`已生成摘录：${name}${resolvedPage ? ` · p.${resolvedPage}` : ""}`);
    if (open) {
      try {
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(created);
      } catch (error) {
        console.error("[MemoFlow] could not open timestamp extract", error);
      }
    }
    return created;
  }
};
module.exports = MemoFlowPlugin;
