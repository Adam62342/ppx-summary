// ==UserScript==
// @name         Perplexity Summarize
// @description  Floating Perplexity panel (top right) that summarizes the current page
// @include      main
// ==/UserScript==

(() => {
  const ID = "pplx-summarize";
  const PREF = "mod.pplx-summarize.";
  const NS = "http://www.w3.org/1999/xhtml";
  const DEFAULT_PROMPT = "Summarize this page into concise bullet points:";
  const MARGIN = 8;

  // Clean up a previous instance if the script is re-run
  window.__pplxSummarize?.destroy();

  const pref = (key, fallback) => {
    try {
      return Services.prefs.getStringPref(PREF + key, fallback) || fallback;
    } catch {
      return fallback;
    }
  };
  const numPref = (key, fallback, min, max) => {
    const n = parseInt(pref(key, String(fallback)), 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  const h = (tag, props = {}, ...kids) => {
    const el = document.createElementNS(NS, tag);
    Object.assign(el, props);
    el.append(...kids);
    return el;
  };

  let panel = null;
  let browserEl = null;
  let lastPageUrl = null;
  let targetUrl = null;

  const pageUrl = () => {
    const uri = gBrowser.currentURI;
    return /^https?$/.test(uri.scheme) ? uri.spec : null;
  };

  function position() {
    if (!panel) return;
    const r = gBrowser.selectedBrowser.getBoundingClientRect();
    const w = Math.min(numPref("width", 420, 280, 1200), r.width - MARGIN * 2);
    const hgt = Math.min(numPref("height", 600, 300, 1400), r.height - MARGIN * 2);
    panel.style.top = `${Math.round(r.top + MARGIN)}px`;
    panel.style.right = `${Math.round(window.innerWidth - r.right + MARGIN)}px`;
    panel.style.width = `${Math.round(w)}px`;
    panel.style.height = `${Math.round(hgt)}px`;
  }

  function load() {
    if (!browserEl || !targetUrl) return;
    const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
    try {
      if (browserEl.fixupAndLoadURIString) {
        browserEl.fixupAndLoadURIString(targetUrl, { triggeringPrincipal });
      } else {
        browserEl.loadURI(Services.io.newURI(targetUrl), { triggeringPrincipal });
      }
    } catch (e) {
      console.error("[pplx-summarize] load failed", e);
    }
  }

  function build() {
    const btn = (label, title, onclick) =>
      h("button", { className: "pplx-btn", textContent: label, title, onclick });

    const header = h(
      "div",
      { className: "pplx-header" },
      h("span", { className: "pplx-title", textContent: "Perplexity · Summary" }),
      h("span", { className: "pplx-spacer" }),
      btn("↻", "Re-run summary", () => load()),
      btn("↗", "Open in a tab", openInTab),
      btn("✕", "Close (Esc)", close)
    );

    browserEl = document.createXULElement("browser");
    for (const [k, v] of Object.entries({
      type: "content",
      remote: "true",
      maychangeremoteness: "true",
      nodefaultsrc: "true",
      disablehistory: "true",
      messagemanagergroup: "browsers",
      autocompletepopup: "PopupAutoComplete",
      flex: "1",
    })) {
      browserEl.setAttribute(k, v);
    }

    const body = h("div", { className: "pplx-body" });
    panel = h("div", { id: `${ID}-panel` }, header, body);
    body.append(browserEl);
    document.documentElement.append(panel);
    position();
  }

  function open(url) {
    lastPageUrl = url;
    const prompt = pref("prompt", DEFAULT_PROMPT);
    targetUrl = "https://www.perplexity.ai/search?q=" + encodeURIComponent(`${prompt} ${url}`);
    if (!panel) build();
    else position();
    load();
  }

  function close() {
    panel?.remove();
    panel = null;
    browserEl = null;
    lastPageUrl = null;
    targetUrl = null;
  }

  function openInTab() {
    const spec = browserEl?.currentURI?.spec || targetUrl;
    if (!spec) return;
    close();
    openTrustedLinkIn(spec, "tab");
  }

  function toggle() {
    const url = pageUrl();
    if (panel && (!url || url === lastPageUrl)) return close(); // same page -> toggle off
    if (url) open(url); // new page -> (re)summarize
  }

  const onKey = (e) => {
    if (e.key === "Escape" && panel) {
      close();
    } else if (e.altKey && e.shiftKey && e.code === "KeyP") {
      e.preventDefault();
      toggle();
    }
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", position);

  // Toolbar button (created once per session, shared across windows)
  const { CustomizableUI } = ChromeUtils.importESModule(
    "resource:///modules/CustomizableUI.sys.mjs"
  );
  if (!CustomizableUI.getWidget(ID)?.provider) {
    CustomizableUI.createWidget({
      id: ID,
      type: "button",
      label: "Summarize with Perplexity",
      tooltiptext: "Summarize this page with Perplexity (Alt+Shift+P)",
      defaultArea: CustomizableUI.AREA_NAVBAR,
      onCommand(e) {
        e.target.ownerGlobal.__pplxSummarize?.toggle();
      },
    });
  }

  window.__pplxSummarize = {
    toggle,
    destroy() {
      close();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", position);
      delete window.__pplxSummarize;
    },
  };

  console.log("[pplx-summarize] loaded");
})();
