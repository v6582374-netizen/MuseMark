type FaviconCandidateInput = {
  favIconUrl?: string;
  url?: string;
  domain?: string;
};

const QUICKDOCK_FALLBACK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#98A2B3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/></svg>';

const QUICKDOCK_FALLBACK_ICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  QUICKDOCK_FALLBACK_ICON_SVG
)}`;

function buildFaviconCandidates(input: FaviconCandidateInput): string[] {
  const unique = new Set<string>();

  const addCandidate = (candidate?: string) => {
    const value = (candidate ?? "").trim();
    if (!value) {
      return;
    }
    unique.add(value);
  };

  addCandidate(input.favIconUrl);

  try {
    if (input.url) {
      const parsed = new URL(input.url);
      addCandidate(new URL("/favicon.ico", parsed.origin).toString());
      addCandidate(`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(parsed.origin)}`);
      addCandidate(`https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`);
    }
  } catch {
    // Ignore invalid URL and continue using domain candidates.
  }

  const safeDomain = (input.domain ?? "").trim();
  if (safeDomain) {
    addCandidate(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(safeDomain)}`);
    addCandidate(`https://icons.duckduckgo.com/ip3/${safeDomain}.ico`);
  }

  addCandidate(QUICKDOCK_FALLBACK_ICON_DATA_URL);
  return Array.from(unique);
}

function nextCandidateOrFallback(
  candidates: string[],
  currentIndex: number
): {
  nextSrc?: string;
  nextIndex: number;
  exhausted: boolean;
} {
  const nextIndex = currentIndex + 1;
  if (nextIndex >= candidates.length) {
    return {
      nextSrc: undefined,
      nextIndex: currentIndex,
      exhausted: true
    };
  }

  return {
    nextSrc: candidates[nextIndex],
    nextIndex,
    exhausted: false
  };
}

(() => {
  const PROTOCOL_VERSION = 1;
  const GLOBAL_KEY = "__musemark_content_ready__";
  const QUICKDOCK_STYLE_ID = "musemark-quickdock-style";

  const win = window as Window & {
    [GLOBAL_KEY]?: boolean;
  };

  if (win[GLOBAL_KEY]) {
    return;
  }
  win[GLOBAL_KEY] = true;

  type OverlayElements = {
    root: HTMLDivElement;
    status: HTMLDivElement;
    summary: HTMLDivElement;
    noteInput: HTMLInputElement;
    categoryBox: HTMLDivElement;
    tagBox: HTMLDivElement;
    saveHint: HTMLDivElement;
  };

  type DockMode = "collapsed" | "expanded";
  type DockPosition = "right" | "bottom_center";

  type DockLayoutState = {
    mode: DockMode;
    pinned: boolean;
    activeProfileId: string;
    updatedAt: string;
  };

  type DockEntry = {
    id: string;
    kind: "bookmark" | "action";
    title: string;
    subtitle?: string;
    url?: string;
    domain?: string;
    favIconUrl?: string;
    pinned?: boolean;
    action?: "open_library" | "save_current_page";
  };

  type DockProfile = {
    id: string;
    name: string;
  };

  type DockStatePayload = {
    enabled: boolean;
    position?: DockPosition;
    layout: DockLayoutState;
    profiles: DockProfile[];
    pinnedIds: string[];
    entries: DockEntry[];
  };

  type DockElements = {
    root: HTMLDivElement;
    rail: HTMLDivElement;
    list: HTMLDivElement;
    hideButton: HTMLButtonElement;
    restoreButton: HTMLButtonElement;
  };

  let overlayElements: OverlayElements | null = null;
  let currentSessionId = "";
  let currentBookmarkId = "";
  let selectedCategory = "";
  let selectedTags = new Set<string>();
  let submitting = false;

  let dockElements: DockElements | null = null;
  let dockEnabled = true;
  let dockMode: DockMode = "expanded";
  let dockPosition: DockPosition = "right";
  let dockEntries: DockEntry[] = [];
  let dockPinnedIds = new Set<string>();
  let dockActiveProfileId = "default";
  let dockFocusedIndex = 0;
  let dockSuppressedByOverlay = false;
  let dockRefreshTimer: number | undefined;
  let dockTransitionTimer: number | undefined;
  let dockTransitionLocked = false;
  let dockContextMenu: HTMLDivElement | null = null;
  let dockDraggingPinnedId: string | null = null;
  let dockDropTargetPinnedId: string | null = null;
  let dockClickSuppressedUntil = 0;

  const DOCK_WATERFALL_STEP_MS = 32;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.protocolVersion !== PROTOCOL_VERSION) {
      return false;
    }

    if (message.type === "musemark/startCapture") {
      const payload = message.payload as { sessionId: string; maxChars: number };
      currentSessionId = payload.sessionId;
      selectedCategory = "";
      selectedTags = new Set<string>();
      submitting = false;
      showOverlay("Captured. AI is analyzing...");

      void (async () => {
        const capture = await collectCapturePayload(payload.sessionId, payload.maxChars);
        sendResponse(capture);
      })();
      return true;
    }

    if (message.type === "musemark/bookmarkLinked") {
      const payload = message.payload as { sessionId: string; bookmarkId: string };
      if (payload.sessionId === currentSessionId) {
        currentBookmarkId = payload.bookmarkId;
      }
      return false;
    }

    if (message.type === "musemark/stage1Ready") {
      const payload = message.payload as {
        sessionId: string;
        summary: string;
        suggestedCategoryCandidates: string[];
        suggestedTags: string[];
        textTruncated: boolean;
      };
      if (payload.sessionId === currentSessionId) {
        updateForStage1(payload.summary, payload.suggestedCategoryCandidates, payload.suggestedTags, payload.textTruncated);
      }
      return false;
    }

    if (message.type === "musemark/classifyPending") {
      const payload = message.payload as { sessionId: string };
      if (payload.sessionId === currentSessionId && overlayElements) {
        submitting = false;
        overlayElements.status.textContent = "Classifying and saving...";
      }
      return false;
    }

    if (message.type === "musemark/stageError") {
      const payload = message.payload as { sessionId: string; error: string };
      if (payload.sessionId === currentSessionId && overlayElements) {
        submitting = false;
        overlayElements.status.textContent = "Saved to Inbox with AI error";
        overlayElements.summary.textContent = payload.error;
      }
      return false;
    }

    if (message.type === "musemark/finalized") {
      const payload = message.payload as { sessionId: string; category?: string; tags?: string[] };
      if (payload.sessionId === currentSessionId && overlayElements) {
        submitting = false;
        const category = payload.category || "Uncategorized";
        const tags = (payload.tags ?? []).join(", ");
        overlayElements.status.textContent = `Saved: ${category}${tags ? ` | ${tags}` : ""}`;
        overlayElements.summary.textContent = "Done. Auto closing...";
        window.setTimeout(() => {
          hideOverlay();
          void refreshQuickDock();
        }, 1200);
      }
      return false;
    }

    return false;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideDockContextMenu();
    }

    if (event.key === "Escape" && overlayElements?.root.style.display !== "none") {
      hideOverlay();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      void toggleDockByShortcut();
      return;
    }

    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      return;
    }

    if (isTypingTarget(event.target)) {
      return;
    }

    const shortcutIndex = resolveDockShortcutIndex(event);
    if (shortcutIndex === undefined) {
      return;
    }

    const entry = dockEntries[shortcutIndex];
    if (!entry) {
      return;
    }

    event.preventDefault();
    dockFocusedIndex = shortcutIndex;
    renderDockEntries();
    void openDockEntry(entry);
  });

  document.addEventListener("click", () => {
    hideDockContextMenu();
  });

  window.addEventListener("focus", () => {
    void refreshQuickDock();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void refreshQuickDock();
    }
  });

  void initializeQuickDock();

  function ensureOverlay(): OverlayElements {
    if (overlayElements) {
      return overlayElements;
    }

    const root = document.createElement("div");
    root.id = "musemark-overlay";
    root.innerHTML = `
      <div class="musemark-card">
        <div class="musemark-title">MuseMark</div>
        <div class="musemark-status"></div>
        <div class="musemark-summary"></div>
        <div class="musemark-section">
          <div class="musemark-label">Category candidates</div>
          <div class="musemark-category-box"></div>
        </div>
        <div class="musemark-section">
          <div class="musemark-label">Tag candidates</div>
          <div class="musemark-tag-box"></div>
        </div>
        <input class="musemark-input" type="text" maxlength="200" placeholder="One-line note (optional). Press Enter to save..." />
        <div class="musemark-hint">Enter = save now, Esc = close (keeps bookmark in Inbox)</div>
        <div class="musemark-actions">
          <button class="musemark-manager">Open Library</button>
        </div>
      </div>
    `;

    const style = document.createElement("style");
    style.textContent = `
      #musemark-overlay {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483647;
        width: min(430px, calc(100vw - 28px));
        font-family: "Avenir Next", "SF Pro Display", "Noto Sans SC", sans-serif;
      }
      #musemark-overlay .musemark-card {
        border-radius: 16px;
        background: linear-gradient(135deg, #101a34 0%, #1d2746 48%, #1f385f 100%);
        color: #f4f8ff;
        border: 1px solid rgba(214, 224, 255, 0.28);
        box-shadow: 0 22px 52px rgba(5, 10, 25, 0.42);
        padding: 14px 14px 12px;
        backdrop-filter: blur(8px);
        animation: musemark-enter 170ms ease-out;
      }
      #musemark-overlay .musemark-title {
        font-weight: 750;
        letter-spacing: 0.2px;
        font-size: 15px;
        margin-bottom: 8px;
      }
      #musemark-overlay .musemark-status {
        font-size: 13px;
        color: #d3e2ff;
      }
      #musemark-overlay .musemark-summary {
        margin-top: 8px;
        font-size: 12px;
        line-height: 1.45;
        color: #d8e6ff;
        max-height: 88px;
        overflow: auto;
        white-space: pre-wrap;
      }
      #musemark-overlay .musemark-section {
        margin-top: 10px;
      }
      #musemark-overlay .musemark-label {
        font-size: 11px;
        color: #a8c5ff;
        margin-bottom: 6px;
      }
      #musemark-overlay .musemark-category-box,
      #musemark-overlay .musemark-tag-box {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #musemark-overlay .musemark-chip {
        border: 1px solid rgba(190, 212, 255, 0.4);
        background: rgba(23, 46, 79, 0.72);
        color: #eff6ff;
        border-radius: 999px;
        font-size: 11px;
        padding: 4px 9px;
        cursor: pointer;
      }
      #musemark-overlay .musemark-chip.active {
        background: #8bd1ff;
        border-color: #8bd1ff;
        color: #07203a;
      }
      #musemark-overlay .musemark-input {
        width: 100%;
        margin-top: 12px;
        border-radius: 10px;
        border: 1px solid rgba(187, 208, 255, 0.5);
        background: rgba(9, 20, 38, 0.65);
        color: #f3f8ff;
        padding: 9px 10px;
        font-size: 13px;
        outline: none;
      }
      #musemark-overlay .musemark-input:focus {
        border-color: #9bc8ff;
        box-shadow: 0 0 0 2px rgba(123, 188, 255, 0.26);
      }
      #musemark-overlay .musemark-hint {
        margin-top: 8px;
        font-size: 11px;
        color: #b8d1ff;
      }
      #musemark-overlay .musemark-actions {
        margin-top: 10px;
        display: flex;
        justify-content: flex-end;
      }
      #musemark-overlay .musemark-manager {
        border: none;
        border-radius: 10px;
        background: #86d4ff;
        color: #072039;
        font-weight: 650;
        padding: 7px 10px;
        cursor: pointer;
        font-size: 12px;
      }
      @keyframes musemark-enter {
        from {
          transform: translateY(8px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `;

    const status = root.querySelector(".musemark-status") as HTMLDivElement;
    const summary = root.querySelector(".musemark-summary") as HTMLDivElement;
    const noteInput = root.querySelector(".musemark-input") as HTMLInputElement;
    const categoryBox = root.querySelector(".musemark-category-box") as HTMLDivElement;
    const tagBox = root.querySelector(".musemark-tag-box") as HTMLDivElement;
    const saveHint = root.querySelector(".musemark-hint") as HTMLDivElement;
    const managerButton = root.querySelector(".musemark-manager") as HTMLButtonElement;
    let composing = false;

    noteInput.addEventListener("compositionstart", () => {
      composing = true;
    });
    noteInput.addEventListener("compositionend", () => {
      composing = false;
    });

    noteInput.addEventListener("keydown", (event) => {
      const isImeComposing = composing || event.isComposing || event.keyCode === 229;
      if (event.key === "Enter" && !event.shiftKey && !isImeComposing) {
        event.preventDefault();
        void submitCurrent();
      }
    });

    managerButton.addEventListener("click", () => {
      void sendRuntimeMessage("content/openManager", {});
    });

    root.style.display = "none";
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(root);

    overlayElements = {
      root,
      status,
      summary,
      noteInput,
      categoryBox,
      tagBox,
      saveHint
    };

    return overlayElements;
  }

  function showOverlay(statusText: string): void {
    const overlay = ensureOverlay();
    overlay.root.style.display = "block";
    overlay.status.textContent = statusText;
    overlay.summary.textContent = "";
    overlay.noteInput.value = "";
    overlay.saveHint.textContent = "Enter = save now, Esc = close (keeps bookmark in Inbox)";
    overlay.categoryBox.innerHTML = "";
    overlay.tagBox.innerHTML = "";
    overlay.noteInput.focus();
    setDockSuppressedByOverlay(true);
  }

  function hideOverlay(): void {
    if (!overlayElements) {
      return;
    }
    overlayElements.root.style.display = "none";
    setDockSuppressedByOverlay(false);
  }

  function updateForStage1(summary: string, categories: string[], tags: string[], truncated: boolean): void {
    const overlay = ensureOverlay();
    overlay.status.textContent = "AI analyzed page. Add a note and press Enter.";
    overlay.summary.textContent = truncated ? `${summary}\n\nText was truncated due to max character limit.` : summary;
    overlay.noteInput.focus();
    renderCategoryChips(categories);
    renderTagChips(tags);
  }

  function renderCategoryChips(categories: string[]): void {
    if (!overlayElements) {
      return;
    }
    overlayElements.categoryBox.innerHTML = "";
    for (const rawCategory of categories.slice(0, 6)) {
      const category = normalizeLabel(rawCategory);
      if (!category) {
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "musemark-chip";
      button.textContent = category;
      button.addEventListener("click", () => {
        selectedCategory = selectedCategory === category ? "" : category;
        const all = overlayElements?.categoryBox.querySelectorAll(".musemark-chip") ?? [];
        all.forEach((chip) => chip.classList.remove("active"));
        if (selectedCategory === category) {
          button.classList.add("active");
        }
      });
      overlayElements.categoryBox.appendChild(button);
    }
  }

  function renderTagChips(tags: string[]): void {
    if (!overlayElements) {
      return;
    }
    overlayElements.tagBox.innerHTML = "";
    for (const rawTag of tags.slice(0, 12)) {
      const tag = normalizeLabel(rawTag);
      if (!tag) {
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "musemark-chip";
      button.textContent = tag;
      button.addEventListener("click", () => {
        if (selectedTags.has(tag)) {
          selectedTags.delete(tag);
          button.classList.remove("active");
        } else {
          selectedTags.add(tag);
          button.classList.add("active");
        }
      });
      overlayElements.tagBox.appendChild(button);
    }
  }

  async function submitCurrent(): Promise<void> {
    if (!overlayElements || submitting || !currentSessionId) {
      return;
    }
    submitting = true;
    overlayElements.status.textContent = "Saving...";

    try {
      await sendRuntimeMessage("content/submitNote", {
        sessionId: currentSessionId,
        bookmarkId: currentBookmarkId || undefined,
        note: overlayElements.noteInput.value,
        selectedCategory: selectedCategory || undefined,
        selectedTags: Array.from(selectedTags)
      });
    } catch (error) {
      submitting = false;
      overlayElements.status.textContent = "Save failed";
      overlayElements.summary.textContent = toErrorMessage(error);
    }
  }

  async function initializeQuickDock(): Promise<void> {
    await refreshQuickDock();

    if (dockRefreshTimer !== undefined) {
      clearInterval(dockRefreshTimer);
    }
    dockRefreshTimer = window.setInterval(() => {
      void refreshQuickDock();
    }, 45_000);
  }

  async function refreshQuickDock(): Promise<void> {
    let payload: DockStatePayload;
    try {
      payload = await sendRuntimeMessage<DockStatePayload>("quickDock/getState", {
        currentUrl: location.href
      });
    } catch (error) {
      const message = toErrorMessage(error).toLowerCase();
      if (message.includes("unknown message type") || message.includes("quickdock")) {
        dockEnabled = false;
        if (dockElements) {
          dockElements.root.style.display = "none";
        }
      }
      return;
    }

    dockEnabled = Boolean(payload.enabled);
    dockEntries = Array.isArray(payload.entries) ? payload.entries : [];
    dockPinnedIds = new Set(Array.isArray(payload.pinnedIds) ? payload.pinnedIds : []);
    dockActiveProfileId = payload.layout?.activeProfileId || "default";
    dockMode = normalizeDockMode(payload.layout?.mode) || dockMode;
    dockPosition = normalizeDockPosition(payload.position) || dockPosition;

    if (!dockEnabled) {
      if (dockElements) {
        dockElements.root.style.display = "none";
      }
      return;
    }

    if (dockFocusedIndex >= dockEntries.length) {
      dockFocusedIndex = 0;
    }

    const dock = ensureDock();
    dock.root.style.display = dockSuppressedByOverlay ? "none" : "block";
    renderDock();
  }

  function ensureDock(): DockElements {
    if (dockElements) {
      return dockElements;
    }

    ensureDockStyle();

    const root = document.createElement("div");
    root.id = "musemark-quickdock";
    root.dataset.position = dockPosition;
    root.classList.add(dockPosition === "bottom_center" ? "pos-bottom" : "pos-right");
    root.innerHTML = `
      <div class="anqd-controls">
        <button class="anqd-restore" type="button" title="Show Dock (Cmd/Ctrl+Shift+K)" aria-label="Show Dock"></button>
        <button class="anqd-hide" type="button" title="Hide Dock" aria-label="Hide Dock"></button>
      </div>
      <div class="anqd-rail">
        <div class="anqd-list" role="list"></div>
      </div>
    `;

    const rail = root.querySelector(".anqd-rail") as HTMLDivElement;
    const list = root.querySelector(".anqd-list") as HTMLDivElement;
    const hideButton = root.querySelector(".anqd-hide") as HTMLButtonElement;
    const restoreButton = root.querySelector(".anqd-restore") as HTMLButtonElement;

    hideButton.addEventListener("click", () => {
      void setDockMode("collapsed", true);
    });

    restoreButton.addEventListener("click", () => {
      void setDockMode("expanded", true);
    });

    document.documentElement.appendChild(root);

    dockElements = {
      root,
      rail,
      list,
      hideButton,
      restoreButton
    };

    return dockElements;
  }

  function ensureDockStyle(): void {
    const existingStyle = document.getElementById(QUICKDOCK_STYLE_ID) as HTMLStyleElement | null;
    const style = existingStyle ?? document.createElement("style");
    style.id = QUICKDOCK_STYLE_ID;
    style.textContent = `
      #musemark-quickdock {
        position: fixed;
        right: 0;
        top: 50%;
        transform: translateY(-50%);
        z-index: 2147483645;
        font-family: "Avenir Next", "SF Pro Text", "Noto Sans SC", sans-serif;
        opacity: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 18px;
        width: 46px;
      }
      #musemark-quickdock .anqd-controls {
        width: 46px;
        min-height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      #musemark-quickdock.pos-bottom {
        right: auto;
        top: auto;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        width: auto;
        max-width: min(92vw, 920px);
        flex-direction: row;
        align-items: center;
        gap: 12px;
      }
      #musemark-quickdock.pos-bottom .anqd-controls {
        width: auto;
        min-height: 0;
        flex: 0 0 auto;
      }
      #musemark-quickdock .anqd-restore {
        position: relative;
        width: 36px;
        height: 22px;
        border: none;
        outline: none;
        border-radius: 9px;
        background: transparent;
        color: transparent;
        display: none;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: transform 180ms ease, filter 180ms ease;
        box-shadow: none;
      }
      #musemark-quickdock .anqd-hide {
        position: relative;
        width: 36px;
        height: 22px;
        border: none;
        outline: none;
        border-radius: 9px;
        background: transparent;
        color: transparent;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        z-index: 2;
        transition: transform 180ms ease, filter 180ms ease;
        box-shadow: none;
      }
      #musemark-quickdock .anqd-hide::before,
      #musemark-quickdock .anqd-restore::before {
        content: "";
        position: absolute;
        left: 7px;
        right: 7px;
        top: 50%;
        height: 1.5px;
        transform: translateY(-50%);
        background: linear-gradient(
          90deg,
          transparent 0%,
          rgba(118, 118, 118, 0.92) 18%,
          rgba(156, 156, 156, 0.98) 50%,
          rgba(118, 118, 118, 0.92) 82%,
          transparent 100%
        );
        box-shadow:
          0 0 8px rgba(84, 84, 84, 0.46),
          0 0 14px rgba(60, 60, 60, 0.28);
        transition: transform 180ms ease, opacity 180ms ease;
      }
      #musemark-quickdock .anqd-hide::after,
      #musemark-quickdock .anqd-restore::after {
        content: "";
        position: absolute;
        left: 50%;
        width: 7px;
        height: 7px;
        border-right: 1.5px solid rgba(124, 124, 124, 0.96);
        border-bottom: 1.5px solid rgba(124, 124, 124, 0.96);
        transform-origin: center;
        filter: drop-shadow(0 0 5px rgba(72, 72, 72, 0.38));
      }
      #musemark-quickdock .anqd-hide::after {
        top: 1px;
        transform: translateX(-50%) rotate(45deg);
      }
      #musemark-quickdock .anqd-restore::after {
        top: 6px;
        transform: translateX(-50%) rotate(-135deg);
      }
      #musemark-quickdock .anqd-hide:hover::before,
      #musemark-quickdock .anqd-restore:hover::before {
        transform: translateY(-50%) scaleX(0.74);
        opacity: 0.95;
      }
      #musemark-quickdock .anqd-hide:hover,
      #musemark-quickdock .anqd-restore:hover {
        transform: translateY(-1px);
        filter: drop-shadow(0 0 10px rgba(92, 92, 92, 0.38));
      }
      #musemark-quickdock.is-transitioning .anqd-hide,
      #musemark-quickdock.is-transitioning .anqd-restore {
        pointer-events: none;
      }
      #musemark-quickdock .anqd-rail {
        position: relative;
        width: 46px;
        border: none;
        outline: none;
        border-radius: 0;
        background: transparent;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        padding: 0;
        display: flex;
        align-items: stretch;
        justify-content: center;
        z-index: 1;
        overflow: visible;
        transition: opacity 140ms ease, transform 140ms ease;
      }
      #musemark-quickdock.pos-bottom .anqd-rail {
        width: auto;
        max-width: min(92vw, 860px);
        overflow: hidden;
      }
      #musemark-quickdock.pos-right.is-collapsed .anqd-rail {
        opacity: 0;
        transform: translateX(16px) scale(0.96);
        pointer-events: none;
      }
      #musemark-quickdock.pos-bottom.is-collapsed .anqd-rail {
        opacity: 0;
        transform: translateY(12px) scale(0.96);
        pointer-events: none;
        max-width: 0;
      }
      #musemark-quickdock.pos-right.is-collapsed .anqd-restore,
      #musemark-quickdock.pos-bottom.is-collapsed .anqd-restore {
        display: inline-flex;
      }
      #musemark-quickdock.pos-right.is-collapsed .anqd-hide,
      #musemark-quickdock.pos-bottom.is-collapsed .anqd-hide {
        display: none;
      }
      #musemark-quickdock .anqd-list {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 24px;
        max-height: min(72vh, 760px);
        overflow-y: auto;
        width: 100%;
        padding: 0;
      }
      #musemark-quickdock.pos-bottom .anqd-list {
        flex-direction: row;
        align-items: center;
        gap: 24px;
        width: auto;
        max-width: min(92vw, 820px);
        max-height: none;
        overflow-x: auto;
        overflow-y: hidden;
        padding: 2px 2px;
      }
      #musemark-quickdock .anqd-list::-webkit-scrollbar {
        width: 0;
        height: 0;
      }
      #musemark-quickdock .anqd-item {
        position: relative;
        width: 30px;
        height: 30px;
        border: none;
        outline: none;
        border-radius: 10px;
        background: transparent;
        box-shadow: none;
        cursor: pointer;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        opacity: 1;
        transform: translateY(0) scale(1);
        transition:
          opacity 72ms ease-in-out,
          transform 72ms ease-in-out,
          box-shadow 140ms ease;
        transition-delay:
          calc(var(--idx, 0) * 32ms),
          calc(var(--idx, 0) * 32ms),
          0ms;
      }
      #musemark-quickdock.pos-right.is-opening .anqd-item,
      #musemark-quickdock.pos-right.is-closing .anqd-item {
        opacity: 0;
        transform: translateY(-8px) scale(0.96);
      }
      #musemark-quickdock.pos-bottom.is-opening .anqd-item,
      #musemark-quickdock.pos-bottom.is-closing .anqd-item {
        opacity: 0;
        transform: translateY(8px) scale(0.96);
      }
      #musemark-quickdock .anqd-item.selected {
        box-shadow: 0 0 22px rgba(255, 255, 255, 0.2);
      }
      #musemark-quickdock .anqd-item[data-pinned="true"] {
        cursor: grab;
      }
      #musemark-quickdock .anqd-item[data-pinned="true"]:active {
        cursor: grabbing;
      }
      #musemark-quickdock .anqd-item.is-dragging {
        opacity: 0.58;
        transform: scale(0.96);
      }
      #musemark-quickdock .anqd-item.is-drop-target {
        box-shadow:
          inset 0 0 0 1px rgba(182, 223, 255, 0.78),
          0 0 0 1px rgba(143, 202, 255, 0.44);
      }
      #musemark-quickdock .anqd-item img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        border-radius: inherit;
        opacity: 1;
      }
      #musemark-quickdock .anqd-fallback {
        width: 100%;
        height: 100%;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: inherit;
        font-size: 13px;
        font-weight: 600;
        color: rgba(170, 178, 193, 0.94);
        background: rgba(32, 37, 47, 0.78);
        box-shadow: inset 0 0 0 0.8px rgba(195, 203, 220, 0.16);
        opacity: 1;
      }
      #musemark-quickdock .anqd-slot {
        position: absolute;
        right: -8px;
        top: -8px;
        min-width: 24px;
        height: 24px;
        padding: 0 4px;
        border-radius: 999px;
        border: none;
        background: transparent;
        color: rgba(248, 250, 255, 0.92);
        font-size: 20px;
        line-height: 24px;
        text-align: center;
        opacity: 0;
        transition: none;
      }
      #musemark-quickdock .anqd-item.selected .anqd-slot {
        opacity: 1;
      }
      #musemark-quickdock .anqd-pinned {
        position: absolute;
        left: 50%;
        transform: translateX(-50%);
        bottom: 0;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: transparent;
        box-shadow:
          inset 0 0 0 1.2px rgba(255, 255, 255, 0.95),
          0 0 8px rgba(189, 231, 255, 0.36);
      }
      #musemark-quickdock .anqd-empty {
        width: 30px;
        min-height: 80px;
        border-radius: 10px;
        border: none;
        background: transparent;
        color: rgba(247, 249, 255, 0.8);
        font-size: 20px;
        line-height: 1.1;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        padding: 12px;
      }
      #musemark-quickdock .anqd-menu {
        position: fixed;
        z-index: 2147483646;
        min-width: 190px;
        border-radius: 10px;
        border: 1px solid rgba(170, 177, 191, 0.78);
        background: rgba(245, 247, 251, 0.98);
        box-shadow: 0 16px 36px rgba(14, 19, 30, 0.24);
        padding: 6px;
        display: none;
      }
      #musemark-quickdock .anqd-menu button {
        width: 100%;
        text-align: left;
        border: none;
        border-radius: 7px;
        background: transparent;
        color: #2f3a4f;
        font-size: 12px;
        padding: 7px;
        cursor: pointer;
      }
      #musemark-quickdock .anqd-menu button:hover {
        background: rgba(219, 225, 236, 0.88);
      }
      @media (max-width: 960px) {
        #musemark-quickdock.pos-right {
          right: 0;
        }
        #musemark-quickdock.pos-bottom {
          bottom: 12px;
          max-width: 94vw;
          gap: 10px;
        }
        #musemark-quickdock .anqd-hide,
        #musemark-quickdock .anqd-restore {
          width: 34px;
          height: 20px;
          border-radius: 8px;
        }
        #musemark-quickdock .anqd-hide::before,
        #musemark-quickdock .anqd-restore::before {
          left: 6px;
          right: 6px;
        }
        #musemark-quickdock .anqd-rail {
          width: 42px;
          border-radius: 0;
          padding: 0;
        }
        #musemark-quickdock.pos-bottom .anqd-rail {
          width: auto;
          max-width: calc(94vw - 46px);
        }
        #musemark-quickdock.pos-bottom .anqd-list {
          max-width: calc(94vw - 46px);
          gap: 18px;
        }
        #musemark-quickdock .anqd-item {
          width: 27px;
          height: 27px;
          border-radius: 9px;
        }
      }
    `;

    if (!existingStyle) {
      document.documentElement.appendChild(style);
    }
  }

  function renderDock(): void {
    if (!dockElements) {
      return;
    }

    dockElements.root.dataset.position = dockPosition;
    dockElements.root.classList.toggle("pos-right", dockPosition === "right");
    dockElements.root.classList.toggle("pos-bottom", dockPosition === "bottom_center");

    const isTransitioning =
      dockElements.root.classList.contains("is-opening") || dockElements.root.classList.contains("is-closing");
    if (!isTransitioning) {
      dockElements.root.classList.toggle("is-collapsed", dockMode === "collapsed");
    }
    renderDockEntries();
  }

  function renderDockEntries(): void {
    if (!dockElements) {
      return;
    }

    const list = dockElements.list;
    list.innerHTML = "";
    const visibleEntries = dockEntries.slice(0, 10);

    if (visibleEntries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "anqd-empty";
      empty.textContent = "No bookmarks";
      list.appendChild(empty);
      return;
    }

    visibleEntries.forEach((entry, index) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "anqd-item";
      row.dataset.entryId = entry.id;
      row.style.setProperty("--idx", String(index));
      if (index === dockFocusedIndex) {
        row.classList.add("selected");
      }
      const shortcut = getDockShortcutLabel(index);
      row.title = `${entry.title}\nShortcut: Ctrl+${shortcut}`;
      const isPinnedEntry = isPinnedDockEntry(entry);
      row.dataset.pinned = isPinnedEntry ? "true" : "false";

      if (entry.kind === "bookmark") {
        const candidates = buildFaviconCandidates({
          favIconUrl: entry.favIconUrl,
          url: entry.url,
          domain: entry.domain
        });
        const img = document.createElement("img");
        img.alt = entry.domain || entry.title;
        img.referrerPolicy = "no-referrer";

        let iconIndex = 0;
        let exhausted = false;
        img.src = candidates[iconIndex] ?? "";
        img.addEventListener("error", () => {
          if (exhausted) {
            return;
          }
          const next = nextCandidateOrFallback(candidates, iconIndex);
          if (next.exhausted || !next.nextSrc) {
            exhausted = true;
            img.remove();
            const fallback = document.createElement("div");
            fallback.className = "anqd-fallback";
            fallback.textContent = (entry.domain || entry.title || "?").slice(0, 1).toUpperCase();
            row.appendChild(fallback);
            return;
          }
          iconIndex = next.nextIndex;
          img.src = next.nextSrc;
        });
        row.appendChild(img);
      } else {
        const fallback = document.createElement("div");
        fallback.className = "anqd-fallback";
        fallback.textContent = (entry.domain || entry.title || "?").slice(0, 1).toUpperCase();
        row.appendChild(fallback);
      }

      const slot = document.createElement("span");
      slot.className = "anqd-slot";
      slot.textContent = shortcut;
      row.appendChild(slot);

      if (isPinnedEntry) {
        const pinned = document.createElement("span");
        pinned.className = "anqd-pinned";
        pinned.title = "Pinned";
        row.appendChild(pinned);
      }

      if (entry.kind === "bookmark") {
        row.addEventListener("contextmenu", (event) => {
          if (dockDraggingPinnedId) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          showDockContextMenu(entry, event.clientX, event.clientY);
        });
      }

      if (isPinnedEntry) {
        row.draggable = true;
        row.addEventListener("dragstart", (event) => {
          dockDraggingPinnedId = entry.id;
          dockDropTargetPinnedId = null;
          hideDockContextMenu();
          clearDockDropTargetStyles();
          row.classList.add("is-dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", entry.id);
          }
        });

        row.addEventListener("dragover", (event) => {
          if (!dockDraggingPinnedId || dockDraggingPinnedId === entry.id) {
            return;
          }
          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }
          if (dockDropTargetPinnedId === entry.id) {
            return;
          }
          dockDropTargetPinnedId = entry.id;
          clearDockDropTargetStyles();
          row.classList.add("is-drop-target");
        });

        row.addEventListener("drop", (event) => {
          if (!dockDraggingPinnedId || dockDraggingPinnedId === entry.id) {
            return;
          }
          event.preventDefault();
          const sourceId = dockDraggingPinnedId;
          dockClickSuppressedUntil = Date.now() + 350;
          void reorderPinnedDockEntries(sourceId, entry.id);
        });

        row.addEventListener("dragend", () => {
          cleanupDockDragState();
        });
      }

      row.addEventListener("click", () => {
        if (Date.now() < dockClickSuppressedUntil) {
          return;
        }
        dockFocusedIndex = index;
        renderDockEntries();
        void openDockEntry(entry);
      });

      list.appendChild(row);
    });
  }

  function isPinnedDockEntry(entry: DockEntry): boolean {
    return entry.kind === "bookmark" && (dockPinnedIds.has(entry.id) || Boolean(entry.pinned));
  }

  function clearDockDropTargetStyles(): void {
    if (!dockElements) {
      return;
    }
    dockElements.list.querySelectorAll(".anqd-item.is-drop-target").forEach((node) => {
      node.classList.remove("is-drop-target");
    });
  }

  function cleanupDockDragState(): void {
    if (!dockElements) {
      dockDraggingPinnedId = null;
      dockDropTargetPinnedId = null;
      return;
    }
    dockElements.list.querySelectorAll(".anqd-item.is-dragging, .anqd-item.is-drop-target").forEach((node) => {
      node.classList.remove("is-dragging", "is-drop-target");
    });
    dockDraggingPinnedId = null;
    dockDropTargetPinnedId = null;
  }

  function buildDockEntriesWithPinnedOrder(orderedPinnedIds: string[]): DockEntry[] {
    const orderedPinnedSet = new Set(orderedPinnedIds);
    const pinnedEntries = dockEntries.filter((entry) => {
      return (
        entry.kind === "bookmark" && (orderedPinnedSet.has(entry.id) || dockPinnedIds.has(entry.id) || Boolean(entry.pinned))
      );
    });
    const pinnedById = new Map(pinnedEntries.map((entry) => [entry.id, entry]));
    const orderedPinnedEntries: DockEntry[] = [];
    const seen = new Set<string>();

    for (const bookmarkId of orderedPinnedIds) {
      const item = pinnedById.get(bookmarkId);
      if (!item || seen.has(bookmarkId)) {
        continue;
      }
      seen.add(bookmarkId);
      orderedPinnedEntries.push(item);
    }

    for (const item of pinnedEntries) {
      if (seen.has(item.id)) {
        continue;
      }
      seen.add(item.id);
      orderedPinnedEntries.push(item);
    }

    let pinnedIndex = 0;
    return dockEntries.map((entry) => {
      if (entry.kind === "bookmark" && (orderedPinnedSet.has(entry.id) || dockPinnedIds.has(entry.id) || Boolean(entry.pinned))) {
        const next = orderedPinnedEntries[pinnedIndex];
        pinnedIndex += 1;
        return next ?? entry;
      }
      return entry;
    });
  }

  async function reorderPinnedDockEntries(sourceId: string, targetId: string): Promise<void> {
    const pinnedIds = dockEntries.filter(isPinnedDockEntry).map((entry) => entry.id);
    const sourceIndex = pinnedIds.indexOf(sourceId);
    const targetIndex = pinnedIds.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) {
      cleanupDockDragState();
      return;
    }

    const nextPinnedIds = [...pinnedIds];
    const [movingId] = nextPinnedIds.splice(sourceIndex, 1);
    nextPinnedIds.splice(targetIndex, 0, movingId);
    dockPinnedIds = new Set(nextPinnedIds);
    dockEntries = buildDockEntriesWithPinnedOrder(nextPinnedIds);
    cleanupDockDragState();
    renderDockEntries();

    try {
      const response = await sendRuntimeMessage<{ pinned: true; profileId: string; pinnedIds: string[] }>("quickDock/reorderPinned", {
        orderedIds: nextPinnedIds,
        profileId: dockActiveProfileId
      });
      if (Array.isArray(response.pinnedIds) && response.pinnedIds.length > 0) {
        dockPinnedIds = new Set(response.pinnedIds);
        dockEntries = buildDockEntriesWithPinnedOrder(response.pinnedIds);
        renderDockEntries();
      }
      await refreshQuickDock();
    } catch {
      await refreshQuickDock();
    }
  }

  async function setDockMode(mode: DockMode, persist: boolean): Promise<void> {
    hideDockContextMenu();

    if (dockTransitionLocked) {
      return;
    }

    const dock = ensureDock();
    const root = dock.root;
    const prevMode = dockMode;
    const visibleCount = Math.max(1, Math.min(dockEntries.length, 10));
    const transitionDuration = Math.min(360, Math.max(220, (visibleCount - 1) * DOCK_WATERFALL_STEP_MS + 72));

    if (dockTransitionTimer !== undefined) {
      window.clearTimeout(dockTransitionTimer);
      dockTransitionTimer = undefined;
    }

    if (prevMode === "collapsed" && mode === "expanded") {
      dockTransitionLocked = true;
      dockMode = "expanded";
      root.classList.remove("is-collapsed", "is-closing");
      root.classList.add("is-transitioning", "is-opening");
      renderDock();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          root.classList.remove("is-opening");
          dockTransitionTimer = window.setTimeout(() => {
            root.classList.remove("is-transitioning");
            dockTransitionLocked = false;
            dockTransitionTimer = undefined;
          }, transitionDuration);
        });
      });
    } else if (prevMode === "expanded" && mode === "collapsed") {
      dockTransitionLocked = true;
      dockMode = "expanded";
      root.classList.remove("is-opening", "is-collapsed", "is-closing");
      root.classList.add("is-transitioning");
      renderDock();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          root.classList.add("is-closing");
          dockTransitionTimer = window.setTimeout(() => {
            dockMode = "collapsed";
            root.classList.remove("is-closing", "is-transitioning");
            renderDock();
            dockTransitionLocked = false;
            dockTransitionTimer = undefined;
          }, transitionDuration);
        });
      });
    } else {
      dockMode = mode;
      root.classList.remove("is-opening", "is-closing", "is-transitioning");
      renderDock();
    }

    if (persist) {
      try {
        await sendRuntimeMessage<{ layout?: DockLayoutState }>("quickDock/updateLayout", {
          mode
        });
      } catch {
        return;
      }
    }
  }

  async function toggleDockByShortcut(): Promise<void> {
    if (!dockEnabled) {
      return;
    }
    await setDockMode(dockMode === "collapsed" ? "expanded" : "collapsed", true);
  }

  async function openDockEntry(entry: DockEntry): Promise<void> {
    try {
      await sendRuntimeMessage("quickDock/open", {
        id: entry.kind === "bookmark" ? entry.id : undefined,
        url: entry.url,
        action: entry.kind === "action" ? entry.action : undefined,
        source: "dock"
      });
      hideDockContextMenu();
      window.setTimeout(() => {
        void refreshQuickDock();
      }, 120);
    } catch {
      return;
    }
  }

  async function openLibraryFromDock(): Promise<void> {
    try {
      await sendRuntimeMessage("quickDock/open", {
        action: "open_library",
        source: "dock"
      });
    } catch {
      return;
    }
  }

  async function triggerSaveCurrentPage(): Promise<void> {
    try {
      await sendRuntimeMessage("quickDock/saveCurrent", {});
      window.setTimeout(() => {
        void refreshQuickDock();
      }, 250);
    } catch {
      return;
    }
  }

  function getDockShortcutLabel(index: number): string {
    if (index === 9) {
      return "0";
    }
    return String(index + 1);
  }

  function resolveDockShortcutIndex(event: KeyboardEvent): number | undefined {
    const code = event.code;
    if (code === "Digit0" || code === "Numpad0") {
      return 9;
    }
    const matched = code.match(/^(Digit|Numpad)([1-9])$/);
    if (matched?.[2]) {
      return Number(matched[2]) - 1;
    }
    return undefined;
  }

  function showDockContextMenu(entry: DockEntry, x: number, y: number): void {
    if (entry.kind !== "bookmark") {
      return;
    }
    const menu = ensureDockContextMenu();
    const isPinned = dockPinnedIds.has(entry.id) || Boolean(entry.pinned);
    menu.innerHTML = "";

    const pinButton = document.createElement("button");
    pinButton.type = "button";
    pinButton.textContent = isPinned ? "Unpin from Dock" : "Pin to Dock";
    pinButton.addEventListener("click", () => {
      void (async () => {
        try {
          await sendRuntimeMessage(isPinned ? "quickDock/unpin" : "quickDock/pin", {
            bookmarkId: entry.id
          });
          hideDockContextMenu();
          await refreshQuickDock();
        } catch {
          return;
        }
      })();
    });

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.textContent = "Remove from suggestions";
    dismissButton.addEventListener("click", () => {
      void (async () => {
        try {
          await sendRuntimeMessage("quickDock/dismiss", {
            bookmarkId: entry.id,
            days: 30
          });
          hideDockContextMenu();
          await refreshQuickDock();
        } catch {
          return;
        }
      })();
    });

    const openLibraryButton = document.createElement("button");
    openLibraryButton.type = "button";
    openLibraryButton.textContent = "Open in Library";
    openLibraryButton.addEventListener("click", () => {
      void openLibraryFromDock();
      hideDockContextMenu();
    });

    const saveCurrentButton = document.createElement("button");
    saveCurrentButton.type = "button";
    saveCurrentButton.textContent = "Save Current Page";
    saveCurrentButton.addEventListener("click", () => {
      void triggerSaveCurrentPage();
      hideDockContextMenu();
    });

    menu.appendChild(pinButton);
    menu.appendChild(dismissButton);
    menu.appendChild(saveCurrentButton);
    menu.appendChild(openLibraryButton);

    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - 210))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - 140))}px`;
    menu.style.display = "block";
  }

  function ensureDockContextMenu(): HTMLDivElement {
    if (dockContextMenu) {
      return dockContextMenu;
    }
    const root = ensureDock();
    const menu = document.createElement("div");
    menu.className = "anqd-menu";
    root.root.appendChild(menu);
    dockContextMenu = menu;
    return menu;
  }

  function hideDockContextMenu(): void {
    if (!dockContextMenu) {
      return;
    }
    dockContextMenu.style.display = "none";
  }

  function setDockSuppressedByOverlay(suppressed: boolean): void {
    dockSuppressedByOverlay = suppressed;
    if (!dockElements) {
      return;
    }
    dockElements.root.style.display = suppressed ? "none" : dockEnabled ? "block" : "none";
  }

  async function sendRuntimeMessage<TResponse = unknown>(type: string, payload?: unknown): Promise<TResponse> {
    const response = (await chrome.runtime.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type,
      payload
    })) as {
      ok?: boolean;
      data?: TResponse;
      error?: string;
    };

    if (!response?.ok) {
      throw new Error(response?.error || `Runtime message failed: ${type}`);
    }

    return response.data as TResponse;
  }

  function normalizeDockMode(mode: unknown): DockMode | undefined {
    if (mode === "collapsed") {
      return "collapsed";
    }
    if (mode === "expanded" || mode === "peek") {
      return "expanded";
    }
    return undefined;
  }

  function normalizeDockPosition(position: unknown): DockPosition | undefined {
    if (position === "bottom_center") {
      return "bottom_center";
    }
    if (position === "right") {
      return "right";
    }
    return undefined;
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    const tag = target.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return true;
    }
    return Boolean(target.closest("[contenteditable='true']"));
  }

  async function collectCapturePayload(sessionId: string, maxChars: number): Promise<{
    sessionId: string;
    url: string;
    canonicalUrl?: string;
    title: string;
    domain: string;
    favIconUrl?: string;
    selection: string;
    text: string;
    textDigest: string;
    textChars: number;
    captureMode: "readability" | "dom_text" | "selection_only";
    wasTruncated: boolean;
  }> {
    const title = document.title || location.hostname;
    const canonicalLink = document.querySelector("link[rel='canonical']") as HTMLLinkElement | null;
    const canonicalUrl = canonicalLink?.href || undefined;
    const favIconUrl = resolveBestFaviconUrl();

    const selection = window.getSelection()?.toString().trim() ?? "";
    const articleNode = document.querySelector("article, main");
    const articleText = articleNode?.textContent?.trim() ?? "";
    const bodyText = document.body?.innerText?.trim() ?? "";
    const primaryText = articleText || bodyText;
    const captureMode = selection && !primaryText ? "selection_only" : articleText ? "readability" : "dom_text";

    const rawText = selection ? `${selection}\n\n${primaryText}` : primaryText;
    const normalized = normalizeText(rawText);
    const wasTruncated = normalized.length > maxChars;
    const text = normalized.slice(0, maxChars);
    const digest = await sha256Hex(text || `${location.href}|${title}`);

    return {
      sessionId,
      url: location.href,
      canonicalUrl,
      title,
      domain: location.hostname,
      favIconUrl,
      selection,
      text,
      textDigest: digest,
      textChars: normalized.length,
      captureMode,
      wasTruncated
    };
  }

  function resolveBestFaviconUrl(): string | undefined {
    const links = Array.from(document.querySelectorAll("link[rel*='icon'], link[rel='apple-touch-icon']")) as HTMLLinkElement[];

    let bestUrl = "";
    let bestScore = -1;

    for (const link of links) {
      const href = toAbsoluteUrl(link.getAttribute("href"));
      if (!href || href.startsWith("data:")) {
        continue;
      }

      const rel = (link.rel || "").toLowerCase();
      const type = (link.type || "").toLowerCase();
      const sizeScore = parseIconSizeScore(link.sizes?.value);

      let score = sizeScore;
      if (rel.includes("icon")) {
        score += 40;
      }
      if (rel.includes("shortcut")) {
        score += 12;
      }
      if (rel.includes("apple-touch-icon")) {
        score += 20;
      }
      if (type.includes("svg")) {
        score += 18;
      }
      if (href.includes("favicon")) {
        score += 8;
      }

      if (score > bestScore) {
        bestScore = score;
        bestUrl = href;
      }
    }

    if (bestUrl) {
      return bestUrl;
    }

    try {
      return new URL("/favicon.ico", location.origin).toString();
    } catch {
      return undefined;
    }
  }

  function parseIconSizeScore(sizesValue?: string): number {
    const value = (sizesValue ?? "").trim().toLowerCase();
    if (!value || value === "any") {
      return 24;
    }

    let best = 0;
    for (const token of value.split(/\s+/)) {
      const matched = token.match(/^(\d+)x(\d+)$/);
      if (!matched) {
        continue;
      }
      const width = Number(matched[1]);
      const height = Number(matched[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        continue;
      }
      best = Math.max(best, Math.min(width, height));
    }

    if (best <= 0) {
      return 8;
    }
    return Math.min(96, best);
  }

  function toAbsoluteUrl(href: string | null): string {
    const value = (href ?? "").trim();
    if (!value) {
      return "";
    }
    try {
      return new URL(value, location.href).toString();
    } catch {
      return "";
    }
  }

  async function sha256Hex(input: string): Promise<string> {
    try {
      const data = new TextEncoder().encode(input);
      const digest = await crypto.subtle.digest("SHA-256", data);
      const bytes = Array.from(new Uint8Array(digest));
      return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch {
      return fallbackHash(input);
    }
  }

  function fallbackHash(input: string): string {
    let hash = 0;
    for (let index = 0; index < input.length; index += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(index);
      hash |= 0;
    }
    return `fallback_${Math.abs(hash)}`;
  }

  function normalizeText(text: string): string {
    return text.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function normalizeLabel(label: string): string {
    return label.trim().replace(/\s+/g, " ").slice(0, 40);
  }

  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error ?? "Unknown error");
  }
})();
