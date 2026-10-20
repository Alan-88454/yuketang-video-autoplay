/*
 * 雨课堂视频自动连播助手 — 内容脚本（ISOLATED world）
 *
 * 职责：
 *   1. 判断当前标签页是「课程学习内容页(driver)」还是「视频播放页(worker)」
 *   2. driver：扫描章节列表 → 挑出未完成的视频 → 点击打开 → 等待完成信号 → 处理下一节
 *   3. worker：接管 <video>，按设置设倍速/静音，防止误暂停，播完上报
 *   4. 关闭雨课堂的「继续观看 / 报告老师」挂机弹窗；遇到必须作答的弹窗则暂停并提示
 *   5. 提供悬浮面板与环境自检报告
 *
 * 不做的事：不拖动进度条、不跳段、不伪造进度上报、不自动答题、不自动登录。
 */
(function () {
  'use strict';

  if (window.__YKT_AUTOPLAY_LOADED__) return;
  window.__YKT_AUTOPLAY_LOADED__ = true;

  // 同源 iframe 交给顶层处理，避免重复接管播放器
  const IS_TOP = (() => {
    try {
      return window.top === window.self;
    } catch (e) {
      return false;
    }
  })();

  let topAccessible = true;
  try {
    void window.top.document;
  } catch (e) {
    topAccessible = false;
  }
  if (!IS_TOP && topAccessible) return;

  // ═══════════════════════════════════════════════════════════════════
  //  常量
  // ═══════════════════════════════════════════════════════════════════

  const VERSION = '1.0.7';

  /**
   * 「极低音量」用的音量值。
   *
   * Chromium 会为了省电把后台「听不到声音」的视频暂停掉（play() 会以
   * AbortError: video-only background media was paused to save power 被拒），
   * 于是浏览器暂停 → 脚本抢回 → 浏览器再暂停，形成每秒几百次的拉锯，
   * 视频只剩不到一半的实际速度。把 muted 关掉、音量设成极小值，
   * 浏览器就认为它在出声，不会走那条省电路径；而 -60dB 人耳听不到。
   */
  const QUIET_VOLUME = 0.001;

  const SEL = {
    chapterItems: [
      '.leaf-detail',
      '.study-unit',
      '.leaf-item',
      '.leaf-list-item',
      '.section-leaf',
      '.nav-item-leaf-box'
    ],
    player: '.xt_video_player',
    progressText: '.progress-wrap .text, .xt_video_player_current_time_display, .progress-text',
    dialogs: '.el-dialog__wrapper, .el-message-box__wrapper',
    nextButton: '.btn-next, .btnNext, [class*="next-video"]',
    title: '.header-bar, .chapter-title, .lesson-title, h1, h2'
  };

  const SKIP_ATTRS = [
    'data-pause-on-blur',
    'data-stop-on-background',
    'data-stop-on-minimize',
    'data-pause-on-hidden'
  ];

  const DONE_WORDS = ['已完成', '100%', '已读完', '已学完'];
  const LOCK_WORDS = ['未开放', '未开始', '已锁定'];
  const EXPIRE_WORDS = ['已截止', '已过期', '已结束'];
  const QUIZ_WORDS = /题目|答题|作答|下列|单选|多选|判断|填空|测验|习题/i;
  const SAFE_DISMISS = ['继续观看', '继续学习', '继续', '确定', '我知道了', '知道了', '关闭', '取消'];

  // 章节树 / 播放器控件的类名线索（用于结构无关的自动识别）
  const CHAPTER_HINT_RE = /leaf|chapter|section|node|tree|catalog|catalogue|outline|menu|sidebar|目录|章节/i;
  const VIDEO_ICON_RE = /icon--shipin|shipin|video|play-circle|playcircle|bofang|media/i;
  const LOCK_ICON_RE = /icon--suo|suo|lock|weikai/i;
  const NODE_TYPE_RE = /^(视频|音频|图文|讨论|作业|测验|考试|文档|课件|PPT|直播|录播|阅读)$/;

  const DEFAULT_SETTINGS = {
    rate: 2.0,
    mute: true,
    // auto：默认真静音，一旦发现浏览器在省电暂停后台视频就自动切成极低音量
    // muted：始终真静音（muted=true）
    // quiet：始终极低音量（muted=false + QUIET_VOLUME）
    muteMode: 'auto',
    antiPause: true,
    autoResume: true,
    closeWorkerTab: true
  };

  // ═══════════════════════════════════════════════════════════════════
  //  工具
  // ═══════════════════════════════════════════════════════════════════

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (base, jitter) => sleep(base + Math.random() * jitter);

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function text(el) {
    if (!el) return '';
    return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  async function pollFor(fn, timeout = 10000, interval = 400) {
    const t0 = Date.now();
    for (;;) {
      const value = safe(fn, null);
      if (value) return value;
      if (Date.now() - t0 > timeout) return null;
      if (!Session.running || Session.stopped) return null;
      await sleep(interval);
    }
  }

  /** 当前帧 + 一层同源 iframe 的 document 列表 */
  function collectDocuments() {
    const docs = [document];
    safe(() => {
      document.querySelectorAll('iframe').forEach((frame) => {
        try {
          if (frame.contentDocument) docs.push(frame.contentDocument);
        } catch (e) {
          /* 跨域 iframe 忽略 */
        }
      });
    }, null);
    return docs;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  存储
  // ═══════════════════════════════════════════════════════════════════

  const SETTINGS_KEY = 'ykt.settings';
  const SESSION_KEY = 'ykt.session';
  const DONE_KEY = 'ykt.done';

  const Store = {
    async get(key, fallback) {
      try {
        const res = await chrome.storage.local.get(key);
        if (res && res[key] !== undefined) return res[key];
      } catch (e) {
        /* 扩展被重载后 chrome 可能失效，走 localStorage 兜底 */
      }
      return safe(() => {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      }, fallback);
    },

    async set(key, value) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch (e) {
        /* 忽略 */
      }
      safe(() => localStorage.setItem(key, JSON.stringify(value)), null);
    },

    async remove(key) {
      try {
        await chrome.storage.local.remove(key);
      } catch (e) {
        /* 忽略 */
      }
      safe(() => localStorage.removeItem(key), null);
    }
  };

  // ═══════════════════════════════════════════════════════════════════
  //  运行时状态
  // ═══════════════════════════════════════════════════════════════════

  const Session = {
    running: false,
    paused: false,
    stopped: true,
    role: 'idle',
    courseKey: '',
    currentTitle: '',
    actualRate: null,
    counts: { total: 0, done: 0 },
    doneKeys: new Set(),
    failedKeys: new Set(),
    attempts: new Map(),
    // 实际生效的静音方式：muted（真静音）| quiet（极低音量）
    muteMode: 'muted',
    // 是否已经把整个标签页静音（极低音量模式下的兜底）
    tabMuted: false,
    lastPlayAt: 0,
    finishedVideos: new WeakSet()
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let pauseGuard = null;
  let popupTimer = null;
  /** 最近一次「视频确实在前进」的时刻——由 timeupdate/playing 这类媒体事件更新，
   *  不依赖 setInterval，所以页面被限速也不会误判成停滞 */
  let lastProgressAt = 0;
  /** 自动播放被拒绝时记下来，供自检报告定位（例如隐藏窗口的自动播放策略） */
  const PlayDiag = {
    errors: [],
    // 因「浏览器省电暂停后台视频」而被迫重播的次数，以及自动切成极低音量的记录
    powerSave: 0,
    quietSwitches: []
  };

  /** 浏览器省电暂停后台视频时，play() 的拒绝信息长这样 */
  const SAVE_POWER_RE = /save power|paused to save power|background media/i;

  /**
   * 当前这一节应该用什么方式「静音」。
   * auto 模式下会跟着 Session.muteMode 走（运行中被浏览器逼着切换过）。
   */
  function muteTargets() {
    const mode = settings.muteMode === 'auto' ? Session.muteMode : settings.muteMode;
    return mode === 'quiet'
      ? { mode: 'quiet', muted: false, volume: QUIET_VOLUME }
      : { mode: 'muted', muted: true, volume: 0 };
  }

  /**
   * 倍速策略（跨视频保留学习结果）：
   *   direct → 直接设 video.playbackRate
   *   ui     → 改点播放器自带的倍速菜单
   *   failed → 两条路都不行，回落原速
   */
  const RateStrategy = {
    mode: 'direct',
    directTries: 0,
    uiTries: 0,
    lastUiAt: 0,
    failed: false,
    warnedWrongMenu: false
  };

  /** 静音策略：同倍速，先直接设，设不住就改点播放器自带的音量按钮 */
  const MuteStrategy = { mode: 'direct', directTries: 0, uiTries: 0, lastUiAt: 0 };

  // ═══════════════════════════════════════════════════════════════════
  //  页面识别
  // ═══════════════════════════════════════════════════════════════════

  function courseKeyFromUrl() {
    const p = location.pathname;
    return (
      (p.match(/\/pro\/lms\/([^/]+)\/([^/]+)/) || [])[0] ||
      (p.match(/\/v2\/web\/studentLog\/([^/]+)/) || [])[0] ||
      (p.match(/\/ai-workspace\/lms-graph\/([^/]+)/) || [])[0] ||
      (p.match(/\/pro\/lms\/([^/]+)/) || [])[0] ||
      location.origin + p
    );
  }

  function allVideos() {
    const out = [];
    for (const doc of collectDocuments()) {
      const list = safe(() => doc.querySelectorAll('video'), null);
      if (list) list.forEach((v) => out.push(v));
    }
    return out.filter((v) => !Session.finishedVideos.has(v));
  }

  /** 真正"在用"的播放器：正在播放、已推进过进度、或可见 */
  function findActiveVideo() {
    const videos = allVideos();
    return (
      videos.find((v) => !v.paused || Number(v.currentTime) > 0 || isVisible(v)) || null
    );
  }

  /** 兜底版本：优先返回"在用"的，其次返回页面上任意一个 video */
  function findVideo() {
    const videos = allVideos();
    return findActiveVideo() || videos[0] || null;
  }

  /**
   * 「已经加载好、正等着被播」的播放器。
   *
   * 雨课堂切下一节时会先把新视频的元数据加载好（duration 已知）却停在第 0 秒，
   * 而且播放器在 unload 状态下会把 <video> 尺寸压成 0 —— 这时 findActiveVideo()
   * 既不满足"在播"也不满足"可见"，会返回 null。早期版本因此判定"没找到播放器"，
   * 等 10 秒就放弃这一节，表现就是「视频卡在 0 秒不动」。
   */
  function findTakeableVideo() {
    const videos = allVideos();
    return (
      videos.find((v) => {
        const d = safe(() => Number(v.duration), NaN);
        if (!Number.isFinite(d) || d <= 0) return false;
        if (safe(() => v.ended, false)) return false;
        // 停在片尾的（上一节的遗留）不算，否则会把"刚看完的那一节"再当成新的
        if (safe(() => Number(v.currentTime), 0) >= d - 0.5) return false;
        return true;
      }) || null
    );
  }

  /** 诊断专用：只要页面上有 <video> 就返回，不受"已播完"过滤影响 */
  function firstVideoEl() {
    for (const doc of collectDocuments()) {
      const v = safe(() => doc.querySelector('video'), null);
      if (v) return v;
    }
    return null;
  }

  function hasChapterList() {
    if (chapterItemSelector() !== null) return true;
    const found = discoverChapterItems();
    return !!(found && found.items && found.items.length);
  }

  function chapterItemSelector() {
    for (const sel of SEL.chapterItems) {
      const found = safe(() => document.querySelectorAll(sel), null);
      if (found && found.length) return sel;
    }
    return null;
  }

  function knownSelectorCount() {
    const sel = chapterItemSelector();
    if (!sel) return 0;
    return safe(() => document.querySelectorAll(sel).length, 0);
  }

  function detectRole() {
    // 有章节树就由本页主导：新版学习空间会把目录和播放器放在同一页
    if (hasChapterList()) return 'driver';

    // 注意：课程页里可能已经存在隐藏的 <video>，所以必须用"在用"判定
    const video = findActiveVideo();
    const playerNode = safe(() => document.querySelector(SEL.player), null);
    if (video || (playerNode && isVisible(playerNode))) return 'worker';
    if (/\/pro\/lms\/.+\/(video|graph)\//.test(location.pathname)) return 'worker';
    if (/studycontent|studentLog|lms-graph/.test(location.pathname)) return 'driver';
    return 'idle';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  章节列表自动识别（结构无关）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 已知类名没命中时，靠"容器里有一批结构相同的子元素"来找章节树。
   * 结果缓存 2 秒，避免频繁全量扫描 DOM。
   */
  function discoverChapterItems() {
    if (discoverChapterItems._cache && Date.now() - discoverChapterItems._at < 2000) {
      return discoverChapterItems._cache;
    }

    let best = null;
    const all = safe(() => document.querySelectorAll('*'), null);
    const CONTAINER_TAGS = {
      DIV: 1, UL: 1, OL: 1, NAV: 1, ASIDE: 1, SECTION: 1, MAIN: 1, TBODY: 1, DL: 1, ARTICLE: 1
    };
    if (all) {
      for (const el of all) {
        if (!CONTAINER_TAGS[el.tagName]) continue;
        const kids = el.children;
        if (!kids || kids.length < 3) continue;
        if (safe(() => !!el.querySelector('video'), false)) continue; // 排除播放器区域

        const groups = new Map();
        for (const kid of kids) {
          const sig =
            kid.tagName + '|' + (typeof kid.className === 'string' ? kid.className.trim() : '');
          if (!groups.has(sig)) groups.set(sig, []);
          groups.get(sig).push(kid);
        }
        let group = null;
        for (const list of groups.values()) if (!group || list.length > group.length) group = list;
        if (!group || group.length < 3) continue;

        const hay =
          (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
        const bodyText = text(el);
        const rect = safe(() => el.getBoundingClientRect(), { width: 0, height: 0 });

        let score = group.length;
        if (CHAPTER_HINT_RE.test(hay)) score += 6;
        if (/视频/.test(bodyText)) score += 3;
        if (/已完成|未完成|未读|已读/.test(bodyText)) score += 3;
        if (rect.height > rect.width) score += 2;

        if (!best || score > best.score) {
          best = { score, items: group, container: el };
        }
      }
    }

    // 雨课堂新版每章各自一个列表（.nav-item-list），只取"最大的那个"会漏掉其它章。
    // 这里把全文档中所有同构容器的小节按文档顺序合并成一条完整序列。
    if (best) {
      const sigOf = (n) =>
        n.tagName + '|' + (typeof n.className === 'string' ? n.className.trim() : '');
      const bestSig = sigOf(best.container);

      const sameSig = [];
      for (const el of all) if (sigOf(el) === bestSig) sameSig.push(el);

      if (sameSig.length > 1) {
        const merged = [];
        const seen = new Set();
        for (const el of sameSig) {
          const groups = new Map();
          for (const kid of el.children) {
            const s =
              kid.tagName + '|' + (typeof kid.className === 'string' ? kid.className.trim() : '');
            if (!groups.has(s)) groups.set(s, []);
            groups.get(s).push(kid);
          }
          let g = null;
          for (const list of groups.values()) if (!g || list.length > g.length) g = list;
          if (!g) continue;
          for (const kid of g) {
            if (seen.has(kid)) continue;
            seen.add(kid);
            merged.push(kid);
          }
        }
        if (merged.length > best.items.length) {
          best = { score: best.score, items: merged, container: best.container };
        }
      }
    }

    discoverChapterItems._cache = best;
    discoverChapterItems._at = Date.now();
    return best;
  }

  /** 从小节里找类型标签（视频/图文/作业/…），新版界面常用一个小标签表示 */
  function nodeTypeLabel(el) {
    const cands = safe(() => el.querySelectorAll('span, em, b, small, i, div'), null);
    if (!cands) return '';
    for (const node of cands) {
      const t = text(node);
      if (t && t.length <= 4 && NODE_TYPE_RE.test(t)) return t;
    }
    return '';
  }

  /**
   * 雨课堂新版学习空间的完成状态是"画出来"的，没有文字：
   *   已完成   → .leaf-item-status 里一个 <i class="iconfont icon-yuanquangou-...">
   *   部分观看 → .leaf-item-status 里一个 <div class="status-pie" style="--p: N">
   *   未开始   → .leaf-item-status 是空的
   * 返回 'done' | 'partial' | 'none' | 'unknown'
   */
  function videoStatusKind(el) {
    const root = safe(() => el.querySelector('.leaf-item-status'), null);
    if (!root) return 'unknown';
    if (safe(() => !!root.querySelector('.status-pie'), false)) return 'partial';
    if (safe(() => !!root.querySelector('i, svg'), false)) return 'done';
    return 'none';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  章节扫描
  // ═══════════════════════════════════════════════════════════════════

  function classifyItem(el) {
    const body = text(el);
    const iconText = safe(
      () =>
        Array.from(el.querySelectorAll('i, svg, em, [class*="icon"]'))
          .map((n) => {
            const c = typeof n.className === 'string' ? n.className : '';
            const d = safe(() => n.getAttribute('data-icon') || '', '');
            return c + ' ' + d;
          })
          .join(' '),
      ''
    );
    const cls = typeof el.className === 'string' ? el.className : '';
    const typeLabel = nodeTypeLabel(el);

    if (LOCK_ICON_RE.test(iconText) || LOCK_WORDS.some((w) => body.includes(w))) return 'locked';
    if (EXPIRE_WORDS.some((w) => body.includes(w))) return 'expired';

    const isVideo = VIDEO_ICON_RE.test(iconText) || typeLabel === '视频' || typeLabel === '音频';
    if (!isVideo) return 'other';

    // 新版学习空间：状态区域里是"已完成"图标时直接判定。
    // 注意只有 'done' 才提前返回——'partial' / 'none' 要留给下面的文字判断，
    // 否则会把"状态标记为空但别处写着已完成"的布局误判成未完成。
    const statusKind = videoStatusKind(el);
    if (statusKind === 'done') return 'video-done';

    // 雨课堂新版把"已完成"画成一个图标，没有文字。这里只采信显式标注
    // （title / aria-label / data-status）；不去猜类名——猜错方向会漏看视频，
    // 比多花时间严重得多。真正的图标标记靠 structure.itemMarkup 确认后再固化。
    const statusRoot = safe(
      () => el.querySelector('.leaf-item-status, .leaf-item-right, .leaf-flag, .status'),
      null
    );
    const statusText = statusRoot ? text(statusRoot) : '';
    const statusLabels = statusRoot
      ? safe(
          () =>
            [statusRoot, ...statusRoot.querySelectorAll('*')]
              .map((n) =>
                ['title', 'aria-label', 'data-status', 'data-state']
                  .map((k) => safe(() => n.getAttribute(k) || '', ''))
                  .join(' ')
              )
              .join(' '),
          ''
        )
      : '';
    const done =
      DONE_WORDS.some((w) => body.includes(w)) ||
      /is-complete|finished|completed|is-done|is-finish|is-success|passed/i.test(cls) ||
      /^(已完成|已学完|已读|完成)$/.test(statusText) ||
      DONE_WORDS.some((w) => statusLabels.includes(w));
    return done ? 'video-done' : 'video-todo';
  }

  function scanChapters() {
    let nodes = null;
    let source = 'selector';

    const selector = chapterItemSelector();
    if (selector) nodes = Array.from(document.querySelectorAll(selector));

    if (!nodes || !nodes.length) {
      const found = discoverChapterItems();
      if (found && found.items && found.items.length) {
        nodes = found.items;
        source = 'auto';
      }
    }
    if (!nodes || !nodes.length) return [];

    if (source === 'auto' && !scanChapters._warned) {
      scanChapters._warned = true;
      log('章节列表使用自动识别（已知类名未命中），建议跑一次「环境自检」确认结果');
    }

    const courseKey = courseKeyFromUrl();
    let items = nodes.map((el, index) => {
      // 标题必须排除"状态/类型"文字，否则小节状态一变 key 就跟着变，
      // 已完成的节会被重新挑出来再播一遍。
      const titleNode = safe(
        () => el.querySelector('.leaf-item-title, .node-title, .leaf-title, h2'),
        null
      );
      const title = ((titleNode ? text(titleNode) : text(el)) || '').slice(0, 80);
      const nodeId = safe(
        () =>
          el.getAttribute('data-node-id') ||
          el.getAttribute('data-id') ||
          el.getAttribute('data-leaf-id') ||
          el.id ||
          '',
        ''
      );
      return {
        el,
        index,
        title: title || `第 ${index + 1} 项`,
        key: nodeId ? `${courseKey}::node:${nodeId}` : `${courseKey}::${index}::${title}`,
        kind: classifyItem(el)
      };
    });

    // 兜底：一个视频都没识别出来时，用文字宽松匹配一次，并留下警告
    if (!items.some((i) => i.kind === 'video-todo' || i.kind === 'video-done')) {
      const loose = items.map((item) => {
        const body = text(item.el);
        if (item.kind === 'locked' || item.kind === 'expired') return item;
        if (!/视频/.test(body)) return item;
        const done = DONE_WORDS.some((w) => body.includes(w));
        return Object.assign({}, item, { kind: done ? 'video-done' : 'video-todo', loose: true });
      });
      if (loose.some((i) => i.loose)) {
        log('⚠️ 图标未命中，已改用文字宽松匹配识别视频，建议跑一次「环境自检」');
        items = loose;
      }
    }

    return items;
  }

  function clickItem(item) {
    const el = item.el;
    if (!el) {
      log(`⚠️ 章节「${item.title}」没有可点击的元素，已跳过`);
      return false;
    }
    safe(() => el.scrollIntoView({ block: 'center' }), null);
    const target = safe(
      () => el.querySelector('.leaf-item-title, a, span, h2') || el,
      el
    );
    safe(() => target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })), null);
    const ok = safe(() => {
      target.click();
      return true;
    }, false);
    if (!ok) log(`⚠️ 章节「${item.title}」点击失败`);
    return ok;
  }

  /** 章节被折叠时，点一下它上层的章标题把它展开 */
  function tryExpandChapter(el) {
    let node = el.parentElement;
    let depth = 0;
    while (node && depth < 8) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (/nav-item-node/.test(cls)) {
        log('该小节所在的章节似乎被折叠，尝试展开');
        safe(() => node.click(), null);
        return true;
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  播放器控制
  // ═══════════════════════════════════════════════════════════════════

  function stripPauseAttributes(video) {
    SKIP_ATTRS.forEach((attr) => {
      safe(() => video.removeAttribute(attr), null);
      let node = video.parentElement;
      let depth = 0;
      while (node && depth < 6) {
        safe(() => node.removeAttribute(attr), null);
        node = node.parentElement;
        depth += 1;
      }
    });
  }

  function ensurePlaying(video) {
    if (!Session.running || Session.paused) return;
    if (!video || !video.paused) return;
    // 播完 / 停在片尾时绝不能重播，否则会把整段视频白放一遍
    if (video.ended) return;
    const dur = Number(video.duration);
    if (Number.isFinite(dur) && dur > 0 && Number(video.currentTime) >= dur - 0.3) return;

    // 节流：浏览器和脚本互抢时，每秒抢几百次毫无意义，只会白烧 CPU
    const now0 = Date.now();
    const recent = ensurePlaying._recent || (ensurePlaying._recent = []);
    while (recent.length && now0 - recent[0] > 10000) recent.shift();
    const fighting = recent.length > 25;
    const gap = fighting ? 700 : 150;
    if (now0 - Session.lastPlayAt < gap) return;
    Session.lastPlayAt = now0;
    recent.push(now0);
    if (fighting && now0 - (ensurePlaying._fightLoggedAt || 0) > 60000) {
      ensurePlaying._fightLoggedAt = now0;
      log(
        `⚠️ 播放被反复打断（10 秒内 ${recent.length} 次）。如果一直这样，` +
          '请在 Edge「设置 → 系统和性能」里关闭「效率模式 / 睡眠标签页」，或把本站在例外里。'
      );
    }

    // 先静音再播放：窗口最小化/隐藏时，未静音的 play() 可能被浏览器的自动播放策略拒掉
    if (settings.mute) {
      const want = muteTargets();
      safe(() => {
        video.muted = want.muted;
        video.volume = want.volume;
      }, null);
    }
    const p = safe(() => video.play(), null);
    if (p && typeof p.catch === 'function') {
      p.catch((e) => {
        const now = Date.now();
        const name = (e && e.name) || 'Error';
        const message = String((e && e.message) || '');
        PlayDiag.errors.push({
          at: new Date(now).toISOString(),
          name,
          message: message.slice(0, 160)
        });
        if (PlayDiag.errors.length > 10) PlayDiag.errors.shift();
        if (SAVE_POWER_RE.test(message)) {
          PlayDiag.powerSave += 1;
          escalateQuietMode(name + ': ' + message.slice(0, 80));
        }
        // 同一种错误最多每 10 秒提示一次，避免刷屏
        if (now - (ensurePlaying._lastLogAt || 0) > 10000) {
          ensurePlaying._lastLogAt = now;
          log(`⚠️ 自动播放被拒绝：${name}（${message.slice(0, 60)}）`);
        }
      });
    }
    return p;
  }

  /**
   * 浏览器把后台「听不到声音」的视频暂停省电了 —— 不再真静音，改用极低音量。
   * 用户自己指定了静音方式时不动（那是用户的选择）。
   *
   * 阶梯：
   *   1. 真静音（muted）—— 最安静，但会被浏览器当成"无声视频"省电暂停
   *   2. 极低音量（muted=false + 极小声）—— 浏览器不再暂停它
   *   3. 极低音量 + 标签页静音 —— 连那一点点声音也不让你听到
   */
  function escalateQuietMode(reason) {
    if (!settings.mute) return;
    if (settings.muteMode !== 'auto') return;
    if (Session.muteMode === 'quiet' && Session.tabMuted) return;

    const firstTime = Session.muteMode !== 'quiet';
    if (firstTime) {
      Session.muteMode = 'quiet';
      PlayDiag.quietSwitches.push({ at: new Date().toISOString(), reason: reason.slice(0, 120) });
    } else {
      PlayDiag.quietSwitches.push({
        at: new Date().toISOString(),
        reason: '极低音量仍被省电暂停：' + reason.slice(0, 100)
      });
    }

    // 标签页静音：让"极低音量"在听感上也等于完全静音。
    // 内容脚本没有 chrome.tabs 写权限，交给后台 Service Worker 做。
    Session.tabMuted = true;
    sendToBackground('ykt:mute-tab', { muted: true });

    if (firstTime) {
      log(
        `⚠️ 浏览器为省电暂停了后台无声音的视频，已自动改为「极低音量」模式（音量 ${QUIET_VOLUME}），` +
          '并把本标签页静音 —— 你听不到声音，但浏览器不会再把它当"无声视频"暂停。'
      );
      ui.toast(
        '⚠️ 已自动切换为「极低音量 + 标签页静音」：浏览器会暂停无声音的后台视频。' +
          '想恢复原样，可在面板把「静音方式」改成「真静音」。',
        15000
      );
    } else {
      log('⚠️ 极低音量仍被省电暂停，已用标签页静音兜底');
    }

    MuteStrategy.mode = 'direct';
    MuteStrategy.directTries = 0;
    syncMediaLock();
    const v = findVideo();
    if (v) {
      applyVolume(v);
      ensurePlaying(v);
    }
  }

  /**
   * 显式暂停当前视频。
   * 注意：脚本运行在隔离世界，这里的 video.pause() 走的是原生实现，
   * 不会被主世界那把「吞掉页面 pause()」的锁拦住（两边的原型链是分开的）。
   */
  function pauseCurrentVideo() {
    const video = findVideo();
    if (video) safe(() => video.pause(), null);
  }

  function applyVolume(video) {
    if (!video || !settings.mute) return;

    const want = muteTargets();
    const stuck = () =>
      safe(() => !!video.muted !== want.muted || Math.abs(Number(video.volume) - want.volume) > 0.02, true);

    if (!stuck()) {
      MuteStrategy.directTries = 0;
      return;
    }

    if (MuteStrategy.mode === 'direct') {
      safe(() => {
        video.muted = want.muted;
        video.volume = want.volume;
      }, null);
      MuteStrategy.directTries += 1;
      if (MuteStrategy.directTries >= 6) {
        MuteStrategy.mode = 'ui';
        log('直接静音没生效，改用播放器自带的音量按钮');
      }
      return;
    }

    // 播放器自带音量按钮：点一下切换静音
    if (Date.now() - MuteStrategy.lastUiAt < 4000) return;
    MuteStrategy.lastUiAt = Date.now();
    MuteStrategy.uiTries += 1;
    const btn = safe(
      () => document.querySelector('xt-volumebutton, .xt_video_player_volume'),
      null
    );
    if (btn) {
      // 只在当前没静音时点，避免把已经静音的又切回有声
      if (!safe(() => !!video.muted, false)) applyMuteViaPlayerUI().catch(() => {});
    } else if (MuteStrategy.uiTries >= 6) {
      MuteStrategy.mode = 'direct';
      MuteStrategy.directTries = 0;
      MuteStrategy.uiTries = 0;
    }
  }

  /**
   * 通过播放器自带的倍速菜单切倍速。
   * 雨课堂(xuetangx)的播放器不认直接设置 video.playbackRate —— 它以自己的倍速状态为准，
   * 会把我们设的值拉回去。只有点它菜单里的 "2.00X" 才真正生效（播放器界面也会同步）。
   */
  /** 找出播放器的倍速菜单（排除音量菜单） */
  function findSpeedMenu() {
    const lists = safe(
      () =>
        Array.from(
          document.querySelectorAll('ul.xt_video_player_common_list, [class*="common_list"]')
        ),
      []
    );
    for (const ul of lists) {
      const items = safe(() => Array.from(ul.querySelectorAll('li')), []);
      if (!items.length) continue;
      const speeds = items.map((li) => {
        const m = text(li).match(/^(\d+(?:\.\d+)?)\s*X$/i);
        return m ? parseFloat(m[1]) : null;
      });
      const looksLikeVolume = items.some((li) => /%/.test(text(li)));
      if (speeds.some((s) => s !== null) && !looksLikeVolume) {
        return { menu: ul, items, speeds };
      }
    }
    return null;
  }

  /**
   * 展开菜单用：只发 hover 类事件，绝不发 click。
   * 菜单往往就是靠 hover 展开的，若顺手再点一下按钮，反而会把它关掉。
   */
  function fireHover(el) {
    if (!el) return;
    const mouse = ['mouseenter', 'mouseover', 'mousemove'];
    const pointer = ['pointerover', 'pointerenter', 'pointermove'];
    mouse.forEach((type) => {
      safe(
        () => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })),
        null
      );
    });
    pointer.forEach((type) => {
      safe(() => el.dispatchEvent(makePointerEvent(type)), null);
    });
  }

  function makePointerEvent(type) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      pointerType: 'mouse',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1
    };
    return typeof PointerEvent === 'function'
      ? new PointerEvent(type, init)
      : new MouseEvent(type, init);
  }

  /**
   * 真正"点一下"。现代播放器普遍监听 Pointer Events（pointerdown），
   * 只发 MouseEvent 是打不到它的处理函数的，所以两套都发。
   */
  function fireActivate(el) {
    if (!el) return;
    ['pointerdown', 'pointerup'].forEach((type) => {
      safe(() => el.dispatchEvent(makePointerEvent(type)), null);
    });
    ['mousedown', 'mouseup', 'click'].forEach((type) => {
      safe(
        () =>
          el.dispatchEvent(
            new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window })
          ),
        null
      );
    });
    safe(() => el.click(), null);
  }

  let rateUiBusy = false;

  /**
   * 通过播放器自己的倍速菜单切倍速。
   *
   * 三个要点都是真机上踩出来的：
   *   1. 只用 hover 展开菜单，绝不点倍速按钮 —— 点它会把刚展开的菜单又关掉
   *   2. 展开后重新查一次菜单 —— hover 时列表可能被替换，旧节点点了没用
   *   3. 要发 PointerEvent —— 播放器监听的是 pointerdown，只发 MouseEvent 打不到
   */
  async function applyRateViaPlayerUI(target) {
    if (rateUiBusy) return false;
    rateUiBusy = true;
    try {
      let found = findSpeedMenu();
      if (!found) return false;

      const button =
        safe(() => found.menu.closest('xt-speedbutton, .xt_video_player_speed'), null) ||
        safe(() => document.querySelector('xt-speedbutton, .xt_video_player_speed'), null) ||
        safe(() => found.menu.parentElement, null);

      if (button && !isVisible(found.menu)) {
        fireHover(button);
        await sleep(300);
        found = findSpeedMenu() || found;
      }

      const idx = found.speeds.findIndex((s) => s !== null && Math.abs(s - target) < 0.001);
      if (idx < 0) return false;

      const li = found.items[idx];
      fireHover(li);
      fireActivate(li);
      const inner = safe(
        () => Array.from(li.querySelectorAll('*')).find((n) => text(n).length > 0),
        null
      );
      if (inner) fireActivate(inner);
      return true;
    } finally {
      rateUiBusy = false;
    }
  }

  /** 通过播放器自己的音量按钮静音（同样是 PointerEvent 路径） */
  async function applyMuteViaPlayerUI() {
    const btn = safe(
      () => document.querySelector('xt-volumebutton, .xt_video_player_volume'),
      null
    );
    if (!btn) return false;
    fireHover(btn);
    await sleep(200);
    fireActivate(btn);
    await sleep(250);
    return true;
  }

  function startPauseGuard(video) {
    stopPauseGuard();

    const kick = () => {
      if (!Session.running || Session.paused) return;
      const current = findVideo();
      if (current) ensurePlaying(current);
    };

    // 页面把视频按停时立刻抢回播放权。用一组短间隔补抢，
    // 因为页面可能在切下一节的过程中连续按停好几次。
    const onPause = () => {
      if (!Session.running || Session.paused) return;
      [0, 200, 700, 1800].forEach((delay) => setTimeout(kick, delay));
    };
    // 媒体事件不会被页面限速，用它们维护「视频确实在前进」的时间戳
    const onProgress = () => {
      lastProgressAt = Date.now();
    };

    safe(() => video.addEventListener('pause', onPause), null);
    safe(() => video.addEventListener('timeupdate', onProgress), null);
    safe(() => video.addEventListener('playing', onProgress), null);

    const timer = setInterval(() => {
      if (!Session.running || Session.paused) return;
      kick();
    }, 2000);

    pauseGuard = {
      stop() {
        clearInterval(timer);
        safe(() => video.removeEventListener('pause', onPause), null);
        safe(() => video.removeEventListener('timeupdate', onProgress), null);
        safe(() => video.removeEventListener('playing', onProgress), null);
      }
    };
  }

  function stopPauseGuard() {
    if (pauseGuard) {
      safe(() => pauseGuard.stop(), null);
      pauseGuard = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  弹窗处理
  // ═══════════════════════════════════════════════════════════════════

  function clickButtonByLabels(container, labels) {
    const buttons = safe(
      () =>
        Array.from(
          container.querySelectorAll(
            'button, .el-button, .el-message-box__btns a, [role="button"], .btn'
          )
        ),
      []
    );
    for (const label of labels) {
      const hit = buttons.find((b) => text(b).includes(label));
      if (hit && !hit.disabled) {
        safe(() => hit.click(), null);
        return true;
      }
    }
    return false;
  }

  /**
   * 返回 'dismissed' | 'quiz' | null
   * 只处理已知的雨课堂挂机弹窗；不认识的弹窗一律不动。
   */
  function handlePopups() {
    const wrappers = safe(() => document.querySelectorAll(SEL.dialogs), null);
    if (!wrappers) return null;

    for (const wrapper of wrappers) {
      if (!isVisible(wrapper)) continue;
      const body = text(wrapper);
      if (!body) continue;

      if (body.includes('继续观看') || body.includes('好好学习')) {
        if (clickButtonByLabels(wrapper, ['继续观看', '继续学习', '继续'])) {
          log('已关闭「继续观看」提示');
          return 'dismissed';
        }
        continue;
      }

      if (body.includes('报告老师')) {
        if (clickButtonByLabels(wrapper, ['取消', '否', '关闭'])) {
          log('已关闭「报告老师」提示');
          return 'dismissed';
        }
        continue;
      }

      if (QUIZ_WORDS.test(body)) {
        const canDismiss = SAFE_DISMISS.some((label) =>
          safe(
            () =>
              Array.from(wrapper.querySelectorAll('button, .el-button, [role="button"]')).some(
                (b) => text(b).includes(label) && !b.disabled
              ),
            false
          )
        );
        if (!canDismiss) return 'quiz';
      }
    }
    return null;
  }

  function startPopupTimer() {
    stopPopupTimer();
    popupTimer = setInterval(() => {
      const result = handlePopups();
      if (result === 'quiz') {
        stall('检测到需要作答的弹窗，已暂停等待你手动处理');
      }
    }, 1200);
  }

  function stopPopupTimer() {
    if (popupTimer) {
      clearInterval(popupTimer);
      popupTimer = null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  进度文字
  // ═══════════════════════════════════════════════════════════════════

  /** 解析 "00:01:41 / 00:01:41" 这类时间显示，返回秒数 */
  function parseTimePair(raw) {
    const m = String(raw).match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*\/\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (!m) return null;
    const toSec = (s) => {
      const p = s.split(':').map(Number);
      return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    };
    return { now: toSec(m[1]), total: toSec(m[2]) };
  }

  /**
   * 播放器自身的完成信号。
   * 关键：只在"播放器区域"内判断，绝不扫描整页——雨课堂侧边目录和右下角
   * 状态条到处都写着"已完成"，全页扫描会把没看的视频误判成已播完。
   */
  function isProgressComplete() {
    const TIME_SEL =
      '.xt_video_player_current_time_display, .progress-wrap .text, .progress-text, xt-time';
    const SCOPE_SEL = '.xt_video_player, .xtplayer, .learning-center-player, #player';

    for (const doc of collectDocuments()) {
      // 1) 播放器时间显示：当前时间 == 总时长 即播完
      const timeNodes = safe(() => doc.querySelectorAll(TIME_SEL), null);
      if (timeNodes) {
        for (const node of timeNodes) {
          const pair = parseTimePair(text(node));
          if (pair && pair.total > 0 && pair.now >= pair.total - 1) return true;
        }
      }

      // 2) 只认播放器区域内的 100% / 已学完
      const scopes = safe(() => doc.querySelectorAll(SCOPE_SEL), null);
      if (scopes) {
        for (const scope of scopes) {
          if (scope.tagName === 'VIDEO') continue;
          if (/(^|[^0-9])100\s*%|已学完/.test(text(scope))) return true;
        }
      }
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════
  //  完成判定
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 接管一个 <video> 并等待它自然播放结束。
   * 返回 reason: ended | rewind | reachedEnd | progressText | quiz | stalled | timeout | novideo
   */
  function watchVideo(firstVideo) {
    let done = false;
    let bound = null;
    let bindStart = 0; // 本次绑定时的起始播放位置；换源 / 重播时重建基线
    let maxTime = 0; // 绑定以来见过的最大播放位置
    let lastTime = 0;
    let lastAdvanceAt = Date.now();
    let boundAt = Date.now();
    let boundEnded = false; // 绑定时这个播放器是不是已经播完了
    let resolvedReason = null;
    let resolveFn = null;

    const t0 = Date.now();

    const promise = new Promise((resolve) => {
      resolveFn = resolve;
    });

    function finish(reason) {
      if (done) return;
      done = true;
      resolvedReason = reason;
      cleanup();
      resolveFn(reason);
    }

    function needDelta() {
      // 绑定时播放器已经播完（雨课堂常复用同一个 <video> 元素）：要求足够的前进量，
      // 避免把"上一节的片尾位置"当成这一节已播完。
      // 绑定时还在播（例如从上次进度续播）：只要有一点前进就够，否则续播的短视频永远判不完。
      if (!boundEnded) return 1;
      const dur = bound ? Number(bound.duration) : NaN;
      if (Number.isFinite(dur) && dur > 0) return Math.min(5, dur * 0.6);
      return 5;
    }

    /** 本次绑定后真实前进的秒数，用来排除"根本没播起来"的误判 */
    function advanced() {
      return Math.max(0, maxTime - bindStart);
    }

    function onEnded() {
      if (advanced() >= needDelta()) finish('ended');
    }

    function durationOf() {
      const dur = bound ? Number(bound.duration) : NaN;
      return Number.isFinite(dur) && dur > 0 ? dur : 0;
    }

    function bind(video) {
      if (bound) safe(() => bound.removeEventListener('ended', onEnded), null);
      bound = video;
      safe(() => bound.addEventListener('ended', onEnded), null);
      // 打上「当前接管对象」的标记：主世界只对这一只吞 pause()，
      // 这样旧的那个 <video> 该停还是能停，不会出现两个视频同时在放
      safe(() => {
        document.querySelectorAll('video[data-ykt-current]').forEach((v) => {
          if (v !== bound) v.removeAttribute('data-ykt-current');
        });
        bound.setAttribute('data-ykt-current', '1');
      }, null);
      const cur = Number(bound.currentTime) || 0;
      bindStart = cur;
      maxTime = cur;
      boundEnded = !!bound.ended;
      // 用 cur 而不是 0：雨课堂常常复用同一个 <video>，绑定时它还停在上一节的片尾，
      // 下一 tick 换源会跳到 0，靠这个值才能识别出"换了新的一节"并重建基线。
      lastTime = cur;
      lastAdvanceAt = Date.now();
      lastProgressAt = Date.now();
      boundAt = Date.now();
      stripPauseAttributes(bound);
      applyVolume(bound);
      ensurePlaying(bound);
      startPauseGuard(bound);
      ui.setVideoInfo(bound);
    }

    /** 检测到换源 / 重播时重建基线，避免把"上一节结束位置"当成已播放进度 */
    function rebaseline(cur) {
      bindStart = cur;
      maxTime = cur;
      boundEnded = false;
      lastTime = cur;
      lastAdvanceAt = Date.now();
      boundAt = Date.now();
    }

    function tickRate() {
      if (!bound) return;
      const target = Number(settings.rate) || 1;
      const actual = Number(bound.playbackRate) || 1;

      if (target > 1 && !RateStrategy.failed) {
        // actual 是"本 tick 开始时"的实际值 —— 刚设完立刻读回永远是成功的，
        // 必须看它能不能撑过一个 tick，才能发现播放器把倍速拉回去。
        if (Math.abs(actual - target) <= 0.01) {
          RateStrategy.directTries = 0;
        } else if (RateStrategy.mode === 'direct') {
          safe(() => {
            bound.playbackRate = target;
          }, null);
          RateStrategy.directTries += 1;
          if (RateStrategy.directTries >= 4) {
            RateStrategy.mode = 'ui';
            log(`直接设置 ${target}x 没生效，改用播放器自带的倍速菜单`);
          }
        } else if (Date.now() - RateStrategy.lastUiAt >= 3000) {
          RateStrategy.lastUiAt = Date.now();
          RateStrategy.uiTries += 1;
          if (!findSpeedMenu()) {
            if (RateStrategy.uiTries >= 4) {
              RateStrategy.failed = true;
              log(`⚠️ 找不到播放器的倍速菜单，无法切到 ${target}x，将按原速播放`);
              settings.rate = 1;
              ui.syncSettings();
              syncMediaLock();
              safe(() => {
                bound.playbackRate = 1;
              }, null);
            }
          } else {
            applyRateViaPlayerUI(target).catch(() => {});
          }

          if (RateStrategy.uiTries >= 20 && !RateStrategy.warnedWrongMenu) {
            // 菜单点到了但倍速没变 —— 多半是点击方式还是不对
            RateStrategy.warnedWrongMenu = true;
            log(
              `⚠️ 点了播放器的倍速菜单但倍速仍是 ${Number(bound.playbackRate) || 1}x。` +
                '请点「环境自检」把报告发我（看 structure.speedMenu）。'
            );
            ui.toast('⚠️ 自动切 2x 没成功，请把「环境自检」报告发给作者。', 0);
          }
        }
      }

      const now = Number(bound.playbackRate) || 1;
      if (now !== Session.actualRate) {
        Session.actualRate = now;
        ui.setStatus();
      }
    }

    function tick() {
      if (done) return;
      if (Session.stopped) {
        finish('stopped');
        return;
      }

      const popupResult = handlePopups();
      if (popupResult === 'quiz') {
        finish('quiz');
        return;
      }

      const video = findVideo() || (bound && bound.isConnected ? bound : null);
      if (!video) {
        if (Date.now() - t0 > 30000) finish('novideo');
        return;
      }
      if (video !== bound) bind(video);

      tickRate();
      applyVolume(bound);
      if (bound.paused) ensurePlaying(bound);

      const cur = Number(bound.currentTime) || 0;

      // 位置大幅回退：要么是「播完自动重播」（判定完成），要么是换到了下一节（重建基线）
      if (lastTime > 0 && cur < lastTime - 2) {
        if (advanced() >= needDelta()) {
          finish('rewind');
          return;
        }
        rebaseline(cur);
        return;
      }

      if (cur > lastTime + 0.15) {
        lastAdvanceAt = Date.now();
        lastProgressAt = Date.now();
      }
      if (cur > maxTime) maxTime = cur;
      lastTime = cur;

      ui.setVideoInfo(bound);

      const dur = durationOf();
      if (dur > 0 && cur >= dur - 0.35 && advanced() >= needDelta()) {
        finish('reachedEnd');
        return;
      }

      // 播放器时间文字只能当"确认真到了结尾"的旁证，不能独立作为完成依据：
      // 时间显示是向下取整的，"00:03 / 00:03" 在还剩将近 1 秒时就出现了，
      // 只按文字判断会在视频只播到七成时就把这一节切走（漏看视频）。
      // 只有拿不到时长（duration 未知）时才退回到纯文字判断。
      if (advanced() >= needDelta() && isProgressComplete()) {
        if (dur <= 0 || cur >= dur - 0.5) {
          finish('progressText');
          return;
        }
      }

      const elapsed = Date.now() - boundAt;
      const budget =
        dur > 0 ? (dur / Math.max(Number(settings.rate) || 1, 1)) * 1000 * 1.15 + 120000 : 180000;
      if (elapsed > budget) {
        finish('timeout');
        return;
      }

      // 绑定到了一个旧播放器、始终没有真实播放进展。
      // 窗口最小化时页面可能要好一会儿才真正把新视频推起来，所以给足 45 秒。
      if (advanced() < needDelta() && elapsed > 45000 && bound.paused) {
        finish('novideo');
        return;
      }

      // 长时间完全没有前进才算停滞。用「媒体事件时间戳」而不是「tick 间隔」判断，
      // 因为页面被限速时 tick 可能一分钟才跑一次，按 tick 间隔算会误判。
      if (Date.now() - Math.max(lastAdvanceAt, lastProgressAt) > 150000) {
        finish('stalled');
      }
    }

    function cleanup() {
      clearInterval(timer);
      stopPauseGuard();
      if (bound) {
        Session.finishedVideos.add(bound);
        safe(() => bound.removeEventListener('ended', onEnded), null);
        // 摘掉接管标记：这一节已经结束，播放器想怎么收尾都随它
        safe(() => bound.removeAttribute('data-ykt-current'), null);
      }
    }

    const timer = setInterval(tick, 800);
    if (firstVideo) bind(firstVideo);

    return {
      promise,
      stop: () => finish('stopped'),
      getReason: () => resolvedReason
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  //  跨标签页信号
  // ═══════════════════════════════════════════════════════════════════

  const signalQueue = [];
  let signalWaiter = null;

  function pushSignal(signal) {
    if (signalWaiter) {
      const waiter = signalWaiter;
      signalWaiter = null;
      waiter(signal);
    } else {
      signalQueue.push(signal);
    }
  }

  function nextSignal(timeoutMs) {
    if (signalQueue.length) return Promise.resolve(signalQueue.shift());
    return new Promise((resolve) => {
      signalWaiter = resolve;
      setTimeout(() => {
        if (signalWaiter === resolve) {
          signalWaiter = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  function sendToBackground(type, payload) {
    try {
      chrome.runtime.sendMessage({ type, payload }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* 扩展重载后可能失效，忽略 */
    }
  }

  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (!message || message.type !== 'ykt:from-worker') {
        if (sendResponse) sendResponse({ ok: false });
        return;
      }
      const payload = message.payload || {};
      pushSignal(payload);
      if (sendResponse) sendResponse({ ok: true });
    });
  } catch (e) {
    /* 忽略 */
  }

  // ═══════════════════════════════════════════════════════════════════
  //  UI 面板
  // ═══════════════════════════════════════════════════════════════════

  const ui = (function createUI() {
    let host = null;
    let root = null;
    let refs = {};
    let logLines = [];
    let minimized = false;
    let mounted = false;

    const STYLE = `
      :host { all: initial; }
      * { box-sizing: border-box; font-family: "Microsoft YaHei", "PingFang SC", system-ui, sans-serif; }
      .wrap { position: fixed; top: 72px; right: 18px; z-index: 2147483646; width: 322px; }
      .panel { background: #fff; border: 1px solid #d9dee7; border-radius: 12px;
               box-shadow: 0 10px 30px rgba(15, 23, 42, .18); overflow: hidden; }
      .head { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
              background: linear-gradient(135deg, #2563eb, #3b82f6); color: #fff; cursor: move; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; flex: 0 0 auto; }
      .dot.run { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.25); }
      .dot.pause { background: #f59e0b; }
      .dot.err { background: #ef4444; }
      .title { font-size: 13px; font-weight: 600; flex: 1 1 auto; }
      .iconbtn { border: 0; background: rgba(255,255,255,.18); color: #fff; width: 22px; height: 22px;
                 border-radius: 6px; cursor: pointer; font-size: 13px; line-height: 1; }
      .iconbtn:hover { background: rgba(255,255,255,.32); }
      .body { padding: 10px 11px; }
      .status { display: grid; grid-template-columns: auto 1fr; gap: 4px 8px;
                font-size: 12px; color: #334155; margin-bottom: 9px; }
      .status b { color: #0f172a; font-weight: 600; }
      .status .v { color: #1d4ed8; word-break: break-all; }
      .btns { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 9px; }
      button.act { border: 0; border-radius: 8px; padding: 6px 11px; font-size: 12px;
                   color: #fff; cursor: pointer; }
      button.act:disabled { opacity: .45; cursor: not-allowed; }
      .start { background: #16a34a; }
      .pause { background: #f59e0b; }
      .stop { background: #64748b; }
      .diag { background: #6366f1; }
      .settings { border-top: 1px dashed #e2e8f0; padding-top: 8px; margin-bottom: 8px;
                  font-size: 12px; color: #334155; display: grid; gap: 6px; }
      .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      select { border: 1px solid #cbd5e1; border-radius: 6px; padding: 3px 6px; font-size: 12px; }
      .logs { height: 132px; overflow-y: auto; background: #0f172a; border-radius: 8px;
              padding: 6px 8px; font-size: 11px; line-height: 1.55; color: #cbd5e1;
              font-family: Consolas, monospace; }
      .logs div { white-space: pre-wrap; word-break: break-all; }
      .logs .warn { color: #fbbf24; }
      .logs .ok { color: #4ade80; }
      .logs .err { color: #f87171; }
      .hint { font-size: 11px; color: #94a3b8; margin-top: 6px; line-height: 1.5; }
      .ball { position: fixed; top: 72px; right: 18px; z-index: 2147483646;
              width: 46px; height: 46px; border-radius: 50%; border: 0; cursor: pointer;
              background: linear-gradient(135deg, #2563eb, #3b82f6); color: #fff;
              font-size: 11px; font-weight: 700; box-shadow: 0 8px 20px rgba(37,99,235,.4); }
      .ball span { display: block; font-size: 9px; font-weight: 400; opacity: .85; }
      .toast { position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
               z-index: 2147483647; max-width: 620px; padding: 11px 16px; border-radius: 10px;
               font-size: 13px; color: #fff; background: #dc2626;
               box-shadow: 0 10px 26px rgba(220,38,38,.35); display: none; line-height: 1.6; }
      .modal { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,23,42,.55);
               display: none; align-items: center; justify-content: center; }
      .modal.show { display: flex; }
      .modal .box { width: min(760px, 92vw); background: #fff; border-radius: 12px; padding: 14px; }
      .modal h3 { margin: 0 0 8px; font-size: 14px; color: #0f172a; }
      .modal textarea { width: 100%; height: 48vh; border: 1px solid #cbd5e1; border-radius: 8px;
                        padding: 8px; font-size: 11px; font-family: Consolas, monospace; resize: vertical; }
      .modal .row { margin-top: 10px; justify-content: flex-end; }
      .modal button { border: 0; border-radius: 8px; padding: 7px 14px; font-size: 12px;
                      color: #fff; cursor: pointer; background: #2563eb; }
      .modal button.ghost { background: #94a3b8; }
    `;

    const HTML = `
      <div class="wrap" data-el="wrap">
        <div class="panel">
          <div class="head" data-el="head">
            <span class="dot" data-el="dot"></span>
            <span class="title">雨课堂自动连播 v${VERSION}</span>
            <button class="iconbtn" data-el="min" title="收起">—</button>
          </div>
          <div class="body">
            <div class="status">
              <span>角色</span><b class="v" data-el="role">检测中…</b>
              <span>状态</span><b class="v" data-el="state">未启动</b>
              <span>当前</span><b class="v" data-el="current">—</b>
              <span>进度</span><b class="v" data-el="counts">—</b>
              <span>倍速</span><b class="v" data-el="rateView">—</b>
            </div>
            <div class="btns">
              <button class="act start" data-el="start">开始</button>
              <button class="act pause" data-el="pause" disabled>暂停</button>
              <button class="act stop" data-el="stop" disabled>停止</button>
              <button class="act diag" data-el="diag">环境自检</button>
            </div>
            <div class="settings">
              <div class="row">
                <span>播放倍速</span>
                <select data-el="rate">
                  <option value="1">1.0x 原速</option>
                  <option value="1.25">1.25x</option>
                  <option value="1.5">1.5x</option>
                  <option value="2">2.0x</option>
                </select>
              </div>
              <div class="row"><span>自动静音</span><input type="checkbox" data-el="mute"></div>
              <div class="row">
                <span>静音方式</span>
                <select data-el="muteMode">
                  <option value="auto">自动（推荐）</option>
                  <option value="muted">真静音</option>
                  <option value="quiet">极低音量</option>
                </select>
              </div>
              <div class="row"><span>反切屏保持播放</span><input type="checkbox" data-el="antiPause"></div>
              <div class="row"><span>刷新后自动续跑</span><input type="checkbox" data-el="autoResume"></div>
              <div class="row"><span>播完关闭视频页</span><input type="checkbox" data-el="closeWorkerTab"></div>
              <div class="row">
                <button class="act stop" data-el="resetProgress" style="width:100%">清除本课程播放记录</button>
              </div>
            </div>
            <div class="logs" data-el="logs"></div>
            <div class="hint">
              只负责「点开未完成视频 → 播放 → 自动下一节」，跳过图文/讨论/作业与未开放章节；
              遇到必须作答的弹窗会暂停并提示，不会自动答题。
            </div>
          </div>
        </div>
      </div>
      <button class="ball" data-el="ball">连播<span data-el="ballState">就绪</span></button>
      <div class="toast" data-el="toast"></div>
      <div class="modal" data-el="modal">
        <div class="box">
          <h3>环境自检报告</h3>
          <textarea data-el="report" spellcheck="false"></textarea>
          <div class="row">
            <button class="ghost" data-el="closeModal">关闭</button>
            <button data-el="copy">复制报告</button>
          </div>
        </div>
      </div>
    `;

    function mount() {
      if (mounted) return;
      if (!document.documentElement) return;

      host = document.createElement('div');
      host.id = 'ykt-autoplay-host';
      root = host.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = STYLE;
      root.appendChild(style);

      const holder = document.createElement('div');
      holder.innerHTML = HTML;
      while (holder.firstChild) root.appendChild(holder.firstChild);

      refs = {};
      root.querySelectorAll('[data-el]').forEach((node) => {
        refs[node.getAttribute('data-el')] = node;
      });

      document.documentElement.appendChild(host);
      mounted = true;

      bindEvents();
      refs.rate.value = String(settings.rate);
      syncSettings();
    }

    function bindEvents() {
      refs.start.addEventListener('click', () => startSession());
      refs.stop.addEventListener('click', () => stopSession('user'));
      refs.pause.addEventListener('click', togglePause);
      refs.diag.addEventListener('click', runDiagnostics);
      refs.resetProgress.addEventListener('click', async () => {
        const key = courseKeyFromUrl();
        const all = (await Store.get(DONE_KEY, {})) || {};
        delete all[key];
        await Store.set(DONE_KEY, all);
        Session.doneKeys = new Set();
        Session.failedKeys = new Set();
        Session.counts.done = 0;
        ui.setStatus();
        log('已清除本课程的播放记录，下次「开始」会重新扫描全部视频');
      });
      refs.min.addEventListener('click', () => setMinimized(true));
      refs.ball.addEventListener('click', () => setMinimized(false));
      refs.closeModal.addEventListener('click', () => refs.modal.classList.remove('show'));
      refs.copy.addEventListener('click', () => {
        refs.report.select();
        safe(() => document.execCommand('copy'), null);
        safe(() => navigator.clipboard.writeText(refs.report.value), null);
        refs.copy.textContent = '已复制';
        setTimeout(() => (refs.copy.textContent = '复制报告'), 1500);
      });

      refs.rate.addEventListener('change', () => {
        settings.rate = Number(refs.rate.value) || 1;
        persistSettings();
        syncMediaLock();
        // 目标变了就重置策略，两条路径重新试一遍
        RateStrategy.mode = 'direct';
        RateStrategy.directTries = 0;
        RateStrategy.uiTries = 0;
        RateStrategy.failed = false;
        RateStrategy.warnedWrongMenu = false;
        const v = findVideo();
        if (v) {
          safe(() => {
            v.playbackRate = settings.rate;
          }, null);
          if (settings.rate > 1) applyRateViaPlayerUI(settings.rate).catch(() => {});
        }
        log(`倍速已改为 ${settings.rate}x，正在应用到当前视频`);
      });
      ['mute', 'antiPause', 'autoResume', 'closeWorkerTab'].forEach((key) => {
        refs[key].addEventListener('change', () => {
          settings[key] = refs[key].checked;
          persistSettings();
          syncMediaLock();
          if (key === 'antiPause') applyAntiPause();
          log(`设置已更新：${key} = ${settings[key]}`);
        });
      });

      refs.muteMode.addEventListener('change', () => {
        settings.muteMode = refs.muteMode.value;
        // 选了固定方式就直接生效；auto 保留当前这一次会话已经推导出来的方式
        if (settings.muteMode !== 'auto') Session.muteMode = settings.muteMode;
        if (settings.muteMode !== 'quiet') {
          // 回到「真静音 / 自动」就把标签页静音撤掉，别让用户莫名其妙没有声音
          Session.tabMuted = false;
          sendToBackground('ykt:mute-tab', { muted: false });
        }
        persistSettings();
        MuteStrategy.mode = 'direct';
        MuteStrategy.directTries = 0;
        syncMediaLock();
        const v = findVideo();
        if (v) {
          applyVolume(v);
          if (!v.paused) safe(() => v.play(), null);
        }
        log(
          settings.muteMode === 'auto'
            ? '静音方式：自动（默认真静音；被浏览器省电暂停时自动改极低音量）'
            : `静音方式已改为：${refs.muteMode.options[refs.muteMode.selectedIndex].textContent}`
        );
      });

      // 拖动
      let dragging = false;
      let ox = 0;
      let oy = 0;
      refs.head.addEventListener('mousedown', (e) => {
        if (e.target === refs.min) return;
        dragging = true;
        const rect = refs.wrap.getBoundingClientRect();
        ox = e.clientX - rect.left;
        oy = e.clientY - rect.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        refs.wrap.style.left = `${e.clientX - ox}px`;
        refs.wrap.style.top = `${e.clientY - oy}px`;
        refs.wrap.style.right = 'auto';
      });
      window.addEventListener('mouseup', () => {
        dragging = false;
      });
    }

    function setMinimized(value) {
      minimized = value;
      if (!mounted) return;
      refs.wrap.style.display = value ? 'none' : '';
      refs.ball.style.display = value ? 'block' : 'none';
    }

    function setRole(role) {
      if (!mounted) return;
      const label = { driver: '课程目录页', worker: '视频播放页', idle: '非学习页面' }[role] || role;
      refs.role.textContent = label;
    }

    function setStatus() {
      if (!mounted) return;
      const dot = refs.dot;
      dot.className = 'dot';
      if (Session.stopped) {
        refs.state.textContent = '未启动';
        refs.pause.disabled = true;
        refs.stop.disabled = true;
        refs.start.disabled = false;
        refs.ballState.textContent = '就绪';
      } else if (Session.paused) {
        dot.classList.add('pause');
        refs.state.textContent = '已暂停';
        refs.pause.textContent = '继续';
        refs.pause.disabled = false;
        refs.stop.disabled = false;
        refs.start.disabled = true;
        refs.ballState.textContent = '暂停';
      } else {
        dot.classList.add('run');
        refs.state.textContent = '运行中';
        refs.pause.textContent = '暂停';
        refs.pause.disabled = false;
        refs.stop.disabled = false;
        refs.start.disabled = true;
        refs.ballState.textContent = '运行';
      }
      refs.current.textContent = Session.currentTitle || '—';
      refs.counts.textContent = `${Session.counts.done} / ${Session.counts.total}`;
      refs.rateView.textContent = Session.actualRate ? `${Session.actualRate}x` : '—';
    }

    function setVideoInfo(video) {
      if (!mounted || !video) return;
      const rate = Number(video.playbackRate) || 1;
      Session.actualRate = rate;
      refs.rateView.textContent = `${rate}x`;
    }

    function syncSettings() {
      if (!mounted) return;
      refs.rate.value = String(settings.rate);
      refs.mute.checked = !!settings.mute;
      refs.muteMode.value = settings.muteMode;
      refs.antiPause.checked = !!settings.antiPause;
      refs.autoResume.checked = !!settings.autoResume;
      refs.closeWorkerTab.checked = !!settings.closeWorkerTab;
    }

    function log(message, kind) {
      const cls = kind || (message.startsWith('✅') ? 'ok' : message.startsWith('⚠️') ? 'warn' : '');
      logLines.push({ message, cls });
      if (logLines.length > 300) logLines = logLines.slice(-300);
      if (mounted && refs.logs) {
        const line = document.createElement('div');
        line.className = cls;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        refs.logs.appendChild(line);
        while (refs.logs.childElementCount > 300) refs.logs.removeChild(refs.logs.firstChild);
        refs.logs.scrollTop = refs.logs.scrollHeight;
      }
      console.log(`[雨课堂连播] ${message}`);
    }

    function toast(message, ms = 8000) {
      if (!mounted) return;
      refs.toast.textContent = message;
      refs.toast.style.display = 'block';
      clearTimeout(toast._timer);
      // ms <= 0 表示常驻提示，直到手动关闭或下次 toast
      if (ms > 0) {
        toast._timer = setTimeout(() => {
          refs.toast.style.display = 'none';
        }, ms);
      }
    }

    function showReport(json) {
      if (!mounted) return;
      refs.report.value = json;
      refs.modal.classList.add('show');
    }

    return {
      mount,
      setRole,
      setStatus,
      setVideoInfo,
      syncSettings,
      log,
      toast,
      showReport,
      setMinimized,
      getLogs: () => logLines.map((l) => l.message),
      isMounted: () => mounted
    };
  })();

  function log(message, kind) {
    ui.log(message, kind);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  设置读写
  // ═══════════════════════════════════════════════════════════════════

  async function loadSettings() {
    const stored = await Store.get(SETTINGS_KEY, null);
    settings = Object.assign({}, DEFAULT_SETTINGS, stored || {});
    return settings;
  }

  function persistSettings() {
    Store.set(SETTINGS_KEY, settings);
    applyAntiPause();
  }

  /** 把反切屏开关同步给 MAIN world 脚本（localStorage + postMessage） */
  function applyAntiPause() {
    safe(() => localStorage.setItem('ykt_antipause', settings.antiPause ? '1' : '0'), null);
    safe(
      () =>
        window.postMessage(
          { __ykt__: true, type: 'set-antipause', enabled: !!settings.antiPause },
          location.origin
        ),
      null
    );
  }

  /**
   * 告诉页面世界要不要锁住播放器的倍速/音量。
   * 雨课堂的播放器每 0.3 秒把自己的状态写回 <video>，不拦住就永远稳不住。
   */
  function syncMediaLock() {
    const active = Session.running && !Session.stopped;
    const want = muteTargets();
    const payload = active
      ? {
          __ykt__: true,
          type: 'lock-media',
          rate: Number(settings.rate) || 1,
          muted: !!settings.mute ? want.muted : null,
          volume: !!settings.mute ? want.volume : null,
          // 只有会话真正在跑、且没有被我们暂停时，才去吞页面发起的 pause()
          holdPlay: !Session.paused
        }
      : { __ykt__: true, type: 'unlock-media' };
    safe(() => window.postMessage(payload, location.origin), null);
  }

  /** 让主世界把「谁在 pause」的统计清零，便于每次自检看到干净的数据 */
  function resetPauseDiag() {
    safe(
      () => window.postMessage({ __ykt__: true, type: 'reset-pause-diag' }, location.origin),
      null
    );
  }

  /** 读主世界记录下来的「页面 pause 了视频多少次、被吞掉多少次、调用栈是什么」 */
  function readPauseDiag() {
    return safe(() => {
      const raw = document.documentElement.getAttribute('data-ykt-pause-diag');
      return raw ? JSON.parse(raw) : null;
    }, null);
  }

  async function loadProgress(courseKey) {
    const all = (await Store.get(DONE_KEY, {})) || {};
    const list = all[courseKey] || [];
    Session.doneKeys = new Set(list);
  }

  async function saveProgress(courseKey) {
    const all = (await Store.get(DONE_KEY, {})) || {};
    all[courseKey] = Array.from(Session.doneKeys);
    await Store.set(DONE_KEY, all);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  会话控制
  // ═══════════════════════════════════════════════════════════════════

  async function startSession() {
    if (Session.running && !Session.paused) return;

    await loadSettings();
    Session.courseKey = courseKeyFromUrl();
    Session.role = detectRole();
    Session.finishedVideos = new WeakSet();
    Session.stopped = false;
    Session.paused = false;
    Session.running = true;
    Session.actualRate = null;
    signalQueue.length = 0;
    lastProgressAt = Date.now();
    // auto 模式每次会话从「真静音」重新开始；用户手动指定了方式就听用户的
    if (settings.muteMode === 'auto') Session.muteMode = 'muted';
    else Session.muteMode = settings.muteMode;
    Session.tabMuted = false;
    sendToBackground('ykt:mute-tab', { muted: false });
    Session.lastPlayAt = 0;
    ensurePlaying._recent = [];
    PlayDiag.powerSave = 0;
    PlayDiag.quietSwitches = [];
    PlayDiag.errors = [];
    resetPauseDiag();

    await loadProgress(Session.courseKey);
    // 失败记录每次会话重置，避免历史失败项被永久跳过
    Session.failedKeys = new Set();
    Session.attempts = new Map();

    await Store.set(SESSION_KEY, {
      running: true,
      courseKey: Session.courseKey,
      startedAt: Date.now()
    });

    safe(() => document.documentElement.setAttribute('data-ykt-running', '1'), null);
    startPopupTimer();
    applyAntiPause();
    syncMediaLock();
    ui.setRole(Session.role);
    ui.setStatus();
    log(`▶ 会话启动（角色：${Session.role}）`);

    setTimeout(() => ui.setMinimized(true), 3000);

    if (Session.role === 'driver') {
      sendToBackground('ykt:driver-online', { courseKey: Session.courseKey });
      driverLoop();
    } else if (Session.role === 'worker') {
      workerLoop();
    } else {
      log('⚠️ 当前页面既没有章节列表也没有播放器，请先进入课程「学习内容」页');
      stopSession('idle-page');
    }
  }

  function togglePause() {
    if (!Session.running) return;
    Session.paused = !Session.paused;
    // 暂停时要放开「保住播放」，让用户手动暂停、以及页面的收尾逻辑都能生效
    syncMediaLock();
    if (Session.paused) {
      // 显式暂停：只靠"不再抢播放"是等页面自己停，遇到不主动暂停的页面就停不下来
      pauseCurrentVideo();
    } else {
      const video = findVideo();
      if (video) ensurePlaying(video);
    }
    ui.setStatus();
    log(Session.paused ? '⏸ 已暂停' : '▶ 已继续');
  }

  async function stopSession(reason) {
    if (!Session.running && Session.stopped) return;
    Session.running = false;
    Session.paused = false;
    Session.stopped = true;
    safe(() => document.documentElement.setAttribute('data-ykt-running', '0'), null);
    stopPauseGuard();
    stopPopupTimer();
    pushSignal({ kind: 'session-stopped' });
    syncMediaLock();
    pauseCurrentVideo();
    if (Session.tabMuted) {
      // 会话结束就别再压着用户的标签页了
      Session.tabMuted = false;
      sendToBackground('ykt:mute-tab', { muted: false });
    }
    await Store.remove(SESSION_KEY);
    sendToBackground('ykt:driver-offline', {});
    ui.setStatus();
    if (reason === 'complete') {
      log('🎉 本课程全部视频已播放完毕');
      ui.toast('🎉 本课程全部视频已播放完毕，可以关闭页面了', 15000);
      ui.setMinimized(false);
    } else {
      log(`⏹ 会话已停止（${reason}）`);
    }
  }

  function stall(message) {
    if (!Session.running || Session.paused) return;
    Session.paused = true;
    // 交给用户处理期间不再抢播放权，避免和页面继续对打
    syncMediaLock();
    ui.setStatus();
    ui.setMinimized(false);
    ui.toast(`⚠️ ${message}。请手动处理后在面板点「继续」。`, 0);
    log(`⚠️ ${message}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  //  driver 主循环
  // ═══════════════════════════════════════════════════════════════════

  async function gate() {
    while (Session.paused && Session.running) await sleep(300);
    return Session.running;
  }

  async function driverLoop() {
    try {
      while (Session.running) {
        if (!(await gate())) return;

        const items = scanChapters();
        if (!items.length) {
          log('⚠️ 未找到章节列表，请确认已进入课程「学习内容」页');
          await sleep(3000);
          if (!scanChapters().length) {
            stall('章节列表为空，无法继续');
            return;
          }
          continue;
        }

        const videoItems = items.filter((i) => i.kind === 'video-todo' || i.kind === 'video-done');
        Session.counts.total = videoItems.length;
        Session.counts.done = videoItems.filter(
          (i) => i.kind === 'video-done' || Session.doneKeys.has(i.key)
        ).length;
        ui.setStatus();

        const remaining = items.filter(
          (i) => i.kind === 'video-todo' && !Session.doneKeys.has(i.key)
        );
        if (!remaining.length) {
          // 开局就是"全部已完成"需要提醒：可能是判定依据失效，而不是真的都看完了
          if (videoItems.length >= 5 && Session.doneKeys.size === 0) {
            log(
              `⚠️ 页面上 ${videoItems.length} 个视频全部显示为已完成，且本次一个都没播过。` +
                '若与实际不符，请点「环境自检」把报告发我。'
            );
            ui.toast(
              '⚠️ 全部视频都显示为已完成，已停止以免误跳过。若你其实还没看完，请点「环境自检」把报告发我。',
              0
            );
          }
          await stopSession('complete');
          return;
        }

        const todo = remaining.filter((i) => !Session.failedKeys.has(i.key));
        if (!todo.length) {
          stall(`剩余 ${remaining.length} 节均未能自动完成，已暂停等待你检查页面`);
          return;
        }

        const item = todo[0];
        const result = await processItem(item);

        if (result === 'done') {
          Session.doneKeys.add(item.key);
          Session.failedKeys.delete(item.key);
          Session.attempts.delete(item.key);
          await saveProgress(Session.courseKey);
          Session.counts.done = Math.min(Session.counts.total, Session.counts.done + 1);
        } else if (result === 'stalled' || result === 'quiz') {
          await saveProgress(Session.courseKey);
          return;
        } else if (result === 'stopped') {
          return;
        } else {
          // 单节失败先重试几次再放弃：切下一节时偶尔会赶上页面自己还在切，
          // 立刻放弃会漏看视频，比多等一会儿严重得多。
          const tries = (Session.attempts.get(item.key) || 0) + 1;
          Session.attempts.set(item.key, tries);
          if (tries < 3) {
            log(`⚠️ 第 ${tries} 次未能完成：${item.title}（${result}），${tries * 5} 秒后重试`);
            await sleep(tries * 5000);
          } else {
            Session.failedKeys.add(item.key);
            log(`⚠️ 跳过无法完成的一节：${item.title}（${result}，已重试 ${tries - 1} 次）`);
            if (Session.failedKeys.size >= 5) {
              stall('连续多节无法完成，已暂停等待你检查页面');
              return;
            }
          }
        }

        ui.setStatus();
        await rand(600, 600);
      }
    } catch (e) {
      log(`❌ driver 循环异常：${e && e.message}`);
      stall(`脚本异常：${e && e.message}`);
    }
  }

  /**
   * 处理一节视频。返回值：
   *   'done' | 'stalled' | 'quiz' | 'stopped' | 'timeout' | 'no-signal' | ...
   */
  async function processItem(item) {
    Session.currentTitle = item.title;
    ui.setStatus();
    log(`▶ 打开：${item.title}`);

    // 章节可能被折叠，先展开再点，否则元素不可见、点了也没用
    if (!isVisible(item.el) && tryExpandChapter(item.el)) {
      await sleep(700);
      const again =
        scanChapters().find((i) => i.key === item.key) ||
        scanChapters().find((i) => i.title === item.title);
      if (again) item = again;
    }

    // 雨课堂经常复用同一个 <video> 元素，每处理一节都重置"已结束播放器"记录
    Session.finishedVideos = new WeakSet();
    Session.actualRate = null;
    signalQueue.length = 0;

    // 这一节可能已经在播了（例如点开视频页后自动播放，或页内自动切换）——
    // 此时不要再点一次，否则会把视频从头开始重播。
    // 正在播这一节（点开视频页后自动播放 / 页内自动切换）才跳过点击。
    // 注意：视频自然播完后 Chrome 里 paused 仍是 false，必须用 ended 和片尾位置排除。
    const already = findActiveVideo();
    const alreadyDur = already ? Number(already.duration) : 0;
    const alreadyNearEnd =
      Number.isFinite(alreadyDur) && alreadyDur > 0
        ? Number(already.currentTime) >= alreadyDur - 0.5
        : false;
    if (
      already &&
      !already.paused &&
      !already.ended &&
      !alreadyNearEnd &&
      Number(already.currentTime) > 0.5
    ) {
      log('检测到正在播放的视频，直接接管（不重复点击）');
      return await playAndWatch(item, already);
    }

    clickItem(item);

    // 分支 A：页面内切换 —— 本页出现（或复用）可用的 <video>。
    // 除了"正在播的"，也要认"已经加载好但停在第 0 秒等着的"，
    // 否则切换时页面没自动起播就会白等 10 秒然后放弃这一节。
    const localVideo = await pollFor(() => findActiveVideo() || findTakeableVideo(), 10000, 350);
    if (localVideo) {
      log('页面内切换模式，开始接管播放器');
      return await playAndWatch(item, localVideo);
    }

    // 没找到可用播放器时，把隔离世界看到的真实状态记下来，便于定位
    const probed = allVideos();
    if (probed.length) {
      const v = probed[0];
      log(
        `未发现可用播放器：video=${probed.length}，paused=${safe(() => v.paused, '?')}，` +
          `currentTime=${safe(() => Number(v.currentTime).toFixed(2), '?')}，` +
          `duration=${safe(() => v.duration, '?')}，可见=${isVisible(v)}`
      );
    } else {
      log('未发现可用播放器：页面上没有 <video> 元素');
    }

    // 分支 B：新标签页打开 —— 等待 worker 的完成信号
    log('等待视频播放页的完成信号…');

    // 第一阶段：最多 45 秒等视频页上线
    const first = await nextSignal(45000);
    const firstResult = handleWorkerSignal(first, item);
    if (firstResult) return firstResult;

    // 第二阶段：视频页已上线，长等待播放完成
    for (;;) {
      const signal = await nextSignal(90 * 60 * 1000);
      if (!signal) return 'no-signal';
      const result = handleWorkerSignal(signal, item);
      if (result) return result;
    }
  }

  /** 返回 null 表示该信号需要继续等待（例如 worker-online） */
  function handleWorkerSignal(signal, item) {
    if (!signal) return 'no-signal';
    if (signal.kind === 'session-stopped') return 'stopped';
    if (signal.kind === 'worker-online') {
      Session.currentTitle = signal.title || Session.currentTitle;
      ui.setStatus();
      return null;
    }
    if (signal.kind === 'video-done') {
      Session.actualRate = null;
      log(`✅ 视频页报告完成（${signal.reason}）`);
      return 'done';
    }
    if (signal.kind === 'video-stalled') {
      stall(`视频页报告异常：${signal.reason}`);
      return 'stalled';
    }
    if (signal.kind === 'worker-closed') {
      log('视频页被关闭但未收到完成信号，重新扫描章节确认');
      const now = scanChapters().find((i) => i.key === item.key);
      if (now && now.kind === 'video-done') return 'done';
      return 'no-signal';
    }
    return null;
  }

  async function playAndWatch(item, video) {
    const watcher = watchVideo(video);
    const reason = await watcher.promise;
    stopPauseGuard();

    if (reason === 'quiz') {
      stall('检测到需要作答的弹窗，已暂停等待你手动处理');
      return 'quiz';
    }
    if (reason === 'stopped') return 'stopped';
    if (reason === 'stalled') {
      stall(`「${item.title}」播放进度长时间停滞，已暂停等待你检查`);
      return 'stalled';
    }
    if (reason === 'timeout' || reason === 'novideo') {
      log(`⚠️ 未能确认播放完成（${reason}）：${item.title}`);
      return 'failed';
    }

    log(`✅ 完成：${item.title}（判定依据：${reason}）`);

    // 页面内切换的常见形态：右下角有「下一集」按钮
    const next = safe(() => document.querySelector(SEL.nextButton), null);
    if (next && isVisible(next) && !next.disabled) {
      await rand(800, 400);
      safe(() => next.click(), null);
      log('已点击「下一集」按钮');
    }
    return 'done';
  }

  // ═══════════════════════════════════════════════════════════════════
  //  worker：视频播放页
  // ═══════════════════════════════════════════════════════════════════

  async function workerLoop() {
    try {
      const video = await pollFor(() => findVideo(), 25000, 400);
      if (!video) {
        log('⚠️ 未找到视频元素');
        sendToBackground('ykt:video-stalled', { reason: 'no-video' });
        return;
      }

      Session.currentTitle = safe(() => text(document.querySelector(SEL.title)), '') || '视频播放中';
      ui.setStatus();
      sendToBackground('ykt:worker-online', { title: Session.currentTitle });
      log('▶ 已接管播放器');

      const watcher = watchVideo(video);
      const reason = await watcher.promise;
      stopPauseGuard();

      if (reason === 'quiz') {
        log('⚠️ 检测到需要作答的弹窗');
        sendToBackground('ykt:video-stalled', { reason: 'quiz' });
        stall('本视频出现答题弹窗，已暂停等待你手动处理');
        return;
      }
      if (reason === 'stopped') return;
      if (reason === 'stalled' || reason === 'timeout' || reason === 'novideo') {
        log(`⚠️ 播放异常：${reason}`);
        sendToBackground('ykt:video-stalled', { reason });
        stall(`播放异常（${reason}），已暂停`);
        return;
      }

      log(`✅ 播放完成（判定依据：${reason}）`);
      sendToBackground('ykt:video-done', { reason, title: Session.currentTitle });

      // 等背景页关闭本标签页；若未被关闭则自行退出会话
      setTimeout(() => {
        Session.running = false;
        Session.stopped = true;
        ui.setStatus();
      }, 4000);
    } catch (e) {
      log(`❌ worker 循环异常：${e && e.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  //  环境自检
  // ═══════════════════════════════════════════════════════════════════

  async function testRate(video) {
    if (!video) return { supported: false, reason: 'no-video' };
    const original = Number(video.playbackRate) || 1;
    let got = original;
    try {
      video.playbackRate = 2;
      got = Number(video.playbackRate);
      video.playbackRate = original;
    } catch (e) {
      return { supported: false, reason: String(e && e.message) };
    }
    return { supported: Math.abs(got - 2) < 0.01, value: got, restored: original };
  }

  function describePage(doc, label) {
    const count = (sel) => safe(() => doc.querySelectorAll(sel).length, -1);
    const buttons = safe(
      () =>
        Array.from(doc.querySelectorAll('button, .el-button, [role="button"]'))
          .filter(isVisible)
          .map((b) => text(b))
          .filter(Boolean)
          .slice(0, 25),
      []
    );
    const dialogs = safe(
      () =>
        Array.from(doc.querySelectorAll(SEL.dialogs))
          .filter(isVisible)
          .map((d) => text(d).slice(0, 160)),
      []
    );
    const items = safe(() => {
      const sel = SEL.chapterItems.find((s) => doc.querySelectorAll(s).length);
      if (!sel) return { selector: null, samples: [] };
      const nodes = Array.from(doc.querySelectorAll(sel));
      return {
        selector: sel,
        count: nodes.length,
        samples: nodes.slice(0, 30).map((el, i) => ({
          i,
          kind: classifyItem(el),
          icons: safe(
            () => Array.from(el.querySelectorAll('i')).map((x) => x.className).join(','),
            ''
          ),
          text: text(el).slice(0, 90)
        }))
      };
    }, { selector: null, samples: [] });

    return {
      label,
      url: safe(() => doc.location.href, ''),
      pathname: safe(() => doc.location.pathname, ''),
      videos: count('video'),
      player: count('.xt_video_player'),
      speedButton: count('xt-speedbutton'),
      progressText: safe(() => text(doc.querySelector(SEL.progressText)), ''),
      nextButton: count('.btn-next'),
      visibleButtons: buttons,
      visibleDialogs: dialogs,
      chapterItems: items,
      mainWorldHook: safe(
        () => doc.documentElement.getAttribute('data-ykt-main-world') === '1',
        false
      ),
      antiPauseFlag: safe(() => localStorage.getItem('ykt_antipause'), null)
    };
  }

  /**
   * 结构无关的 DOM 探针：不依赖任何已知类名，直接把页面上"像列表 / 像播放器控件"
   * 的元素按 class/id 归类报出来，用于适配未知版本的页面结构。
   */
  function probeStructure(doc) {
    const PLAYER_KEYS = [
      'speed',
      'play',
      'next',
      'prev',
      'progress',
      'volume',
      'toolbar',
      'control',
      'xt_',
      'switch'
    ];

    function inventory(keys, limit) {
      const groups = new Map();
      const all = safe(() => doc.querySelectorAll('*'), null);
      if (!all) return [];
      for (const el of all) {
        const cls = typeof el.className === 'string' ? el.className.trim() : '';
        const id = el.id || '';
        const hay = (cls + ' ' + id).toLowerCase();
        if (!keys.some((k) => hay.includes(k))) continue;
        const sig = el.tagName.toLowerCase() + (id ? '#' + id : '') + (cls ? '.' + cls.split(/\s+/).join('.') : '');
        let entry = groups.get(sig);
        if (!entry) {
          entry = { sel: sig, count: 0, children: el.childElementCount, sample: '' };
          groups.set(sig, entry);
        }
        entry.count += 1;
        if (!entry.sample) entry.sample = text(el).slice(0, 60);
      }
      return Array.from(groups.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);
    }

    function listContainers(limit) {
      const out = [];
      const all = safe(() => doc.querySelectorAll('*'), null);
      if (!all) return [];
      for (const el of all) {
        const kids = el.children;
        if (!kids || kids.length < 3) continue;
        const counts = new Map();
        for (const kid of kids) {
          const sig =
            kid.tagName.toLowerCase() +
            '.' +
            (typeof kid.className === 'string' ? kid.className.trim() : '');
          counts.set(sig, (counts.get(sig) || 0) + 1);
        }
        let sig = null;
        let n = 0;
        for (const [s, c] of counts) if (c > n) ((n = c), (sig = s));
        if (n < 3) continue;
        const rect = safe(() => el.getBoundingClientRect(), { width: 0, height: 0 });
        out.push({
          container:
            el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : '') +
            (typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\s+/).join('.')
              : ''),
          childSig: sig,
          similarChildren: n,
          totalChildren: kids.length,
          size: Math.round(rect.width) + 'x' + Math.round(rect.height),
          firstText: text(kids[0]).slice(0, 60)
        });
      }
      return out.sort((a, b) => b.similarChildren - a.similarChildren).slice(0, limit);
    }

    function treeSample(limit) {
      const found = discoverChapterItems();
      if (!found || !found.items) return { found: false };
      return {
        found: true,
        score: found.score,
        container:
          found.container.tagName.toLowerCase() +
          (found.container.id ? '#' + found.container.id : '') +
          (typeof found.container.className === 'string' && found.container.className.trim()
            ? '.' + found.container.className.trim().split(/\s+/).join('.')
            : ''),
        count: found.items.length,
        items: found.items.slice(0, 8).map((k, i) => ({
          i,
          kind: classifyItem(k),
          tag: k.tagName.toLowerCase(),
          cls: typeof k.className === 'string' ? k.className.trim() : '',
          attrs: safe(
            () =>
              Array.from(k.attributes)
                .map((a) => a.name + '=' + String(a.value).slice(0, 40))
                .slice(0, 8),
            []
          ),
          text: text(k).slice(0, 70)
        }))
      };
    }

    let found = null;
    safe(() => {
      found = discoverChapterItems();
    }, null);

    /** 直接给出前几个小节的外层 HTML——用来确认真实的标记结构（例如"已完成"图标） */
    function itemMarkup(limit) {
      const sel = chapterItemSelector();
      const nodes = sel
        ? Array.from(doc.querySelectorAll(sel))
        : found && found.items
          ? found.items
          : [];
      return nodes.slice(0, limit).map((n, i) => ({
        i,
        kind: classifyItem(n),
        html: safe(() => (n.outerHTML || '').replace(/\s+/g, ' ').slice(0, 500), '')
      }));
    }

    return {
      autoDetectedTree: found
        ? { container: found.container.tagName.toLowerCase(), count: found.items.length, score: found.score }
        : null,
      knownSelector: chapterItemSelector(),
      itemCount: knownSelectorCount(),
      listContainers: listContainers(10),
      chapterLikeClasses: inventory(
        ['leaf', 'chapter', 'section', 'node', 'tree', 'catalog', 'catalogue', 'outline', 'menu', 'sidebar'],
        40
      ),
      playerControls: inventory(PLAYER_KEYS, 40),
      autoTreeSample: treeSample(8),
      itemMarkup: itemMarkup(4),
      speedMenu: (function () {
        const f = findSpeedMenu();
        if (!f) return { found: false, hint: '未找到倍速菜单，需要按 playerControls 调整选择器' };
        const cls = (n) =>
          (typeof n.className === 'string' ? n.className.trim() : '') || '(no class)';
        const button = safe(() => f.menu.closest('xt-speedbutton, [class*="speed"]'), null);
        return {
          found: true,
          menu: f.menu.tagName.toLowerCase() + '.' + cls(f.menu),
          items: f.items.map((li) => text(li)).slice(0, 8),
          itemTag: f.items[0] ? f.items[0].tagName.toLowerCase() + ' > ' +
            Array.from(f.items[0].querySelectorAll('*')).map((n) => n.tagName.toLowerCase()).join(',') : '',
          button: button ? button.tagName.toLowerCase() + '.' + cls(button) : null
        };
      })()
    };
  }

  /**
   * 主动控制探针：现场施加静音 + 2x，分别在"刚设完"和"1.6 秒后"读回，
   * 用来判断是"没设上"还是"设上了又被播放器拉回去"。
   */
  async function probeControl() {
    const video = firstVideoEl();
    if (!video) return { ok: false, reason: '页面上没有可用的 <video>' };

    const read = () => ({
      muted: safe(() => video.muted, null),
      volume: safe(() => Number(Number(video.volume).toFixed(2)), null),
      rate: safe(() => Number(video.playbackRate), null),
      paused: safe(() => video.paused, null),
      activeSpeed: safe(
        () => text(document.querySelector('.xt_video_player_common_active')),
        ''
      )
    });

    const before = read();
    const setOk = safe(() => {
      video.muted = true;
      video.volume = 0;
      video.playbackRate = 2;
      return true;
    }, false);
    const immediate = read();

    await sleep(1600);
    const afterDirect = read();

    const clickedMenu = await applyRateViaPlayerUI(2);
    await sleep(1400);
    const afterUiClick = read();

    const clickedVolume = await applyMuteViaPlayerUI();
    await sleep(1200);
    const afterMuteClick = read();

    return {
      ok: true,
      setOk,
      before,
      immediate,
      afterDirect,
      clickedMenu,
      afterUiClick,
      clickedVolume,
      afterMuteClick
    };
  }

  /** 当前会话状态——用来判断扩展到底有没有在接管这个视频 */
  function sessionSnapshot() {
    return {
      running: Session.running,
      paused: Session.paused,
      stopped: Session.stopped,
      role: Session.role,
      currentTitle: Session.currentTitle,
      actualRate: Session.actualRate,
      counts: Object.assign({}, Session.counts),
      boundVideo: !!findActiveVideo(),
      rate: {
        mode: RateStrategy.mode,
        directTries: RateStrategy.directTries,
        uiTries: RateStrategy.uiTries,
        failed: RateStrategy.failed
      },
      mute: {
        mode: MuteStrategy.mode,
        directTries: MuteStrategy.directTries,
        uiTries: MuteStrategy.uiTries
      },
      // 实际生效的静音方式，以及被浏览器省电暂停的次数
      muteMode: muteTargets().mode,
      autoMuteMode: Session.muteMode,
      tabMuted: !!Session.tabMuted,
      setting: settings.muteMode,
      resolvedMuteTargets: muteTargets()
    };
  }

  async function runDiagnostics() {
    log('开始环境自检…');
    const video = firstVideoEl();

    const report = {
      generatedAt: new Date().toISOString(),
      version: VERSION,
      host: location.host,
      href: location.href,
      topFrame: IS_TOP,
      detectedRole: detectRole(),
      courseKey: courseKeyFromUrl(),
      settings: Object.assign({}, settings),
      userAgent: navigator.userAgent,
      rateTest: await testRate(video),
      videoState: video
        ? {
            currentTime: safe(() => Number(video.currentTime.toFixed(2)), null),
            duration: safe(
              () => (Number.isFinite(video.duration) ? Number(video.duration.toFixed(2)) : null),
              null
            ),
            paused: safe(() => video.paused, null),
            playbackRate: safe(() => video.playbackRate, null),
            ended: safe(() => video.ended, null),
            src: safe(() => (video.currentSrc || '').slice(0, 120), '')
          }
        : null,
      frames: collectDocuments().map((doc, i) => describePage(doc, i === 0 ? 'top' : `iframe#${i}`)),
      structure: probeStructure(document),
      session: sessionSnapshot(),
      controlProbe: await probeControl(),
      // 最小化时「播放/暂停反复跳」的现场证据：谁在 pause、被吞掉几次、调用栈是什么
      pauseDiag: readPauseDiag(),
      playErrors: PlayDiag.errors.slice(-10),
      backgroundPowerSave: {
        count: PlayDiag.powerSave,
        quietSwitches: PlayDiag.quietSwitches.slice(-5)
      },
      recentLogs: safe(() => ui.getLogs().slice(-60), []),
      notes: [
        'session.running=false 说明扩展当前没有在接管视频，静音/倍速自然不会生效。',
        'controlProbe 对比 immediate / afterDirect：两者不同就说明播放器把设置拉回去了。',
        'controlProbe.afterUiClick.activeSpeed 是点完倍速菜单后播放器自己显示的倍速。',
        'controlProbe.afterMuteClick.muted 是点完音量按钮后是否静音。',
        'frames[].chapterItems.selector 为 null 说明已知类名未命中；此时看 structure.autoDetectedTree。',
        'structure.listContainers 列出页面上所有「有 3 个以上同构子元素」的容器，章节树通常在其中。',
        'structure.chapterLikeClasses 按 class/id 关键词归类，用来确认真实的类名。',
        'structure.playerControls 用来找播放器上的「下一集 / 倍速」等控件。',
        'videoState.duration 为 null 说明视频元数据还没加载，请在视频页再跑一次。',
        'pauseDiag.blocked>0 说明页面自己按了暂停、被脚本抢回播放（最小化时的「反复跳」就是这么来的）。',
        'pauseDiag.stacks 是被吞掉 pause() 时的调用栈，用来定位到底是播放器哪段代码在按暂停。',
        'playErrors 里如果有 NotAllowedError，说明是浏览器自动播放策略拒绝了 play()。',
        'playErrors 里出现 "paused to save power" 说明是浏览器为省电暂停了后台无声音的视频；',
        '这时脚本会自动切成「极低音量」（见 backgroundPowerSave.quietSwitches 与 session.muteMode）。',
        '如果 backgroundPowerSave.count 还在增长，说明极低音量也没躲开，建议关闭 Edge 的「效率模式 / 睡眠标签页」。',
        'recentLogs 是面板日志的最后若干行，能看出脚本当时走到哪一步。'
      ]
    };

    const json = JSON.stringify(report, null, 2);
    ui.showReport(json);
    log('环境自检完成，报告已弹出，可点「复制报告」回传');
  }

  // ═══════════════════════════════════════════════════════════════════
  //  启动
  // ═══════════════════════════════════════════════════════════════════

  async function boot() {
    await loadSettings();
    applyAntiPause();

    const role = detectRole();
    Session.role = role;

    // 只有在学习相关页面才挂面板，避免登录页等处干扰
    const learningPage =
      role !== 'idle' ||
      /studycontent|studentLog|lms-graph|\/pro\/lms\//.test(location.pathname);

    if (learningPage) {
      ui.mount();
      ui.setRole(role);
      ui.setStatus();
    }

    const saved = await Store.get(SESSION_KEY, null);
    const sessionActive = !!(saved && saved.running);
    const sameCourse = sessionActive && saved.courseKey === courseKeyFromUrl();

    // 视频页由课程页打开：只要会话进行中就必须自动接管，与"刷新后续跑"开关无关
    if (role === 'worker' && sessionActive) {
      log('检测到进行中的会话，本页作为视频页接管播放');
      setTimeout(() => startSession(), 800);
      return;
    }

    // 课程目录页刷新 / 页内跳转后按设置恢复上一次的会话
    if (role === 'driver' && sameCourse && settings.autoResume) {
      log('检测到上次未结束的会话，自动续跑');
      setTimeout(() => startSession(), 1500);
      return;
    }

    if (learningPage) {
      log(`已就绪（${role === 'driver' ? '课程目录页' : role === 'worker' ? '视频播放页' : '未知'}）。点「开始」即可自动连播。`);
    }

    // 页面结构变化时刷新角色显示
    let lastRole = role;
    setInterval(() => {
      if (!ui.isMounted()) return;
      const now = detectRole();
      if (now !== lastRole) {
        lastRole = now;
        Session.role = now;
        ui.setRole(now);
        log(`页面角色变化：${now}`);
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot(), { once: true });
  } else {
    boot();
  }
})();
