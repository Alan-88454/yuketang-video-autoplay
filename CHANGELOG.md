# 更新日志 / Changelog

每个版本先列中文，再列英文。  
Chinese notes come first, English notes follow.

## v1.0.7 — 2026-10-20

**中文**

- 新增面板「静音方式」三档：自动（默认）/ 真静音 / 极低音量。
- 识别浏览器的后台省电暂停（`AbortError: ... video-only background media was paused to save power`），
  自动切成「极低音量 + 标签页静音」，让浏览器不再把视频当成无声视频暂停。
- 给重播加节流，不再出现每秒数百次的 play/pause 拉锯（实测把有效速度从不足一半拉回正常）。
- 自检报告新增 `pauseDiag`、`playErrors`、`backgroundPowerSave`、`recentLogs`，出问题能直接定位。
- 文档：英文 README + 中英切换、Latest Release 直链、MIT LICENSE、本 CHANGELOG。

**English**

- New panel setting “Mute mode” with three options: Auto (default), True mute, Very low volume.
- Detects Chromium's background power-saving pause (`AbortError: ... video-only background media was
  paused to save power`) and switches to “very low volume + tab muted” so the browser stops pausing it.
- Throttles re-play attempts, removing the hundreds-of-play/pause-per-second fight that cut effective
  speed to below half.
- Self-check report now includes `pauseDiag`, `playErrors`, `backgroundPowerSave` and `recentLogs`.
- Docs: English README with a language switch, direct link to the latest release, MIT license, changelog.

## v1.0.6 — 2026-10-11

**中文**

- 修复窗口最小化后切下一节时「播放/暂停反复跳、视频卡住」：会话运行期间吞掉播放器自己发起的
  `pause()`，只在用户刚亲手操作过、视频已到片尾、或不是当前接管的视频时放行。
- 能接管「元数据已加载但停在第 0 秒、且 `<video>` 尺寸为 0」的新视频（旧逻辑会判成
  「未发现可用播放器」，白等 10 秒后放弃这一节）。
- 修正提前判定完成：播放器时间向下取整，`00:03 / 00:03` 在还剩近 1 秒时就出现，
  旧逻辑会在只播到约 74% 时切走。进度文字改为「确实到结尾」的旁证。
- 单节失败改为最多重试 3 次并写明日志，不再静默跳过。
- 面板「暂停」按钮会真正暂停视频。
- 停滞判定改用媒体事件时间戳，页面被限速时不再误判。

**English**

- Fixed the play/pause oscillation and stall when advancing to the next section with the window
  minimised: while a session runs, `pause()` calls from the player are swallowed, except when the user
  has just interacted, the video has reached its end, or it is not the video currently being driven.
- Takes over a new video that has loaded its metadata but sits at second 0 with a zero-sized `<video>`
  element; previously this was reported as “no usable player found” and the section was abandoned
  after 10 seconds.
- Fixed premature completion: the player floors its time display, so `00:03 / 00:03` appears almost a
  second early and the old logic advanced at roughly 74% watched. The time text is now only used to
  confirm a real end.
- Failed sections are retried up to 3 times with explicit logging instead of being skipped silently.
- The panel's Pause button now really pauses the video.
- Stall detection uses media-event timestamps, so a throttled page no longer triggers a false stall.

## v1.0.5 — 2026-10-11

**中文**

- 引入媒体状态锁：在页面世界里包装 `<video>` 的 `playbackRate` / `muted` / `volume` setter，
  锁开启时吞掉播放器每 0.3 秒的状态回写，倍速和静音才真正稳得住。
- 用 `MutationObserver` 在切视频新建 `<video>` 的当下立即补锁，另加 150ms 定时兜底。
- 播放器界面高亮的倍速项同步到真实倍速（只挪高亮类，不改选项文字，避免把菜单改坏）。

**English**

- Introduced a media state lock: wraps the `playbackRate` / `muted` / `volume` setters on `<video>` in
  the page's JS world and swallows the player's 0.3 s state write-back, which is what made rate and
  muting stick.
- A `MutationObserver` locks newly created `<video>` elements the moment they appear, with a 150 ms
  timer as a backstop.
- The highlighted speed item in the player UI follows the real rate (only the highlight class moves;
  option text is never edited, which would corrupt the menu).

## v1.0.0 – v1.0.4 — 2026-10-10

**中文**

- 首个可用版本：角色识别（driver / worker）、章节扫描与分类、自动连播、弹窗处理、
  悬浮面板与环境自检。
- 逐步解决 2x 倍速与自动静音被雨课堂播放器拉回的问题（试过直接设值、点击其倍速菜单等路径）。

**English**

- First working version: role detection (driver / worker), chapter scanning and classification,
  auto-advance, dialog handling, floating panel and self-check.
- Iterated on keeping 2x playback and muting from being pulled back by the Yuketang player (direct
  assignment and clicking its speed menu were both explored).
