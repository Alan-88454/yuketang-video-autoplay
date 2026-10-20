/*
 * 雨课堂视频自动连播助手 — MAIN world 注入脚本
 *
 * 只在 document_start 运行，唯一职责：绕过雨课堂的「切屏 / 失焦自动暂停」检测。
 * 通过 localStorage 的 ykt_antipause 键同步用户开关（'0' = 关闭），
 * 并监听 window.postMessage 以支持运行中热切换，无需刷新页面。
 *
 * 另外两件事：
 *   · 媒体状态锁：锁住 <video> 的倍速/音量，不让播放器每 0.3 秒把设置拉回去
 *   · 播放保住：会话运行期间吞掉页面发起的 pause()，避免最小化时和自动重播互相抢
 *
 * 注意：本脚本不修改播放进度、不伪造任何网络请求。
 */
(function () {
  'use strict';

  if (window.__YKT_MAIN_WORLD__) return;
  window.__YKT_MAIN_WORLD__ = true;

  var FLAG_KEY = 'ykt_antipause';
  var BLOCKED_TYPES = {
    visibilitychange: 1,
    webkitvisibilitychange: 1,
    blur: 1,
    pagehide: 1,
    freeze: 1
  };

  // 保存原始引用，供内部与降级路径使用
  var origAddEventListener = EventTarget.prototype.addEventListener;

  function antiPauseEnabled() {
    try {
      return localStorage.getItem(FLAG_KEY) !== '0';
    } catch (e) {
      return true;
    }
  }

  // 只拦截挂在 window / document 上的全局可见性监听，
  // 避免影响输入框等普通元素的 blur 行为。
  function isGlobalTarget(target) {
    try {
      return (
        target === window ||
        target === document ||
        target === document.documentElement ||
        (document.body && target === document.body)
      );
    } catch (e) {
      return false;
    }
  }

  // ── 1. 拦截全局可见性 / 失焦监听注册 ─────────────────────────────
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    try {
      if (
        antiPauseEnabled() &&
        isGlobalTarget(this) &&
        Object.prototype.hasOwnProperty.call(BLOCKED_TYPES, String(type).toLowerCase())
      ) {
        return;
      }
    } catch (e) {
      /* 降级：按原样注册 */
    }
    return origAddEventListener.call(this, type, listener, options);
  };

  // ── 2. 伪装页面可见性状态 ───────────────────────────────────────
  // 关闭开关时回落到浏览器真实值，而不是返回 undefined。
  function overrideVisible(target, prop, fakeValue) {
    var realGetter = null;
    try {
      var desc = Object.getOwnPropertyDescriptor(target, prop);
      if (!desc) desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), prop);
      if (desc && typeof desc.get === 'function') realGetter = desc.get;
    } catch (e) {
      /* 忽略 */
    }

    try {
      Object.defineProperty(target, prop, {
        configurable: true,
        enumerable: false,
        get: function () {
          if (antiPauseEnabled()) return fakeValue;
          try {
            return realGetter ? realGetter.call(target) : fakeValue;
          } catch (e) {
            return fakeValue;
          }
        },
        set: function () {}
      });
    } catch (e) {
      /* 某些属性可能不可重定义，忽略 */
    }
  }

  overrideVisible(document, 'hidden', false);
  overrideVisible(document, 'visibilityState', 'visible');
  overrideVisible(document, 'webkitHidden', false);
  overrideVisible(document, 'webkitVisibilityState', 'visible');

  // ── 3. on* 属性式监听一并中和 ───────────────────────────────────
  function neutralizeHandler(target, prop) {
    try {
      Object.defineProperty(target, prop, {
        configurable: true,
        get: function () {
          return null;
        },
        set: function () {}
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  neutralizeHandler(document, 'onvisibilitychange');
  neutralizeHandler(document, 'onwebkitvisibilitychange');
  neutralizeHandler(window, 'onblur');
  neutralizeHandler(window, 'onpagehide');

  try {
    origAddEventListener.call(
      document,
      'visibilitychange',
      function (event) {
        if (!antiPauseEnabled()) return;
        event.stopImmediatePropagation();
      },
      true
    );
  } catch (e) {
    /* 忽略 */
  }

  try {
    document.hasFocus = function () {
      return true;
    };
  } catch (e) {
    /* 忽略 */
  }

  // ── 4. 媒体状态锁 ───────────────────────────────────────────────
  // 雨课堂播放器大约每 0.3 秒把自己的倍速/音量重新写回 <video> 一次，
  // 所以脚本直接设值必然被覆盖；而它自己的倍速菜单是靠 CSS :hover 展开的，
  // 合成事件唤不醒 hover，点菜单项也没用。
  //
  // 这里在页面世界把这三个属性的 setter 包起来：锁开启时，吞掉播放器的回写，
  // 只放行我们自己的写入。这样倍速/静音才能真正稳住。
  var mediaLock = { on: false, rate: null, muted: null, volume: null, holdPlay: false };
  var MEDIA_PROPS = ['playbackRate', 'muted', 'volume'];
  var patchedVideos = new WeakSet();

  function patchVideo(video) {
    if (!video || patchedVideos.has(video)) return;
    patchedVideos.add(video);
    for (var i = 0; i < MEDIA_PROPS.length; i++) {
      (function (name) {
        var desc;
        try {
          desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
        } catch (e) {
          return;
        }
        if (!desc || typeof desc.get !== 'function' || typeof desc.set !== 'function') return;
        try {
          Object.defineProperty(video, name, {
            configurable: true,
            enumerable: false,
            get: function () {
              return desc.get.call(this);
            },
            set: function (value) {
              if (mediaLock.on && !this.__yktAllow) return; // 吞掉页面的回写
              desc.set.call(this, value);
            }
          });
        } catch (e) {
          /* 忽略 */
        }
      })(MEDIA_PROPS[i]);
    }
  }

  function enforceMediaLock() {
    if (!mediaLock.on) return;
    var list;
    try {
      list = document.querySelectorAll('video');
    } catch (e) {
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      patchVideo(v);
      v.__yktAllow = true;
      try {
        if (mediaLock.rate != null && Number(v.playbackRate) !== mediaLock.rate) {
          v.playbackRate = mediaLock.rate;
        }
        if (mediaLock.muted != null) {
          if (!!v.muted !== mediaLock.muted) v.muted = mediaLock.muted;
          // 极低音量模式：muted=false 但音量几乎为 0，用来躲开浏览器「省电暂停后台无声视频」
          var wantVol =
            typeof mediaLock.volume === 'number' ? mediaLock.volume : mediaLock.muted ? 0 : 1;
          if (Math.abs(Number(v.volume) - wantVol) > 0.005) v.volume = wantVol;
        }
      } catch (e) {
        /* 忽略 */
      }
      v.__yktAllow = false;
    }
  }

  // 切视频时播放器常会新建 <video> 元素 —— 新元素没上锁，中间就有个空窗期。
  // 所以用 MutationObserver 在节点出现的当下立刻补锁，另加一个定时兜底。
  var enforceTimer = null;
  var mediaObserver = null;

  function enforceNow() {
    if (!mediaLock.on) return;
    var list;
    try {
      list = document.querySelectorAll('video');
    } catch (e) {
      return;
    }
    for (var i = 0; i < list.length; i++) patchVideo(list[i]);
    enforceMediaLock();
    syncSpeedLabel();
  }

  function startEnforcing() {
    if (enforceTimer) return;
    enforceTimer = setInterval(enforceNow, 150);
    try {
      mediaObserver = new MutationObserver(function (records) {
        if (!mediaLock.on) return;
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'VIDEO' || (n.querySelector && n.querySelector('video'))) {
              enforceNow();
              return;
            }
          }
        }
      });
      mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      /* 忽略 */
    }
  }

  function stopEnforcing() {
    if (enforceTimer) {
      clearInterval(enforceTimer);
      enforceTimer = null;
    }
    if (mediaObserver) {
      try {
        mediaObserver.disconnect();
      } catch (e) {
        /* 忽略 */
      }
      mediaObserver = null;
    }
  }

  /**
   * 让播放器界面上高亮的那一项与真实倍速一致。
   *
   * 我们拦住的是 <video> 元素上的写入，播放器内部那把状态没变，所以它界面上
   * 一直高亮 1.00X。这里只把 active 类挪到正确的选项上 ——
   * 注意不能改 li 的文字，否则会把这个菜单的选项列表改坏（出现两个 2.00X）。
   */
  function syncSpeedLabel() {
    if (mediaLock.rate == null) return;
    var buttons;
    try {
      buttons = document.querySelectorAll('xt-speedbutton, [class*="speed"]');
    } catch (e) {
      return;
    }
    for (var i = 0; i < buttons.length; i++) {
      var items;
      try {
        items = buttons[i].querySelectorAll('li');
      } catch (e) {
        continue;
      }
      var target = null;
      for (var j = 0; j < items.length; j++) {
        var m = String(items[j].textContent).trim().match(/^(\d+(?:\.\d+)?)\s*X$/i);
        if (m && Math.abs(parseFloat(m[1]) - mediaLock.rate) < 0.001) {
          target = items[j];
          break;
        }
      }
      if (!target) continue;
      for (var k = 0; k < items.length; k++) {
        var on = items[k] === target;
        if (items[k].classList.contains('xt_video_player_common_active') !== on) {
          items[k].classList.toggle('xt_video_player_common_active', on);
        }
      }
    }
  }

  // ── 4b. 「保住播放」：吞掉页面自己发起的 pause() ────────────────
  // 窗口最小化时，播放器会在切换下一节的过程中反复调用 pause()，
  // 和我们这边的自动重播互相抢，表现为「播放/暂停来回跳、视频卡住」。
  // 这里沿用和倍速/静音同一招：锁开启时把页面发起的 pause() 吞掉。
  //
  // 放行（不吞）的情况：
  //   · 用户刚刚亲手点过（真实输入，1.5 秒内）—— 手动暂停必须有效
  //   · 视频已经播到片尾 / 已 ended —— 播放器的收尾逻辑要能正常跑
  //   · 不是当前正在接管的那一个 <video>（由隔离世界打 data-ykt-current 标记）
  //   · 锁关闭（会话停止 / 用户点了面板的「暂停」）
  var lastUserInputAt = 0;
  ['pointerdown', 'mousedown', 'touchstart', 'keydown', 'click'].forEach(function (t) {
    try {
      origAddEventListener.call(
        window,
        t,
        function (event) {
          if (event && event.isTrusted) lastUserInputAt = Date.now();
        },
        true
      );
    } catch (e) {
      /* 忽略 */
    }
  });

  var pauseDiag = {
    total: 0,        // 页面发起的 pause() 次数（锁开启期间）
    blocked: 0,      // 被我们吞掉的次数
    allowedUser: 0,  // 因为用户刚操作过而放行
    allowedEnd: 0,   // 因为已到片尾而放行
    other: 0,        // 不是当前视频 / 锁已关
    stacks: [],      // 前几次被吞掉时的调用栈（用来定位是谁在 pause）
    since: 0
  };

  function publishPauseDiag() {
    try {
      pauseDiag.lockOn = !!mediaLock.on;
      pauseDiag.holdPlay = !!mediaLock.holdPlay;
      document.documentElement.setAttribute('data-ykt-pause-diag', JSON.stringify(pauseDiag));
    } catch (e) {
      /* 忽略 */
    }
  }

  function isAtEnd(v) {
    try {
      if (v.ended) return true;
      var d = Number(v.duration);
      return Number.isFinite(d) && d > 0 && Number(v.currentTime) >= d - 0.5;
    } catch (e) {
      return false;
    }
  }

  var origPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function () {
    if (!mediaLock.on || !mediaLock.holdPlay) {
      return origPause.apply(this, arguments);
    }
    var isCurrent = false;
    try {
      isCurrent = this.hasAttribute('data-ykt-current');
    } catch (e) {
      /* 忽略 */
    }
    if (!isCurrent) {
      pauseDiag.other += 1;
      publishPauseDiag();
      return origPause.apply(this, arguments);
    }
    pauseDiag.total += 1;
    if (!pauseDiag.since) pauseDiag.since = Date.now();

    if (this.__yktAllowPause) {
      publishPauseDiag();
      return origPause.apply(this, arguments);
    }
    if (isAtEnd(this)) {
      pauseDiag.allowedEnd += 1;
      publishPauseDiag();
      return origPause.apply(this, arguments);
    }
    if (Date.now() - lastUserInputAt < 1500) {
      pauseDiag.allowedUser += 1;
      publishPauseDiag();
      return origPause.apply(this, arguments);
    }

    pauseDiag.blocked += 1;
    if (pauseDiag.stacks.length < 3) {
      var st = '';
      try {
        st = String(new Error().stack || '');
      } catch (e) {
        /* 忽略 */
      }
      pauseDiag.stacks.push(st.split('\n').slice(1, 8).join(' | ').slice(0, 900));
    }
    publishPauseDiag();
    return; // 吞掉这次 pause
  };

  // ── 5. 运行中热切换开关 ─────────────────────────────────────────
  origAddEventListener.call(
    window,
    'message',
    function (event) {
      var data = event && event.data;
      if (!data || data.__ykt__ !== true) return;
      if (data.type === 'set-antipause') {
        try {
          localStorage.setItem(FLAG_KEY, data.enabled ? '1' : '0');
        } catch (e) {
          /* 忽略 */
        }
      } else if (data.type === 'lock-media') {
        mediaLock.on = true;
        mediaLock.rate = typeof data.rate === 'number' ? data.rate : null;
        mediaLock.muted = typeof data.muted === 'boolean' ? data.muted : null;
        mediaLock.volume = typeof data.volume === 'number' ? data.volume : null;
        mediaLock.holdPlay = data.holdPlay === true;
        startEnforcing();
        enforceNow();
        publishPauseDiag();
      } else if (data.type === 'unlock-media') {
        mediaLock.on = false;
        mediaLock.holdPlay = false;
        stopEnforcing();
        publishPauseDiag();
      } else if (data.type === 'reset-pause-diag') {
        pauseDiag.total = 0;
        pauseDiag.blocked = 0;
        pauseDiag.allowedUser = 0;
        pauseDiag.allowedEnd = 0;
        pauseDiag.other = 0;
        pauseDiag.stacks = [];
        pauseDiag.since = 0;
        publishPauseDiag();
      }
    },
    false
  );

  // ── 6. 给隔离世界留下一个可读的 DOM 标记 ────────────────────────
  try {
    document.documentElement.setAttribute('data-ykt-main-world', '1');
    publishPauseDiag();
  } catch (e) {
    /* 忽略 */
  }
})();
