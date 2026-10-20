[简体中文](README.md) | **English**

# Yuketang (Changjiang Yuketang) Video Auto-Play Extension

📦 **[Download the latest release](https://github.com/Alan-88454/yuketang-video-autoplay/releases/latest)** (current version `1.0.7`)

A locally loaded Edge extension. Once installed, on a Yuketang course page it will:

1. Find **unfinished** video sections and open them automatically
2. Take over the player: play at the configured rate, mute, and prevent accidental pauses
3. **Move on to the next section** automatically when one finishes
4. Skip readings, discussions, assignments, quizzes, exams, and locked (not yet open) sections
5. Stop with a notification once every video in the course has been played

Two Yuketang page layouts are supported:

- Legacy course page: `/pro/lms/{course}/{class}/studycontent` (videos open in a new tab)
- New learning space: `/ai-workspace/lms-graph/{class}` (the outline `.leaf-item` sits on the same page
  as the player, and each chapter has its own `.nav-item-list`)

In the new learning space the chapter tree is **also present on the video page**, so advancing to the
next section is an in-page switch with no navigation.

In the new learning space, "watched" is drawn as an icon rather than text. The script reads the real markers:

| Icon in the second column | Meaning | Script behaviour |
| --- | --- | --- |
| Filled circle with a check | Completed | Skip |
| Circular progress ring | Partially watched | Resume from where it stopped |
| Empty | Not started | Play from the beginning |
| Label reads "Discussion / Reading / Assignment" | Not a video | Skip |

If neither known layout matches, the script **auto-detects** the page: it looks for the container that
holds a batch of similarly structured sections, then classifies each item by its type label
(video / reading / assignment …), icon class names and completion state — without relying on
hard-coded class names.

## What it does not do

- It does not drag the progress bar, skip segments, or change the playback position
- It does not forge progress reports (the player reports progress to Yuketang itself, at its normal cadence)
- It does not answer questions: if a mandatory dialog appears it **pauses and prompts you** to handle it manually
- It does not log in for you and never reads or stores your credentials
- It makes no external network requests and only asks for permission on `*.yuketang.cn`

## Installation

1. Open Edge and go to `edge://extensions/`
2. Turn on **Developer mode** (bottom-left corner or the left sidebar)
3. Click **Load unpacked** and pick the unzipped folder (the one that directly contains `manifest.json`
   and the `src` folder)
4. The entry “雨课堂视频自动连播助手” appearing in the list means it is installed

To upgrade: go back to `edge://extensions/` and click **Reload** on the extension.

**Code changes only take effect after a reload.** The panel title bar and the `version` field in the
self-check report show the version that is actually running; if they don’t match, you haven’t reloaded.
Current version: `1.0.7`.

Mind the order: **reload the extension in `edge://extensions/` first, then refresh the Yuketang page.**
Reloading the extension without refreshing leaves the old script running in that page.

## Usage

1. Log in to Yuketang as usual, open your course, and go to the **Learning content** page (the one with
   the chapter list on the left)
2. A blue floating panel appears on the right side of the page
3. **On first use**, click **Self-check** and confirm that `chapterItems.selector` is not `null` and that
   `detectRole` is `driver` — that means the page structure was recognised
4. Click **Start**; after 3 seconds the panel collapses into a small ball in the bottom-right corner
   (click it to expand)
5. You can now go and do something else; a notification appears when everything has been played

### Panel settings

| Setting | Default | Description |
| --- | --- | --- |
| Playback rate | 2.0x | Can be switched back to 1.0x; see below |
| Auto mute | On | Keeps consecutive videos from disturbing you |
| Keep playing when unfocused | On | Video keeps playing when you switch to another app (see below) |
| Auto-resume after refresh | On | Continues after a course-page refresh or an in-page navigation |
| Close tab when finished | On | In new-tab playback mode, closes that tab and returns to the course page |
| Clear this course’s history | — | Use when you want to rewatch; the next run scans every video again |

### About playback rate

The default is 2.0x. **Note:** if your course rules treat “no fast-forwarding” as including accelerated
playback, switch the rate back to `1.0x`. The setting can be changed at any time and applies to the next
video immediately.

The Yuketang player **ignores** a direct write to `video.playbackRate`: it keeps its own rate state and
writes it back to the `<video>` element roughly every 0.3 seconds, so any direct assignment is overwritten
(the panel shows 2x while the player still says 1.00X). The same is true for muting.

**Its speed menu cannot be clicked either**: the menu opens through CSS `:hover`, and synthetic events
cannot put the browser into a `:hover` state — clicking menu items from a content script is a dead end
(the approaches that work use OS-level real mouse input).

So the script uses a **media state lock**: in the page’s own JS world it wraps the `playbackRate` /
`muted` / `volume` setters on `<video>` and, while the lock is on, **swallows the player’s writes**,
letting only the script’s own writes through. The player cannot pull the rate back to 1x.

As for the on-screen label: the script moves the **highlighted item** in the player’s speed menu to the
option matching the real rate (it only moves the highlight and never edits the option text, which would
corrupt the menu). If the player’s label is derived from the selected item it will show `2.00X`; if it
maintains a separate label it will still say `1.00X`.

**To tell whether it took effect, read the “Rate” row in the panel** — it shows the real value of the
video element (`video.playbackRate`), not the player’s text. You can also see the video progressing
visibly faster.

The lock is only active while a session is running; clicking **Stop** releases it and the player regains
full control. While the lock is on, changing rate or volume from the player UI has no effect — use the
panel instead.

When switching videos the player often creates a new `<video>` element, which starts out unlocked.
A `MutationObserver` locks it the moment it appears, with a 150 ms timer as a backstop, so it no longer
drops back to 1x for a few seconds after a switch.

If the second strategy ever kicks in, the log shows `直接设置 2x 没生效，改用播放器自带的倍速菜单` and
the player’s own indicator switches to 2.00X. The “Rate” row always shows the **effective** value rather
than your setting. If both paths fail it falls back to normal speed and tells you.

### About “Keep playing when unfocused”

Yuketang pauses the video when the tab loses focus. This switch intercepts the page’s visibility and blur
listeners so the video keeps playing in the background while you do something else. It does not change the
playback position and does not affect progress reporting. If you would rather not alter page behaviour,
turn it off — at the cost of keeping the Yuketang page in the foreground.

### About “Mute mode”

Chromium-based browsers (Edge and Chrome alike) have a power-saving rule: **when the page is in the
background and the video is “silent”, the video is paused**. If a script tries to take playback back, the
browser pauses it again, producing hundreds of play/pause rounds per second, an effective speed below half,
and log entries such as:

```
AbortError: The play() request was interrupted because
video-only background media was paused to save power.
```

Hence three modes in the panel:

| Mode | Behaviour | When to use |
| --- | --- | --- |
| **Auto** (default) | Starts truly muted; as soon as the power-saving pause is detected, switches to “very low volume” and mutes the tab | The usual choice |
| True mute | Always `muted = true` | You want complete silence even if playback may slow down when minimised |
| Very low volume | Always `muted = false` with volume `0.001`, plus tab muting | Force the “the browser thinks it is producing sound” path |

“Very low volume” works because the browser then considers the video audible and skips the power-saving
path; `0.001` (about −60 dB) is inaudible, and the extension additionally mutes the whole tab, so it
sounds completely silent.

If `playErrors` **still** shows `paused to save power` after the automatic switch, the browser is still
pausing it: go to Edge **Settings → System and performance** and turn off **Efficiency mode** and
**Sleeping tabs**, or add `changjiang.yuketang.cn` to the exception list.

## Troubleshooting

- **The panel does not appear**: make sure you are on a learning-related `*.yuketang.cn` page
  (`/pro/lms/`, `/studycontent`, `/student-log`, …) and that the extension is enabled in
  `edge://extensions/`.
- **“No chapter list found”**: auto-detection failed too. Click **Self-check** → **Copy report** and send
  the JSON back; it will be adapted using the real structure in `structure`.
- **“No usable player found”**: open the self-check report and look at `videoState` and `frames[].videos`.
- Structure-related fields in the report:
  - `structure.autoDetectedTree`: the auto-detected chapter tree (count, score) — anything other than
    `null` means detection succeeded
  - `structure.listContainers`: every container with “3 or more similar children”; the chapter tree is
    usually among them
  - `structure.chapterLikeClasses`: grouped by class/id keywords, to confirm the real class names
  - `structure.playerControls`: controls such as “next episode” and “rate” on the player
- **Some sections never play**: the panel pauses and tells you; click **Continue** after handling it.
  Items that keep failing are skipped, and you can start over with **Clear this course’s history**.
- **Pause for now**: click **Pause**; click **Stop** to end the session.
- **After minimising, the next section oscillates between playing and paused**: during the switch the
  Yuketang player repeatedly pauses the new video while the script tries to take it back. Since `1.0.6`
  the script **swallows pauses initiated by the player** while a session is running, and only lets them
  through when you have just interacted yourself (within 1.5 s), when the video has reached its end, or
  when it is not the video currently being driven. Your own pause button on the player still works.

  Since `1.0.7` it also addresses the more common cause when minimised: **the browser pausing silent
  background video to save power**. On detection it switches to “very low volume + tab muted” so the
  browser stops pausing it (see “Mute mode” above). Re-plays are throttled as well, so it no longer burns
  CPU with hundreds of attempts per second.

  The evidence trail lives in the self-check report: `pauseDiag.blocked` counts pauses taken back,
  `pauseDiag.stacks` holds the call stacks (showing which player code paused it), `pauseDiag.holdPlay`
  shows whether that protection is currently active, and a `NotAllowedError` in `playErrors` means the
  browser’s autoplay policy rejected `play()`. If it still stalls when minimised, run Self-check and send
  the report — those four fields are enough to locate it.
- **A finished video restarts from the beginning**: normally the script prevents this (a finished player is
  never auto-`play()`ed again). If it still happens, the page must use another replay mechanism — send the
  self-check report.
- **“Completed” although you did not watch it**: completion is judged only inside the player area (the
  player’s `current / total` time display matching, or 100% inside the player). The side outline and the
  status bar are full of “completed” text, and the script **does not** treat them as evidence. If you see
  the opposite, send the report.
- **“All videos already completed” right at the start**: the whole course shows check marks on the page.
  If you really have not watched it, the completion markers probably changed — run Self-check and send the
  report. The script deliberately **stops and asks** instead of skipping the whole course.
- **Set to 2x but still playing at 1x**: look at the panel’s “Rate” row. If it stays at `1x` and the log
  line `直接设置 2x 没生效，改用播放器自带的倍速菜单` changes nothing, after about a minute you will see
  `点了播放器的倍速菜单但倍速仍是 1x` — run Self-check and send the report; `structure.speedMenu` will
  contain the real menu structure (selector, option texts, inner tags, button label), and one adjustment
  will make it exact.

  First confirm one thing: **is the panel’s “Status” row showing “Running”?** If it says “Not started” or
  “Paused”, the extension is not driving the video, so muting and rate obviously will not apply — click
  **Start**. `session.running` in the report means the same thing.

  The report also contains `controlProbe`, which sets mute and 2x on the spot and reads them back:
  - `immediate` equals `afterDirect` → the value was accepted, so the problem is that the extension is
    not running
  - the two differ → the player pulled it back; check `afterUiClick.activeSpeed` (`2.00X` means the menu
    path works)

## File structure

```
manifest.json          MV3 manifest (permissions: storage, tabs; host: *.yuketang.cn)
src/main-world.js      injected at document_start: anti background-pause hooks, media state lock, playback protection
src/content.js         page detection / chapter classification / playback control / completion detection / dialogs / panel / self-check
src/background.js      service worker: signal relay between course and video pages, tab cleanup, tab-level muting
build.ps1              packages the files above into a distributable zip
README.md              Chinese documentation
README.en.md           English documentation (this file)
CHANGELOG.md           version history (Chinese + English)
LICENSE                MIT license
assets/social-preview.png   social preview image (1280×640)
assets/social-preview.html  design source; open it in a browser to re-render
```

Building the distributable:

```powershell
pwsh -File .\build.ps1
```

This produces `dist/yuketang-video-autoplay-v<version>.zip`. The recipient unzips it and loads the inner
folder into Edge via **Load unpacked**.

## Known limitations

- Known class names cover `/pro/lms/` and `/ai-workspace/lms-graph/`; if the site changes again,
  auto-detection should still work — otherwise adapt it using the self-check report.
- Playback history is keyed by “course path + section index + section title”. If the section order or
  titles change, the records may no longer match — use **Clear this course’s history** to start over.
- Only the currently open course is handled.

## License

[MIT](LICENSE). Free to use, modify and redistribute as long as the copyright notice is kept.

Use at your own risk: this is a study/productivity tool, and using it to bypass course requirements may
violate the rules of your course. Please check and follow them. Whether 2x playback counts as
“fast-forwarding” is likewise governed by your course rules.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
