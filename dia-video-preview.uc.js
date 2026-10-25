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
  const RETURN_POLL_MS = 250; // how often to check for a return while our PiP is up

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
  // Runs in each tab, and in the preview's blank page in the sidebar.
  // In a tab, it finds the main video and reports its shape and position.
  // It can also hand that video over to the preview the way Firefox's
  // Picture-in-Picture does: the tab passes a reference to the video, and the
  // preview page (in the same process) looks it up and calls
  // cloneElementVisually(), which shows the same decoded frames in a second
  // <video>, with no copying.
  const FRAME_SCRIPT = `
(() => {
  const { ContentDOMReference } = ChromeUtils.importESModule(
    "resource://gre/modules/ContentDOMReference.sys.mjs"
  );
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

  // ---- In a tab: share the video ----
  let shared = null; // the video handed to the preview
  function share() {
    const v = pick();
    shared = v;
    let ref = null;
    try { if (v) ref = ContentDOMReference.get(v); } catch (e) {}
    sendAsyncMessage("DiaVideo:Ref", ref);
  }
  addMessageListener("DiaVideo:Query", () => {
    const v = pick();
    // The site swapped its video element (next episode, ad, etc.): follow it.
    if (shared && v && v !== shared) share();
    sendAsyncMessage("DiaVideo:Rect", v ? Object.assign(pictureRect(v), { paused: v.paused }) : null);
  });
  addMessageListener("DiaVideo:Share", share);
  addMessageListener("DiaVideo:Unshare", () => { shared = null; });

  // ---- In the preview page: show the shared video ----
  let mirror = null; // { source, target }
  function detach() {
    if (!mirror) return;
    try { mirror.source.stopCloningElementVisually(); } catch (e) {}
    try { mirror.target.remove(); } catch (e) {}
    mirror = null;
  }
  addMessageListener("DiaVideo:Attach", async ({ data }) => {
    detach();
    try {
      const source = data && (await ContentDOMReference.resolve(data));
      if (!source) throw new Error("video isn't in this process");
      const doc = content.document;
      let body = doc.body;
      if (!body) {
        body = doc.createElement("body");
        doc.documentElement.appendChild(body);
      }
      doc.documentElement.style.cssText = "background:#000;";
      body.style.cssText = "margin:0;background:#000;overflow:hidden;";
      const target = doc.createElement("video");
      target.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;background:#000;";
      body.appendChild(target);
      mirror = { source, target };
      await source.cloneElementVisually(target);
      sendAsyncMessage("DiaVideo:MirrorResult", { ok: true });
    } catch (e) {
      detach();
      sendAsyncMessage("DiaVideo:MirrorResult", { ok: false, error: String(e) });
    }
  });
  addMessageListener("DiaVideo:Detach", detach);

  // Lets the window know this page is ready for messages.
  sendAsyncMessage("DiaVideo:Hello");
})();
`;
  const FRAME_SCRIPT_URL = "data:application/javascript;charset=utf-8," + encodeURIComponent(FRAME_SCRIPT);

  // ---- State --------------------------------------------------------------
  let el = null; // preview container
  let canvas = null;
  let ctx = null;
  let preview = null; // { tab, browser, mode, mirrorBrowser, rect, lastSeen, drawing, timer, rectTimer }
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
    // Sits on top of the mirrored page so clicks reach us, not the page.
    const shield = document.createElementNS(HTML_NS, "div");
    shield.className = "dvp-shield";
    el.appendChild(shield);
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
    // Only render the mirror while it can be seen.
    if (preview?.mirrorBrowser) setMirrorActive(show);
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
    if (!preview || preview.mode === "mirror") return;
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

  // ---- Mirror (PiP-style) ---------------------------------------------------
  // A tiny blank page in the sidebar, created in the same process as the video
  // tab (the same trick Firefox's PiP player uses), for the tab to mirror its
  // video into.
  function createMirror(tab) {
    const src = tab.linkedBrowser;
    const group = src.browsingContext?.group?.id;
    if (!src.remoteType || !group) return null;
    const b = document.createXULElement("browser");
    b.className = "dvp-mirror";
    b.setAttribute("type", "content");
    b.setAttribute("remote", "true");
    b.setAttribute("nodefaultsrc", "true");
    b.setAttribute("disableglobalhistory", "true");
    b.setAttribute("tabindex", "-1");
    b.setAttribute("remoteType", src.remoteType);
    b.setAttribute("initialBrowsingContextGroupId", group);
    el.insertBefore(b, el.firstChild);
    return b;
  }

  function setMirrorActive(active) {
    const b = preview?.mirrorBrowser;
    if (!b) return;
    // Both are needed for a remote page to actually draw; either can throw
    // while the page is still starting up, so this is retried once it's ready.
    try {
      b.docShellIsActive = active;
    } catch (e) {}
    try {
      b.renderLayers = active;
    } catch (e) {}
  }

  // The tab sent a reference to its video.
  function onRef(msg) {
    if (!preview || preview.browser !== msg.target) return;
    preview.ref = msg.data;
    if (!msg.data) {
      if (preview.mode !== "snapshot") useSnapshots("no video to share");
      return;
    }
    attach();
  }

  // The preview's blank page has loaded our helper and can take messages.
  function onHello(msg) {
    if (!preview?.mirrorBrowser || preview.mirrorBrowser !== msg.target) return;
    preview.mirrorReady = true;
    setMirrorActive(!el.hidden);
    attach();
  }

  function attach() {
    const p = preview;
    if (!p?.mirrorBrowser || !p.mirrorReady || !p.ref) return;
    try {
      p.mirrorBrowser.messageManager.sendAsyncMessage("DiaVideo:Attach", p.ref);
    } catch (e) {
      useSnapshots(String(e));
    }
  }

  function onMirrorResult(msg) {
    if (!preview?.mirrorBrowser || preview.mirrorBrowser !== msg.target) return;
    if (msg.data?.ok) {
      preview.mode = "mirror";
      el.setAttribute("mode", "mirror");
      clearTimeout(preview.timer); // snapshots no longer needed
      setMirrorActive(!el.hidden);
    } else {
      useSnapshots(msg.data?.error);
    }
  }

  function useSnapshots(reason) {
    const p = preview;
    if (!p) return;
    if (reason) console.warn("Dia Video Preview: mirroring unavailable, using snapshots:", reason);
    try {
      p.browser.messageManager?.sendAsyncMessage("DiaVideo:Unshare");
    } catch (e) {}
    p.mirrorBrowser?.remove();
    p.mirrorBrowser = null;
    p.mode = "snapshot";
    el.setAttribute("mode", "snapshot");
    scheduleFrame(0);
  }

  function startPreview(tab, rect) {
    stopPreview();
    if (!el && !build()) return;
    preview = {
      tab,
      browser: tab.linkedBrowser,
      // "connecting" draws snapshots until the live mirror is confirmed.
      mode: "connecting",
      mirrorBrowser: null,
      mirrorReady: false,
      ref: null,
      rect,
      lastSeen: performance.now(),
      drawing: false,
      timer: 0,
      rectTimer: setInterval(() => preview && query(preview.browser), RECT_REFRESH_MS),
    };
    el.setAttribute("mode", "connecting");
    sizeCanvas();
    updateVisibility();
    scheduleFrame(0);

    try {
      preview.mirrorBrowser = createMirror(tab);
      if (!preview.mirrorBrowser) return useSnapshots("tab has no content process");
      tab.linkedBrowser.messageManager.sendAsyncMessage("DiaVideo:Share");
    } catch (e) {
      return useSnapshots(String(e));
    }
    // If the mirror never connects, stay on snapshots rather than wait forever.
    const p = preview;
    setTimeout(() => {
      if (preview === p && p.mode === "connecting") useSnapshots("timed out connecting");
    }, 3000);
  }

  function stopPreview() {
    if (!preview) return;
    clearTimeout(preview.timer);
    clearInterval(preview.rectTimer);
    try {
      preview.browser.messageManager?.sendAsyncMessage("DiaVideo:Unshare");
    } catch (e) {}
    try {
      preview.mirrorBrowser?.messageManager?.sendAsyncMessage("DiaVideo:Detach");
    } catch (e) {}
    preview.mirrorBrowser?.remove();
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
    if (autoPipTab === e.target) {
      autoPipTab = null;
      stopWatchingForReturn();
    }
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
    if (pref("pip_current_tab", true) && isPlaying(selected)) return selected;
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
      if (togglePip(tab)) {
        autoPipTab = tab;
        watchForReturn();
      }
    }, APP_SWITCH_CHECK_MS);
  }

  // Coming back to Zen often focuses the PiP window rather than this one
  // (it's the frontmost Zen window), so this window never gets "activate".
  // While our PiP is up, watch for *any* Zen window becoming active instead.
  let returnWatch = 0;
  function watchForReturn() {
    clearInterval(returnWatch);
    returnWatch = setInterval(() => {
      if (!autoPipTab) return stopWatchingForReturn();
      if (Services.focus.activeWindow) onReturn();
    }, RETURN_POLL_MS);
  }

  function stopWatchingForReturn() {
    clearInterval(returnWatch);
    returnWatch = 0;
  }

  function onReturn() {
    stopWatchingForReturn();
    const tab = autoPipTab;
    autoPipTab = null;
    if (tab && pref("close_pip_on_return", true) && inPip(tab)) {
      togglePip(tab);
      // Bring the main window forward in place of the closing PiP window.
      if (Services.focus.activeWindow !== window) window.focus();
    }
    // The preview pauses while Zen isn't focused; pick it back up.
    if (preview) scheduleFrame(0);
  }

  function onActivate() {
    if (autoPipTab) onReturn();
    else if (preview) scheduleFrame(0);
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
    window.messageManager.addMessageListener("DiaVideo:Ref", onRef);
    window.messageManager.addMessageListener("DiaVideo:Hello", onHello);
    window.messageManager.addMessageListener("DiaVideo:MirrorResult", onMirrorResult);
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
        return {
          preview: preview && { tab: preview.tab.label, mode: preview.mode, rect: preview.rect },
          autoPipTab: autoPipTab?.label,
        };
      },
      uninit() {
        stopPreview();
        stopWatchingForReturn();
        window.messageManager.removeDelayedFrameScript(FRAME_SCRIPT_URL);
        window.messageManager.removeMessageListener("DiaVideo:Rect", onRect);
        window.messageManager.removeMessageListener("DiaVideo:Ref", onRef);
        window.messageManager.removeMessageListener("DiaVideo:Hello", onHello);
        window.messageManager.removeMessageListener("DiaVideo:MirrorResult", onMirrorResult);
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
