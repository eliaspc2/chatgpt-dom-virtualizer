// ==UserScript==
// @name         ChatGPT DOM Virtualizer
// @namespace    https://github.com/eliaspc2/chatgpt-dom-virtualizer
// @version      1.0.32
// @description  Keep a tiny live ChatGPT viewport, serialize turns to disk, and refill the rest from a persistent buffer.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @noframes
// @run-at       document-start
// @inject-into  content
// @downloadURL  https://raw.githubusercontent.com/eliaspc2/chatgpt-dom-virtualizer/main/chatgpt-dom-virtualizer.user.js
// @updateURL    https://raw.githubusercontent.com/eliaspc2/chatgpt-dom-virtualizer/main/chatgpt-dom-virtualizer.user.js
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window) {
    return;
  }

  if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(location.href)) {
    return;
  }

  const SCRIPT_VERSION = "1.0.32";

  const CONFIG = Object.freeze({
    initialTail: 5,
    step: 2,
    backgroundCrawlEnabled: false,
    backgroundCrawlIdleMs: 3500,
    backgroundCrawlStepPx: 560,
    backgroundCrawlPauseMs: 450,
    persistDebounceMs: 300,
    snapshotCacheRadius: 8,
    edgeThresholdRatio: 0.35,
    minEdgeThresholdPx: 220,
    bootstrapWaitMs: 45000,
    bootstrapRetryMs: 500,
    coldStartHoldMs: 3500,
    hydrationQuietMs: 1200,
    hydrationMaxWaitMs: 18000,
    nativeJumpCooldownMs: 650,
    healthCheckMs: 1200,
    recoveryCooldownMs: 2500,
    scrollRetryDelaysMs: [80, 180, 420, 900, 1500, 2400],
    mutationCooldownMs: 60,
  });

  const DB_NAME = "chatgpt-dom-virtualizer";
  const DB_VERSION = 1;
  const DB_STORE = "snapshots";
  const OVERLAY_HOST_ID = "chatgpt-dom-virtualizer-overlay";
  const OVERLAY_STORAGE_KEY = "chatgpt-dom-virtualizer-overlay-expanded";

  const TURN_SELECTOR = [
    "[data-message-author-role]",
    "[data-testid=\"conversation-turn\"]",
    "article",
    "[role=\"article\"]",
  ].join(", ");

  const TURN_ROOT_SELECTOR = [
    "[data-message-author-role]",
    "[data-testid*=\"conversation-turn\"]",
    "[data-turn-id]",
    "[data-message-id]",
    "[data-turn-start-message=\"true\"]",
  ].join(", ");

  const IMAGE_GENERATION_TEXT_PATTERN = /a criar imagem|a gerar imagem|gerando imagem|creating image|generating image|image generation|imagem em criacao|imagem em criação/i;

  const COMPOSER_SELECTORS = Object.freeze([
    "textarea[name=\"prompt-textarea\"]",
    "#prompt-textarea",
    "[data-testid=\"prompt-textarea\"]",
    "textarea[aria-label*=\"message\" i]",
    "textarea[aria-label*=\"mensagem\" i]",
  ]);

  const state = {
    enabled: true,
    bootstrapped: false,
    root: null,
    composer: null,
    composerForm: null,
    scrollTarget: null,
    pageSupported: false,
    records: [],
    recordByNode: new WeakMap(),
    resizeObserver: null,
    mutationObserver: null,
    startupObserver: null,
    scrollHandler: null,
    inputHandler: null,
    routeTimer: null,
    retryTimer: null,
    applyTimer: null,
    startupCheckQueued: false,
    mutationPause: 0,
    href: location.href,
    scriptStartedAt: Date.now(),
    lastPageMutationAt: Date.now(),
    windowStart: 0,
    windowEnd: -1,
    topHeight: 0,
    loadedHeight: 0,
    bottomHeight: 0,
    lastScrollTop: 0,
    scrollDirection: "down",
    lastPolicyReason: "",
    turnSelector: "",
    conversationKey: "",
    dbPromise: null,
    dbReady: false,
    persistTimer: null,
    persistQueue: new Set(),
    crawlTimer: null,
    crawlRunning: false,
    crawlAttemptAtTop: 0,
    crawlExhausted: false,
    internalScrollDepth: 0,
    scrollToLatestTimer: null,
    scrollToLatestRetryTimer: null,
    scrollToLatestStartedAt: 0,
    runtimePhase: "init",
    runtimeDetail: "",
    healthTimer: null,
    bootstrapAttempts: 0,
    bootstrapStartedAt: 0,
    lastRecoveryAt: 0,
    lastNativeJumpAt: 0,
    lastFailure: "",
    lastFailureAt: 0,
    overlayHost: null,
    overlayShadow: null,
    overlayCompact: true,
    overlayExpanded: false,
    lastUserActivityAt: 0,
    nextSequence: 0,
    scanCursor: null,
    scanTimer: null,
    scanExhausted: false,
    startupObserverBodyObserved: false,
  };

  installApi();
  markBoot("installed");
  installRouteWatchers();
  installHealthWatchdog();
  if (syncPageSupport("init") && state.enabled) {
    primeBootstrap("init");
  }

  function installApi() {
    if (window.__chatgptDomVirtualizer) {
      return;
    }

    window.__chatgptDomVirtualizer = {
      refresh() {
        clearBootstrapFailure();
        syncPageSupport("manual-refresh");
        if (state.enabled && state.pageSupported) {
          setRuntimePhase("booting", "manual-refresh");
          scheduleBootstrap("manual-refresh");
        }
      },
      disable() {
        state.enabled = false;
        resetSession(true);
        setRuntimePhase("disabled", "manual-disable");
      },
      enable() {
        state.enabled = true;
        clearBootstrapFailure();
        syncPageSupport("manual-enable");
        if (state.pageSupported) {
          setRuntimePhase("booting", "manual-enable");
          scheduleBootstrap("manual-enable");
        }
      },
      inspect() {
        return buildInspection();
      },
      status() {
        return buildInspection();
      },
      toggleOverlay() {
        toggleDiagnosticsOverlay();
      },
      showOverlay() {
        setDiagnosticsOverlayState(false, false);
      },
      hideOverlay() {
        setDiagnosticsOverlayState(true, false);
      },
      showDetails() {
        setDiagnosticsOverlayExpanded(true);
      },
      hideDetails() {
        setDiagnosticsOverlayExpanded(false);
      },
    };

    console.info("[ChatGPT DOM Virtualizer] installed");
  }

  function buildInspection() {
    const root = state.root;
    const composer = state.composer;
    const scrollTarget = state.scrollTarget;
    return {
      enabled: state.enabled,
      scriptVersion: SCRIPT_VERSION,
      bootstrapped: state.bootstrapped,
      pageSupported: state.pageSupported,
      overlayCompact: state.overlayCompact,
      href: location.href,
      rootTag: root ? root.tagName : "",
      composerName: composer ? composer.getAttribute("name") || composer.id || composer.tagName : "",
      scrollTargetTag: scrollTarget ? scrollTarget.tagName : "",
      totalRecords: state.records.length,
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      activeWindowSize: state.windowEnd >= state.windowStart ? state.windowEnd - state.windowStart + 1 : 0,
      topHeight: state.topHeight,
      loadedHeight: state.loadedHeight,
      bottomHeight: state.bottomHeight,
      conversationKey: state.conversationKey,
      dbReady: state.dbReady,
      persistQueueSize: state.persistQueue.size,
      crawlRunning: state.crawlRunning,
      crawlExhausted: state.crawlExhausted,
      runtimePhase: state.runtimePhase,
      runtimeDetail: state.runtimeDetail,
      bootstrapAttempts: state.bootstrapAttempts,
      lastFailure: state.lastFailure,
      lastFailureAt: state.lastFailureAt,
      overlayExpanded: state.overlayExpanded,
      nextSequence: state.nextSequence,
      edgeThresholdPx: getEdgeThresholdPx(),
      composerFocused: isComposerFocused(),
      scrollTop: getScrollTop(),
      scrollDirection: state.scrollDirection,
      turnSelector: state.turnSelector,
      composerSummary: describeElement(composer),
      rootSummary: describeElement(root),
      scrollTargetSummary: describeElement(scrollTarget),
      scanCursorSummary: describeElement(state.scanCursor),
    };
  }

  function buildPhaseLabel(phase) {
    switch (phase) {
      case "ready":
        return "Ready";
      case "booting":
        return "Booting";
      case "waiting-body":
        return "Waiting for page";
      case "waiting-composer":
        return "Looking for the text box";
      case "waiting-root":
        return "Looking for the conversation";
      case "waiting-history":
        return "Waiting for messages";
      case "waiting-hydration":
        return "Waiting for ChatGPT";
      case "retrying":
        return "Retrying";
      case "error":
        return "Error";
      case "disabled":
        return "Disabled";
      case "init":
        return "Initializing";
      default:
        return "Working";
    }
  }

  function buildWindowSummary() {
    if (!state.records.length) {
      return "No messages found yet.";
    }

    const visible = state.windowEnd >= state.windowStart ? state.windowEnd - state.windowStart + 1 : 0;
    return `Showing ${visible} of ${state.records.length} messages.`;
  }

  function buildReasonLabel(reason) {
    switch (reason) {
      case "init":
        return "initial startup";
      case "bootstrap":
        return "bootstrap";
      case "manual-refresh":
      case "overlay-refresh":
        return "manual refresh";
      case "manual-enable":
        return "manual enable";
      case "manual-disable":
        return "manual disable";
      case "route-change":
        return "conversation change";
      case "startup-ready":
        return "page ready";
      case "startup-fallback":
        return "startup fallback";
      case "waiting-body":
        return "still waiting for the page";
      case "waiting-composer":
        return "still looking for the text box";
      case "waiting-root":
        return "still looking for the conversation";
      case "waiting-history":
        return "still waiting for messages";
      case "waiting-hydration":
        return "the page is still hydrating";
      case "native-jump":
        return "asking ChatGPT to show the latest message";
      case "retry":
        return "retry";
      case "background-crawl":
        return "background crawl";
      case "background-scan":
        return "message discovery";
      case "history-scan":
        return "history discovery";
      case "scroll":
        return "scroll";
      case "input":
        return "typing in the box";
      case "mutation":
        return "page change";
      case "detached-session":
        return "stale state removed";
      case "overlay-refresh":
        return "panel refresh";
      case "indexedDB unavailable":
        return "local storage unavailable";
      case "indexedDB open failed":
        return "failed to open local storage";
      case "indexedDB error":
        return "local storage error";
      case "indexedDB blocked":
        return "local storage blocked";
      case "unsupported-page":
        return "unsupported page";
      default:
        return reason || "no details";
    }
  }

  function buildFailureLabel(failure) {
    const text = String(failure || "").trim();
    if (!text) {
      return "No recent failures.";
    }

    const stage = text.split(":")[0].trim();
    switch (stage) {
      case "composer-not-found":
        return "Could not find the ChatGPT text box.";
      case "conversation-root-not-found":
        return "Found the text box, but not the main conversation area.";
      case "indexedDB unavailable":
        return "Local storage is not available in this browser.";
      case "indexedDB open failed":
        return "Could not open local storage.";
      case "indexedDB error":
        return "There was a local storage error.";
      case "indexedDB blocked":
        return "Local storage is blocked.";
      default:
        return text;
    }
  }

  function buildDiagnosticsSummary() {
    if (!state.enabled) {
      return "The virtualizer is off.";
    }
    if (state.lastFailure) {
      return "I hit a startup problem.";
    }
    if (!state.bootstrapped) {
      return `${buildPhaseLabel(state.runtimePhase)}.`;
    }
    return `${buildPhaseLabel("ready")}. ${buildWindowSummary()}`;
  }

  function buildDiagnosticsDetails() {
    const lines = [
      `${buildPhaseLabel(state.runtimePhase)}${state.runtimeDetail ? `: ${buildReasonLabel(state.runtimeDetail)}` : ""}`,
      `CDV version: ${SCRIPT_VERSION}`,
      `Conversation: ${state.conversationKey || "not identified yet"}`,
      `Text box: ${state.composerSummary || "not found yet"}`,
      `Main conversation: ${state.rootSummary || "not found yet"}`,
      `Scroll area: ${state.scrollTargetSummary || "not found yet"}`,
      `Messages loaded: ${state.records.length}`,
      `Visible window: ${state.windowStart} to ${state.windowEnd}`,
      `Current scroll: ${Math.round(getScrollTop())} px`,
      `Local DB: ${state.dbReady ? "active" : "still preparing"}`,
      `Background history: ${!CONFIG.backgroundCrawlEnabled ? "off" : state.crawlRunning ? "running" : state.crawlExhausted ? "exhausted" : "idle"}`,
    ];

    if (state.lastFailure) {
      lines.push(`Last problem: ${buildFailureLabel(state.lastFailure)}`);
    }

    return lines.join("\n");
  }

  function loadOverlayCompactPreference() {
    return true;
  }

  function saveOverlayCompactPreference(compact) {
    void compact;
  }

  function setDiagnosticsOverlayCompact(compact) {
    setDiagnosticsOverlayState(compact, false);
  }

  function toggleDiagnosticsOverlay() {
    setDiagnosticsOverlayState(!state.overlayCompact, false);
  }

  function setDiagnosticsOverlayExpanded(expanded) {
    setDiagnosticsOverlayState(state.overlayCompact, expanded);
  }

  function toggleDiagnosticsDetails() {
    setDiagnosticsOverlayExpanded(!state.overlayExpanded);
  }

  function setDiagnosticsOverlayState(compact, expanded) {
    const nextCompact = !!compact;
    const nextExpanded = !!expanded;
    state.overlayCompact = nextExpanded ? false : nextCompact;
    state.overlayExpanded = nextExpanded;
    saveOverlayCompactPreference(state.overlayCompact);
    renderDiagnosticsOverlay();
  }

  function setRuntimePhase(phase, detail = "") {
    state.runtimePhase = phase || "idle";
    state.runtimeDetail = detail || "";
    markBoot(state.runtimePhase, state.runtimeDetail);
    renderDiagnosticsOverlay();
  }

  function clearBootstrapFailure() {
    state.lastFailure = "";
    state.lastFailureAt = 0;
  }

  function reportBootstrapFailure(stage, detail) {
    state.lastFailure = detail ? `${stage}: ${detail}` : stage;
    state.lastFailureAt = Date.now();
    setRuntimePhase("error", stage);
  }

  function markBoot(phase, detail = "") {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    root.dataset.cdvBootVersion = SCRIPT_VERSION;
    root.dataset.cdvBootPhase = phase || "";
    root.dataset.cdvBootDetail = detail || "";
  }

  function describeElement(node) {
    if (!(node instanceof HTMLElement)) {
      return "";
    }

    const pieces = [node.tagName.toLowerCase()];
    if (node.id) {
      pieces.push(`#${node.id}`);
    }
    const testId = node.getAttribute("data-testid");
    if (testId) {
      pieces.push(`[data-testid="${testId}"]`);
    }
    const role = node.getAttribute("role");
    if (role) {
      pieces.push(`[role="${role}"]`);
    }
    return pieces.join("");
  }

  function isLocalePrefix(segment) {
    return /^[a-z]{2}(?:-[a-z]{2})?$/i.test(segment || "");
  }

  function isSupportedChatRoute(pathname = location.pathname) {
    const cleanedPath = (pathname || "/").replace(/\/+$/, "") || "/";
    const segments = cleanedPath.split("/").filter(Boolean);
    const routeIndex = segments.length > 0 && isLocalePrefix(segments[0]) ? 1 : 0;
    const routeHead = segments[routeIndex] || "";
    return routeHead === "" || routeHead === "c" || routeHead === "g" || routeHead === "chat";
  }

  function removeDiagnosticsOverlay() {
    if (state.overlayHost && state.overlayHost.isConnected) {
      state.overlayHost.remove();
    }
    state.overlayHost = null;
    state.overlayShadow = null;
  }

  function syncPageSupport(reason = "route-change") {
    const supported = isSupportedChatRoute();

    if (state.pageSupported === supported) {
      if (supported && !state.overlayHost) {
        installDiagnosticsOverlay();
        if (!state.enabled) {
          setRuntimePhase("disabled", reason || "supported page");
        }
      } else if (!supported) {
        removeDiagnosticsOverlay();
      }
      return supported;
    }

    state.pageSupported = supported;

    if (!supported) {
      disconnectStartupObserver();
      resetSession(true);
      removeDiagnosticsOverlay();
      setRuntimePhase("disabled", "unsupported-page");
      return false;
    }

    installDiagnosticsOverlay();
    if (!state.enabled) {
      setRuntimePhase("disabled", reason || "supported page");
    }
    return true;
  }

  function installDiagnosticsOverlay() {
    if (!state.pageSupported) {
      return;
    }
    if (state.overlayHost) {
      return;
    }

    state.overlayCompact = loadOverlayCompactPreference();
    state.overlayExpanded = false;

    const host = document.createElement("div");
    host.id = OVERLAY_HOST_ID;
    host.dataset.cdvOverlayRoot = "true";
    host.style.cssText = [
      "position: fixed",
      "right: 12px",
      "bottom: 12px",
      "z-index: 2147483647",
      "pointer-events: none",
      "contain: layout style paint",
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
        }
        * {
          box-sizing: border-box;
        }
        .panel {
          --panel-radius: 20px;
          pointer-events: auto;
          color: #f3f6fb;
          font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
          position: relative;
          border: 1px solid rgba(255, 255, 255, 0.10);
          background: rgba(18, 23, 31, 0.92);
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          background-clip: padding-box;
          overflow: hidden;
          border-radius: var(--panel-radius);
          clip-path: inset(0 round var(--panel-radius));
          -webkit-clip-path: inset(0 round var(--panel-radius));
          isolation: isolate;
        }
        .panel[data-phase="ready"] .dot {
          background: #39d98a;
          box-shadow: 0 0 0 4px rgba(57, 217, 138, 0.18);
        }
        .panel[data-phase="booting"] .dot,
        .panel[data-phase="waiting"] .dot {
          background: #f2c14e;
          box-shadow: 0 0 0 4px rgba(242, 193, 78, 0.18);
        }
        .panel[data-phase="error"] .dot {
          background: #ff7b72;
          box-shadow: 0 0 0 4px rgba(255, 123, 114, 0.18);
        }
        .panel[data-phase="disabled"] .dot {
          background: #8f97a3;
          box-shadow: 0 0 0 4px rgba(143, 151, 163, 0.18);
        }
        .panel[data-compact="true"] {
          --panel-radius: 12px;
          width: 40px;
          height: 40px;
        }
        .panel[data-compact="false"] {
          --panel-radius: 20px;
          width: min(360px, calc(100vw - 24px));
          min-height: 480px;
          max-height: min(84vh, 760px);
        }
        .surface {
          display: none;
          position: relative;
          width: 100%;
          height: 100%;
          padding: 10px 10px 50px;
          gap: 8px;
        }
        .panel[data-compact="false"] .surface {
          display: grid;
          grid-template-rows: auto auto 1fr;
        }
        .panel[data-compact="true"] .surface {
          display: none;
        }
        .dock {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 40px;
          height: 40px;
          z-index: 2;
        }
        .launcher {
          border: 0;
          color: inherit;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 0;
          background: transparent;
        }
        .launcher:hover {
          background: rgba(255, 255, 255, 0.08);
        }
        .launcher:active {
          transform: translateY(1px);
        }
        .launcher--outer {
          width: 100%;
          height: 100%;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.08);
        }
        .header {
          display: flex;
          align-items: center;
          gap: 10px;
          min-width: 0;
        }
        .dot {
          width: 10px;
          height: 10px;
          border-radius: 999px;
          background: #39d98a;
          flex: 0 0 auto;
        }
        .title {
          display: flex;
          flex-direction: column;
          min-width: 0;
          gap: 1px;
          flex: 1 1 auto;
        }
        .title strong {
          font-size: 11px;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }
        .title span {
          color: #b8c1cf;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
        button {
          border: 0;
          border-radius: 999px;
          padding: 6px 10px;
          color: inherit;
          background: rgba(255, 255, 255, 0.08);
          cursor: pointer;
          font: inherit;
        }
        button:hover {
          background: rgba(255, 255, 255, 0.14);
        }
        button:active {
          transform: translateY(1px);
        }
        .tools {
          display: none;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 8px;
        }
        .panel[data-compact="false"] .tools {
          display: grid;
        }
        .tool {
          justify-content: flex-start;
          padding: 8px 10px;
          border-radius: 12px;
        }
        .tool--primary {
          background: rgba(57, 217, 138, 0.16);
        }
        .tool--primary:hover {
          background: rgba(57, 217, 138, 0.24);
        }
        .tool--ghost {
          background: rgba(255, 255, 255, 0.06);
        }
        .tool--ghost:hover {
          background: rgba(255, 255, 255, 0.11);
        }
        .tool--subtle {
          background: rgba(255, 255, 255, 0.08);
        }
        .body {
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          padding-top: 10px;
          display: grid;
          gap: 10px;
          min-height: 0;
        }
        .summary {
          color: #d9e1ec;
          font-weight: 600;
          word-break: break-word;
          padding: 10px 12px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.06);
        }
        pre {
          margin: 0;
          max-height: min(34vh, 300px);
          overflow: auto;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255, 255, 255, 0.06);
          color: #eef3f9;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .panel[data-expanded="false"] .details {
          display: none;
        }
        .panel[data-expanded="false"] {
          min-height: 0;
          max-height: none;
        }
        .panel[data-expanded="false"] .surface {
          grid-template-rows: auto auto;
        }
        .panel[data-expanded="false"] .body {
          display: none;
        }
      </style>
      <section class="panel" data-compact="${state.overlayCompact ? "true" : "false"}" data-expanded="${state.overlayExpanded ? "true" : "false"}">
        <div class="surface">
          <div class="header">
            <div class="title">
              <strong>CDV</strong>
              <span class="summary"></span>
            </div>
          </div>
          <div class="tools">
            <button type="button" class="refresh tool tool--primary" title="Refresh now" aria-label="Refresh now">Refresh</button>
            <button type="button" class="scroll tool tool--ghost" title="Jump to the latest message" aria-label="Jump to the latest message">Go to end</button>
            <button type="button" class="toggle tool tool--subtle" title="Show details" aria-label="Show details">Details</button>
          </div>
          <div class="body">
            <pre class="details"></pre>
          </div>
        </div>
        <div class="dock">
          <button type="button" class="launcher launcher--outer" title="Open panel" aria-label="Open panel">
            <span class="dot" aria-hidden="true"></span>
          </button>
        </div>
      </section>
    `;

    const panel = shadow.querySelector(".panel");
    const outerLauncher = shadow.querySelector(".launcher--outer");
    const summaryNode = shadow.querySelector(".summary");
    const detailsNode = shadow.querySelector(".details");
    const refreshButton = shadow.querySelector(".refresh");
    const scrollButton = shadow.querySelector(".scroll");
    const toggleButton = shadow.querySelector(".toggle");

    if (!(panel instanceof HTMLElement) || !(outerLauncher instanceof HTMLButtonElement) || !(summaryNode instanceof HTMLElement) || !(detailsNode instanceof HTMLElement) || !(refreshButton instanceof HTMLButtonElement) || !(scrollButton instanceof HTMLButtonElement) || !(toggleButton instanceof HTMLButtonElement)) {
      return;
    }

    outerLauncher.addEventListener("click", () => {
      toggleDiagnosticsOverlay();
    });

    refreshButton.addEventListener("click", () => {
      clearBootstrapFailure();
      setRuntimePhase("booting", "overlay-refresh");
      scheduleBootstrap("overlay-refresh");
    });

    scrollButton.addEventListener("click", () => {
      scheduleScrollToLatest("overlay-scroll", true);
    });

    toggleButton.addEventListener("click", () => {
      toggleDiagnosticsDetails();
    });

    const mountTarget = document.documentElement;
    if (!mountTarget) {
      window.setTimeout(installDiagnosticsOverlay, 50);
      return;
    }
    state.overlayHost = host;
    state.overlayShadow = shadow;
    state.overlayCompact = !!state.overlayCompact;
    state.overlayExpanded = !!state.overlayExpanded;
    mountTarget.appendChild(host);

    renderDiagnosticsOverlay();
  }

  function renderDiagnosticsOverlay() {
    if (!state.overlayShadow || !state.pageSupported) {
      return;
    }

    const panel = state.overlayShadow.querySelector(".panel");
    const outerLauncher = state.overlayShadow.querySelector(".launcher--outer");
    const summaryNode = state.overlayShadow.querySelector(".summary");
    const detailsNode = state.overlayShadow.querySelector(".details");
    const scrollButton = state.overlayShadow.querySelector(".scroll");
    const toggleButton = state.overlayShadow.querySelector(".toggle");

    if (!(panel instanceof HTMLElement) || !(outerLauncher instanceof HTMLButtonElement) || !(summaryNode instanceof HTMLElement) || !(detailsNode instanceof HTMLElement) || !(scrollButton instanceof HTMLButtonElement) || !(toggleButton instanceof HTMLButtonElement)) {
      return;
    }

    const phase = state.lastFailure
      ? "error"
      : !state.enabled
        ? "disabled"
        : state.bootstrapped
          ? "ready"
          : "booting";
    panel.dataset.phase = phase;
    panel.dataset.compact = state.overlayCompact ? "true" : "false";
    panel.dataset.expanded = state.overlayExpanded ? "true" : "false";
    outerLauncher.title = state.overlayCompact ? "Open panel" : "Collapse panel";
    outerLauncher.setAttribute("aria-label", outerLauncher.title);
    scrollButton.title = "Jump to the latest message";
    scrollButton.setAttribute("aria-label", "Jump to the latest message");
    summaryNode.textContent = buildDiagnosticsSummary();
    detailsNode.textContent = buildDiagnosticsDetails();
    toggleButton.textContent = state.overlayExpanded ? "Hide" : "Details";
    toggleButton.title = state.overlayExpanded ? "Hide details" : "Show details";
    toggleButton.setAttribute("aria-label", toggleButton.title);
  }

  function installRouteWatchers() {
    const pushState = history.pushState;
    const replaceState = history.replaceState;

    history.pushState = function pushStatePatched(...args) {
      const result = pushState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    history.replaceState = function replaceStatePatched(...args) {
      const result = replaceState.apply(this, args);
      notifyRouteChange();
      return result;
    };

    window.addEventListener("popstate", notifyRouteChange, true);
    window.addEventListener("pageshow", notifyRouteChange, true);
    window.addEventListener(
      "load",
      () => {
        if (!state.enabled || !state.pageSupported) {
          return;
        }
        if (!state.bootstrapped) {
          primeBootstrap("window-load");
          return;
        }
        scheduleScrollToLatest("window-load", true);
      },
      true
    );

    state.routeTimer = window.setInterval(() => {
      if (state.href !== location.href) {
        notifyRouteChange();
      }
    }, 1000);
  }

  function installHealthWatchdog() {
    if (state.healthTimer) {
      return;
    }

    state.healthTimer = window.setInterval(() => {
      if (!state.enabled || !state.pageSupported || !state.bootstrapped) {
        return;
      }
      if (hasMountedSession()) {
        return;
      }
      recoverDetachedSession("detached-session");
    }, CONFIG.healthCheckMs);
  }

  function hasMountedSession() {
    const rootOk = state.root instanceof HTMLElement
      && state.root !== document.body
      && state.root !== document.documentElement
      && state.root.isConnected
      && document.contains(state.root);
    const composerOk = state.composer instanceof HTMLElement && state.composer.isConnected && document.contains(state.composer);
    const anyMountedRecord = state.records.some((record) => {
      const node = getRecordOrderNode(record);
      return node instanceof HTMLElement && node.isConnected && document.contains(node);
    });

    if (!state.records.length) {
      return rootOk || composerOk;
    }

    return rootOk && (composerOk || anyMountedRecord);
  }

  function recoverDetachedSession(reason) {
    const now = Date.now();
    if (now - state.lastRecoveryAt < CONFIG.recoveryCooldownMs) {
      return;
    }
    state.lastRecoveryAt = now;
    console.warn("[ChatGPT DOM Virtualizer] recovering detached session", buildInspection());
    resetSession(true);
    setRuntimePhase("waiting-composer", reason || "detached-session");
    installStartupObserver(reason || "detached-session");
    scheduleRetry();
  }

  function notifyRouteChange() {
    if (state.href === location.href && state.bootstrapped) {
      return;
    }
    state.href = location.href;
    if (!syncPageSupport("route-change") || !state.enabled) {
      return;
    }
    scheduleBootstrap("route-change");
  }

  function scheduleBootstrap(reason) {
    if (!state.enabled || !state.pageSupported) {
      return;
    }
    if (state.retryTimer) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      bootstrap(reason).catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] bootstrap failed", error);
        scheduleBootstrap("retry");
      });
    }, 0);
  }

  function primeBootstrap(reason) {
    if (!state.pageSupported) {
      setRuntimePhase("disabled", "unsupported-page");
      return;
    }

    if (!state.enabled) {
      setRuntimePhase("disabled", "bootstrap skipped");
      return;
    }

    if (!state.bootstrapStartedAt) {
      state.bootstrapStartedAt = Date.now();
    }

    installStartupObserver(reason);

    if (document.readyState === "loading") {
      setRuntimePhase("waiting-body", reason);
      return;
    }

    setRuntimePhase("booting", reason);
    scheduleBootstrap(reason);
  }

  function installStartupObserver(reason) {
    if (!state.startupObserver) {
      const target = document.documentElement || document;
      state.startupObserver = new MutationObserver(() => {
        markPageMutation();
        queueStartupCheck(reason);
      });
      state.startupObserver.observe(target, {
        childList: true,
        subtree: true,
      });
    }

    if (!state.startupObserverBodyObserved && document.body instanceof HTMLElement) {
      state.startupObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
      state.startupObserverBodyObserved = true;
    }

    queueStartupCheck(reason);
  }

  function queueStartupCheck(reason) {
    if (state.startupCheckQueued) {
      return;
    }

    state.startupCheckQueued = true;
    window.requestAnimationFrame(() => {
      state.startupCheckQueued = false;
      tryStartBootstrap(reason);
    });
  }

  function markPageMutation() {
    state.lastPageMutationAt = Date.now();
  }

  function shouldWaitForInitialHydration(reason) {
    if (state.bootstrapped || !isInitialBootstrapReason(reason)) {
      return false;
    }

    const now = Date.now();
    const elapsed = now - state.scriptStartedAt;
    const quietFor = now - state.lastPageMutationAt;
    if (elapsed >= CONFIG.hydrationMaxWaitMs) {
      return false;
    }

    return document.readyState !== "complete" ||
      elapsed < CONFIG.coldStartHoldMs ||
      quietFor < CONFIG.hydrationQuietMs;
  }

  function isInitialBootstrapReason(reason) {
    return !reason ||
      reason === "init" ||
      reason === "window-load" ||
      reason === "route-change" ||
      reason === "startup-ready" ||
      reason === "startup-fallback" ||
      reason === "retry" ||
      reason === "mutation" ||
      reason === "waiting-history" ||
      reason === "detached-session";
  }

  function waitForInitialHydration(reason) {
    setRuntimePhase("waiting-hydration", reason || "waiting-hydration");
    installStartupObserver(reason || "waiting-hydration");
    scheduleRetry();
  }

  function tryStartBootstrap(reason) {
    if (!state.enabled || state.bootstrapped || !state.pageSupported) {
      return;
    }

    if (shouldWaitForInitialHydration(reason)) {
      waitForInitialHydration(reason);
      return;
    }

    const composer = findComposer();
    if (!composer) {
      setRuntimePhase("waiting-composer", reason);
      installStartupObserver(reason);
      if (document.readyState !== "loading") {
        scheduleBootstrap(reason || "startup-fallback");
      }
      return;
    }

    const root = findConversationRoot(composer);
    if (!root) {
      setRuntimePhase("waiting-root", reason);
      installStartupObserver(reason);
      if (document.readyState !== "loading") {
        scheduleBootstrap(reason || "startup-fallback");
      }
      return;
    }

    disconnectStartupObserver();
    scheduleBootstrap(reason || "startup-ready");
  }

  function disconnectStartupObserver() {
    if (!state.startupObserver) {
      return;
    }
    state.startupObserver.disconnect();
    state.startupObserver = null;
    state.startupObserverBodyObserved = false;
  }

  async function bootstrap(reason) {
    if (!state.enabled || !state.pageSupported) {
      return;
    }

    state.bootstrapAttempts += 1;
    if (!state.bootstrapStartedAt) {
      state.bootstrapStartedAt = Date.now();
    }
    setRuntimePhase("booting", reason);

    if (shouldWaitForInitialHydration(reason)) {
      waitForInitialHydration(reason);
      return;
    }

    const composer = findComposer();
    if (!composer) {
      if (Date.now() - state.bootstrapStartedAt >= CONFIG.bootstrapWaitMs) {
        reportBootstrapFailure("composer-not-found", "No composer matched the current selectors");
      } else {
        setRuntimePhase("waiting-composer", reason);
      }
      installStartupObserver(reason);
      scheduleRetry();
      return;
    }

    const root = findConversationRoot(composer);
    if (!root) {
      if (Date.now() - state.bootstrapStartedAt >= CONFIG.bootstrapWaitMs) {
        reportBootstrapFailure("conversation-root-not-found", "Composer matched but no visible conversation root");
      } else {
        setRuntimePhase("waiting-root", reason);
      }
      installStartupObserver(reason);
      scheduleRetry();
      return;
    }

    const conversationKey = buildConversationKey();
    if (state.conversationKey && state.conversationKey !== conversationKey) {
      resetSession(false);
      state.bootstrapAttempts = 1;
    }

    state.composer = composer;
    state.composerForm = composer.closest("form");
    state.root = root;
    state.scrollTarget = findScrollTarget(root, composer);
    state.conversationKey = conversationKey;
    state.lastUserActivityAt = Date.now();
    state.lastScrollTop = getScrollTop();
    disconnectStartupObserver();

    if (state.records.length === 0) {
      const seed = seedTurnNodesFromTail(root, composer, CONFIG.initialTail);
      const nodes = seed.nodes.length ? seed.nodes : [];
      state.turnSelector = TURN_SELECTOR;
      if (seed.nodes.length >= 2) {
        state.scanCursor = seed.cursor;
        state.scanExhausted = !seed.cursor;
      } else {
        state.scanCursor = seed.cursor || findTailStart(root, composer);
        state.scanExhausted = !state.scanCursor;
      }
      if (nodes.length) {
        rebuildRecords(nodes);
        const initialStart = Math.max(0, state.records.length - CONFIG.initialTail);
        const initialEnd = state.records.length - 1;
        await transitionWindow(initialStart, initialEnd, reason || "bootstrap");
      } else {
        state.records = [];
        state.recordByNode = new WeakMap();
        state.windowStart = 0;
        state.windowEnd = -1;
        state.topHeight = 0;
        state.loadedHeight = 0;
        state.bottomHeight = 0;
        clearBootstrapFailure();
        setRuntimePhase("waiting-history", reason);
        attachObservers();
        installStartupObserver(reason);
        // Keep the viewport steady while ChatGPT is still hydrating a new thread.
        // Forcing a jump-to-bottom here can leave the page looking blank before the
        // first real turns are available to virtualize.
        scheduleRetry();
        console.info(
          "[ChatGPT DOM Virtualizer] waiting for ChatGPT history",
          buildInspection(),
          "selector:",
          state.turnSelector || TURN_SELECTOR
        );
        return;
      }
    } else {
      await applyPolicy(reason || "bootstrap");
    }

    // Give the page one more paint before the first auto-scroll, especially on cold refreshes.
    await sleep(16);
    state.bootstrapped = true;
    clearBootstrapFailure();
    attachObservers();
    warmDiskBuffer(reason || "bootstrap");
    scheduleBackgroundCrawl(reason || "bootstrap");
    scheduleScrollToLatest(reason || "bootstrap", true);

    if (!state.records.length) {
      setRuntimePhase("ready", "observer-only");
    } else {
      setRuntimePhase("ready", reason || "bootstrap");
    }

    console.info(
      "[ChatGPT DOM Virtualizer] ready",
      buildInspection(),
      "selector:",
      state.turnSelector || TURN_SELECTOR
    );
  }

  function scheduleRetry() {
    if (state.retryTimer) {
      return;
    }
    if (!state.lastFailure && !state.runtimePhase.startsWith("waiting-")) {
      setRuntimePhase("retrying", "bootstrap-retry");
    }
    state.retryTimer = window.setTimeout(() => {
      state.retryTimer = null;
      bootstrap("retry").catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] retry failed", error);
      });
    }, CONFIG.bootstrapRetryMs);
  }

  function scheduleScrollToLatest(reason, force = false) {
    if (!state.enabled || !state.pageSupported) {
      return;
    }
    if (isImageGenerationActive()) {
      return;
    }

    if (state.scrollToLatestTimer) {
      return;
    }

    const scrollReason = reason || "latest";
    state.scrollToLatestTimer = window.requestAnimationFrame(() => {
      state.scrollToLatestTimer = null;
      void runScrollToLatest(scrollReason, force).catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] scroll to latest failed", error);
      });
    });
  }

  async function runScrollToLatest(reason, force = false) {
    if (isImageGenerationActive()) {
      return;
    }
    if (force) {
      await ensureLatestWindow(reason || "latest");
    }
    clickNativeJumpToBottom(reason || "latest");
    scrollToLatestMessage(reason || "latest");
    if (force) {
      if (!state.scrollToLatestStartedAt) {
        state.scrollToLatestStartedAt = Date.now();
      }
      scheduleScrollToLatestRetry(reason || "latest", 0);
    }
  }

  function scheduleScrollToLatestRetry(reason, attempt) {
    if (!state.enabled || !state.pageSupported) {
      return;
    }

    if (state.scrollToLatestRetryTimer) {
      return;
    }

    const startedAt = state.scrollToLatestStartedAt || state.bootstrapStartedAt || Date.now();
    if (Date.now() - startedAt >= CONFIG.bootstrapWaitMs) {
      state.scrollToLatestStartedAt = 0;
      return;
    }

    if (state.records.length > 0 && isLatestRecordVisible()) {
      state.scrollToLatestStartedAt = 0;
      return;
    }

    const delays = CONFIG.scrollRetryDelaysMs || [];
    const delay = delays[Math.min(attempt, Math.max(0, delays.length - 1))] || delays[0] || 250;

    state.scrollToLatestRetryTimer = window.setTimeout(() => {
      state.scrollToLatestRetryTimer = null;
      if (!state.enabled || !state.pageSupported) {
        return;
      }
      if (state.records.length > 0 && isLatestRecordVisible()) {
        state.scrollToLatestStartedAt = 0;
        return;
      }

      void (async () => {
        await ensureLatestWindow(reason || "latest");
        scrollToLatestMessage(reason || "latest");
        if (state.records.length === 0 || !isLatestRecordVisible()) {
          scheduleScrollToLatestRetry(reason || "latest", attempt + 1);
        } else {
          state.scrollToLatestStartedAt = 0;
        }
      })().catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] scroll retry failed", error);
        scheduleScrollToLatestRetry(reason || "latest", attempt + 1);
      });
    }, delay);
  }

  async function ensureLatestWindow(reason) {
    if (!state.records.length) {
      return;
    }

    const total = state.records.length;
    const keep = Math.min(CONFIG.initialTail, total);
    const nextEnd = total - 1;
    const nextStart = Math.max(0, nextEnd - keep + 1);
    if (state.windowStart === nextStart && state.windowEnd === nextEnd) {
      return;
    }

    await transitionWindow(nextStart, nextEnd, reason || "latest-window");
  }

  function clickNativeJumpToBottom(reason) {
    const now = Date.now();
    if (now - state.lastNativeJumpAt < CONFIG.nativeJumpCooldownMs) {
      return false;
    }

    const button = findNativeJumpToBottomButton();
    if (!button) {
      return false;
    }

    state.lastNativeJumpAt = now;
    state.internalScrollDepth += 1;
    try {
      button.click();
      setRuntimePhase(state.bootstrapped ? state.runtimePhase : "waiting-history", reason || "native-jump");
      return true;
    } catch (error) {
      console.warn("[ChatGPT DOM Virtualizer] native jump-to-bottom failed", error);
      return false;
    } finally {
      window.setTimeout(() => {
        state.internalScrollDepth = Math.max(0, state.internalScrollDepth - 1);
      }, 80);
    }
  }

  function findNativeJumpToBottomButton() {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const semanticPattern = /bottom|down|latest|newest|scroll|jump|fim|baixo|deslocar|rolar|ultima|última|recente|mensagens/i;

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement) || !isViableNativeJumpButton(candidate)) {
        continue;
      }
      const label = normalizedText([
        candidate.getAttribute("aria-label"),
        candidate.getAttribute("title"),
        candidate.getAttribute("data-testid"),
        candidate.textContent,
      ].filter(Boolean).join(" "));
      if (semanticPattern.test(label)) {
        return candidate;
      }
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const structural = candidates
      .filter((candidate) => candidate instanceof HTMLElement && isViableNativeJumpButton(candidate))
      .map((candidate) => ({
        candidate,
        rect: candidate.getBoundingClientRect(),
      }))
      .filter(({ candidate, rect }) => {
        if (!candidate.querySelector("svg")) {
          return false;
        }
        if (rect.width < 24 || rect.height < 24 || rect.width > 72 || rect.height > 72) {
          return false;
        }
        if (rect.top < viewportHeight * 0.35 || rect.bottom > viewportHeight - 24) {
          return false;
        }
        if (rect.left < 220 || rect.right > viewportWidth - 72) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        const composerTop = state.composerForm instanceof HTMLElement
          ? state.composerForm.getBoundingClientRect().top
          : viewportHeight;
        const aDistance = Math.abs(a.rect.bottom - composerTop);
        const bDistance = Math.abs(b.rect.bottom - composerTop);
        return aDistance - bDistance;
      });

    return structural.length ? structural[0].candidate : null;
  }

  function isViableNativeJumpButton(node) {
    if (!(node instanceof HTMLElement) || !isVisible(node)) {
      return false;
    }
    if (node.closest("nav, aside, header, footer, form, [data-sidebar-item=\"true\"], [data-cdv-overlay-root=\"true\"]")) {
      return false;
    }
    if (node.matches("[disabled], [aria-disabled=\"true\"]")) {
      return false;
    }
    if (isInsideComposer(node)) {
      return false;
    }
    return true;
  }

  function scrollToLatestMessage(reason) {
    if (!state.enabled || !state.pageSupported) {
      return false;
    }
    if (isImageGenerationActive()) {
      return false;
    }

    if (state.root || state.composer) {
      const refreshedTarget = findScrollTarget(state.root, state.composer);
      if (refreshedTarget && refreshedTarget !== state.scrollTarget) {
        state.scrollTarget = refreshedTarget;
      }
    }

    const target = state.scrollTarget || document.scrollingElement || document.documentElement;
    if (!target) {
      return false;
    }

    const lastRecord = state.records.length ? state.records[state.records.length - 1] : null;
    const lastNode = getRecordOrderNode(lastRecord);
    const currentTop = getScrollTop();
    const anchor = lastNode instanceof HTMLElement ? lastNode : target;

    state.internalScrollDepth += 1;
    try {
      if (lastNode instanceof HTMLElement && typeof lastNode.scrollIntoView === "function") {
        lastNode.scrollIntoView({ block: "end", inline: "nearest", behavior: "auto" });
      }
      if (anchor instanceof HTMLElement) {
        forceScrollAncestorsToBottom(anchor);
      }
      forceScrollTargetToBottom(target);
      forceViewportToBottom();
      state.lastScrollTop = getScrollTop();
      if (state.lastScrollTop >= currentTop) {
        state.scrollDirection = "down";
      }
      return state.lastScrollTop !== currentTop || isLatestRecordVisible() || isNearBottom();
    } finally {
      state.internalScrollDepth = Math.max(0, state.internalScrollDepth - 1);
    }
  }

  function shouldAutoScrollToLatest(reason, atBottom, composerFocused) {
    if (isImageGenerationActive()) {
      return false;
    }
    if (reason === "bootstrap" || reason === "route-change" || reason === "manual-refresh" || reason === "manual-enable") {
      return true;
    }
    if (reason === "mutation" && state.scrollDirection !== "up" && (atBottom || composerFocused)) {
      return true;
    }
    if (reason === "input" && composerFocused) {
      return true;
    }
    return false;
  }

  function shouldForceLatestWindow(reason, atBottom, composerFocused) {
    if (isImageGenerationActive()) {
      return false;
    }
    if (reason === "bootstrap" || reason === "route-change" || reason === "manual-refresh" || reason === "manual-enable") {
      return true;
    }
    if (reason === "mutation" && state.scrollDirection !== "up" && (atBottom || composerFocused)) {
      return true;
    }
    if (reason === "input" && composerFocused) {
      return true;
    }
    return false;
  }

  function warmDiskBuffer(reason) {
    void ensureDatabase()
      .then(() => {
        if (!state.enabled || !state.bootstrapped) {
          return;
        }
        schedulePersistFlush(reason || "warm-disk");
        scheduleBackgroundCrawl(reason || "warm-disk");
      })
      .catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] disk warm-up failed", error);
      });
  }

  function ensureDatabase() {
    if (state.dbPromise) {
      return state.dbPromise;
    }

    state.dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        state.dbReady = false;
        setRuntimePhase(state.runtimePhase === "ready" ? "ready" : state.runtimePhase, "indexedDB unavailable");
        resolve(null);
        return;
      }

      let request;
      try {
        request = window.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (error) {
        console.warn("[ChatGPT DOM Virtualizer] indexedDB open failed", error);
        state.dbReady = false;
        setRuntimePhase(state.runtimePhase === "ready" ? "ready" : state.runtimePhase, "indexedDB open failed");
        resolve(null);
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (db.objectStoreNames.contains(DB_STORE)) {
          db.deleteObjectStore(DB_STORE);
        }
        const store = db.createObjectStore(DB_STORE, { keyPath: "id" });
        store.createIndex("conversationKey", "conversationKey", { unique: false });
        store.createIndex("conversationKeySequence", ["conversationKey", "sequence"], { unique: true });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
        };
        state.dbReady = true;
        resolve(db);
      };

      request.onerror = () => {
        console.warn("[ChatGPT DOM Virtualizer] indexedDB error", request.error);
        state.dbReady = false;
        state.dbPromise = null;
        setRuntimePhase(state.runtimePhase === "ready" ? "ready" : state.runtimePhase, "indexedDB error");
        resolve(null);
      };

      request.onblocked = () => {
        console.warn("[ChatGPT DOM Virtualizer] indexedDB blocked");
        state.dbReady = false;
        state.dbPromise = null;
        setRuntimePhase(state.runtimePhase === "ready" ? "ready" : state.runtimePhase, "indexedDB blocked");
        resolve(null);
      };
    });

    return state.dbPromise;
  }

  function schedulePersistFlush(reason) {
    if (!state.enabled || !state.persistQueue.size) {
      return;
    }
    if (state.persistTimer) {
      return;
    }

    state.persistTimer = window.setTimeout(() => {
      state.persistTimer = null;
      void flushPersistQueue(reason || "persist").catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] persist failed", error);
      });
    }, CONFIG.persistDebounceMs);
  }

  function schedulePersistRecord(record, reason) {
    if (!state.enabled || !record) {
      return;
    }
    state.persistQueue.add(record);
    schedulePersistFlush(reason || "persist-record");
  }

  async function flushPersistQueue(reason) {
    if (!state.persistQueue.size) {
      return;
    }

    const records = Array.from(state.persistQueue);
    state.persistQueue.clear();

    const db = await ensureDatabase();
    if (!db || !state.conversationKey) {
      return;
    }

    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const writes = [];

    for (const record of records) {
      const snapshot = serializeRecordSnapshot(record, reason || "persist");
      if (!snapshot) {
        continue;
      }
      writes.push(
        requestToPromise(store.put(snapshot)).catch((error) => {
          console.warn("[ChatGPT DOM Virtualizer] snapshot write failed", error);
        })
      );
    }

    await Promise.all(writes);
    await transactionComplete(tx);
    trimSnapshotCache();
  }

  function serializeRecordSnapshot(record, reason) {
    if (!record) {
      return null;
    }

    const html = record.snapshotHtml || (record.node instanceof HTMLElement ? record.node.outerHTML : "");
    if (!html) {
      return null;
    }

    if (!record.storageId) {
      record.storageId = buildStorageId(state.conversationKey, record.sequence);
    }

    record.snapshotHtml = html;
    record.persistedAt = Date.now();

    return {
      id: record.storageId,
      conversationKey: state.conversationKey,
      sequence: record.sequence,
      signature: record.signature,
      html,
      innerHeight: record.innerHeight,
      outerHeight: record.outerHeight,
      marginTop: record.marginTop,
      marginBottom: record.marginBottom,
      reason: reason || "",
      updatedAt: Date.now(),
    };
  }

  async function ensureRecordNode(record) {
    if (!record) {
      return null;
    }
    if (record.node instanceof HTMLElement && record.node.isConnected) {
      return record.node;
    }

    if (!record.snapshotHtml) {
      try {
        const snapshot = await loadSnapshotFromDb(record);
        if (snapshot && snapshot.html) {
          record.snapshotHtml = snapshot.html;
          if (snapshot.innerHeight && !record.innerHeight) {
            record.innerHeight = snapshot.innerHeight;
          }
          if (snapshot.outerHeight && !record.outerHeight) {
            record.outerHeight = snapshot.outerHeight;
          }
          if (snapshot.marginTop !== undefined && snapshot.marginTop !== null) {
            record.marginTop = snapshot.marginTop;
          }
          if (snapshot.marginBottom !== undefined && snapshot.marginBottom !== null) {
            record.marginBottom = snapshot.marginBottom;
          }
        }
      } catch (error) {
        console.warn("[ChatGPT DOM Virtualizer] snapshot hydrate failed", error);
      }
    }

    if (!record.snapshotHtml) {
      return null;
    }

    const node = createNodeFromSnapshot(record.snapshotHtml);
    if (!(node instanceof HTMLElement)) {
      return null;
    }

    record.node = node;
    state.recordByNode.set(node, record);
    return node;
  }

  function createNodeFromSnapshot(html) {
    if (!html) {
      return null;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    const node = template.content.firstElementChild;
    return node instanceof HTMLElement ? node : null;
  }

  async function loadSnapshotFromDb(record) {
    const db = await ensureDatabase();
    if (!db || !state.conversationKey) {
      return null;
    }

    const storageId = record.storageId || buildStorageId(state.conversationKey, record.sequence);
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    let snapshot = null;
    try {
      snapshot = await requestToPromise(store.get(storageId));
    } finally {
      await transactionComplete(tx).catch(() => {});
    }

    if (!snapshot) {
      return null;
    }

    record.storageId = storageId;
    record.signature = snapshot.signature || record.signature;
    record.sequence = snapshot.sequence ?? record.sequence;
    record.innerHeight = snapshot.innerHeight ?? record.innerHeight;
    record.outerHeight = snapshot.outerHeight ?? record.outerHeight;
    record.marginTop = snapshot.marginTop ?? record.marginTop;
    record.marginBottom = snapshot.marginBottom ?? record.marginBottom;
    record.snapshotHtml = snapshot.html || record.snapshotHtml;
    return snapshot;
  }

  function trimSnapshotCache() {
    if (!state.records.length) {
      return;
    }

    const lower = Math.max(0, state.windowStart - CONFIG.snapshotCacheRadius);
    const upper = Math.min(state.records.length - 1, state.windowEnd + CONFIG.snapshotCacheRadius);

    for (let index = 0; index < state.records.length; index += 1) {
      const record = state.records[index];
      if (!record || record.loaded || !record.snapshotHtml || state.persistQueue.has(record)) {
        continue;
      }
      if (index < lower || index > upper) {
        record.snapshotHtml = null;
      }
    }
  }

  function scheduleBackgroundCrawl(reason) {
    if (!CONFIG.backgroundCrawlEnabled) {
      state.crawlRunning = false;
      state.crawlExhausted = true;
      return;
    }
    if (!state.enabled || state.crawlRunning || state.crawlTimer || state.crawlExhausted) {
      return;
    }
    if (state.composer && isComposerFocused()) {
      return;
    }

    const idleFor = Date.now() - (state.lastUserActivityAt || 0);
    const delay = Math.max(0, CONFIG.backgroundCrawlIdleMs - idleFor);
    state.crawlTimer = window.setTimeout(() => {
      state.crawlTimer = null;
      void runBackgroundCrawl(reason || "background-crawl").catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] background crawl failed", error);
      });
    }, delay);
  }

  async function runBackgroundCrawl(reason) {
    if (!state.enabled || state.crawlRunning || state.crawlExhausted) {
      return;
    }
    if (state.composer && isComposerFocused()) {
      return;
    }
    if (Date.now() - (state.lastUserActivityAt || 0) < CONFIG.backgroundCrawlIdleMs) {
      scheduleBackgroundCrawl(reason || "background-crawl-idle");
      return;
    }

    state.crawlRunning = true;
    try {
      if (state.scanCursor && !state.scanExhausted) {
        runBackgroundScan(reason || "background-scan");
      }

      if (!state.scanCursor || state.scanExhausted) {
        await crawlFurtherUp(reason || "background-crawl");
      }

      schedulePersistFlush(reason || "background-crawl");
      trimSnapshotCache();
    } finally {
      state.crawlRunning = false;
    }

    if (state.enabled && Date.now() - (state.lastUserActivityAt || 0) >= CONFIG.backgroundCrawlIdleMs) {
      scheduleBackgroundCrawl(reason || "background-crawl");
    }
  }

  async function crawlFurtherUp(reason) {
    const target = state.scrollTarget;
    if (!(target instanceof HTMLElement) && target !== document.scrollingElement && target !== document.documentElement) {
      state.crawlExhausted = true;
      return;
    }

    const currentTop = getScrollTop();
    if (currentTop <= 0) {
      state.crawlAttemptAtTop += 1;
    } else {
      state.crawlAttemptAtTop = 0;
    }

    if (state.crawlAttemptAtTop >= 3) {
      state.crawlExhausted = true;
      return;
    }

    state.internalScrollDepth += 1;
    try {
      const nextTop = Math.max(0, currentTop - CONFIG.backgroundCrawlStepPx);
      if (target instanceof HTMLElement) {
        target.scrollTop = nextTop;
      } else {
        window.scrollTo(0, nextTop);
      }
      await sleep(CONFIG.backgroundCrawlPauseMs);
      if (state.enabled) {
        runBackgroundScan(reason || "background-crawl");
      }
    } finally {
      state.internalScrollDepth = Math.max(0, state.internalScrollDepth - 1);
    }

    if (getScrollTop() <= 0 && !state.scanCursor && state.scanExhausted) {
      state.crawlAttemptAtTop += 1;
      if (state.crawlAttemptAtTop >= 3) {
        state.crawlExhausted = true;
      }
    } else if (getScrollTop() > 0) {
      state.crawlAttemptAtTop = 0;
    }
  }

  function buildConversationKey() {
    const path = location.pathname.replace(/\/+$/, "") || "/";
    const search = location.search || "";
    return `${location.hostname}${path}${search}`;
  }

  function buildStorageId(conversationKey, sequence) {
    return `${conversationKey}::${sequence}`;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function resetSession(restoreNodes) {
    detachObservers();
    if (state.retryTimer) {
      window.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.applyTimer) {
      window.cancelAnimationFrame(state.applyTimer);
      state.applyTimer = null;
    }
    if (state.persistTimer) {
      window.clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }
    if (state.crawlTimer) {
      window.clearTimeout(state.crawlTimer);
      state.crawlTimer = null;
    }
    if (state.scrollToLatestTimer) {
      window.cancelAnimationFrame(state.scrollToLatestTimer);
      state.scrollToLatestTimer = null;
    }
    if (state.scrollToLatestRetryTimer) {
      window.clearTimeout(state.scrollToLatestRetryTimer);
      state.scrollToLatestRetryTimer = null;
    }
    state.scrollToLatestStartedAt = 0;
    if (restoreNodes) {
      restoreAllRecords();
    }
    state.bootstrapped = false;
    state.root = null;
    state.composer = null;
    state.composerForm = null;
    state.scrollTarget = null;
    state.records = [];
    state.recordByNode = new WeakMap();
    state.windowStart = 0;
    state.windowEnd = -1;
    state.topHeight = 0;
    state.loadedHeight = 0;
    state.bottomHeight = 0;
    state.lastScrollTop = 0;
    state.scrollDirection = "down";
    state.lastPolicyReason = "";
    state.turnSelector = "";
    state.conversationKey = "";
    state.bootstrapStartedAt = 0;
    state.lastNativeJumpAt = 0;
    state.persistQueue = new Set();
    state.crawlRunning = false;
    state.crawlAttemptAtTop = 0;
    state.crawlExhausted = false;
    state.internalScrollDepth = 0;
    state.runtimePhase = state.enabled ? "booting" : "disabled";
    state.runtimeDetail = "";
    clearBootstrapFailure();
    state.lastUserActivityAt = 0;
    state.nextSequence = 0;
    state.bootstrapAttempts = 0;
    state.scanCursor = null;
    state.scanTimer = null;
    state.scanExhausted = false;
    state.startupObserverBodyObserved = false;
    state.startupCheckQueued = false;
    disconnectStartupObserver();
    renderDiagnosticsOverlay();
  }

  function detachObservers() {
    if (state.scrollTarget && state.scrollHandler) {
      state.scrollTarget.removeEventListener("scroll", state.scrollHandler);
    }
    if (state.composer && state.inputHandler) {
      state.composer.removeEventListener("input", state.inputHandler, true);
    }
    if (state.mutationObserver) {
      state.mutationObserver.disconnect();
      state.mutationObserver = null;
    }
    if (state.resizeObserver) {
      state.resizeObserver.disconnect();
      state.resizeObserver = null;
    }
    state.scrollHandler = null;
    state.inputHandler = null;
  }

  function attachObservers() {
    if (!state.scrollTarget || state.scrollHandler) {
      return;
    }

    state.scrollHandler = () => {
      const currentScrollTop = getScrollTop();
      if (state.internalScrollDepth > 0) {
        state.lastScrollTop = currentScrollTop;
        return;
      }
      state.lastUserActivityAt = Date.now();
      state.scrollDirection = currentScrollTop >= state.lastScrollTop ? "down" : "up";
      state.lastScrollTop = currentScrollTop;
      scheduleApply("scroll");
    };

    state.inputHandler = () => {
      state.lastUserActivityAt = Date.now();
      scheduleApply("input");
    };

    state.scrollTarget.addEventListener("scroll", state.scrollHandler, { passive: true });
    if (state.composer) {
      state.composer.addEventListener("input", state.inputHandler, true);
    }

    const mutationRoot = state.records.length ? state.root || document.body : document.body;
    state.mutationObserver = new MutationObserver(handleMutations);
    state.mutationObserver.observe(mutationRoot || document.body, {
      childList: true,
      subtree: true,
    });

    state.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const record = state.recordByNode.get(entry.target);
        if (!record || !record.loaded) {
          continue;
        }
        const metrics = measureOuterMetrics(record.node);
        if (metrics.outerHeight === record.outerHeight) {
          continue;
        }
        const delta = metrics.outerHeight - record.outerHeight;
        record.outerHeight = metrics.outerHeight;
        record.innerHeight = metrics.innerHeight;
        record.marginTop = metrics.marginTop;
        record.marginBottom = metrics.marginBottom;
        state.loadedHeight += delta;
        if (record.placeholder && record.placeholder.isConnected) {
          updatePlaceholder(record);
        }
      }
    });

    observeLoadedRecords();
  }

  function handleMutations(mutations) {
    if (state.mutationPause > 0) {
      return;
    }

    markPageMutation();
    let addedTurn = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        const candidates = extractTurnNodes(node);
        for (const candidate of candidates) {
          if (state.recordByNode.has(candidate)) {
            continue;
          }
          if (isInsideComposer(candidate)) {
            continue;
          }
          insertRecordInOrder(candidate);
          addedTurn = true;
        }
      }
    }

    if (addedTurn) {
      clearBootstrapFailure();
      if (!state.bootstrapped) {
        scheduleBootstrap("mutation");
      } else {
        scheduleApply("mutation");
      }
    }
  }

  function scheduleBackgroundScan(reason) {
    if (!state.enabled || state.scanExhausted || !state.scanCursor || state.scanTimer) {
      return;
    }

    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = null;
      if (!state.enabled || state.scanExhausted || !state.scanCursor) {
        return;
      }
      runBackgroundScan(reason || "history-scan");
    }, CONFIG.mutationCooldownMs);
  }

  function runBackgroundScan(reason) {
    if (!state.enabled || state.scanExhausted || !state.scanCursor) {
      return;
    }

    const batch = collectTurnNodesBackward(state.scanCursor, CONFIG.step);
    state.scanCursor = batch.cursor;
    state.scanExhausted = batch.exhausted;

    let inserted = false;
    for (const node of batch.nodes) {
      if (state.recordByNode.has(node)) {
        continue;
      }
      insertRecordInOrder(node);
      inserted = true;
    }

    if (inserted) {
      scheduleApply(reason || "history-scan");
    }
  }

  function seedTurnNodesFromTail(root, composer, limit) {
    const scope = root instanceof HTMLElement ? root : document.body;
    const start = findTailStart(scope, composer);
    if (!start) {
      return seedTurnNodesFromScope(scope, composer, limit);
    }

    const batch = collectTurnNodesBackward(start, limit, composer, scope);
    if (batch.nodes.length >= 1) {
      state.turnSelector = TURN_SELECTOR;
      return batch;
    }

    return seedTurnNodesFromScope(scope, composer, limit);
  }

  function seedTurnNodesFromScope(scope, composer, limit) {
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (node) => {
      if (node instanceof HTMLElement && !seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    };

    if (scope instanceof HTMLElement && looksLikeTurn(scope, composer)) {
      pushCandidate(scope);
    }

    if (scope instanceof HTMLElement) {
      for (const candidate of scope.querySelectorAll(TURN_SELECTOR)) {
        if (!(candidate instanceof HTMLElement)) {
          continue;
        }
        if (!looksLikeTurn(candidate, composer)) {
          continue;
        }
        pushCandidate(candidate);
      }
    }

    if (!candidates.length) {
      return { nodes: [], cursor: null, exhausted: true };
    }

    const orderedCandidates = uniqueElementsInDocumentOrder(candidates);
    const ordered = orderedCandidates.filter((node) => {
      return !orderedCandidates.some((other) => other !== node && other.contains(node));
    });
    const visible = ordered.filter((node) => !isInsideComposer(node, composer));
    const seeded = visible.slice(Math.max(0, visible.length - limit));
    if (!seeded.length) {
      return { nodes: [], cursor: null, exhausted: true };
    }

    state.turnSelector = TURN_SELECTOR;
    const cursor = previousElementInTree(seeded[0], scope);
    return {
      nodes: seeded,
      cursor,
      exhausted: !cursor,
    };
  }

  function collectTurnNodesBackward(startNode, limit, composer = state.composer, scope = state.root instanceof HTMLElement ? state.root : document.body) {
    const nodes = [];
    const seen = new Set();
    let cursor = startNode;
    let hops = 0;
    const composerAnchor = state.composerForm instanceof HTMLElement ? state.composerForm : composer;

    while (cursor && hops < 5000 && nodes.length < limit) {
      if (composerAnchor instanceof HTMLElement && cursor instanceof HTMLElement && composerAnchor.contains(cursor)) {
        cursor = previousElementInTree(composerAnchor, scope);
        hops += 1;
        continue;
      }

      if (cursor instanceof HTMLElement && !seen.has(cursor) && looksLikeTurn(cursor, composer)) {
        seen.add(cursor);
        nodes.push(cursor);
      }

      cursor = previousElementInTree(cursor, scope);
      hops += 1;
    }

    return {
      nodes: uniqueElementsInDocumentOrder(nodes),
      cursor,
      exhausted: !cursor,
    };
  }

  function findTailStart(scope, composer) {
    const anchor = state.composerForm instanceof HTMLElement ? state.composerForm : composer;
    if (anchor instanceof HTMLElement) {
      const cursor = previousElementInTree(anchor, scope);
      if (cursor) {
        return cursor;
      }
    }

    let node = scope;
    while (node && node.lastElementChild) {
      node = node.lastElementChild;
    }
    return node instanceof HTMLElement ? node : null;
  }

  function previousElementInTree(node, scope) {
    if (!(node instanceof HTMLElement) || !scope) {
      return null;
    }
    if (node === scope) {
      return null;
    }

    if (node.previousElementSibling) {
      let cursor = node.previousElementSibling;
      while (cursor.lastElementChild) {
        cursor = cursor.lastElementChild;
      }
      return cursor;
    }

    const parent = node.parentElement;
    if (!parent || parent === scope) {
      return null;
    }

    return parent;
  }

  function insertRecordInOrder(node) {
    const record = makeRecord(node);
    const index = findRecordInsertionIndex(node);
    return insertRecordAtIndex(record, index);
  }

  function insertRecordAtIndex(record, index) {
    if (!record.storageId) {
      record.storageId = buildStorageId(state.conversationKey, record.sequence);
    }
    state.records.splice(index, 0, record);
    state.recordByNode.set(record.node, record);
    if (state.resizeObserver && record.loaded && record.node && record.node.isConnected) {
      state.resizeObserver.observe(record.node);
    }
    schedulePersistRecord(record, "insert");
    state.crawlExhausted = false;
    state.crawlAttemptAtTop = 0;

    if (state.windowEnd < 0) {
      return record;
    }

    const beforeWindow = index <= state.windowStart;
    const insideWindow = index > state.windowStart && index <= state.windowEnd;

    if (beforeWindow) {
      const scope = state.root instanceof HTMLElement ? state.root : document.body;
      const orderNode = getRecordOrderNode(record);
      const resumeNode = orderNode ? previousElementInTree(orderNode, scope) : null;
      state.windowStart += 1;
      state.windowEnd += 1;
      ensureRecordMetrics(record);
      state.topHeight += record.outerHeight || 0;
      unloadRecord(record);
      if (state.scanExhausted && !state.scanCursor && resumeNode) {
        state.scanCursor = resumeNode;
        state.scanExhausted = false;
        scheduleBackgroundScan("scan-resume");
      }
    } else if (insideWindow) {
      state.windowEnd += 1;
      ensureRecordMetrics(record);
      state.loadedHeight += record.outerHeight || 0;
    } else {
      ensureRecordMetrics(record);
      state.loadedHeight += record.outerHeight || 0;
    }

    trimSnapshotCache();
    return record;
  }

  function findRecordInsertionIndex(node) {
    if (!state.records.length) {
      return 0;
    }

    let low = 0;
    let high = state.records.length;

    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const midNode = getRecordOrderNode(state.records[mid]);
      const comparison = compareDocumentOrder(midNode, node);

      if (comparison < 0) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    return low;
  }

  function getRecordOrderNode(record) {
    if (!record) {
      return null;
    }
    if (record.loaded && record.node && record.node.isConnected) {
      return record.node;
    }
    if (record.placeholder && record.placeholder.isConnected) {
      return record.placeholder;
    }
    return record.node || record.placeholder || null;
  }

  function compareDocumentOrder(a, b) {
    if (a === b) {
      return 0;
    }
    if (!(a instanceof Node) || !(b instanceof Node)) {
      return 0;
    }

    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      return -1;
    }
    if (position & Node.DOCUMENT_POSITION_PRECEDING) {
      return 1;
    }
    return 0;
  }

  function extractTurnNodes(node) {
    const candidates = [];
    if (looksLikeTurn(node)) {
      candidates.push(node);
    }
    for (const match of node.querySelectorAll(TURN_SELECTOR)) {
      if (looksLikeTurn(match)) {
        candidates.push(match);
      }
    }
    return uniqueElementsInDocumentOrder(candidates);
  }

  function rebuildRecords(nodes) {
    restoreAllRecords();
    state.records = [];
    state.recordByNode = new WeakMap();
    state.nextSequence = 0;

    for (const node of nodes) {
      const record = makeRecord(node);
      state.records.push(record);
      state.recordByNode.set(node, record);
      schedulePersistRecord(record, "rebuild");
    }

    recomputeHeights();
    state.windowStart = 0;
    state.windowEnd = state.records.length - 1;
  }

  function observeLoadedRecords() {
    if (!state.resizeObserver) {
      return;
    }
    for (const record of state.records) {
      if (record && record.loaded && record.node && record.node.isConnected) {
        state.resizeObserver.observe(record.node);
      }
    }
  }

  function makeRecord(node) {
    const sequence = state.nextSequence++;
    return {
      node,
      placeholder: null,
      loaded: true,
      sequence,
      storageId: state.conversationKey ? buildStorageId(state.conversationKey, sequence) : "",
      snapshotHtml: null,
      snapshotPromise: null,
      outerHeight: null,
      innerHeight: null,
      marginTop: null,
      marginBottom: null,
      signature: nodeSignature(node),
    };
  }

  function ensureRecordMetrics(record) {
    if (!record || !record.node) {
      return null;
    }
    if (record.outerHeight !== null && record.innerHeight !== null) {
      return record;
    }

    const metrics = measureOuterMetrics(record.node);
    record.outerHeight = metrics.outerHeight;
    record.innerHeight = metrics.innerHeight;
    record.marginTop = metrics.marginTop;
    record.marginBottom = metrics.marginBottom;
    return record;
  }

  function recomputeHeights() {
    state.topHeight = 0;
    state.loadedHeight = 0;
    state.bottomHeight = 0;
    for (let index = 0; index < state.records.length; index += 1) {
      const record = state.records[index];
      if (record.loaded) {
        ensureRecordMetrics(record);
        state.loadedHeight += record.outerHeight || 0;
      } else if (index < state.windowStart) {
        state.topHeight += record.outerHeight || 0;
      } else if (index > state.windowEnd) {
        state.bottomHeight += record.outerHeight || 0;
      }
    }
  }

  function scheduleApply(reason) {
    state.lastPolicyReason = reason;
    if (state.applyTimer) {
      return;
    }
    state.applyTimer = window.requestAnimationFrame(() => {
      state.applyTimer = null;
      void applyPolicy(reason).catch((error) => {
        console.warn("[ChatGPT DOM Virtualizer] apply policy failed", error);
      });
    });
  }

  async function applyPolicy(reason) {
    if (!state.enabled || !state.pageSupported || !state.records.length) {
      return;
    }
    if (isImageGenerationActive()) {
      return;
    }

    const total = state.records.length;
    const keep = Math.min(CONFIG.initialTail, total);
    const atBottom = isNearBottom();
    const atTop = isNearTop();
    const composerFocused = isComposerFocused();
    let nextStart = state.windowStart;
    let nextEnd = state.windowEnd;

    if (composerFocused && atBottom) {
      nextEnd = total - 1;
      nextStart = Math.max(0, total - keep);
    } else if (atTop && state.scrollDirection === "up") {
      nextStart = Math.max(0, state.windowStart - CONFIG.step);
      nextEnd = Math.min(total - 1, nextStart + keep - 1);
    } else if (atBottom && state.scrollDirection === "down") {
      nextEnd = Math.min(total - 1, state.windowEnd + CONFIG.step);
      nextStart = Math.max(0, nextEnd - keep + 1);
    } else if (state.windowEnd >= total) {
      nextEnd = total - 1;
      nextStart = Math.max(0, nextEnd - keep + 1);
    }

    nextStart = clamp(nextStart, 0, Math.max(0, total - 1));
    nextEnd = clamp(nextEnd, nextStart, Math.max(0, total - 1));

    await transitionWindow(nextStart, nextEnd, reason);

    if (
      reason === "scroll" &&
      atTop &&
      state.scrollDirection === "up" &&
      state.scanCursor &&
      !state.scanExhausted
    ) {
      scheduleBackgroundScan("scroll");
    }

    scheduleBackgroundCrawl(reason || "apply-policy");
    if (shouldAutoScrollToLatest(reason, atBottom, composerFocused)) {
      scheduleScrollToLatest(reason || "apply-policy", shouldForceLatestWindow(reason, atBottom, composerFocused));
    }
  }

  async function transitionWindow(nextStart, nextEnd, reason) {
    if (!state.records.length) {
      return;
    }

    nextStart = clamp(nextStart, 0, state.records.length - 1);
    nextEnd = clamp(nextEnd, nextStart, state.records.length - 1);

    if (state.windowStart === nextStart && state.windowEnd === nextEnd) {
      return;
    }

    state.mutationPause += 1;
    try {
      while (state.windowStart < nextStart) {
        const record = state.records[state.windowStart];
        if (record && record.loaded) {
          unloadRecord(record);
        }
        state.windowStart += 1;
      }

      while (state.windowStart > nextStart) {
        state.windowStart -= 1;
        const record = state.records[state.windowStart];
        if (record && !record.loaded) {
          // eslint-disable-next-line no-await-in-loop
          await loadRecord(record, true);
        }
      }

      while (state.windowEnd < nextEnd) {
        state.windowEnd += 1;
        const record = state.records[state.windowEnd];
        if (record && !record.loaded) {
          // eslint-disable-next-line no-await-in-loop
          await loadRecord(record, false);
        }
      }

      while (state.windowEnd > nextEnd) {
        const record = state.records[state.windowEnd];
        if (record && record.loaded) {
          unloadRecord(record);
        }
        state.windowEnd -= 1;
      }
    } finally {
      state.mutationPause -= 1;
    }

    state.windowStart = nextStart;
    state.windowEnd = nextEnd;
    recomputeHeights();
    trimSnapshotCache();
  }

  function unloadRecord(record) {
    if (!record || !record.loaded || !record.node || !record.node.isConnected) {
      return;
    }
    const node = record.node;
    if (isProtected(node)) {
      return;
    }

    ensureRecordMetrics(record);
    record.snapshotHtml = node.outerHTML;

    const placeholder = document.createElement("div");
    placeholder.dataset.cdvPlaceholder = "true";
    placeholder.style.display = "block";
    placeholder.style.width = "100%";
    placeholder.style.height = `${record.innerHeight}px`;
    placeholder.style.minHeight = `${record.innerHeight}px`;
    placeholder.style.marginTop = `${record.marginTop}px`;
    placeholder.style.marginBottom = `${record.marginBottom}px`;
    placeholder.style.flexShrink = "0";
    placeholder.style.overflow = "hidden";
    placeholder.style.pointerEvents = "none";
    placeholder.style.overflowAnchor = "none";
    placeholder.setAttribute("aria-hidden", "true");

    node.replaceWith(placeholder);
    record.placeholder = placeholder;
    record.loaded = false;
    record.node = null;
    if (state.resizeObserver) {
      state.resizeObserver.unobserve(node);
    }
    schedulePersistRecord(record, "unload");
  }

  async function loadRecord(record, fromTop) {
    if (!record || record.loaded) {
      return;
    }
    const node = await ensureRecordNode(record);
    if (!(node instanceof HTMLElement)) {
      return;
    }
    if (record.placeholder && record.placeholder.isConnected) {
      record.placeholder.replaceWith(node);
    } else if (!node.isConnected) {
      const neighbor = findNeighborForRestore(record, fromTop);
      if (neighbor && neighbor.parentNode) {
        if (fromTop) {
          neighbor.before(node);
        } else {
          neighbor.after(node);
        }
      } else if (state.root && state.root.parentNode) {
        state.root.appendChild(node);
      }
    }

    record.placeholder = null;
    record.loaded = true;
    record.node = node;
    ensureRecordMetrics(record);
    if (state.resizeObserver) {
      state.resizeObserver.observe(node);
    }
    schedulePersistRecord(record, "load");
  }

  function findNeighborForRestore(record, fromTop) {
    const index = state.records.indexOf(record);
    if (index === -1) {
      return null;
    }
    if (fromTop) {
      for (let i = index + 1; i < state.records.length; i += 1) {
        const sibling = state.records[i];
        if (sibling && sibling.loaded && sibling.node && sibling.node.isConnected) {
          return sibling.node;
        }
      }
    } else {
      for (let i = index - 1; i >= 0; i -= 1) {
        const sibling = state.records[i];
        if (sibling && sibling.loaded && sibling.node && sibling.node.isConnected) {
          return sibling.node;
        }
      }
    }
    return null;
  }

  function restoreAllRecords() {
    state.mutationPause += 1;
    try {
      for (const record of state.records) {
        if (record.placeholder && record.placeholder.isConnected) {
          let node = record.node;
          if (!(node instanceof HTMLElement)) {
            node = createNodeFromSnapshot(record.snapshotHtml);
            if (node instanceof HTMLElement) {
              record.node = node;
            }
          }
          if (node instanceof HTMLElement) {
            record.placeholder.replaceWith(node);
          } else {
            record.placeholder.remove();
          }
        }
        record.placeholder = null;
        record.loaded = true;
      }
    } finally {
      state.mutationPause -= 1;
    }
  }

  function isProtected(node) {
    if (!node) {
      return false;
    }
    if (isLayoutOrComposerContainer(node)) {
      return true;
    }
    if (containsLiveMedia(node)) {
      return true;
    }
    const active = document.activeElement;
    if (active && node.contains(active)) {
      return true;
    }
    return false;
  }

  function containsLiveMedia(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const mediaSelector = [
      "img",
      "picture",
      "video",
      "canvas",
      "iframe",
      "object",
      "embed",
      "[data-testid*=\"image\" i]",
      "[data-testid*=\"media\" i]",
      "[aria-label*=\"image\" i]",
      "[aria-label*=\"imagem\" i]",
    ].join(", ");
    return node.matches(mediaSelector) || !!node.querySelector(mediaSelector);
  }

  function isImageGenerationActive() {
    const candidates = [];
    const recentRecordStart = Math.max(0, state.records.length - 6);
    for (let index = recentRecordStart; index < state.records.length; index += 1) {
      const record = state.records[index];
      const node = getRecordOrderNode(record);
      if (node instanceof HTMLElement && node.isConnected) {
        candidates.push(node);
      }
    }

    if (state.root instanceof HTMLElement && state.root.isConnected) {
      const recentTurns = Array.from(state.root.querySelectorAll(TURN_SELECTOR)).slice(-6);
      for (const node of recentTurns) {
        if (node instanceof HTMLElement && node.isConnected) {
          candidates.push(node);
        }
      }
    }

    for (const node of uniqueElementsInDocumentOrder(candidates)) {
      if (containsLiveMedia(node)) {
        return true;
      }

      const text = normalizedText([
        node.getAttribute("aria-label"),
        node.getAttribute("title"),
        node.textContent,
      ].filter(Boolean).join(" "));
      if (IMAGE_GENERATION_TEXT_PATTERN.test(text)) {
        return true;
      }
    }

    return false;
  }

  function isComposerFocused() {
    const composer = state.composer;
    return !!(composer && document.activeElement && composer.contains(document.activeElement));
  }

  function isNearTop() {
    const scrollTop = getScrollTop();
    const topBoundary = state.topHeight;
    return scrollTop <= topBoundary + getEdgeThresholdPx();
  }

  function isNearBottom() {
    const scrollTop = getScrollTop();
    const viewportHeight = getViewportHeight();
    const bottomBoundary = state.topHeight + state.loadedHeight + state.bottomHeight;
    return scrollTop + viewportHeight >= bottomBoundary - getEdgeThresholdPx();
  }

  function isLatestRecordVisible() {
    if (!state.records.length) {
      return false;
    }

    const lastRecord = state.records[state.records.length - 1];
    const lastNode = getRecordOrderNode(lastRecord);
    if (!(lastNode instanceof HTMLElement) || !lastNode.isConnected) {
      return false;
    }

    const rect = lastNode.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const verticallyVisible = rect.bottom > 0 && rect.top < viewportHeight;
    const horizontallyVisible = rect.right > 0 && rect.left < viewportWidth;
    return verticallyVisible && horizontallyVisible;
  }

  function getEdgeThresholdPx() {
    return Math.max(CONFIG.minEdgeThresholdPx, Math.round(getViewportHeight() * CONFIG.edgeThresholdRatio));
  }

  function getViewportHeight() {
    const target = state.scrollTarget || document.scrollingElement || document.documentElement;
    return target ? target.clientHeight || window.innerHeight || 0 : window.innerHeight || 0;
  }

  function getScrollTop() {
    const target = state.scrollTarget || document.scrollingElement || document.documentElement;
    return target ? target.scrollTop || 0 : window.scrollY || 0;
  }

  function findScrollTarget(root, composer) {
    const candidates = [];
    const turnContainers = new Set();
    const seen = new Set();
    const pushCandidate = (node) => {
      if (node instanceof HTMLElement && !seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    };

    pushCandidate(root);
    pushCandidate(composer ? composer.closest("main") : null);
    pushCandidate(composer ? composer.closest('[role="main"]') : null);

    let cursor = composer instanceof HTMLElement ? composer.parentElement : null;
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      pushCandidate(cursor);
      cursor = cursor.parentElement;
    }

    const scope = root instanceof HTMLElement ? root : null;
    if (scope) {
      let sampledTurns = 0;
      for (const turnNode of scope.querySelectorAll(TURN_SELECTOR)) {
        if (!(turnNode instanceof HTMLElement)) {
          continue;
        }
        sampledTurns += 1;
        if (sampledTurns > 80) {
          break;
        }

        let ancestor = turnNode.parentElement;
        while (ancestor && ancestor !== scope && ancestor !== document.body && ancestor !== document.documentElement) {
          if (isScrollable(ancestor)) {
            pushCandidate(ancestor);
            turnContainers.add(ancestor);
          }
          ancestor = ancestor.parentElement;
        }
        if (ancestor && isScrollable(ancestor)) {
          pushCandidate(ancestor);
          turnContainers.add(ancestor);
        }
      }
    }

    pushCandidate(document.scrollingElement);
    pushCandidate(document.documentElement);

    let best = null;
    let bestScore = -Infinity;
    for (const candidate of candidates) {
      if (!isScrollable(candidate)) {
        continue;
      }
      let score = scoreScrollTarget(candidate);
      if (candidate === root) {
        score += 2;
      }
      if (root instanceof HTMLElement && root.contains(candidate)) {
        score += 1.25;
      }
      if (turnContainers.has(candidate)) {
        score += 4;
      }
      if (candidate.contains(composer)) {
        score += 2.5;
      }
      if (candidate === document.scrollingElement || candidate === document.documentElement) {
        score -= 0.5;
      }
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    return best || document.scrollingElement || document.documentElement;
  }

  function forceScrollAncestorsToBottom(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }

    let moved = false;
    const ancestors = [];
    let cursor = node.parentElement;

    while (cursor) {
      if (isScrollable(cursor) || cursor === document.body || cursor === document.documentElement) {
        ancestors.push(cursor);
      }
      if (cursor === document.body || cursor === document.documentElement) {
        break;
      }
      cursor = cursor.parentElement;
    }

    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement instanceof HTMLElement && !ancestors.includes(scrollingElement)) {
      ancestors.push(scrollingElement);
    }

    for (const ancestor of ancestors) {
      if (!(ancestor instanceof HTMLElement)) {
        continue;
      }
      const nextTop = Math.max(0, ancestor.scrollHeight - ancestor.clientHeight);
      if (ancestor.scrollTop !== nextTop) {
        ancestor.scrollTop = nextTop;
        moved = true;
      }
    }

    if (!ancestors.length) {
      const viewportHeight = getViewportHeight();
      const scrollHeight = Math.max(
        document.documentElement ? document.documentElement.scrollHeight || 0 : 0,
        document.body ? document.body.scrollHeight || 0 : 0
      );
      const nextTop = Math.max(0, scrollHeight - viewportHeight);
      if (window.scrollY !== nextTop) {
        window.scrollTo(0, nextTop);
        moved = true;
      }
    }

    return moved;
  }

  function forceScrollTargetToBottom(target) {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    const nextTop = getBottomScrollTop(target);
    if (target.scrollTop !== nextTop) {
      target.scrollTop = nextTop;
      return true;
    }
    return false;
  }

  function forceViewportToBottom() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollHeight = Math.max(
      document.documentElement ? document.documentElement.scrollHeight || 0 : 0,
      document.body ? document.body.scrollHeight || 0 : 0,
      getVirtualScrollHeight()
    );
    const nextTop = Math.max(0, scrollHeight - viewportHeight);

    let moved = false;
    const scrollingElement = document.scrollingElement || document.documentElement;
    if (scrollingElement instanceof HTMLElement && scrollingElement.scrollTop !== nextTop) {
      scrollingElement.scrollTop = nextTop;
      moved = true;
    }
    if (document.documentElement instanceof HTMLElement && document.documentElement.scrollTop !== nextTop) {
      document.documentElement.scrollTop = nextTop;
      moved = true;
    }
    if (document.body instanceof HTMLElement && document.body.scrollTop !== nextTop) {
      document.body.scrollTop = nextTop;
      moved = true;
    }
    if (window.scrollY !== nextTop) {
      window.scrollTo(0, nextTop);
      moved = true;
    }

    return moved;
  }

  function getBottomScrollTop(target) {
    if (!(target instanceof HTMLElement)) {
      return 0;
    }
    const clientHeight = target.clientHeight || window.innerHeight || 0;
    const scrollHeight = Math.max(target.scrollHeight || 0, getVirtualScrollHeight());
    return Math.max(0, scrollHeight - clientHeight);
  }

  function getVirtualScrollHeight() {
    return Math.max(0, state.topHeight + state.loadedHeight + state.bottomHeight);
  }

  function isScrollable(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = getComputedStyle(node);
    const overflowY = style.overflowY;
    const canScroll = overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
    return canScroll && node.scrollHeight > node.clientHeight + 100;
  }

  function scoreScrollTarget(node) {
    if (!(node instanceof HTMLElement)) {
      return 0;
    }
    const ratio = node.clientHeight ? node.scrollHeight / Math.max(1, node.clientHeight) : 0;
    const tagBonus = node.tagName === "MAIN" ? 2 : node === document.scrollingElement ? 1.5 : 1;
    return ratio * tagBonus;
  }

  function findComposer() {
    for (const selector of COMPOSER_SELECTORS) {
      const node = document.querySelector(selector);
      if (node instanceof HTMLElement && isVisible(node)) {
        return node;
      }
      if (node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && selector.includes("prompt-textarea"))) {
        const visibleAnchor = findVisibleComposerAnchor(node);
        if (visibleAnchor) {
          return visibleAnchor;
        }
        return node;
      }
    }

    const textarea = document.querySelector("textarea");
    if (textarea instanceof HTMLTextAreaElement) {
      if (isVisible(textarea)) {
        return textarea;
      }
      const visibleAnchor = findVisibleComposerAnchor(textarea);
      if (visibleAnchor) {
        return visibleAnchor;
      }
      return textarea;
    }

    const editable = document.querySelector('[contenteditable="true"]');
    if (editable instanceof HTMLElement) {
      if (isVisible(editable)) {
        return editable;
      }
      const visibleAnchor = findVisibleComposerAnchor(editable);
      if (visibleAnchor) {
        return visibleAnchor;
      }
      return editable;
    }

    return null;
  }

  function findVisibleComposerAnchor(node) {
    let cursor = node instanceof HTMLElement ? node.parentElement : null;
    while (cursor && cursor !== document.body && cursor !== document.documentElement) {
      if (cursor instanceof HTMLElement && isVisible(cursor)) {
        return cursor;
      }
      cursor = cursor.parentElement;
    }
    return null;
  }

  function findConversationRoot(composer) {
    const candidates = [
      composer ? composer.closest("main") : null,
      document.querySelector("#main"),
      document.querySelector("main"),
      document.querySelector("[role=\"main\"]"),
    ];

    for (const node of candidates) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }
      if (node === document.body || node === document.documentElement || !isVisible(node)) {
        continue;
      }
      if (isInsideComposer(node, composer)) {
        continue;
      }
      if (node.closest('[data-cdv-overlay-root="true"]')) {
        continue;
      }
      if (node.matches("nav, aside, header, footer, form, textarea, button, input, select")) {
        continue;
      }
      if (!hasConversationTurnMarkers(node)) {
        continue;
      }
      return node;
    }

    return null;
  }

  function hasConversationTurnMarkers(node) {
    if (!(node instanceof HTMLElement) || !isVisible(node)) {
      return false;
    }

    const turnNodes = node.matches(TURN_ROOT_SELECTOR)
      ? [node]
      : Array.from(node.querySelectorAll(TURN_ROOT_SELECTOR));
    return turnNodes.some((turnNode) => turnNode instanceof HTMLElement && turnNode.isConnected && isVisible(turnNode));
  }

  function looksLikeTurn(node, composer = state.composer) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const hasTurnSignal = hasTurnSelectorSignal(node);
    if (!hasTurnSignal && isLayoutOrComposerContainer(node, composer)) {
      return false;
    }
    if (node.dataset && node.dataset.cdvOverlayRoot === "true") {
      return false;
    }
    if (node.closest('[data-cdv-overlay-root="true"]')) {
      return false;
    }
    if (isInsideComposer(node, composer)) {
      return false;
    }
    if (node.matches("nav, aside, header, footer, form, textarea, button, input, select, option")) {
      return false;
    }
    if (node.closest("nav, aside, header, footer, [data-sidebar-item=\"true\"], [aria-label*=\"history\" i]")) {
      return false;
    }
    if (!hasTurnSignal && node.querySelector("nav, aside, header, footer")) {
      return false;
    }
    if (!isVisible(node)) {
      return false;
    }

    const text = normalizedText(node.innerText || node.textContent || "");
    if (text.length < 20) {
      return false;
    }

    const hasMessageSignals = !!node.querySelector("button, svg, code, pre, blockquote, p, ul, ol, table, img, a");
    return hasTurnSignal || (hasMessageSignals && text.length > 120) || text.length > 240;
  }

  function hasTurnSelectorSignal(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const testId = node.getAttribute("data-testid") || "";
    return (
      node.hasAttribute("data-message-author-role") ||
      /conversation-turn/i.test(testId) ||
      node.hasAttribute("data-message-id") ||
      node.hasAttribute("data-turn-id") ||
      node.getAttribute("role") === "article" ||
      node.tagName === "ARTICLE"
    );
  }

  function isLayoutOrComposerContainer(node, composer = state.composer) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    if (node === document.documentElement || node === document.body) {
      return true;
    }
    if (state.root && node === state.root) {
      return true;
    }
    const activeComposer = composer instanceof HTMLElement ? composer : state.composer;
    if (activeComposer instanceof HTMLElement && node.contains(activeComposer)) {
      return true;
    }
    const form = state.composerForm instanceof HTMLElement
      ? state.composerForm
      : activeComposer instanceof HTMLElement
        ? activeComposer.closest("form")
        : null;
    if (form instanceof HTMLElement && node.contains(form)) {
      return true;
    }
    return false;
  }

  function nodeSignature(node) {
    const role = node.getAttribute("data-message-author-role") || node.getAttribute("data-testid") || node.tagName;
    const text = normalizedText(node.innerText || node.textContent || "").slice(0, 180);
    return `${role}::${text}`;
  }

  function uniqueElementsInDocumentOrder(nodes) {
    const unique = [];
    const seen = new Set();
    for (const node of nodes) {
      if (!(node instanceof HTMLElement) || seen.has(node)) {
        continue;
      }
      seen.add(node);
      unique.push(node);
    }
    unique.sort((a, b) => {
      if (a === b) {
        return 0;
      }
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        return -1;
      }
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) {
        return 1;
      }
      return 0;
    });
    return unique;
  }

  function isInsideComposer(node, composer = state.composer) {
    if (!node || !composer) {
      return false;
    }
    return node === composer || composer.contains(node) || (!!state.composerForm && state.composerForm.contains(node));
  }

  function isVisible(node) {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function measureInnerHeight(node) {
    const rect = node.getBoundingClientRect();
    return Math.max(1, Math.ceil(rect.height));
  }

  function measureOuterMetrics(node) {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const marginTop = parseFloat(style.marginTop) || 0;
    const marginBottom = parseFloat(style.marginBottom) || 0;
    const innerHeight = Math.max(1, Math.ceil(rect.height));
    const outerHeight = Math.max(1, Math.ceil(innerHeight + marginTop + marginBottom));
    return {
      innerHeight,
      outerHeight,
      marginTop,
      marginBottom,
    };
  }

  function updatePlaceholder(record) {
    if (!record.placeholder) {
      return;
    }
    record.placeholder.style.height = `${record.innerHeight}px`;
    record.placeholder.style.minHeight = `${record.innerHeight}px`;
    record.placeholder.style.marginTop = `${record.marginTop}px`;
    record.placeholder.style.marginBottom = `${record.marginBottom}px`;
  }

  function normalizedText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
})();
