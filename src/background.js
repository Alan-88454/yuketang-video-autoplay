/*
 * 雨课堂视频自动连播助手 — Service Worker
 *
 * 只做三件事：
 *   1. 记录「课程学习内容页(driver)」和「视频播放页(worker)」的标签页关系
 *   2. 把 worker 的完成 / 卡住信号转发给 driver
 *   3. worker 播完后按设置关闭该标签页并把焦点交回 driver
 *
 * 不做任何网络请求，不读取页面数据。
 */

const SESSION_KEY = 'ykt.runtime';
const SETTINGS_KEY = 'ykt.settings';

const DEFAULT_SETTINGS = {
  rate: 2.0,
  mute: true,
  muteMode: 'auto',
  antiPause: true,
  autoResume: true,
  closeWorkerTab: true
};

/** 内存中的运行时状态（同时持久化，防止 SW 被回收后丢状态） */
let runtime = {
  driverTabId: null,
  driverCourseKey: '',
  workerTabId: null,
  updatedAt: 0
};

async function loadRuntime() {
  try {
    const stored = await chrome.storage.local.get(SESSION_KEY);
    if (stored && stored[SESSION_KEY]) {
      runtime = Object.assign(runtime, stored[SESSION_KEY]);
    }
  } catch (e) {
    /* 忽略 */
  }
  return runtime;
}

async function saveRuntime(patch) {
  runtime = Object.assign({}, runtime, patch, { updatedAt: Date.now() });
  try {
    await chrome.storage.local.set({ [SESSION_KEY]: runtime });
  } catch (e) {
    /* 忽略 */
  }
  return runtime;
}

async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    return Object.assign({}, DEFAULT_SETTINGS, (stored && stored[SETTINGS_KEY]) || {});
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

/** 向 driver 标签页投递一条来自 worker 的消息 */
async function notifyDriver(payload) {
  await loadRuntime();
  const tabId = runtime.driverTabId;
  if (tabId == null) return false;

  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ykt:from-worker', payload });
    return true;
  } catch (e) {
    // driver 已经关闭或尚未注入内容脚本
    return false;
  }
}

/** worker 播完后收尾：关闭视频页并把焦点交回 driver */
async function closeWorkerTab(workerTabId) {
  if (workerTabId == null) return;

  await loadRuntime();
  // 同一个标签页（课程页内部跳转到视频页）绝不能关，那是用户唯一的那一页
  if (runtime.driverTabId === workerTabId) {
    return;
  }

  const settings = await getSettings();
  if (!settings.closeWorkerTab) {
    if (runtime.driverTabId != null) {
      try {
        await chrome.tabs.update(runtime.driverTabId, { active: true });
      } catch (e) {
        /* 忽略 */
      }
    }
    return;
  }

  try {
    await chrome.tabs.remove(workerTabId);
  } catch (e) {
    /* 标签页可能已被用户手动关闭 */
  }

  if (runtime.driverTabId != null) {
    try {
      await chrome.tabs.update(runtime.driverTabId, { active: true });
    } catch (e) {
      /* 忽略 */
    }
  }
}

// ── 消息路由 ────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : null;

  (async () => {
    switch (message && message.type) {
      case 'ykt:driver-online': {
        await saveRuntime({
          driverTabId: tabId,
          driverCourseKey: (message.payload && message.payload.courseKey) || ''
        });
        sendResponse({ ok: true, runtime });
        break;
      }

      case 'ykt:driver-offline': {
        await loadRuntime();
        if (runtime.driverTabId === tabId) {
          await saveRuntime({ driverTabId: null, driverCourseKey: '' });
        }
        sendResponse({ ok: true });
        break;
      }

      case 'ykt:worker-online': {
        await saveRuntime({ workerTabId: tabId });
        await notifyDriver({
          kind: 'worker-online',
          tabId,
          title: (message.payload && message.payload.title) || ''
        });
        sendResponse({ ok: true });
        break;
      }

      case 'ykt:video-done': {
        await notifyDriver({
          kind: 'video-done',
          tabId,
          reason: (message.payload && message.payload.reason) || 'ended',
          title: (message.payload && message.payload.title) || ''
        });
        await loadRuntime();
        if (runtime.workerTabId === tabId) {
          await saveRuntime({ workerTabId: null });
        }
        sendResponse({ ok: true });
        // 给 driver 一点时间接收信号，再关掉视频页
        setTimeout(() => {
          closeWorkerTab(tabId);
        }, 1200);
        break;
      }

      case 'ykt:video-stalled': {
        await notifyDriver({
          kind: 'video-stalled',
          tabId,
          reason: (message.payload && message.payload.reason) || 'unknown',
          detail: (message.payload && message.payload.detail) || ''
        });
        sendResponse({ ok: true });
        break;
      }

      case 'ykt:get-runtime': {
        await loadRuntime();
        sendResponse({ ok: true, runtime, settings: await getSettings() });
        break;
      }

      case 'ykt:reset-runtime': {
        await saveRuntime({ driverTabId: null, driverCourseKey: '', workerTabId: null });
        sendResponse({ ok: true });
        break;
      }

      // 标签页级静音。内容脚本没有 chrome.tabs 的写权限，所以走这里。
      // 用途：浏览器会为省电暂停后台「听不到声音」的视频，此时脚本会把 <video>
      // 改成极低音量（让浏览器认为它在出声），再用标签页静音保证你真的听不到。
      case 'ykt:mute-tab': {
        if (tabId == null) {
          sendResponse({ ok: false, reason: 'no-tab' });
          break;
        }
        try {
          await chrome.tabs.update(tabId, { muted: !!(message.payload && message.payload.muted) });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message) });
        }
        break;
      }

      default:
        sendResponse({ ok: false });
    }
  })();

  return true; // 异步响应
});

// ── 标签页生命周期 ──────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await loadRuntime();
  if (runtime.workerTabId === tabId) {
    await saveRuntime({ workerTabId: null });
    notifyDriver({ kind: 'worker-closed', tabId });
  }
  if (runtime.driverTabId === tabId) {
    await saveRuntime({ driverTabId: null, driverCourseKey: '', workerTabId: null });
  }
});

// ── 安装时写入默认设置 ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch (e) {
    /* 忽略 */
  }
  await loadRuntime();
});
