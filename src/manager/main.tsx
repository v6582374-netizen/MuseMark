import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { sendRuntimeMessage } from "../shared/runtime";
import type { AuthState, BookmarkItem, BookmarkStatus, CategoryRule, SearchTrace, SemanticSearchItem } from "../shared/types";
import "./styles.css";

type ScopeType = "inbox" | "library" | "trash";

type FacetEntry = {
  value: string;
  count: number;
};

type StatusFacet = {
  value: BookmarkStatus;
  count: number;
};

type BackfillResult = {
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
};

type FaviconBackfillResult = {
  scanned: number;
  updated: number;
};

type CommandAction = {
  id: string;
  label: string;
  run: () => Promise<void>;
};

type SemanticSearchResponse = {
  items: SemanticSearchItem[];
  fallback: boolean;
  explain: string;
  hints?: string[];
  mode?: "direct" | "clarify";
  confidence?: number;
  clarifyingQuestion?: string;
  clarifyOptions?: string[];
  sessionId?: string;
  trace?: SearchTrace;
};

const SCOPE_LABELS: Record<ScopeType, string> = {
  inbox: "Inbox",
  library: "Library",
  trash: "Trash"
};

function App() {
  const [scope, setScope] = useState<ScopeType>("library");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<BookmarkStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [items, setItems] = useState<SemanticSearchItem[]>([]);
  const [categories, setCategories] = useState<FacetEntry[]>([]);
  const [tags, setTags] = useState<FacetEntry[]>([]);
  const [statuses, setStatuses] = useState<StatusFacet[]>([]);
  const [categoryRules, setCategoryRules] = useState<CategoryRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [statusHint, setStatusHint] = useState("Ready");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [selectedBookmarkId, setSelectedBookmarkId] = useState<string | null>(null);
  const [showCategoryStudio, setShowCategoryStudio] = useState(false);
  const [ruleCanonical, setRuleCanonical] = useState("");
  const [ruleAliases, setRuleAliases] = useState("");
  const [authState, setAuthState] = useState<AuthState>({
    mode: "guest",
    syncStatus: "idle"
  });
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [authEmail, setAuthEmail] = useState("");
  const [migrationPromptOpen, setMigrationPromptOpen] = useState(false);
  const [quickDockPinnedIds, setQuickDockPinnedIds] = useState<string[]>([]);
  const [searchTrace, setSearchTrace] = useState<SearchTrace | null>(null);
  const [searchConfidence, setSearchConfidence] = useState<number | null>(null);
  const [clarifyPrompt, setClarifyPrompt] = useState("");
  const [clarifyOptions, setClarifyOptions] = useState<string[]>([]);
  const [clarifySessionId, setClarifySessionId] = useState<string | null>(null);

  const importInput = useRef<HTMLInputElement | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 260);
  const hasActiveSearch = debouncedQuery.length > 0;

  const selectedBookmark = useMemo(() => items.find((item) => item.id === selectedBookmarkId) ?? null, [items, selectedBookmarkId]);
  const quickRailItems = useMemo(() => {
    if (hasActiveSearch) {
      return items.slice(0, 20);
    }
    return items
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 20);
  }, [items, hasActiveSearch]);
  const compactItems = useMemo(() => {
    if (hasActiveSearch) {
      return items;
    }
    return items.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }, [items, hasActiveSearch]);
  const quickDockPinnedSet = useMemo(() => new Set(quickDockPinnedIds), [quickDockPinnedIds]);

  const commandActions = useMemo(() => {
    const topCategories = Array.from(
      new Set([
        ...categoryRules.map((rule) => rule.canonical),
        ...categories.map((entry) => entry.value),
        ...items.map((item) => item.category).filter((value): value is string => Boolean(value))
      ])
    ).slice(0, 12);

    return buildCommandActions({
      selectedBookmark,
      topCategories,
      scope,
      reload: reloadAll,
      moveToTrash: handleMoveToTrash,
      restore: handleRestore,
      deletePermanent: handleDeletePermanent,
      retryAi: handleRetryAi,
      addTag: handleAddTagWithPrompt,
      moveToCategory: handleMoveToCategory,
      emptyTrash: handleEmptyTrash,
      backfillEmbeddings: handleBackfillEmbeddings,
      backfillFavicons: handleBackfillFavicons
    });
  }, [selectedBookmark, categoryRules, categories, items, scope]);

  const filteredCommands = useMemo(() => {
    const search = paletteQuery.trim().toLowerCase();
    if (!search) {
      return commandActions;
    }
    return commandActions.filter((action) => action.label.toLowerCase().includes(search));
  }, [paletteQuery, commandActions]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    };

    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => {
    void refreshAuthState();
    void reloadQuickDockState();
  }, []);

  useEffect(() => {
    void reloadMeta();
  }, [scope]);

  useEffect(() => {
    void reloadItems();
  }, [scope, debouncedQuery, statusFilter, categoryFilter, tagFilter]);

  useEffect(() => {
    if (!selectedBookmarkId) {
      return;
    }
    if (!items.some((item) => item.id === selectedBookmarkId)) {
      setSelectedBookmarkId(null);
    }
  }, [items, selectedBookmarkId]);

  useEffect(() => {
    setMigrationPromptOpen(authState.mode === "authenticated" && Boolean(authState.needsMigration));
  }, [authState.mode, authState.needsMigration]);

  async function reloadMeta() {
    setError("");
    try {
      let facetResponse: { categories: FacetEntry[]; tags: FacetEntry[]; statuses: StatusFacet[] } | undefined;
      let rulesResponse: { items: CategoryRule[] } | undefined;

      try {
        facetResponse = await sendRuntimeMessage<{ categories: FacetEntry[]; tags: FacetEntry[]; statuses: StatusFacet[] }>("manager/facets", {
          scope
        });
      } catch (facetError) {
        if (!isUnknownMessageTypeError(facetError, "manager/facets")) {
          throw facetError;
        }
      }

      try {
        rulesResponse = await sendRuntimeMessage<{ items: CategoryRule[] }>("manager/categoryRules/list");
      } catch (rulesError) {
        if (!isUnknownMessageTypeError(rulesError, "manager/categoryRules/list")) {
          throw rulesError;
        }
        setStatusHint("检测到后台版本较旧：分类规则暂不可用，建议在扩展页点击“重新加载”");
      }

      if (!facetResponse) {
        const listFallback = await sendRuntimeMessage<{ items: BookmarkItem[] }>("manager/list", {
          scope,
          limit: 600
        });
        facetResponse = computeFallbackFacets(listFallback.items);
      }

      setCategories(facetResponse.categories);
      setTags(facetResponse.tags);
      setStatuses(facetResponse.statuses);
      setCategoryRules(rulesResponse?.items ?? []);
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    }
  }

  async function refreshAuthState() {
    try {
      const response = await sendRuntimeMessage<AuthState>("auth/getState");
      setAuthState(response);
    } catch (authError) {
      setError(toErrorMessage(authError));
    }
  }

  async function reloadQuickDockState() {
    try {
      const response = await sendRuntimeMessage<{ pinnedIds?: string[] }>("quickDock/getState", {
        currentUrl: ""
      });
      setQuickDockPinnedIds(Array.isArray(response.pinnedIds) ? response.pinnedIds : []);
    } catch (dockError) {
      if (!isUnknownMessageTypeError(dockError, "quickDock/getState")) {
        setError(toErrorMessage(dockError));
      }
      setQuickDockPinnedIds([]);
    }
  }

  function openOptionsPage() {
    const optionsUrl = chrome.runtime.getURL("options/index.html");
    window.open(optionsUrl, "_blank", "noopener,noreferrer");
  }

  async function handleSignInOAuth() {
    setAuthBusy(true);
    setError("");
    try {
      await sendRuntimeMessage<{ state: AuthState }>("auth/signInOAuth", { provider: "google" });
      await refreshAuthState();
      setAuthModalOpen(false);
      setStatusHint("Google 登录成功");
    } catch (loginError) {
      setError(toErrorMessage(loginError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSendMagicLink() {
    setAuthBusy(true);
    setError("");
    try {
      const result = await sendRuntimeMessage<{ sent: boolean; hint: string }>("auth/sendMagicLink", {
        email: authEmail
      });
      setStatusHint(result.hint);
    } catch (loginError) {
      setError(toErrorMessage(loginError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    setAuthBusy(true);
    setError("");
    try {
      await sendRuntimeMessage("auth/signOut");
      await refreshAuthState();
      setStatusHint("已退出登录，当前仍可继续本地使用。");
    } catch (signOutError) {
      setError(toErrorMessage(signOutError));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSyncNow() {
    setAuthBusy(true);
    setError("");
    try {
      const result = await sendRuntimeMessage<{ source: string; pushedBookmarks: number; pulledBookmarks: number; skipped: boolean }>(
        "auth/syncNow"
      );
      await refreshAuthState();
      if (result.skipped) {
        setStatusHint("同步已跳过：请先完成登录并在设置中启用 cloud sync。");
      } else {
        setStatusHint(`同步完成：推送 ${result.pushedBookmarks} 条，拉取 ${result.pulledBookmarks} 条`);
      }
      await reloadAll();
    } catch (syncError) {
      setError(toErrorMessage(syncError));
      await refreshAuthState();
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleMigrateNow() {
    setAuthBusy(true);
    setError("");
    try {
      const result = await sendRuntimeMessage<{ success: boolean; stats: Record<string, number> }>("auth/migrateLocalToCloud");
      setMigrationPromptOpen(false);
      await refreshAuthState();
      const marked = Number(result.stats.markedDirty ?? 0);
      setStatusHint(`迁移完成：已标记 ${marked} 条本地记录并同步到云端`);
      await reloadAll();
    } catch (migrationError) {
      setError(toErrorMessage(migrationError));
      await refreshAuthState();
    } finally {
      setAuthBusy(false);
    }
  }

  async function reloadItems(input?: { clarificationAnswer?: string; sessionId?: string; queryOverride?: string }) {
    setLoading(true);
    setError("");
    const searchQuery = (input?.queryOverride ?? debouncedQuery).trim();

    try {
      if (searchQuery) {
        try {
          const response = await sendRuntimeMessage<SemanticSearchResponse>("manager/searchSemantic", {
            query: searchQuery,
            scope,
            limit: 120,
            clarificationAnswer: input?.clarificationAnswer,
            sessionId: input?.sessionId
          });

          const filtered = applyClientFilters(response.items, statusFilter, categoryFilter, tagFilter);
          setItems(filtered);
          setSearchTrace(response.trace ?? null);
          setSearchConfidence(typeof response.confidence === "number" ? response.confidence : null);
          const hintText = (response.hints ?? []).join(" | ");
          const filterText = summarizeClientFilters(statusFilter, categoryFilter, tagFilter);
          if (response.mode === "clarify" && response.clarifyingQuestion) {
            setClarifyPrompt(response.clarifyingQuestion);
            setClarifyOptions(response.clarifyOptions ?? []);
            setClarifySessionId(response.sessionId ?? null);
            setStatusHint(
              `Low confidence (${(response.confidence ?? 0).toFixed(2)}), clarify intent first${hintText ? ` | ${hintText}` : ""}${
                filterText ? ` | ${filterText}` : ""
              }`
            );
          } else {
            setClarifyPrompt("");
            setClarifyOptions([]);
            setClarifySessionId(null);
            if (response.fallback) {
              setStatusHint(
                `Fallback mode: ${response.explain}${hintText ? ` | ${hintText}` : ""}${filterText ? ` | ${filterText}` : ""}`
              );
            } else {
              setStatusHint(`Semantic search active${hintText ? ` | ${hintText}` : ""}${filterText ? ` | ${filterText}` : ""}`);
            }
          }
        } catch (semanticError) {
          if (!isUnknownMessageTypeError(semanticError, "manager/searchSemantic")) {
            throw semanticError;
          }
          const response = await sendRuntimeMessage<{ items: BookmarkItem[] }>("manager/list", {
            scope,
            search: searchQuery,
            status: statusFilter,
            category: categoryFilter || undefined,
            tag: tagFilter || undefined,
            limit: 240
          });
          const mapped = response.items.map((item) => ({
            ...item,
            whyMatched: "",
            searchSignals: item.searchSignals ?? {}
          }));
          setItems(mapped);
          setSearchTrace(null);
          setSearchConfidence(null);
          setClarifyPrompt("");
          setClarifyOptions([]);
          setClarifySessionId(null);
          setStatusHint("语义搜索接口不可用，已自动降级到本地检索（建议重载扩展）");
        }
      } else {
        const response = await sendRuntimeMessage<{ items: BookmarkItem[] }>("manager/list", {
          scope,
          status: statusFilter,
          category: categoryFilter || undefined,
          tag: tagFilter || undefined,
          limit: 240
        });

        const mapped = response.items.map((item) => ({
          ...item,
          whyMatched: "",
          searchSignals: item.searchSignals ?? {}
        }));

        setItems(mapped);
        setSearchTrace(null);
        setSearchConfidence(null);
        setClarifyPrompt("");
        setClarifyOptions([]);
        setClarifySessionId(null);
        setStatusHint("Ready");
      }
    } catch (loadError) {
      setError(toErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function reloadAll() {
    await Promise.all([reloadMeta(), reloadItems(), refreshAuthState(), reloadQuickDockState()]);
  }

  async function handlePinToDock(itemId: string) {
    await sendRuntimeMessage("quickDock/pin", { bookmarkId: itemId });
    await reloadQuickDockState();
    setStatusHint("Pinned to QuickDock");
  }

  async function handleUnpinFromDock(itemId: string) {
    await sendRuntimeMessage("quickDock/unpin", { bookmarkId: itemId });
    await reloadQuickDockState();
    setStatusHint("Removed from QuickDock");
  }

  async function handleSearchSubmit() {
    await reloadItems({ queryOverride: query.trim() });
  }

  async function handleSearchBack() {
    setQuery("");
    await reloadItems({ queryOverride: "" });
  }

  async function handleSave(
    item: BookmarkItem,
    draft: { category?: string; tags: string[]; userNote: string; pinned: boolean; locked: boolean }
  ) {
    await sendRuntimeMessage("manager/update", {
      id: item.id,
      category: draft.category,
      tags: draft.tags,
      userNote: draft.userNote,
      pinned: draft.pinned,
      locked: draft.locked
    });
    await reloadAll();
  }

  async function handleMoveToTrash(itemId: string) {
    try {
      await sendRuntimeMessage("manager/trash", { id: itemId });
    } catch (trashError) {
      if (!isUnknownMessageTypeError(trashError, "manager/trash")) {
        throw trashError;
      }
      await sendRuntimeMessage("manager/update", {
        id: itemId,
        status: "trashed"
      });
      setStatusHint("已通过兼容模式移入 Trash（建议重载扩展启用完整能力）");
    }
    await reloadAll();
  }

  async function handleRestore(itemId: string) {
    try {
      await sendRuntimeMessage("manager/restore", { id: itemId });
    } catch (restoreError) {
      if (!isUnknownMessageTypeError(restoreError, "manager/restore")) {
        throw restoreError;
      }
      const current = items.find((item) => item.id === itemId);
      const fallbackStatus: BookmarkStatus =
        current && ((current.category && current.category.trim()) || (current.tags && current.tags.length > 0)) ? "classified" : "inbox";
      await sendRuntimeMessage("manager/update", {
        id: itemId,
        status: fallbackStatus
      });
      setStatusHint("已通过兼容模式恢复书签（建议重载扩展启用完整能力）");
    }
    await reloadAll();
  }

  async function handleDeletePermanent(itemId: string) {
    const ok = window.confirm("Delete this bookmark permanently?");
    if (!ok) {
      return;
    }

    try {
      await sendRuntimeMessage("manager/deletePermanent", { id: itemId });
    } catch (deleteError) {
      if (!isUnknownMessageTypeError(deleteError, "manager/deletePermanent")) {
        throw deleteError;
      }
      setStatusHint("当前后台不支持永久删除，请先重载扩展；已保留在 Trash");
      await handleMoveToTrash(itemId);
      return;
    }
    await reloadAll();
  }

  async function handleEmptyTrash() {
    const ok = window.confirm("Empty Trash permanently?");
    if (!ok) {
      return;
    }

    try {
      await sendRuntimeMessage<{ deletedCount: number }>("manager/emptyTrash", { olderThanDays: 0 });
    } catch (emptyError) {
      if (!isUnknownMessageTypeError(emptyError, "manager/emptyTrash")) {
        throw emptyError;
      }
      setStatusHint("当前后台不支持 Empty Trash，请先重载扩展");
      return;
    }
    await reloadAll();
  }

  async function handleRetryAi(itemId: string) {
    await sendRuntimeMessage("manager/retryAi", { id: itemId });
    await reloadAll();
  }

  async function handleMoveToCategory(itemId: string, category?: string) {
    await sendRuntimeMessage("manager/update", {
      id: itemId,
      category,
      status: category ? "classified" : "inbox"
    });
    await reloadAll();
  }

  async function handleAddTagWithPrompt(itemId: string) {
    const selected = items.find((item) => item.id === itemId);
    if (!selected) {
      return;
    }

    const raw = window.prompt("Tag name", "");
    const normalized = raw?.trim() ?? "";
    if (!normalized) {
      return;
    }

    const merged = Array.from(new Set([...(selected.tags ?? []), normalized]));
    await sendRuntimeMessage("manager/update", {
      id: itemId,
      tags: merged
    });
    await reloadAll();
  }

  async function handleBackfillEmbeddings() {
    try {
      const result = await sendRuntimeMessage<BackfillResult>("manager/backfillEmbeddings", {
        limit: 220,
        delayMs: 1200
      });
      setStatusHint(`Backfill done: processed ${result.processed}, updated ${result.updated}, failed ${result.failed}`);
      await reloadItems();
    } catch (backfillError) {
      if (!isUnknownMessageTypeError(backfillError, "manager/backfillEmbeddings")) {
        throw backfillError;
      }
      setStatusHint("当前后台不支持 embedding 回填，请先重载扩展");
    }
  }

  async function handleBackfillFavicons() {
    try {
      const result = await sendRuntimeMessage<FaviconBackfillResult>("manager/backfillFavicons", {
        limit: 600
      });
      setStatusHint(`Favicon backfill done: scanned ${result.scanned}, updated ${result.updated}`);
      await reloadItems();
    } catch (faviconError) {
      if (!isUnknownMessageTypeError(faviconError, "manager/backfillFavicons")) {
        throw faviconError;
      }
      setStatusHint("当前后台不支持 favicon 回填，请先重载扩展");
    }
  }

  async function handleExport() {
    const response = await sendRuntimeMessage<{ items: BookmarkItem[]; categoryRules?: CategoryRule[] }>("manager/export");
    const blob = new Blob([
      JSON.stringify(
        {
          items: response.items,
          categoryRules: response.categoryRules ?? []
        },
        null,
        2
      )
    ]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `musemark-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(event: Event) {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) {
      return;
    }

    const text = await file.text();
    const parsed = JSON.parse(text) as { items?: BookmarkItem[]; categoryRules?: CategoryRule[] } | BookmarkItem[];

    const payload = Array.isArray(parsed)
      ? {
          items: parsed,
          categoryRules: []
        }
      : {
          items: parsed.items ?? [],
          categoryRules: parsed.categoryRules ?? []
        };

    await sendRuntimeMessage("manager/import", payload);
    target.value = "";
    await reloadAll();
  }

  async function handleCreateRule() {
    if (!ruleCanonical.trim()) {
      return;
    }

    const aliases = ruleAliases
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);

    await sendRuntimeMessage("manager/categoryRules/upsert", {
      canonical: ruleCanonical,
      aliases
    });

    setRuleCanonical("");
    setRuleAliases("");
    await reloadMeta();
  }

  async function handleDeleteRule(rule: CategoryRule) {
    const reassignTo = window.prompt("Optional: reassign this category to another canonical name", "") ?? "";
    await sendRuntimeMessage("manager/categoryRules/delete", {
      id: rule.id,
      reassignTo: reassignTo.trim() || undefined
    });
    await reloadAll();
  }

  async function executeCommand(action: CommandAction) {
    setPaletteOpen(false);
    setPaletteQuery("");
    try {
      await action.run();
    } catch (commandError) {
      setError(toErrorMessage(commandError));
    }
  }

  const topCategorySuggestions = useMemo(() => {
    return Array.from(new Set([...categoryRules.map((rule) => rule.canonical), ...categories.map((entry) => entry.value)])).slice(0, 8);
  }, [categoryRules, categories]);

  const dashboardStats = useMemo(() => {
    const total = statuses.reduce((sum, entry) => sum + entry.count, 0);
    const classified = statuses.find((entry) => entry.value === "classified")?.count ?? 0;
    const inbox = statuses.find((entry) => entry.value === "inbox")?.count ?? 0;
    const analyzing = statuses.find((entry) => entry.value === "analyzing")?.count ?? 0;
    const trash = statuses.find((entry) => entry.value === "trashed")?.count ?? 0;
    return {
      total,
      classified,
      active: inbox + analyzing,
      trash
    };
  }, [statuses]);
  const canReturnFromSearch = query.trim().length > 0 || hasActiveSearch;

  return (
    <div class="shell">
      <header class="topbar">
        <div class="title-row">
          <div>
            <h1>MuseMark</h1>
            <p>AI associative retrieval and full lifecycle CRUD.</p>
          </div>

          <div class="top-actions">
            <div class="auth-summary">
              <span class={`sync-dot ${authState.syncStatus || "idle"}`} />
              {authState.mode === "authenticated" ? (
                <span>{authState.user?.email}</span>
              ) : (
                <span>Guest mode</span>
              )}
            </div>
            <button class="btn" onClick={() => setAuthModalOpen(true)}>
              {authState.mode === "authenticated" ? "Account" : "Sign In"}
            </button>
            <button class="btn" disabled={authBusy} onClick={() => void handleSyncNow()}>
              Sync now
            </button>
          </div>
        </div>

        <div class="scope-switch">
          {(Object.keys(SCOPE_LABELS) as ScopeType[]).map((value) => (
            <button key={value} class={`scope-pill ${scope === value ? "active" : ""}`} onClick={() => setScope(value)}>
              {SCOPE_LABELS[value]}
            </button>
          ))}
        </div>

        <div class="search-row">
          <div class="search-shell">
            <input
              value={query}
              onInput={(event) => setQuery((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleSearchSubmit();
                }
              }}
              placeholder="Ask naturally: the AI agents benchmark article I saw last week"
            />
          </div>
          <button class="btn" onClick={() => void handleSearchSubmit()}>
            Search
          </button>
          <button class="btn" onClick={() => void handleSearchBack()} disabled={!canReturnFromSearch}>
            Back
          </button>
          <button class="btn" onClick={() => setPaletteOpen(true)}>
            Cmd/Ctrl+K
          </button>
        </div>

        <button class="btn primary dock-control-jump-btn" onClick={openOptionsPage}>
          Open Dock Control
        </button>

        <div class="toolbar">
          <button class="btn primary" onClick={() => void reloadAll()}>
            Refresh
          </button>
          {authState.mode === "authenticated" && (
            <button class="btn" disabled={authBusy} onClick={() => void handleMigrateNow()}>
              Migrate local to cloud
            </button>
          )}
          <button class="btn" onClick={() => void handleBackfillEmbeddings()}>
            Backfill embeddings
          </button>
          <button class="btn" onClick={() => void handleBackfillFavicons()}>
            Backfill favicons
          </button>
          <button class="btn" onClick={() => void handleExport()}>
            Export
          </button>
          <button class="btn" onClick={() => setShowCategoryStudio((current) => !current)}>
            {showCategoryStudio ? "Hide Category Studio" : "Category Studio"}
          </button>
          <button class="btn" onClick={() => importInput.current?.click()}>
            Import
          </button>
          {scope === "trash" && (
            <button class="btn danger" onClick={() => void handleEmptyTrash()}>
              Empty Trash
            </button>
          )}
          <input ref={importInput} type="file" accept="application/json" class="hidden" onChange={(event) => void handleImport(event)} />
        </div>

        <div class="metric-row">
          <div class="metric-pill">
            <span>Total</span>
            <strong>{dashboardStats.total}</strong>
          </div>
          <div class="metric-pill">
            <span>Classified</span>
            <strong>{dashboardStats.classified}</strong>
          </div>
          <div class="metric-pill">
            <span>Active Queue</span>
            <strong>{dashboardStats.active}</strong>
          </div>
          <div class="metric-pill">
            <span>Trash</span>
            <strong>{dashboardStats.trash}</strong>
          </div>
        </div>

        <div class="chip-row">
          <span class="chip-label">Status</span>
          <button class={`chip ${statusFilter === "all" ? "active" : ""}`} onClick={() => setStatusFilter("all")}>All</button>
          {statuses.map((entry) => (
            <button
              key={entry.value}
              class={`chip ${statusFilter === entry.value ? "active" : ""}`}
              onClick={() => setStatusFilter(entry.value)}
            >
              {entry.value} ({entry.count})
            </button>
          ))}
        </div>

        <div class="chip-row">
          <span class="chip-label">Category</span>
          <button class={`chip ${!categoryFilter ? "active" : ""}`} onClick={() => setCategoryFilter("")}>Any</button>
          {categories.slice(0, 10).map((entry) => (
            <button
              key={entry.value}
              class={`chip ${categoryFilter === entry.value ? "active" : ""}`}
              onClick={() => setCategoryFilter(entry.value)}
            >
              {entry.value} ({entry.count})
            </button>
          ))}
        </div>

        <div class="chip-row">
          <span class="chip-label">Tag</span>
          <button class={`chip ${!tagFilter ? "active" : ""}`} onClick={() => setTagFilter("")}>Any</button>
          {tags.slice(0, 12).map((entry) => (
            <button key={entry.value} class={`chip ${tagFilter === entry.value ? "active" : ""}`} onClick={() => setTagFilter(entry.value)}>
              {entry.value} ({entry.count})
            </button>
          ))}
        </div>
      </header>

      {authState.mode === "guest" && (
        <section class="guest-banner">
          登录后可开启跨设备同步（书签 + 设置），不登录也可继续本地使用。
          <button class="btn primary" onClick={() => setAuthModalOpen(true)}>
            立即登录
          </button>
        </section>
      )}

      {migrationPromptOpen && authState.mode === "authenticated" && (
        <section class="migration-banner">
          <span>检测到你首次登录此账号，建议立即执行“一键迁移并合并本地数据”。</span>
          <div class="migration-actions">
            <button class="btn primary" disabled={authBusy} onClick={() => void handleMigrateNow()}>
              Start Migration
            </button>
            <button class="btn" onClick={() => setMigrationPromptOpen(false)}>
              Later
            </button>
          </div>
        </section>
      )}

      <section class="status-line">{statusHint}</section>

      {clarifyPrompt && clarifyOptions.length > 0 && (
        <section class="clarify-box">
          <strong>{clarifyPrompt}</strong>
          <div class="clarify-actions">
            {clarifyOptions.map((option) => (
              <button
                key={option}
                class="chip"
                onClick={() =>
                  void reloadItems({
                    clarificationAnswer: option,
                    sessionId: clarifySessionId ?? undefined
                  })
                }
              >
                {option}
              </button>
            ))}
          </div>
        </section>
      )}

      {searchTrace && (
        <section class="trace-box">
          <div class="trace-head">
            <strong>Search Trace</strong>
            <span class="muted">Confidence: {searchConfidence !== null ? searchConfidence.toFixed(2) : "-"}</span>
          </div>
          <div class="trace-meta">
            <span>Intent: {searchTrace.intentType}</span>
            <span>Web: {searchTrace.webUsed ? "on" : "off"}</span>
            <span>Reason: {searchTrace.decisionReason}</span>
          </div>
          <div class="trace-meta">
            <span>Query: {searchTrace.effectiveQuery || "-"}</span>
            <span>Web note: {searchTrace.webReason || "-"}</span>
          </div>
          {searchTrace.expandedTerms.length > 0 && (
            <div class="trace-meta">
              <span>Expanded: {searchTrace.expandedTerms.join(", ")}</span>
            </div>
          )}
          {searchTrace.scoreBreakdown.slice(0, 3).map((entry) => (
            <div class="trace-row" key={entry.bookmarkId}>
              <span>{entry.title}</span>
              <span>
                F {entry.finalScore.toFixed(3)} | L {entry.lexicalScore.toFixed(2)} | S {entry.semanticScore.toFixed(2)} | T{" "}
                {entry.taxonomyScore.toFixed(2)}
              </span>
            </div>
          ))}
        </section>
      )}

      {error && <section class="error-box">{error}</section>}
      {loading && <section class="empty">Loading bookmarks...</section>}
      {!loading && items.length === 0 && <section class="empty">No bookmarks for current filters.</section>}

      <main class={`layout ${showCategoryStudio ? "with-studio" : "single-panel"}`}>
        {showCategoryStudio && (
          <aside class="rules-panel">
          <h2>Category Rules</h2>
          <p>Canonical categories keep your taxonomy stable while AI classifies at scale.</p>

          <div class="rule-form">
            <input value={ruleCanonical} onInput={(event) => setRuleCanonical((event.currentTarget as HTMLInputElement).value)} placeholder="Canonical category" />
            <input
              value={ruleAliases}
              onInput={(event) => setRuleAliases((event.currentTarget as HTMLInputElement).value)}
              placeholder="Aliases, comma separated"
            />
            <button class="btn primary" onClick={() => void handleCreateRule()}>
              Add / Merge Rule
            </button>
          </div>

          <div class="rule-list">
            {categoryRules.length === 0 && <div class="muted">No rules yet.</div>}
            {categoryRules.map((rule) => (
              <article class="rule-card" key={rule.id}>
                <div class="rule-title-row">
                  <strong>{rule.canonical}</strong>
                </div>
                <div class="rule-alias-row">
                  {rule.aliases.length === 0 ? <span class="muted">No aliases</span> : rule.aliases.map((alias) => <span class="tag" key={alias}>{alias}</span>)}
                </div>
                <button class="btn danger" onClick={() => void handleDeleteRule(rule)}>
                  Delete Rule
                </button>
              </article>
            ))}
          </div>
          </aside>
        )}

        <section class="content-panel">
          <div class="compact-home">
            <div class="bookmark-rail">
              {quickRailItems.map((item) => (
                <button key={item.id} class="rail-item" onClick={() => setSelectedBookmarkId(item.id)} title={item.title}>
                  <FaviconBadge item={item} />
                  <span>{item.title}</span>
                </button>
              ))}
            </div>

            <div class="compact-list">
              {compactItems.map((item) => (
                <CompactBookmarkRow
                  key={item.id}
                  item={item}
                  onOpenDetails={() => setSelectedBookmarkId(item.id)}
                />
              ))}
            </div>
          </div>
        </section>
      </main>

      {selectedBookmark && (
        <div class="detail-overlay" onClick={() => setSelectedBookmarkId(null)}>
          <aside class="detail-drawer" onClick={(event) => event.stopPropagation()}>
            <div class="detail-head">
              <div>
                <h3>Bookmark Details</h3>
                <p>Edit category, tags, note and lifecycle actions here.</p>
              </div>
              <button class="btn" onClick={() => setSelectedBookmarkId(null)}>
                Close
              </button>
            </div>
            <BookmarkCard
              key={selectedBookmark.id}
              item={selectedBookmark}
              dockPinned={quickDockPinnedSet.has(selectedBookmark.id)}
              scope={scope}
              categorySuggestions={topCategorySuggestions}
              tagSuggestions={tags.slice(0, 12).map((entry) => entry.value)}
              onSelect={() => undefined}
              variant="detail"
              onSave={handleSave}
              onMoveToTrash={handleMoveToTrash}
              onRestore={handleRestore}
              onDeletePermanent={handleDeletePermanent}
              onRetryAi={handleRetryAi}
              onMoveToCategory={handleMoveToCategory}
              onPinToDock={handlePinToDock}
              onUnpinFromDock={handleUnpinFromDock}
            />
          </aside>
        </div>
      )}

      {authModalOpen && (
        <div class="auth-overlay" onClick={() => setAuthModalOpen(false)}>
          <section class="auth-modal" onClick={(event) => event.stopPropagation()}>
            <div class="auth-head">
              <h3>{authState.mode === "authenticated" ? "Account" : "Sign in to MuseMark"}</h3>
              <button class="btn" onClick={() => setAuthModalOpen(false)}>
                Close
              </button>
            </div>

            {authState.mode === "authenticated" ? (
              <div class="auth-user">
                <p>{authState.user?.email}</p>
                <p class="muted">Sync status: {authState.syncStatus || "idle"}</p>
                {authState.lastSyncAt && <p class="muted">Last sync: {formatDate(authState.lastSyncAt)}</p>}
                {authState.lastError && <p class="error-inline">{authState.lastError}</p>}
                <div class="auth-actions">
                  <button class="btn" disabled={authBusy} onClick={() => void handleSyncNow()}>
                    Sync now
                  </button>
                  <button class="btn danger" disabled={authBusy} onClick={() => void handleSignOut()}>
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <div class="auth-login-panel">
                <button class="btn primary wide" disabled={authBusy} onClick={() => void handleSignInOAuth()}>
                  Continue with Google
                </button>
                <div class="auth-divider">or</div>
                <div class="auth-email-row">
                  <input
                    type="email"
                    value={authEmail}
                    onInput={(event) => setAuthEmail((event.currentTarget as HTMLInputElement).value)}
                    placeholder="you@example.com"
                  />
                  <button class="btn" disabled={authBusy} onClick={() => void handleSendMagicLink()}>
                    Send Magic Link
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {paletteOpen && (
        <div class="palette-overlay" onClick={() => setPaletteOpen(false)}>
          <section class="palette" onClick={(event) => event.stopPropagation()}>
            <input
              class="palette-input"
              value={paletteQuery}
              onInput={(event) => setPaletteQuery((event.currentTarget as HTMLInputElement).value)}
              placeholder="Run command..."
              autofocus
            />
            <div class="palette-list">
              {filteredCommands.length === 0 && <div class="muted">No command matches.</div>}
              {filteredCommands.map((action) => (
                <button key={action.id} class="palette-item" onClick={() => void executeCommand(action)}>
                  {action.label}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function CompactBookmarkRow(props: {
  item: SemanticSearchItem;
  onOpenDetails: () => void;
}) {
  const { item, onOpenDetails } = props;
  const categoryText = item.category || "Uncategorized";
  const firstTags = (item.tags ?? []).slice(0, 2);

  return (
    <article class={`compact-row ${item.status}`} onClick={onOpenDetails}>
      <div class="compact-main">
        <div class="compact-title-row">
          <FaviconBadge item={item} />
          <div class="compact-title-group">
            <strong>{item.title}</strong>
            <span>{item.domain}</span>
          </div>
        </div>
        <div class="compact-meta-row">
          <span class={`status-pill ${item.status}`}>{item.status}</span>
          <span class="compact-pill">{categoryText}</span>
          {firstTags.map((tag) => (
            <span class="compact-pill muted" key={tag}>
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div class="compact-actions">
        <a
          class="btn"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          Open
        </a>
        <button
          class="btn primary"
          onClick={(event) => {
            event.stopPropagation();
            onOpenDetails();
          }}
        >
          Details
        </button>
      </div>
    </article>
  );
}

function FaviconBadge(props: {
  item: SemanticSearchItem;
}) {
  const { item } = props;
  const candidates = useMemo(() => buildFaviconCandidates(item), [item.favIconUrl, item.url, item.domain]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentSrc = candidates[currentIndex];

  useEffect(() => {
    setCurrentIndex(0);
  }, [candidates.join("|")]);

  const fallback = (item.domain || item.title || "?").trim().charAt(0).toUpperCase() || "?";
  if (currentSrc) {
    return (
      <img
        class="favicon-badge"
        src={currentSrc}
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        onError={() => {
          setCurrentIndex((index) => {
            if (index + 1 < candidates.length) {
              return index + 1;
            }
            return index;
          });
        }}
      />
    );
  }
  return <span class="favicon-badge fallback">{fallback}</span>;
}

function buildFaviconCandidates(item: { favIconUrl?: string; url: string; domain: string }): string[] {
  const list: string[] = [];

  if (item.favIconUrl) {
    list.push(item.favIconUrl);
  }

  try {
    const parsed = new URL(item.url);
    list.push(new URL("/favicon.ico", parsed.origin).toString());
    list.push(`https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(parsed.origin)}`);
    list.push(`https://icons.duckduckgo.com/ip3/${parsed.hostname}.ico`);
  } catch {
    const safeDomain = (item.domain ?? "").trim();
    if (safeDomain) {
      list.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(safeDomain)}`);
      list.push(`https://icons.duckduckgo.com/ip3/${safeDomain}.ico`);
    }
  }

  const unique = new Set<string>();
  for (const candidate of list) {
    const value = (candidate ?? "").trim();
    if (!value) {
      continue;
    }
    unique.add(value);
  }

  return Array.from(unique);
}

function BookmarkCard(props: {
  item: SemanticSearchItem;
  dockPinned: boolean;
  scope: ScopeType;
  variant?: "feed" | "detail";
  categorySuggestions: string[];
  tagSuggestions: string[];
  onSelect: () => void;
  onSave: (
    item: BookmarkItem,
    draft: { category?: string; tags: string[]; userNote: string; pinned: boolean; locked: boolean }
  ) => Promise<void>;
  onMoveToTrash: (id: string) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
  onDeletePermanent: (id: string) => Promise<void>;
  onRetryAi: (id: string) => Promise<void>;
  onMoveToCategory: (id: string, category?: string) => Promise<void>;
  onPinToDock: (id: string) => Promise<void>;
  onUnpinFromDock: (id: string) => Promise<void>;
}) {
  const {
    item,
    dockPinned,
    scope,
    variant = "feed",
    categorySuggestions,
    tagSuggestions,
    onSelect,
    onSave,
    onMoveToTrash,
    onRestore,
    onDeletePermanent,
    onRetryAi,
    onMoveToCategory,
    onPinToDock,
    onUnpinFromDock
  } = props;

  const [userNote, setUserNote] = useState(item.userNote ?? "");
  const [tags, setTags] = useState<string[]>(item.tags ?? []);
  const [newTag, setNewTag] = useState("");
  const [pinned, setPinned] = useState(Boolean(item.pinned));
  const [locked, setLocked] = useState(Boolean(item.locked));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setUserNote(item.userNote ?? "");
    setTags(item.tags ?? []);
    setPinned(Boolean(item.pinned));
    setLocked(Boolean(item.locked));
    setNewTag("");
  }, [item.id, item.userNote, item.tags.join(","), item.pinned, item.locked]);

  async function saveCard(categoryOverride?: string) {
    setSaving(true);
    setError("");
    try {
      await onSave(item, {
        category: categoryOverride ?? item.category,
        tags,
        userNote,
        pinned,
        locked
      });
    } catch (saveError) {
      setError(toErrorMessage(saveError));
    } finally {
      setSaving(false);
    }
  }

  function removeTag(tag: string) {
    setTags((current) => current.filter((entry) => entry !== tag));
  }

  function addTag(tag: string) {
    const normalized = tag.trim();
    if (!normalized) {
      return;
    }
    setTags((current) => {
      if (current.includes(normalized)) {
        return current;
      }
      return [...current, normalized].slice(0, 24);
    });
    setNewTag("");
  }

  const quickCategoryCandidates = [
    "Uncategorized",
    ...categorySuggestions.filter((value) => value && value !== item.category)
  ].slice(0, 6);
  const hasSearchSignals =
    Number(item.searchSignals?.lexicalScore ?? 0) > 0 ||
    Number(item.searchSignals?.semanticScore ?? 0) > 0 ||
    Number(item.searchSignals?.taxonomyScore ?? 0) > 0 ||
    Number(item.searchSignals?.recencyScore ?? 0) > 0;

  return (
    <article
      class={`bookmark-card ${item.status} ${variant}`}
      draggable={variant !== "detail" && scope !== "trash"}
      onDragStart={(event) => event.dataTransfer?.setData("text/musemark-bookmark-id", item.id)}
      onClick={() => {
        if (variant !== "detail") {
          onSelect();
        }
      }}
    >
      <div class="card-head">
        <h4>
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        </h4>
        <span class={`status-pill ${item.status}`}>{item.status}</span>
      </div>

      <div class="meta-row">{item.domain} | updated {formatDate(item.updatedAt)} | saves {item.saveCount}</div>
      <div class="flag-row">
        <button class={`chip ${pinned ? "active" : ""}`} onClick={() => setPinned((current) => !current)}>
          {pinned ? "Pinned" : "Pin"}
        </button>
        <button class={`chip ${locked ? "active" : ""}`} onClick={() => setLocked((current) => !current)}>
          {locked ? "Locked" : "Lock"}
        </button>
      </div>

      {item.aiSummary && <div class="summary">{item.aiSummary}</div>}
      {item.whyMatched && <div class="match-note">Why matched: {item.whyMatched}</div>}
      {hasSearchSignals && (
        <div class="score-note">
          Scores: L {Number(item.searchSignals.lexicalScore ?? 0).toFixed(2)} | S {Number(item.searchSignals.semanticScore ?? 0).toFixed(2)} | T{" "}
          {Number(item.searchSignals.taxonomyScore ?? 0).toFixed(2)} | R {Number(item.searchSignals.recencyScore ?? 0).toFixed(2)}
        </div>
      )}

      <div class="tag-editor">
        {tags.map((tag) => (
          <button key={tag} class="tag" onClick={() => removeTag(tag)} title="Click to remove">
            {tag} x
          </button>
        ))}
      </div>

      <div class="tag-input-row">
        <input
          value={newTag}
          onInput={(event) => setNewTag((event.currentTarget as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addTag(newTag);
            }
          }}
          placeholder="Add tag and press Enter"
        />
      </div>

      <div class="tag-suggestions">
        {tagSuggestions
          .filter((tag) => !tags.includes(tag))
          .slice(0, 6)
          .map((tag) => (
            <button key={tag} class="chip" onClick={() => addTag(tag)}>
              + {tag}
            </button>
          ))}
      </div>

      <textarea
        value={userNote}
        onInput={(event) => setUserNote((event.currentTarget as HTMLTextAreaElement).value)}
        placeholder="One-line note"
      />

      <div class="quick-categories">
        {quickCategoryCandidates.map((candidate) => (
          <button
            key={candidate}
            class={`chip ${item.category === candidate || (!item.category && candidate === "Uncategorized") ? "active" : ""}`}
            onClick={() => void onMoveToCategory(item.id, candidate === "Uncategorized" ? undefined : candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      {error && <div class="error-inline">{error}</div>}

      <div class="card-actions">
        <a class="btn" href={item.url} target="_blank" rel="noreferrer">
          Open
        </a>
        <button class={`btn ${dockPinned ? "primary" : ""}`} onClick={() => void (dockPinned ? onUnpinFromDock(item.id) : onPinToDock(item.id))}>
          {dockPinned ? "Unpin Dock" : "Pin to Dock"}
        </button>
        <button class="btn primary" disabled={saving} onClick={() => void saveCard()}>
          {saving ? "Saving..." : "Save"}
        </button>

        {scope === "trash" || item.status === "trashed" ? (
          <>
            <button class="btn" onClick={() => void onRestore(item.id)}>Restore</button>
            <button class="btn danger" disabled={Boolean(item.locked)} onClick={() => void onDeletePermanent(item.id)}>
              Delete permanently
            </button>
          </>
        ) : (
          <button class="btn danger" disabled={Boolean(item.locked)} onClick={() => void onMoveToTrash(item.id)}>
            Move to Trash
          </button>
        )}

        {scope !== "trash" && item.status !== "trashed" && (
          <button class="btn" onClick={() => void onRetryAi(item.id)}>
            Retry AI
          </button>
        )}
      </div>
    </article>
  );
}

function applyClientFilters(
  items: SemanticSearchItem[],
  statusFilter: BookmarkStatus | "all",
  categoryFilter: string,
  tagFilter: string
): SemanticSearchItem[] {
  return items.filter((item) => {
    if (statusFilter !== "all" && item.status !== statusFilter) {
      return false;
    }
    if (categoryFilter && item.category !== categoryFilter) {
      return false;
    }
    if (tagFilter && !item.tags.includes(tagFilter)) {
      return false;
    }
    return true;
  });
}

function computeFallbackFacets(items: BookmarkItem[]): {
  categories: FacetEntry[];
  tags: FacetEntry[];
  statuses: StatusFacet[];
} {
  const categoryCounter = new Map<string, number>();
  const tagCounter = new Map<string, number>();
  const statusCounter = new Map<BookmarkStatus, number>();

  for (const item of items) {
    statusCounter.set(item.status, (statusCounter.get(item.status) ?? 0) + 1);
    if (item.category) {
      categoryCounter.set(item.category, (categoryCounter.get(item.category) ?? 0) + 1);
    }
    for (const tag of item.tags ?? []) {
      tagCounter.set(tag, (tagCounter.get(tag) ?? 0) + 1);
    }
  }

  return {
    categories: Array.from(categoryCounter.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
    tags: Array.from(tagCounter.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
    statuses: Array.from(statusCounter.entries())
      .map(([value, count]) => ({ value, count }))
      .sort((left, right) => right.count - left.count)
  };
}

function summarizeClientFilters(statusFilter: BookmarkStatus | "all", categoryFilter: string, tagFilter: string): string {
  const active: string[] = [];
  if (statusFilter !== "all") {
    active.push(`status=${statusFilter}`);
  }
  if (categoryFilter) {
    active.push(`category=${categoryFilter}`);
  }
  if (tagFilter) {
    active.push(`tag=${tagFilter}`);
  }
  if (active.length === 0) {
    return "";
  }
  return `filters: ${active.join(", ")}`;
}

function buildCommandActions(input: {
  selectedBookmark: SemanticSearchItem | null;
  topCategories: string[];
  scope: ScopeType;
  reload: () => Promise<void>;
  moveToTrash: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  deletePermanent: (id: string) => Promise<void>;
  retryAi: (id: string) => Promise<void>;
  addTag: (id: string) => Promise<void>;
  moveToCategory: (id: string, category?: string) => Promise<void>;
  emptyTrash: () => Promise<void>;
  backfillEmbeddings: () => Promise<void>;
  backfillFavicons: () => Promise<void>;
}): CommandAction[] {
  const actions: CommandAction[] = [
    {
      id: "refresh",
      label: "Refresh data",
      run: input.reload
    },
    {
      id: "backfill",
      label: "Backfill missing embeddings",
      run: input.backfillEmbeddings
    },
    {
      id: "favicon-backfill",
      label: "Backfill missing favicons",
      run: input.backfillFavicons
    }
  ];

  if (input.scope === "trash") {
    actions.push({
      id: "empty-trash",
      label: "Empty trash permanently",
      run: input.emptyTrash
    });
  }

  if (!input.selectedBookmark) {
    return actions;
  }

  const bookmark = input.selectedBookmark;
  if (bookmark.status === "trashed") {
    actions.push(
      {
        id: "restore",
        label: "Restore selected bookmark",
        run: () => input.restore(bookmark.id)
      },
      {
        id: "delete-permanent",
        label: "Delete selected bookmark permanently",
        run: () => input.deletePermanent(bookmark.id)
      }
    );
  } else {
    actions.push(
      {
        id: "trash",
        label: "Move selected bookmark to Trash",
        run: () => input.moveToTrash(bookmark.id)
      },
      {
        id: "retry-ai",
        label: "Retry AI classification",
        run: () => input.retryAi(bookmark.id)
      },
      {
        id: "add-tag",
        label: "Add tag to selected bookmark",
        run: () => input.addTag(bookmark.id)
      }
    );

    for (const category of ["Uncategorized", ...input.topCategories].slice(0, 10)) {
      actions.push({
        id: `move-${category}`,
        label: `Move selected bookmark to ${category}`,
        run: () => input.moveToCategory(bookmark.id, category === "Uncategorized" ? undefined : category)
      });
    }
  }

  return actions;
}

function useDebouncedValue(value: string, waitMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), waitMs);
    return () => clearTimeout(timeout);
  }, [value, waitMs]);

  return debounced;
}

function formatDate(iso: string): string {
  if (!iso) {
    return "-";
  }
  return new Date(iso).toLocaleString();
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}

function isUnknownMessageTypeError(error: unknown, type?: string): boolean {
  const message = toErrorMessage(error);
  if (!message.includes("Unknown message type")) {
    return false;
  }
  if (!type) {
    return true;
  }
  return message.includes(type);
}

render(<App />, document.getElementById("app")!);
