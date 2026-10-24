// ==UserScript==
// @name           Dia Video Preview
// @description    Live video above Zen's sidebar media player; auto PiP on app switch
// @include        main
// ==/UserScript==

(function () {
  "use strict";
  if (window.DiaVideoPreview) return;

  // ---- Tuning -------------------------------------------------------------
  const DEFAULT_FPS = 24;
  const PAUSED_FPS = 2; // keep the still frame fresh without burning CPU
  const RECT_REFRESH_MS = 1000; // re-locate the video (it may move or resize)
  const NO_VIDEO_GRACE_MS = 2500; // how long a missing video is tolerated
  const MAX_HEIGHT = 220; // tallest the preview gets in the sidebar
  const APP_SWITCH_CHECK_MS = 80; // let focus settle before deciding

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const PREF = "mod.diavideo.";

  const pref = (name, def) => {
    try {
      const type = Services.prefs.getPrefType(PREF + name);
      if (type === Services.prefs.PREF_BOOL) return Services.prefs.getBoolPref(PREF + name);
      if (type === Services.prefs.PREF_STRING) return Services.prefs.getStringPref(PREF + name);
      if (type === Services.prefs.PREF_INT) return Services.prefs.getIntPref(PREF + name);
    } catch (e) {}
    return def;
  };
  const fps = () => {
    const n = parseFloat(pref("fps", DEFAULT_FPS));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 60) : DEFAULT_FPS;
  };

  // ---- Content helper -----------------------------------------------------
  // Runs in each tab and reports where the main video's picture sits on
  // screen (viewport coordinates), so we can snapshot exactly that area.
  const FRAME_SCRIPT = `
(() => {
  const MIN_AREA = 120 * 68;
  function pick() {
    let best = null, bestScore = 0;
    for (const v of content.document.querySelectorAll("video")) {
      if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < MIN_AREA) continue;
      const score = area * (v.paused ? 0.2 : 1) * (v.muted ? 0.5 : 1);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    return best;
  }
  function pictureRect(v) {
    const r = v.getBoundingClientRect();
    const ratio = v.videoWidth / v.videoHeight;
    let w = r.width, h = r.height;
    const fit = content.getComputedStyle(v).objectFit;
    // Default "contain": the picture is letterboxed inside the element.
    if (fit !== "fill" && fit !== "cover") {
      if (w / h > ratio) w = h * ratio; else h = w / ratio;
    }
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
  }
  addMessageListener("DiaVideo:Query", () => {
    const v = pick();
    sendAsyncMessage("DiaVideo:Rect", v ? Object.assign(pictureRect(v), { paused: v.paused }) : null);
  });
})();
`;
  const FRAME_SCRIPT_URL = "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT);

  // ---- State --------------------------------------------------------------
  let el = null; // preview container
  let canvas = null;
  let ctx = null;
  let preview = null; // { tab, browser, rect, lastSeen, drawing, timer, rectTimer }
  let autoPipTab = null; // tab we opened PiP for on app switch
  let barObserver = null;

  const mediaBar = () => document.getElementById("zen-media-controls-toolbar");
  const controllerOf = tab => tab?.linkedBrowser?.browsingContext?.mediaController;
  const isPlaying = tab => !!controllerOf(tab)?.isPlaying;
  const inPip = tab => !!controllerOf(tab)?.isBeingUsedInPIPModeOrFullscreen;
  const windowActive = () => Services.focus.activeWindow === window;

  // ---- Preview element ------------------------------------------------------
  function build() {
    const bar = mediaBar();
    if (!bar) return false;
    canvas = document.createElementNS(HTML_NS, "canvas");
    canvas.className = "dvp-canvas";
    ctx = canvas.getContext("2d", { alpha: false });
    el = document.createElementNS(HTML_NS, "div");
    el.className = "dvp-preview";
    el.hidden = true;
    el.title = "Go to video";
    el.appendChild(canvas);
    el.addEventListener("click", () => {
      if (preview?.tab) selectTab(preview.tab);
    });
    bar.parentNode.insertBefore(el, bar);

    // Follow Zen's player: when its bar hides or shows, we do too.
    barObserver = new MutationObserver(updateVisibility);
    barObserver.observe(bar, { attributes: true, attributeFilter: ["hidden"] });
    return true;
  }

  function selectTab(tab) {
    if (typeof gZenWorkspaces !== "undefined" && gZenWorkspaces.switchTabIfNeeded) {
      gZenWorkspaces.switchTabIfNeeded(tab);
    } else {
      gBrowser.selectedTab = tab;
    }
  }

  function shouldShow() {
    if (!preview || !el || !pref("preview", true)) return false;
    const bar = mediaBar();
    return (
      preview.rect &&
      preview.tab !== gBrowser.selectedTab &&
      !inPip(preview.tab) &&
      bar &&
      !bar.hidden
    );
  }

  function updateVisibility() {
    if (!el) return;
    const show = shouldShow();
    if (el.hidden === !show) return;
    el.hidden = !show;
    if (show) {
      sizeCanvas();
      scheduleFrame(0);
    }
  }

  // Match the canvas to the sidebar width and the video's shape.
  function sizeCanvas() {
    if (!preview?.rect || !el) return;
    const width = el.clientWidth || el.parentNode.clientWidth || 220;
    const ratio = preview.rect.w / preview.rect.h || 16 / 9;
    const height = Math.min(MAX_HEIGHT, Math.round(width / ratio));
    el.style.height = `${height}px`;
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(width * dpr);
    const ch = Math.round(height * dpr);
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
  }

  // ---- Frame loop -----------------------------------------------------------
  function scheduleFrame(delay) {
    if (!preview) return;
    clearTimeout(preview.timer);
    preview.timer = setTimeout(drawFrame, delay);
  }

  async function drawFrame() {
    const p = preview;
    if (!p || p.drawing) return;
    // Nothing to draw into, or nobody can see it: idle until something changes.
    if (el.hidden || !windowActive()) return;

    const wg = p.browser.browsingContext?.currentWindowGlobal;
    const r = p.rect;
    if (!wg || !r) return scheduleFrame(500);

    p.drawing = true;
    const started = performance.now();
    try {
      const scale = canvas.width / r.w;
      const bitmap = await wg.drawSnapshot(new DOMRect(r.x, r.y, r.w, r.h), scale, "black");
      if (preview === p && !el.hidden) {
        // Fit the picture to the canvas, letterboxing if the shapes differ.
        const k = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
        const dw = bitmap.width * k;
        const dh = bitmap.height * k;
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
      }
      bitmap.close?.();
    } catch (e) {
      // The tab navigated or its process changed; the next rect refresh fixes it.
    } finally {
      p.drawing = false;
    }
    if (preview !== p) return;
    const interval = 1000 / (isPlaying(p.tab) ? fps() : PAUSED_FPS);
    scheduleFrame(Math.max(0, interval - (performance.now() - started)));
  }

  // ---- Locating the video ---------------------------------------------------
  function query(browser) {
    try {
      browser.messageManager?.sendAsyncMessage("DiaVideo:Query");
    } catch (e) {}
  }

  function onRect(msg) {
    const browser = msg.target;
    const data = msg.data;

    // Answer to "is there a video in the tab I just left?"
    if (pendingStart && pendingStart.linkedBrowser === browser) {
      const tab = pendingStart;
      pendingStart = null;
      if (data && tab !== gBrowser.selectedTab) startPreview(tab, data);
      return;
    }

    if (!preview || preview.browser !== browser) return;
    if (data) {
      const sizeChanged = !preview.rect || Math.abs(preview.rect.w / preview.rect.h - data.w / data.h) > 0.01;
      preview.rect = data;
      preview.lastSeen = performance.now();
      if (sizeChanged) sizeCanvas();
      updateVisibility();
    } else if (performance.now() - preview.lastSeen > NO_VIDEO_GRACE_MS) {
      stopPreview(); // the video's gone (navigated away, closed player…)
    }
  }

  let pendingStart = null;

  function startPreview(tab, rect) {
    stopPreview();
    if (!el && !build()) return;
    preview = {
      tab,
      browser: tab.linkedBrowser,
      rect,
      lastSeen: performance.now(),
      drawing: false,
      timer: 0,
      rectTimer: setInterval(() => preview && query(preview.browser), RECT_REFRESH_MS),
    };
    sizeCanvas();
    updateVisibility();
  }

  function stopPreview() {
    if (!preview) return;
    clearTimeout(preview.timer);
    clearInterval(preview.rectTimer);
    preview = null;
    if (el) el.hidden = true;
  }

  // ---- Tab switching --------------------------------------------------------
  function onTabSelect(e) {
    const selected = gBrowser.selectedTab;
    if (preview?.tab === selected) stopPreview();

    const prev = e.detail?.previousTab;
    if (prev && prev !== selected && isPlaying(prev) && pref("preview", true)) {
      pendingStart = prev;
      query(prev.linkedBrowser);
    } else {
      updateVisibility();
    }
  }

  function onTabClose(e) {
    if (preview?.tab === e.target) stopPreview();
    if (autoPipTab === e.target) autoPipTab = null;
    if (pendingStart === e.target) pendingStart = null;
  }

  // ---- Picture-in-Picture on app switch ------------------------------------
  function togglePip(tab) {
    try {
      tab.linkedBrowser.browsingContext.currentWindowGlobal
        .getActor("PictureInPictureLauncher")
        .sendAsyncMessage("PictureInPicture:KeyToggle");
      return true;
    } catch (e) {
      console.error("Dia Video Preview: couldn't toggle Picture-in-Picture", e);
      return false;
    }
  }

  function pipCandidate() {
    if (preview && isPlaying(preview.tab)) return preview.tab;
    const selected = gBrowser.selectedTab;
    if (pref("pip_current_tab", false) && isPlaying(selected)) return selected;
    return null;
  }

  function onDeactivate() {
    if (!pref("auto_pip", true)) return;
    // Wait for focus to land: another Zen window (or a PiP window) being
    // focused isn't an app switch.
    setTimeout(() => {
      if (Services.focus.activeWindow) return;
      const tab = pipCandidate();
      if (!tab || inPip(tab)) return;
      if (togglePip(tab)) autoPipTab = tab;
    }, APP_SWITCH_CHECK_MS);
  }

  function onActivate() {
    const tab = autoPipTab;
    autoPipTab = null;
    if (tab && pref("close_pip_on_return", true) && inPip(tab)) togglePip(tab);
    // The preview pauses while Zen isn't focused; pick it back up.
    if (preview) scheduleFrame(0);
  }

  // ---- Overridden Firefox prefs ---------------------------------------------
  // - Background decoding: Firefox stops drawing frames for videos in
  //   background tabs after a few seconds, which would freeze the preview.
  // - Tab-switch PiP: Firefox (on by default in Zen) jumps straight to PiP
  //   when you leave a video tab, skipping the sidebar preview. This mod
  //   takes over that moment: preview on tab switch, PiP on app switch.
  // Original values are restored when the mod is turned off.
  const OVERRIDES = [
    { modPref: "keep_decoding", pref: "media.suspend-bkgnd-video.enabled", value: false },
    {
      modPref: "preview",
      pref: "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled",
      value: false,
    },
  ];
  const saved = new Map(); // firefox pref -> original value, or "default"

  function applyOverrides() {
    for (const { modPref, pref: name, value } of OVERRIDES) {
      if (pref(modPref, true)) {
        if (!saved.has(name)) {
          saved.set(
            name,
            Services.prefs.prefHasUserValue(name) ? Services.prefs.getBoolPref(name) : "default"
          );
        }
        Services.prefs.setBoolPref(name, value);
      } else {
        restoreOverride(name);
      }
    }
  }

  function restoreOverride(name) {
    if (!saved.has(name)) return;
    const original = saved.get(name);
    saved.delete(name);
    if (original === "default") Services.prefs.clearUserPref(name);
    else Services.prefs.setBoolPref(name, original);
  }

  function restoreOverrides() {
    for (const name of [...saved.keys()]) restoreOverride(name);
  }

  const prefObserver = {
    observe() {
      applyOverrides();
      if (!pref("preview", true)) stopPreview();
      updateVisibility();
    },
  };

  // ---- Lifecycle ------------------------------------------------------------
  function onResize() {
    if (preview) {
      sizeCanvas();
      scheduleFrame(0);
    }
  }

  function init() {
    window.messageManager.addMessageListener("DiaVideo:Rect", onRect);
    // Loads into every tab in this window, now and in future.
    window.messageManager.loadFrameScript(FRAME_SCRIPT_URL, true);

    window.addEventListener("TabSelect", onTabSelect);
    window.addEventListener("TabClose", onTabClose);
    window.addEventListener("deactivate", onDeactivate);
    window.addEventListener("activate", onActivate);
    window.addEventListener("resize", onResize);
    Services.prefs.addObserver(PREF, prefObserver);
    applyOverrides();

    window.DiaVideoPreview = {
      get state() {
        return { preview: preview && { tab: preview.tab.label, rect: preview.rect }, autoPipTab: autoPipTab?.label };
      },
      uninit() {
        stopPreview();
        window.messageManager.removeDelayedFrameScript(FRAME_SCRIPT_URL);
        window.messageManager.removeMessageListener("DiaVideo:Rect", onRect);
        window.removeEventListener("TabSelect", onTabSelect);
        window.removeEventListener("TabClose", onTabClose);
        window.removeEventListener("deactivate", onDeactivate);
        window.removeEventListener("activate", onActivate);
        window.removeEventListener("resize", onResize);
        Services.prefs.removeObserver(PREF, prefObserver);
        restoreOverrides();
        barObserver?.disconnect();
        el?.remove();
        el = null;
        delete window.DiaVideoPreview;
      },
    };
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = subject => {
      if (subject !== window) return;
      Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
      init();
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
})();
