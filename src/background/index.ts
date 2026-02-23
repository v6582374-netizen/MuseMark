import Dexie, { type Table } from "dexie";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";
import { PROTOCOL_VERSION, type MessageEnvelope, type RuntimeResponse } from "../shared/messages";
import { DEFAULT_SETTINGS, getSettingsFromStorage, saveSettingsToStorage } from "../shared/settings";
import type {
  AnalyzeOutput,
  AuthProvider,
  AuthSessionUser,
  AuthState,
  BookmarkItem,
  BookmarkSyncState,
  BookmarkStatus,
  CapturePayload,
  CategoryRule,
  ClassifyOutput,
  DockEntry,
  DockItemPreference,
  DockLayoutState,
  DockProfile,
  DockRankingState,
  ExtensionSettings,
  RankingWeights,
  SearchScoreBreakdown,
  SearchTrace,
  SemanticSearchItem
} from "../shared/types";

const PROMPT_VERSION = "current";
const EMBEDDING_TIMEOUT_MS = 3_000;
const WEB_AUGMENT_TIMEOUT_MS = 5_000;
const BACKFILL_BATCH_SIZE = 25;
const BACKFILL_BATCH_DELAY_MS = 1_200;
const TYPE_RECLASSIFY_BATCH_SIZE = 30;
const TYPE_RECLASSIFY_BATCH_DELAY_MS = 800;
const JOB_LEASE_MS = 90_000;
const BACKFILL_JOB_ID = "embedding_backfill";
const TYPE_RECLASSIFY_JOB_ID = "type_reclassify";
const TRASH_CLEANUP_JOB_ID = "trash_cleanup";
const SYNC_JOB_ID = "cloud_sync";
const LEGACY_PREFIX = ["auto", "note"].join("");
const ALARM_BACKFILL = `${LEGACY_PREFIX}.embedding.backfill`;
const ALARM_TRASH_CLEANUP = `${LEGACY_PREFIX}.trash.cleanup`;
const ALARM_SYNC = `${LEGACY_PREFIX}.cloud.sync`;
const STORAGE_AUDIT_KEY = `${LEGACY_PREFIX}_last_migration_audit_at`;
const STORAGE_LAST_CLEANUP_KEY = `${LEGACY_PREFIX}_last_cleanup_at`;
const STORAGE_DEMO_PURGED_KEY = `${LEGACY_PREFIX}_demo_purged_v1`;
const STORAGE_TYPE_RECLASSIFY_DONE_KEY = `${LEGACY_PREFIX}_reclassify_v1_done`;
const STORAGE_AUTH_STATE_KEY = `${LEGACY_PREFIX}_auth_state`;
const STORAGE_QUICKDOCK_PROFILES_KEY = `${LEGACY_PREFIX}_quickdock_profiles_v1`;
const STORAGE_QUICKDOCK_PREFS_KEY = `${LEGACY_PREFIX}_quickdock_prefs_v1`;
const STORAGE_QUICKDOCK_LAYOUT_KEY = `${LEGACY_PREFIX}_quickdock_layout_v1`;
const BRIDGE_STATE_TTL_MS = 10 * 60 * 1000;
const QUICKDOCK_DEFAULT_PROFILE_ID = "default";
const QUICKDOCK_CANDIDATE_LIMIT = 300;
const QUICKDOCK_EVENT_WINDOW_DAYS = 30;
const QUICKDOCK_MAX_EVENT_LOG = 120;
const SEARCH_CLARIFY_SESSION_TTL_MS = 10 * 60 * 1000;

const BOOKMARK_TYPE_CATEGORIES = [
  "个人博客",
  "官方文档",
  "网络安全",
  "期刊论文",
  "科技工具",
  "资源网站",
  "新闻媒体",
  "社区论坛",
  "视频课程",
  "代码仓库"
] as const;

const BOOKMARK_TYPE_FALLBACK = "资源网站";

type AuthSession = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  provider: AuthProvider;
  user: AuthSessionUser;
};

type AuthStorageState = {
  session?: AuthSession;
  syncStatus?: "idle" | "syncing" | "error";
  lastSyncAt?: string;
  lastError?: string;
  pendingState?: string;
  pendingNonce?: string;
  pendingStateExpiresAt?: string;
};

type SyncMetaRow = {
  id: string;
  activeUserId?: string;
  lastPullAt?: string;
  lastPushAt?: string;
  lastMigrationAt?: string;
  migrationDone?: boolean;
  updatedAt: string;
};

type CloudBookmarkRow = {
  id?: string;
  user_id: string;
  dedupe_key: string;
  url: string;
  canonical_url?: string | null;
  title: string;
  domain: string;
  favicon_url?: string | null;
  status: BookmarkStatus;
  category?: string | null;
  tags?: string[] | null;
  user_note?: string | null;
  ai_summary?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  save_count: number;
};

type CloudCategoryRuleRow = {
  id?: string;
  user_id: string;
  canonical: string;
  aliases: string[];
  pinned: boolean;
  color?: string | null;
  updated_at: string;
};

type ManagerScope = "inbox" | "library" | "trash";
type BookmarkTypeCategory = (typeof BOOKMARK_TYPE_CATEGORIES)[number];

type CaptureSession = {
  sessionId: string;
  tabId: number;
  bookmarkId: string;
  capture: CapturePayload;
  stage1Promise?: Promise<AnalyzeOutput>;
  stage1Result?: AnalyzeOutput;
  aiDisabledReason?: string;
};

type ManagerListPayload = {
  scope?: ManagerScope;
  search?: string;
  status?: BookmarkStatus | "all";
  category?: string;
  tag?: string;
  limit?: number;
};

type SearchSemanticPayload = {
  query: string;
  scope?: ManagerScope;
  limit?: number;
  clarificationAnswer?: string;
  sessionId?: string;
};

type ManagerFacetsPayload = {
  scope?: ManagerScope;
};

type UpdateBookmarkPayload = {
  id: string;
  category?: string;
  tags?: string[];
  userNote?: string;
  status?: BookmarkStatus;
  pinned?: boolean;
  locked?: boolean;
};

type QuickDockGetStatePayload = {
  currentUrl?: string;
};

type QuickDockListEntriesPayload = {
  currentUrl?: string;
  profileId?: string;
  limit?: number;
};

type QuickDockControlDataPayload = {
  currentUrl?: string;
  profileId?: string;
  suggestedLimit?: number;
};

type QuickDockOpenPayload = {
  id?: string;
  url?: string;
  action?: "open_library" | "save_current_page";
  source?: "dock" | "manager" | "command";
};

type QuickDockPinPayload = {
  bookmarkId: string;
};

type QuickDockDismissPayload = {
  bookmarkId: string;
  days?: number;
};

type QuickDockUpdateLayoutPayload = {
  mode?: DockLayoutState["mode"];
  pinned?: boolean;
  activeProfileId?: string;
};

type QuickDockReorderPinnedPayload = {
  orderedIds: string[];
  profileId?: string;
};

type QuickDockState = {
  enabled: boolean;
  position: ExtensionSettings["quickDockPosition"];
  layout: DockLayoutState;
  profiles: DockProfile[];
  pinnedIds: string[];
  entries: DockEntry[];
};

type QuickDockControlData = {
  enabled: boolean;
  profileId: string;
  maxItems: number;
  pinnedEntries: DockEntry[];
  suggestedEntries: DockEntry[];
};

type QuickDockStorage = {
  profiles: DockProfile[];
  prefsById: Map<string, DockItemPreference>;
  layout: DockLayoutState;
};

type SearchRankRow = {
  item: BookmarkItem;
  exactMatchTier: number;
  lexicalScore: number;
  semanticScore: number;
  taxonomyScore: number;
  recencyScore: number;
  finalScore: number;
};

type SearchSemanticResult = {
  items: SemanticSearchItem[];
  mode: "direct" | "clarify";
  confidence: number;
  clarifyingQuestion?: string;
  clarifyOptions?: string[];
  sessionId?: string;
  trace: SearchTrace;
  fallback: boolean;
  explain: string;
  hints: string[];
};

type WebAugmentResult = {
  terms: string[];
  reason: string;
  used: boolean;
  degraded: boolean;
};

type ClarifySession = {
  id: string;
  query: string;
  scope: ManagerScope;
  options: string[];
  createdAt: number;
};

type JobState = {
  id: string;
  running: boolean;
  leaseUntil: number;
  updatedAt: string;
  cursorUpdatedAt?: string;
  cursorId?: string;
  lastRunAt?: string;
  lastError?: string;
};

class MuseMarkDB extends Dexie {
  bookmarks!: Table<BookmarkItem, string>;
  categoryRules!: Table<CategoryRule, string>;
  jobs!: Table<JobState, string>;
  syncMeta!: Table<SyncMetaRow, string>;

  constructor() {
    super(`${LEGACY_PREFIX}_db`);

    this.version(1).stores({
      bookmarks: "id,url,canonicalUrl,createdAt,updatedAt,lastSavedAt,status,category,*tags,domain"
    });

    this.version(2)
      .stores({
        bookmarks: "id,url,canonicalUrl,createdAt,updatedAt,lastSavedAt,status,deletedAt,category,*tags,domain,embeddingUpdatedAt",
        categoryRules: "id,canonical,*aliases,pinned,updatedAt"
      })
      .upgrade((transaction) => {
        return transaction
          .table("bookmarks")
          .toCollection()
          .modify((raw) => {
            const item = raw as BookmarkItem;
            item.tags = normalizeTags(item.tags ?? []);
            item.saveCount = Math.max(1, Number(item.saveCount ?? 1));
            item.lastSavedAt = item.lastSavedAt || item.updatedAt || item.createdAt || nowIso();
            item.status = item.status || "inbox";
            if (item.status === "trashed") {
              item.deletedAt = item.deletedAt || nowIso();
            }
            item.pinned = Boolean(item.pinned);
            item.locked = Boolean(item.locked);
            item.searchText = buildSearchText(item);
          });
      });

    this.version(3)
      .stores({
        bookmarks:
          "id,url,canonicalUrl,createdAt,updatedAt,lastSavedAt,status,deletedAt,category,*tags,domain,embeddingUpdatedAt,[status+updatedAt],[category+updatedAt],[status+deletedAt]",
        categoryRules: "id,canonical,*aliases,pinned,updatedAt",
        jobs: "id,updatedAt,running,leaseUntil,lastRunAt"
      })
      .upgrade((transaction) => {
        return transaction
          .table("bookmarks")
          .toCollection()
          .modify((raw) => {
            const item = raw as BookmarkItem;
            item.status = item.status || "inbox";
            item.tags = normalizeTags(item.tags ?? []);
            item.searchText = buildSearchText(item);
            item.pinned = Boolean(item.pinned);
            item.locked = Boolean(item.locked);
            if (item.status === "trashed" && !item.deletedAt) {
              item.deletedAt = nowIso();
            }
          });
      });

    this.version(4)
      .stores({
        bookmarks:
          "id,url,canonicalUrl,createdAt,updatedAt,lastSavedAt,status,deletedAt,category,*tags,domain,embeddingUpdatedAt,syncState,lastSyncedAt,cloudUpdatedAt,[status+updatedAt],[category+updatedAt],[status+deletedAt]",
        categoryRules: "id,canonical,*aliases,pinned,updatedAt",
        jobs: "id,updatedAt,running,leaseUntil,lastRunAt",
        syncMeta: "id,updatedAt,activeUserId,lastPullAt,lastPushAt,lastMigrationAt,migrationDone"
      })
      .upgrade((transaction) => {
        return transaction
          .table("bookmarks")
          .toCollection()
          .modify((raw) => {
            const item = raw as BookmarkItem;
            if (!item.syncState) {
              item.syncState = "dirty";
            }
            item.lastSyncedAt = item.lastSyncedAt || undefined;
            item.cloudUpdatedAt = item.cloudUpdatedAt || undefined;
            item.cloudId = item.cloudId || undefined;
            item.searchText = buildSearchText(item);
          });
      });
  }
}

const db = new MuseMarkDB();
const captureSessions = new Map<string, CaptureSession>();
const embeddingInFlight = new Set<string>();
const clarifySessions = new Map<string, ClarifySession>();
let authStorageCache: AuthStorageState | undefined;

function runBackgroundTask(taskName: string, task: () => Promise<unknown>): void {
  void task().catch((error) => {
    console.error(`[MuseMark] Background task failed: ${taskName}`, error);
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettingsFromStorage();
  await chrome.storage.local.set({
    [`${LEGACY_PREFIX}_settings_initialized`]: true
  });
  await saveSettingsToStorage(settings);
  await getAuthStorageState();
  await ensureSyncMetaRow();
  await purgeDemoBookmarksOnce();
  runBackgroundTask("runTypeReclassifyJobIfNeeded(install)", () => runTypeReclassifyJobIfNeeded("install"));
  await ensureBackgroundAlarms();
  await runMigrationSelfCheckIfNeeded(true);
  runBackgroundTask("syncNow(install)", () => syncNow("install"));
});

chrome.runtime.onStartup.addListener(() => {
  runBackgroundTask("purgeDemoBookmarksOnce(startup)", () => purgeDemoBookmarksOnce());
  runBackgroundTask("runTypeReclassifyJobIfNeeded(startup)", () => runTypeReclassifyJobIfNeeded("startup"));
  runBackgroundTask("ensureBackgroundAlarms(startup)", () => ensureBackgroundAlarms());
  runBackgroundTask("runMigrationSelfCheckIfNeeded(startup)", () => runMigrationSelfCheckIfNeeded(false));
  runBackgroundTask("syncNow(startup)", () => syncNow("startup"));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_BACKFILL) {
    runBackgroundTask("runBackfillJob(alarm)", () =>
      runBackfillJob({
        source: "alarm",
        limit: BACKFILL_BATCH_SIZE,
        delayMs: BACKFILL_BATCH_DELAY_MS
      })
    );
  }

  if (alarm.name === ALARM_TRASH_CLEANUP) {
    runBackgroundTask("runRetentionCleanupJob(alarm)", () => runRetentionCleanupJob());
  }

  if (alarm.name === ALARM_SYNC) {
    runBackgroundTask("syncNow(alarm)", () => syncNow("alarm"));
  }
});

runBackgroundTask("ensureBackgroundAlarms(bootstrap)", () => ensureBackgroundAlarms());
runBackgroundTask("purgeDemoBookmarksOnce(bootstrap)", () => purgeDemoBookmarksOnce());
runBackgroundTask("runTypeReclassifyJobIfNeeded(bootstrap)", () => runTypeReclassifyJobIfNeeded("startup"));
runBackgroundTask("runMigrationSelfCheckIfNeeded(bootstrap)", () => runMigrationSelfCheckIfNeeded(false));
runBackgroundTask("getAuthStorageState(bootstrap)", () => getAuthStorageState());

chrome.commands.onCommand.addListener((command) => {
  if (command === "save-and-classify") {
    runBackgroundTask("handleSaveAndClassifyCommand(command)", () => handleSaveAndClassifyCommand());
  }
});

chrome.action.onClicked.addListener(() => {
  runBackgroundTask("openManagerTab(action)", () => openManagerTab());
});

chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
  const message = rawMessage as MessageEnvelope;
  if (!message || message.protocolVersion !== PROTOCOL_VERSION || typeof message.type !== "string") {
    return false;
  }

  void (async () => {
    try {
      const data = await routeRuntimeMessage(message, sender);
      const response: RuntimeResponse = { ok: true, data };
      sendResponse(response);
    } catch (error) {
      const response: RuntimeResponse = { ok: false, error: toErrorMessage(error) };
      sendResponse(response);
    }
  })();

  return true;
});

chrome.runtime.onMessageExternal.addListener((rawMessage, sender, sendResponse) => {
  const message = rawMessage as MessageEnvelope;
  if (!message || message.protocolVersion !== PROTOCOL_VERSION || typeof message.type !== "string") {
    return false;
  }

  void (async () => {
    try {
      if (message.type !== "auth/bridgeComplete") {
        throw new Error(`Unknown external message type: ${message.type}`);
      }
      const data = await handleBridgeCompleteMessage(
        message.payload as {
          state?: string;
          nonce?: string;
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: string;
          expiresIn?: number;
          provider?: AuthProvider;
        },
        sender
      );
      sendResponse({ ok: true, data } satisfies RuntimeResponse);
    } catch (error) {
      sendResponse({ ok: false, error: toErrorMessage(error) } satisfies RuntimeResponse);
    }
  })();

  return true;
});

async function routeRuntimeMessage(message: MessageEnvelope, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (message.type) {
    case "content/submitNote":
      return handleSubmitNoteMessage(
        message.payload as {
          sessionId: string;
          bookmarkId?: string;
          note?: string;
          selectedCategory?: string;
          selectedTags?: string[];
        }
      );

    case "content/openManager":
      await openManagerTab();
      return { opened: true };

    case "manager/list":
      return {
        items: await listBookmarks((message.payload ?? {}) as ManagerListPayload)
      };

    case "manager/searchSemantic":
      return await searchSemantic((message.payload ?? {}) as SearchSemanticPayload);

    case "manager/facets":
      return getFacetData(((message.payload ?? {}) as ManagerFacetsPayload).scope);

    case "manager/update":
      await updateBookmark((message.payload ?? {}) as UpdateBookmarkPayload);
      return { updated: true };

    case "manager/retryAi":
      await retryAiClassification((message.payload as { id: string }).id);
      return { retried: true };

    case "manager/trash":
      await moveBookmarkToTrash((message.payload as { id: string }).id);
      return { trashed: true };

    case "manager/restore":
      await restoreBookmark((message.payload as { id: string }).id);
      return { restored: true };

    case "manager/deletePermanent":
      await deleteBookmarkPermanently((message.payload as { id: string }).id);
      return { deleted: true };

    case "manager/emptyTrash":
      return await emptyTrash(message.payload as { olderThanDays?: number } | undefined);

    case "manager/backfillEmbeddings":
      return await backfillEmbeddings(message.payload as { limit?: number; delayMs?: number; resetCursor?: boolean } | undefined);

    case "manager/backfillFavicons":
      return await backfillFavicons(message.payload as { limit?: number } | undefined);

    case "manager/categoryRules/list":
      {
        const cleanup = await cleanupEmptyCategoryRules();
        return {
          items: await listCategoryRules(),
          cleanup
        };
      }

    case "manager/categoryRules/upsert":
      return {
        item: await upsertCategoryRule(
          message.payload as {
            id?: string;
            canonical: string;
            aliases?: string[];
            pinned?: boolean;
            color?: string;
          }
        )
      };

    case "manager/categoryRules/delete":
      await deleteCategoryRule(
        message.payload as {
          id: string;
          reassignTo?: string;
        }
      );
      return { deleted: true };

    case "manager/export":
      return {
        items: await db.bookmarks.toArray(),
        categoryRules: await db.categoryRules.toArray()
      };

    case "manager/import":
      await importBookmarks(
        (message.payload as {
          items: BookmarkItem[];
          categoryRules?: CategoryRule[];
        }) ?? { items: [] }
      );
      return { imported: true };

    case "quickDock/getState":
      return await getQuickDockState((message.payload ?? {}) as QuickDockGetStatePayload);

    case "quickDock/listEntries":
      return await listQuickDockEntries((message.payload ?? {}) as QuickDockListEntriesPayload);

    case "quickDock/controlData":
      return await getQuickDockControlData((message.payload ?? {}) as QuickDockControlDataPayload);

    case "quickDock/open":
      return await openQuickDockEntry((message.payload ?? {}) as QuickDockOpenPayload);

    case "quickDock/pin":
      return await pinQuickDockItem((message.payload ?? {}) as QuickDockPinPayload);

    case "quickDock/unpin":
      return await unpinQuickDockItem((message.payload ?? {}) as QuickDockPinPayload);

    case "quickDock/reorderPinned":
      return await reorderQuickDockPinned((message.payload ?? {}) as QuickDockReorderPinnedPayload);

    case "quickDock/dismiss":
      return await dismissQuickDockItem((message.payload ?? {}) as QuickDockDismissPayload);

    case "quickDock/saveCurrent":
      await handleSaveAndClassifyCommand();
      return { started: true };

    case "quickDock/updateLayout":
      return await updateQuickDockLayout((message.payload ?? {}) as QuickDockUpdateLayoutPayload);

    case "settings/get":
      return getSettingsFromStorage();

    case "settings/save": {
      const incoming = message.payload as Partial<ExtensionSettings>;
      const current = await getSettingsFromStorage();
      const merged = { ...current, ...incoming };
      await requestNetworkPermissionsForSettings(current, merged);
      const saved = await saveSettingsToStorage(merged);
      if (saved.classificationMode === "by_type") {
        runBackgroundTask("runTypeReclassifyJobIfNeeded(settings)", () => runTypeReclassifyJobIfNeeded("settings"));
      }
      return saved;
    }

    case "settings/test":
      return testAiConnection();

    case "permissions/requestOrigin":
      return await requestOriginPermission((message.payload as { url?: string; reason?: string }) ?? {});

    case "permissions/checkOrigin":
      return await checkOriginPermission((message.payload as { url?: string }) ?? {});

    case "auth/getState":
      return getAuthState();

    case "auth/signInOAuth":
      return signInOAuth((message.payload as { provider: "google" }).provider);

    case "auth/sendMagicLink":
      return sendMagicLink((message.payload as { email: string }).email);

    case "auth/signOut":
      await signOut();
      return { signedOut: true };

    case "auth/syncNow":
      return syncNow("manual");

    case "auth/migrateLocalToCloud":
      return migrateLocalToCloud();

    case "auth/debugState":
      return getAuthDebugState();

    default:
      throw new Error(`Unknown message type: ${message.type} (${sender.id ?? "unknown sender"})`);
  }
}

async function handleSaveAndClassifyCommand(): Promise<void> {
  const activeTab = await getActiveTab();
  if (!activeTab?.id) {
    return;
  }

  if (!isHttpUrl(activeTab.url)) {
    await notifyUser("MuseMark cannot run on this page type.");
    return;
  }

  const settings = await getSettingsFromStorage();
  const sessionId = crypto.randomUUID();

  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      files: ["content.js"]
    });
  } catch (error) {
    await notifyUser(`MuseMark failed to inject on this page: ${toErrorMessage(error)}`);
    return;
  }

  let capture: CapturePayload;
  try {
    capture = (await chrome.tabs.sendMessage(activeTab.id, {
      protocolVersion: PROTOCOL_VERSION,
      type: "musemark/startCapture",
      payload: {
        sessionId,
        maxChars: settings.maxChars
      }
    })) as CapturePayload;
  } catch (error) {
    await notifyUser(`MuseMark failed to capture this page: ${toErrorMessage(error)}`);
    return;
  }

  if ((!capture.favIconUrl || !capture.favIconUrl.trim()) && activeTab.favIconUrl) {
    capture.favIconUrl = activeTab.favIconUrl;
  }
  if (!capture.favIconUrl) {
    capture.favIconUrl = deriveFaviconFallback(capture.url, capture.domain);
  }

  if (!capture?.url || !capture?.title) {
    await notifyUser("MuseMark captured incomplete page data.");
    return;
  }

  const bookmark = await upsertBookmarkFromCapture(capture);
  const session: CaptureSession = {
    sessionId,
    tabId: activeTab.id,
    bookmarkId: bookmark.id,
    capture
  };
  captureSessions.set(sessionId, session);

  await sendMessageToTab(activeTab.id, "musemark/bookmarkLinked", {
    sessionId,
    bookmarkId: bookmark.id
  });

  const excludedByRule = getMatchedExcludedPattern(capture.url, settings.excludedUrlPatterns);
  if (excludedByRule) {
    session.aiDisabledReason = `AI skipped by privacy rule: ${excludedByRule}`;
    await db.bookmarks.update(bookmark.id, {
      status: "inbox",
      updatedAt: nowIso(),
      syncState: "dirty"
    });
    await sendMessageToTab(activeTab.id, "musemark/stageError", {
      sessionId,
      error: session.aiDisabledReason
    });
    return;
  }

  const stage1Promise = runStage1ForSession(sessionId);
  session.stage1Promise = stage1Promise;
}

async function handleSubmitNoteMessage(payload: {
  sessionId: string;
  bookmarkId?: string;
  note?: string;
  selectedCategory?: string;
  selectedTags?: string[];
}): Promise<{ status: BookmarkStatus }> {
  const note = (payload.note ?? "").trim();
  const selectedCategory = normalizeCategory(payload.selectedCategory);
  const selectedTags = normalizeTags(payload.selectedTags ?? []);
  const session = captureSessions.get(payload.sessionId);
  const bookmarkId = session?.bookmarkId ?? payload.bookmarkId;

  if (!bookmarkId) {
    throw new Error("Missing bookmark reference for note submission.");
  }

  const bookmark = await db.bookmarks.get(bookmarkId);
  if (!bookmark) {
    throw new Error("Bookmark not found for note submission.");
  }

  const updatedPreview: BookmarkItem = {
    ...bookmark,
    userNote: note,
    updatedAt: nowIso()
  };
  updatedPreview.searchText = buildSearchText(updatedPreview);

  await db.bookmarks.update(bookmarkId, {
    userNote: note,
    updatedAt: updatedPreview.updatedAt,
    searchText: updatedPreview.searchText,
    syncState: "dirty"
  });

  queueEmbeddingRefresh(bookmarkId);

  if (session) {
    await sendMessageToTab(session.tabId, "musemark/classifyPending", {
      sessionId: payload.sessionId
    });
  }

  let stage1: AnalyzeOutput | undefined = session?.stage1Result;
  if (!stage1 && session?.stage1Promise) {
    try {
      stage1 = await session.stage1Promise;
    } catch {
      stage1 = undefined;
    }
  }

  const settings = await getSettingsFromStorage();
  if (session?.aiDisabledReason) {
    if (selectedCategory || selectedTags.length > 0) {
      await finalizeBookmarkClassification({
        bookmarkId,
        category: selectedCategory,
        tags: selectedTags,
        reason: "Manual classification under privacy exclusion.",
        confidence: 0.5,
        settings
      });

      if (session) {
        await sendMessageToTab(session.tabId, "musemark/finalized", {
          sessionId: payload.sessionId,
          category: selectedCategory,
          tags: selectedTags
        });
      }
      return { status: "classified" };
    }

    await db.bookmarks.update(bookmarkId, {
      status: "inbox",
      updatedAt: nowIso(),
      syncState: "dirty"
    });
    if (session) {
      await sendMessageToTab(session.tabId, "musemark/finalized", {
        sessionId: payload.sessionId,
        category: undefined,
        tags: []
      });
    }
    return { status: "inbox" };
  }

  const excludedPattern = getMatchedExcludedPattern(bookmark.url, settings.excludedUrlPatterns);
  if (excludedPattern) {
    if (selectedCategory || selectedTags.length > 0) {
      await finalizeBookmarkClassification({
        bookmarkId,
        category: selectedCategory,
        tags: selectedTags,
        reason: "Manual classification under privacy exclusion.",
        confidence: 0.5,
        settings
      });
      return { status: "classified" };
    }
    await db.bookmarks.update(bookmarkId, {
      status: "inbox",
      updatedAt: nowIso(),
      syncState: "dirty"
    });
    return { status: "inbox" };
  }

  if (!settings.apiKey) {
    if (selectedCategory || selectedTags.length > 0) {
      await finalizeBookmarkClassification({
        bookmarkId,
        category: selectedCategory,
        tags: selectedTags,
        reason: "Manual classification without API key.",
        confidence: 0.5,
        settings
      });

      if (session) {
        await sendMessageToTab(session.tabId, "musemark/finalized", {
          sessionId: payload.sessionId,
          category: selectedCategory,
          tags: selectedTags
        });
      }

      return { status: "classified" };
    }

    await markBookmarkError(bookmarkId, "AI key is missing. Configure it in Options.", settings);
    if (session) {
      await sendMessageToTab(session.tabId, "musemark/stageError", {
        sessionId: payload.sessionId,
        error: "AI key is missing. Configure it in Options."
      });
    }

    return { status: "error" };
  }

  if (!stage1) {
    stage1 = {
      summary: bookmark.aiSummary || `${bookmark.title} (${bookmark.domain})`,
      keyTopics: [],
      suggestedCategoryCandidates: selectedCategory ? [selectedCategory] : [],
      suggestedTags: selectedTags,
      language: "unknown",
      confidence: 0.3
    };
  }

  try {
    const { topCategories, topTags } = await getTopFacets(30, 50);
    const classify = await classifyWithAi({
      settings,
      bookmark,
      stage1,
      userNote: note,
      selectedCategory,
      selectedTags,
      topCategories,
      topTags
    });

    await finalizeBookmarkClassification({
      bookmarkId,
      category: classify.category,
      tags: classify.tags,
      reason: classify.shortReason,
      confidence: classify.confidence,
      settings
    });

    if (session) {
      await sendMessageToTab(session.tabId, "musemark/finalized", {
        sessionId: payload.sessionId,
        category: classify.category,
        tags: classify.tags
      });
    }

    return { status: "classified" };
  } catch (error) {
    await markBookmarkError(bookmarkId, toErrorMessage(error), settings);
    if (session) {
      await sendMessageToTab(session.tabId, "musemark/stageError", {
        sessionId: payload.sessionId,
        error: toErrorMessage(error)
      });
    }
    return { status: "error" };
  }
}

async function runStage1ForSession(sessionId: string): Promise<AnalyzeOutput> {
  const session = captureSessions.get(sessionId);
  if (!session) {
    throw new Error("Capture session not found.");
  }

  const settings = await getSettingsFromStorage();
  const excludedByRule = getMatchedExcludedPattern(session.capture.url, settings.excludedUrlPatterns);
  if (excludedByRule) {
    const reason = `AI skipped by privacy rule: ${excludedByRule}`;
    await db.bookmarks.update(session.bookmarkId, {
      status: "inbox",
      updatedAt: nowIso(),
      syncState: "dirty"
    });
    await sendMessageToTab(session.tabId, "musemark/stageError", {
      sessionId,
      error: reason
    });
    throw new Error(reason);
  }

  if (!settings.apiKey) {
    await markBookmarkError(session.bookmarkId, "AI key is missing. Configure it in Options.", settings);
    await sendMessageToTab(session.tabId, "musemark/stageError", {
      sessionId,
      error: "AI key is missing. Configure it in Options."
    });
    throw new Error("Missing API key.");
  }

  try {
    const analyze = await analyzeWithAi(settings, session.capture);
    session.stage1Result = analyze;

    const item = await db.bookmarks.get(session.bookmarkId);
    if (item) {
      const aiMeta = {
        provider: "openai_compatible" as const,
        baseUrl: settings.baseUrl,
        model: settings.model,
        promptVersion: PROMPT_VERSION,
        stage1: {
          finishedAt: nowIso(),
          confidence: analyze.confidence
        }
      };

      const updated: BookmarkItem = {
        ...item,
        aiSummary: analyze.summary,
        status: "analyzing",
        aiMeta,
        updatedAt: nowIso(),
        syncState: "dirty"
      };
      updated.searchText = buildSearchText(updated);

      await db.bookmarks.put(updated);
      queueEmbeddingRefresh(session.bookmarkId);
    }

    await sendMessageToTab(session.tabId, "musemark/stage1Ready", {
      sessionId,
      summary: analyze.summary,
      suggestedCategoryCandidates: analyze.suggestedCategoryCandidates,
      suggestedTags: analyze.suggestedTags,
      textTruncated: session.capture.wasTruncated
    });

    return analyze;
  } catch (error) {
    await markBookmarkError(session.bookmarkId, toErrorMessage(error), settings);
    await sendMessageToTab(session.tabId, "musemark/stageError", {
      sessionId,
      error: toErrorMessage(error)
    });
    throw error;
  }
}

async function upsertBookmarkFromCapture(capture: CapturePayload): Promise<BookmarkItem> {
  const existing = await findExistingBookmark(capture.canonicalUrl || capture.url, capture.url);
  const timestamp = nowIso();
  const favoredIcon = capture.favIconUrl || deriveFaviconFallback(capture.url, capture.domain);

  if (existing) {
    const updated: BookmarkItem = {
      ...existing,
      url: capture.url,
      canonicalUrl: capture.canonicalUrl || existing.canonicalUrl,
      title: capture.title,
      domain: capture.domain || existing.domain,
      favIconUrl: favoredIcon || existing.favIconUrl,
      updatedAt: timestamp,
      lastSavedAt: timestamp,
      saveCount: (existing.saveCount ?? 1) + 1,
      pinned: Boolean(existing.pinned),
      locked: Boolean(existing.locked),
      status: "analyzing",
      syncState: "dirty",
      deletedAt: undefined,
      contentCapture: {
        textDigest: capture.textDigest,
        textChars: capture.textChars,
        captureMode: capture.captureMode
      },
      aiMeta: {
        provider: "openai_compatible",
        baseUrl: existing.aiMeta?.baseUrl ?? DEFAULT_SETTINGS.baseUrl,
        model: existing.aiMeta?.model ?? DEFAULT_SETTINGS.model,
        promptVersion: PROMPT_VERSION
      }
    };

    updated.searchText = buildSearchText(updated);
    await db.bookmarks.put(updated);
    queueEmbeddingRefresh(updated.id);
    return updated;
  }

  const created: BookmarkItem = {
    id: crypto.randomUUID(),
    url: capture.url,
    canonicalUrl: capture.canonicalUrl,
    title: capture.title,
    domain: capture.domain,
    favIconUrl: favoredIcon,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSavedAt: timestamp,
    saveCount: 1,
    pinned: false,
    locked: false,
    status: "analyzing",
    syncState: "dirty",
    tags: [],
    contentCapture: {
      textDigest: capture.textDigest,
      textChars: capture.textChars,
      captureMode: capture.captureMode
    },
    aiMeta: {
      provider: "openai_compatible",
      baseUrl: DEFAULT_SETTINGS.baseUrl,
      model: DEFAULT_SETTINGS.model,
      promptVersion: PROMPT_VERSION
    },
    searchText: ""
  };

  created.searchText = buildSearchText(created);
  await db.bookmarks.add(created);
  queueEmbeddingRefresh(created.id);
  return created;
}

async function finalizeBookmarkClassification(input: {
  bookmarkId: string;
  category?: string;
  tags: string[];
  reason: string;
  confidence?: number;
  settings?: ExtensionSettings;
}): Promise<void> {
  const item = await db.bookmarks.get(input.bookmarkId);
  if (!item) {
    return;
  }

  const settings = input.settings ?? (await getSettingsFromStorage());
  const rules = await listCategoryRules();
  const normalizedCategory =
    settings.classificationMode === "by_type"
      ? normalizeTypeCategory(input.category)
      : await normalizeCategoryWithRules(input.category, rules, settings);
  const normalizedTags = normalizeTags(input.tags);

  const aiMeta = {
    provider: "openai_compatible" as const,
    baseUrl: settings.baseUrl,
    model: settings.model,
    promptVersion: PROMPT_VERSION,
    stage1: item.aiMeta?.stage1,
    stage2: {
      finishedAt: nowIso(),
      confidence: clamp01(Number(input.confidence ?? 0.5))
    }
  };

  const updated: BookmarkItem = {
    ...item,
    category: normalizedCategory,
    tags: normalizedTags,
    status: "classified",
    deletedAt: undefined,
    updatedAt: nowIso(),
    syncState: "dirty",
    classificationConfidence: clamp01(Number(input.confidence ?? 0.5)),
    aiMeta
  };

  updated.searchText = buildSearchText(updated);
  await db.bookmarks.put(updated);
  queueEmbeddingRefresh(updated.id);
}

async function markBookmarkError(bookmarkId: string, reason: string, settings?: ExtensionSettings): Promise<void> {
  const item = await db.bookmarks.get(bookmarkId);
  if (!item) {
    return;
  }

  const fallbackSettings = settings ?? (await getSettingsFromStorage());
  const updated: BookmarkItem = {
    ...item,
    status: "error",
    updatedAt: nowIso(),
    syncState: "dirty",
    aiMeta: {
      provider: "openai_compatible",
      baseUrl: fallbackSettings.baseUrl,
      model: fallbackSettings.model,
      promptVersion: PROMPT_VERSION,
      stage1: item.aiMeta?.stage1,
      stage2: item.aiMeta?.stage2,
      lastError: reason
    }
  };

  updated.searchText = buildSearchText(updated);
  await db.bookmarks.put(updated);
}

async function listBookmarks(payload: ManagerListPayload): Promise<BookmarkItem[]> {
  const scope = payload.scope ?? "library";
  const search = (payload.search ?? "").trim().toLowerCase();
  const selectedCategory = normalizeCategory(payload.category);
  const selectedTag = normalizeTag(payload.tag);
  const scoped = await queryByScope(scope, payload.status);

  const filtered = scoped.filter((item) => {
    if (selectedCategory && normalizeCategory(item.category) !== selectedCategory) {
      return false;
    }
    if (selectedTag && !item.tags.map(normalizeTag).includes(selectedTag)) {
      return false;
    }
    if (search && !item.searchText.includes(search)) {
      return false;
    }
    return true;
  });

  filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (payload.limit && payload.limit > 0) {
    return filtered.slice(0, payload.limit);
  }
  return filtered;
}

async function searchSemantic(payload: SearchSemanticPayload): Promise<SearchSemanticResult> {
  const query = (payload.query ?? "").trim();
  const scope = payload.scope ?? "library";
  const limit = Number.isFinite(payload.limit) ? Math.max(1, Math.min(200, Number(payload.limit))) : 80;
  const clarificationAnswer = (payload.clarificationAnswer ?? "").trim();
  const settings = await getSettingsFromStorage();
  const allItems = await db.bookmarks.toArray();
  const items = applyScope(allItems, scope);
  const hiddenTrashCount = scope === "trash" ? 0 : allItems.filter((item) => item.status === "trashed").length;
  const session = payload.sessionId ? getClarifySession(payload.sessionId) : undefined;
  const baseQuery = query || session?.query || "";

  let effectiveQuery = baseQuery;
  if (clarificationAnswer) {
    effectiveQuery = `${baseQuery} ${clarificationAnswer}`.trim();
  }

  if (!effectiveQuery) {
    const rankedEmpty = items
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((item) => ({
        ...item,
        whyMatched: "最近保存",
        searchSignals: {
          lexicalScore: 0,
          semanticScore: 0,
          taxonomyScore: 0,
          recencyScore: recencyScore(item)
        }
      }));
    const trace: SearchTrace = {
      query,
      effectiveQuery,
      intentType: "empty",
      webUsed: false,
      webReason: "空查询未触发联网补充",
      expandedTerms: [],
      decisionReason: "空查询返回最近保存结果",
      scoreBreakdown: rankedEmpty.slice(0, 5).map((item) => ({
        bookmarkId: item.id,
        title: item.title,
        finalScore: 0,
        exactMatchTier: 0,
        lexicalScore: 0,
        semanticScore: 0,
        taxonomyScore: 0,
        recencyScore: clamp01(item.searchSignals.recencyScore ?? 0)
      }))
    };
    return {
      items: rankedEmpty,
      mode: "direct",
      confidence: 0.5,
      trace,
      fallback: true,
      explain: "空查询返回最近保存结果",
      hints: hiddenTrashCount > 0 ? [`${hiddenTrashCount} 条 Trash 记录已隐藏`] : []
    };
  }

  const fallbackReason: string[] = [];
  const hints: string[] = [];
  let webUsed = false;
  let webReason = "未触发联网补充";
  const expandedTerms: string[] = [];
  let fallback = false;
  const intentType = detectSearchIntent(baseQuery, clarificationAnswer);

  if (
    settings.webAugmentEnabled &&
    settings.maxWebAugmentPerQuery > 0 &&
    intentType === "ambiguous" &&
    !clarificationAnswer
  ) {
    const augment = await augmentIntentWithWeb(settings, effectiveQuery, settings.maxWebAugmentPerQuery);
    webUsed = augment.used;
    webReason = augment.reason;
    expandedTerms.push(...augment.terms);
    if (augment.degraded && augment.reason) {
      fallback = true;
      fallbackReason.push(`联网补充降级: ${augment.reason}`);
    }
  }

  const queryWithExpandedTerms = [effectiveQuery, ...expandedTerms].join(" ").trim();
  const normalizedQuery = normalizeLookup(queryWithExpandedTerms);
  const queryLooksLikeUrl = /^https?:\/\//i.test(queryWithExpandedTerms) || queryWithExpandedTerms.includes("www.");
  const baseTokens = tokenize(queryWithExpandedTerms);
  const useExpandedTokens = baseTokens.length > 0 && baseTokens.length <= 2;
  const tokenSet = buildExpandedTokenSet(queryWithExpandedTerms, useExpandedTokens);

  let queryEmbedding: number[] | undefined;

  if (settings.semanticSearchEnabled && settings.apiKey && settings.searchFallbackMode !== "lexical_only") {
    try {
      queryEmbedding = await withTimeout(generateEmbedding(settings, queryWithExpandedTerms), EMBEDDING_TIMEOUT_MS, "Embedding timed out");
    } catch (error) {
      fallback = true;
      fallbackReason.push(`语义检索降级: ${toErrorMessage(error)}`);
    }
  } else {
    fallback = true;
    fallbackReason.push("语义检索未启用、缺少 API key 或当前模式为 lexical_only");
  }

  const recallLimit = Math.max(limit * 6, 120);
  const recallRows: SearchRankRow[] = items.map((item) => {
    const lexical = lexicalScore(item, queryWithExpandedTerms, tokenSet);
    const localSemantic =
      settings.searchFallbackMode === "lexical_only" ? 0 : localHybridSemanticScore(item, queryWithExpandedTerms, tokenSet);
    const exactMatchTier = computeExactMatchTier(item, normalizedQuery, queryLooksLikeUrl);
    const recallScore = exactMatchTier > 0 ? 10 + exactMatchTier + lexical : lexical * 1.1 + localSemantic * 0.4;
    return {
      item,
      exactMatchTier,
      lexicalScore: lexical,
      semanticScore: localSemantic,
      taxonomyScore: 0,
      recencyScore: 0,
      finalScore: recallScore
    };
  });

  recallRows.sort((left, right) => {
    if (right.exactMatchTier !== left.exactMatchTier) {
      return right.exactMatchTier - left.exactMatchTier;
    }
    if (right.finalScore !== left.finalScore) {
      return right.finalScore - left.finalScore;
    }
    return right.item.updatedAt.localeCompare(left.item.updatedAt);
  });

  const candidates = recallRows.slice(0, Math.min(recallLimit, recallRows.length));
  const weights = resolveRankingWeights(settings, Boolean(queryEmbedding));
  const rankRows: SearchRankRow[] = [];
  let noEmbeddingCount = 0;

  for (const candidate of candidates) {
    const item = candidate.item;
    const lexical = candidate.lexicalScore;
    const taxonomy = taxonomyScore(item, tokenSet);
    const recency = recencyScore(item);

    let semantic =
      settings.searchFallbackMode === "lexical_only" ? 0 : localHybridSemanticScore(item, queryWithExpandedTerms, tokenSet);
    if (queryEmbedding && item.embedding && item.embedding.length === queryEmbedding.length) {
      semantic = cosineSimilarity(queryEmbedding, item.embedding);
    } else if (settings.semanticSearchEnabled && settings.apiKey && !item.embedding) {
      noEmbeddingCount += 1;
      if (!getMatchedExcludedPattern(item.url, settings.excludedUrlPatterns)) {
        queueEmbeddingRefresh(item.id);
      }
    }

    const finalScore =
      weights.semantic * semantic + weights.lexical * lexical + weights.taxonomy * taxonomy + weights.recency * recency;

    rankRows.push({
      item,
      exactMatchTier: candidate.exactMatchTier,
      lexicalScore: lexical,
      semanticScore: semantic,
      taxonomyScore: taxonomy,
      recencyScore: recency,
      finalScore
    });
  }

  rankRows.sort((left, right) => {
    if (right.exactMatchTier !== left.exactMatchTier) {
      return right.exactMatchTier - left.exactMatchTier;
    }
    if (right.finalScore !== left.finalScore) {
      return right.finalScore - left.finalScore;
    }
    return right.item.updatedAt.localeCompare(left.item.updatedAt);
  });

  const filteredRows = rankRows.filter((row) => {
    if (row.exactMatchTier > 0) {
      return true;
    }
    if (row.lexicalScore >= 0.12) {
      return true;
    }
    if (row.semanticScore >= 0.16) {
      return true;
    }
    if (row.taxonomyScore >= 0.2) {
      return true;
    }
    return false;
  });

  const selectedRows = (filteredRows.length > 0 ? filteredRows : rankRows).slice(0, limit);
  const confidence = computeSearchConfidence(selectedRows);

  const ranked = selectedRows.map((row) => {
    const whyMatched = buildWhyMatched(row);
    return {
      ...row.item,
      whyMatched,
      searchSignals: {
        lexicalScore: clamp01(row.lexicalScore),
        semanticScore: clamp01(row.semanticScore),
        taxonomyScore: clamp01(row.taxonomyScore),
        recencyScore: clamp01(row.recencyScore)
      }
    } satisfies SemanticSearchItem;
  });

  if (hiddenTrashCount > 0) {
    hints.push(`${hiddenTrashCount} 条 Trash 记录未参与当前检索`);
  }
  if (noEmbeddingCount > 0 && queryEmbedding) {
    hints.push(`${noEmbeddingCount} 条记录尚无 embedding，已触发后台回填`);
  }
  if (!queryEmbedding && settings.searchFallbackMode === "lexical_only") {
    hints.push("当前为 lexical_only 模式，语义分数已禁用");
  }
  if (!useExpandedTokens && baseTokens.length > 2) {
    hints.push("长查询已禁用同义词扩展，减少误召回");
  }
  const exactHitCount = selectedRows.filter((row) => row.exactMatchTier > 0).length;
  const lexicalHitCount = selectedRows.filter((row) => row.lexicalScore >= 0.35).length;
  const semanticHitCount = selectedRows.filter((row) => row.semanticScore >= 0.45).length;
  hints.push(`置信度: ${confidence.toFixed(2)}`);
  hints.push(`命中统计: exact ${exactHitCount} | lexical ${lexicalHitCount} | semantic ${semanticHitCount}`);

  const shouldClarify =
    settings.clarifyOnLowConfidence &&
    intentType === "ambiguous" &&
    !clarificationAnswer &&
    selectedRows.length > 1 &&
    confidence < settings.lowConfidenceThreshold;

  let nextSessionId: string | undefined;
  let clarifyingQuestion: string | undefined;
  let clarifyOptions: string[] | undefined;
  let decisionReason = `直接返回结果（置信度 ${confidence.toFixed(2)}）`;

  if (shouldClarify) {
    clarifyOptions = buildClarifyOptions(selectedRows);
    if (clarifyOptions.length > 0) {
      nextSessionId = createClarifySession({
        query: baseQuery,
        scope,
        options: clarifyOptions
      });
      clarifyingQuestion = "你的搜索比较模糊。你更想看哪一类结果？";
      decisionReason = `置信度 ${confidence.toFixed(2)} 低于阈值 ${settings.lowConfidenceThreshold.toFixed(2)}，触发澄清`;
      hints.push("已触发澄清问题，建议先选择意图再排序");
    }
  } else if (session) {
    clarifySessions.delete(session.id);
  }

  const scoreBreakdown: SearchScoreBreakdown[] = selectedRows.slice(0, 8).map((row) => ({
    bookmarkId: row.item.id,
    title: row.item.title,
    finalScore: Number(row.finalScore.toFixed(4)),
    exactMatchTier: row.exactMatchTier,
    lexicalScore: Number(clamp01(row.lexicalScore).toFixed(4)),
    semanticScore: Number(clamp01(row.semanticScore).toFixed(4)),
    taxonomyScore: Number(clamp01(row.taxonomyScore).toFixed(4)),
    recencyScore: Number(clamp01(row.recencyScore).toFixed(4))
  }));

  const trace: SearchTrace = {
    query,
    effectiveQuery: queryWithExpandedTerms,
    intentType,
    webUsed,
    webReason,
    expandedTerms,
    decisionReason,
    scoreBreakdown
  };

  return {
    items: ranked,
    mode: nextSessionId ? "clarify" : "direct",
    confidence,
    clarifyingQuestion,
    clarifyOptions,
    sessionId: nextSessionId,
    trace,
    fallback,
    explain: fallbackReason.join("; ") || "使用语义混合检索",
    hints
  };
}

async function getFacetData(scope: ManagerScope = "library"): Promise<{
  categories: Array<{ value: string; count: number }>;
  tags: Array<{ value: string; count: number }>;
  statuses: Array<{ value: BookmarkStatus; count: number }>;
}> {
  const items = applyScope(await db.bookmarks.toArray(), scope);

  const categoryCounter = new Map<string, number>();
  const tagCounter = new Map<string, number>();
  const statusCounter = new Map<BookmarkStatus, number>();

  for (const item of items) {
    statusCounter.set(item.status, (statusCounter.get(item.status) ?? 0) + 1);

    const category = normalizeCategory(item.category);
    if (category) {
      categoryCounter.set(category, (categoryCounter.get(category) ?? 0) + 1);
    }
    for (const tag of normalizeTags(item.tags)) {
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

async function getQuickDockState(payload: QuickDockGetStatePayload): Promise<QuickDockState> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const activeProfileId = storage.layout.activeProfileId;
  const profile = storage.profiles.find((entry) => entry.id === activeProfileId) ?? storage.profiles[0];
  const entries = settings.quickDockEnabled
    ? await buildQuickDockEntries({
        settings,
        profileId: profile.id,
        currentUrl: payload.currentUrl,
        limit: settings.quickDockMaxItems,
        storage
      })
    : [];

  return {
    enabled: settings.quickDockEnabled,
    position: settings.quickDockPosition,
    layout: storage.layout,
    profiles: storage.profiles,
    pinnedIds: getPinnedIdsForProfile(storage, profile.id),
    entries
  };
}

async function listQuickDockEntries(payload: QuickDockListEntriesPayload): Promise<{
  entries: DockEntry[];
  profileId: string;
  pinnedIds: string[];
  limit: number;
}> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const requestedProfile = payload.profileId ? storage.profiles.find((entry) => entry.id === payload.profileId) : undefined;
  const profileId = requestedProfile?.id ?? storage.layout.activeProfileId;
  const limit = resolveQuickDockLimit(payload.limit, settings.quickDockMaxItems);
  const entries = settings.quickDockEnabled
    ? await buildQuickDockEntries({
        settings,
        profileId,
        currentUrl: payload.currentUrl,
        limit,
        storage
      })
    : [];

  return {
    entries,
    profileId,
    pinnedIds: getPinnedIdsForProfile(storage, profileId),
    limit
  };
}

async function getQuickDockControlData(payload: QuickDockControlDataPayload): Promise<QuickDockControlData> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const requestedProfile = payload.profileId ? storage.profiles.find((entry) => entry.id === payload.profileId) : undefined;
  const profileId = requestedProfile?.id ?? storage.layout.activeProfileId;
  const pinnedEntries = await listPinnedDockEntries(storage, profileId);
  const suggestedLimitCandidate = Number.isFinite(payload.suggestedLimit) ? Number(payload.suggestedLimit) : 20;
  const suggestedLimit = Math.max(1, Math.min(50, Math.round(suggestedLimitCandidate)));
  const pinnedSet = new Set(pinnedEntries.map((entry) => entry.id));
  const candidates = (await listQuickDockCandidates()).filter((item) => !pinnedSet.has(item.id));
  const ranked = rankQuickDockCandidates({
    items: candidates,
    prefsById: storage.prefsById,
    currentUrl: payload.currentUrl,
    limit: suggestedLimit
  });
  const suggestedEntries = ranked.map((row) => createBookmarkDockEntry(row.item, false, row.ranking));

  return {
    enabled: settings.quickDockEnabled,
    profileId,
    maxItems: resolveQuickDockLimit(settings.quickDockMaxItems, settings.quickDockMaxItems),
    pinnedEntries,
    suggestedEntries
  };
}

async function openQuickDockEntry(payload: QuickDockOpenPayload): Promise<{ opened: boolean; action?: string }> {
  const actionFromId =
    payload.id === "action:open_library" ? "open_library" : payload.id === "action:save_current_page" ? "save_current_page" : undefined;
  const action = payload.action ?? actionFromId;
  if (action === "open_library") {
    await openManagerTab();
    return { opened: true, action };
  }
  if (action === "save_current_page") {
    await handleSaveAndClassifyCommand();
    return { opened: true, action };
  }

  let bookmark: BookmarkItem | undefined;
  if (payload.id) {
    bookmark = await db.bookmarks.get(payload.id);
  }
  const targetUrl = payload.url || bookmark?.url;
  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return { opened: false };
  }

  await chrome.tabs.create({ url: targetUrl });

  if (bookmark) {
    const settings = await getSettingsFromStorage();
    const storage = await ensureQuickDockStorage(settings);
    const current = storage.prefsById.get(bookmark.id) ?? { bookmarkId: bookmark.id };
    const now = nowIso();
    const events = (current.dockOpenEvents ?? [])
      .filter((entry) => {
        const ms = Date.parse(entry);
        return Number.isFinite(ms) && ms >= Date.now() - QUICKDOCK_EVENT_WINDOW_DAYS * 86_400_000;
      })
      .concat(now)
      .slice(-QUICKDOCK_MAX_EVENT_LOG);
    const next: DockItemPreference = {
      ...current,
      dockOpenCount: Math.max(0, Number(current.dockOpenCount ?? 0)) + 1,
      dockLastOpenedAt: now,
      dockOpenEvents: events
    };
    storage.prefsById.set(bookmark.id, next);
    await chrome.storage.local.set({
      [STORAGE_QUICKDOCK_PREFS_KEY]: serializeDockPreferences(storage.prefsById)
    });
  }

  return { opened: true };
}

async function pinQuickDockItem(payload: QuickDockPinPayload): Promise<{ pinned: boolean; pinnedIds: string[] }> {
  const bookmark = await db.bookmarks.get(payload.bookmarkId);
  if (!bookmark || bookmark.status === "trashed" || !isHttpUrl(bookmark.url)) {
    return { pinned: false, pinnedIds: [] };
  }

  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const activeProfile = storage.profiles.find((entry) => entry.id === storage.layout.activeProfileId) ?? storage.profiles[0];
  const maxPinOrder = Math.max(
    0,
    ...Array.from(storage.prefsById.values())
      .filter((entry) => entry.pinned)
      .map((entry) => Number(entry.pinOrder ?? 0))
  );
  const current = storage.prefsById.get(payload.bookmarkId) ?? { bookmarkId: payload.bookmarkId };
  storage.prefsById.set(payload.bookmarkId, {
    ...current,
    pinned: true,
    pinOrder: current.pinOrder && current.pinOrder > 0 ? current.pinOrder : maxPinOrder + 1,
    dismissedUntil: undefined
  });

  if (!activeProfile.itemIds.includes(payload.bookmarkId)) {
    activeProfile.itemIds = [...activeProfile.itemIds, payload.bookmarkId];
  }
  activeProfile.updatedAt = nowIso();

  await chrome.storage.local.set({
    [STORAGE_QUICKDOCK_PROFILES_KEY]: storage.profiles,
    [STORAGE_QUICKDOCK_PREFS_KEY]: serializeDockPreferences(storage.prefsById)
  });

  return {
    pinned: true,
    pinnedIds: getPinnedIdsForProfile(storage, activeProfile.id)
  };
}

async function unpinQuickDockItem(payload: QuickDockPinPayload): Promise<{ pinned: boolean; pinnedIds: string[] }> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const current = storage.prefsById.get(payload.bookmarkId) ?? { bookmarkId: payload.bookmarkId };
  storage.prefsById.set(payload.bookmarkId, {
    ...current,
    pinned: false,
    pinOrder: undefined
  });

  const updatedProfiles = storage.profiles.map((profile) => {
    if (!profile.itemIds.includes(payload.bookmarkId)) {
      return profile;
    }
    return {
      ...profile,
      itemIds: profile.itemIds.filter((id) => id !== payload.bookmarkId),
      updatedAt: nowIso()
    };
  });
  storage.profiles = updatedProfiles;

  await chrome.storage.local.set({
    [STORAGE_QUICKDOCK_PROFILES_KEY]: storage.profiles,
    [STORAGE_QUICKDOCK_PREFS_KEY]: serializeDockPreferences(storage.prefsById)
  });

  return {
    pinned: false,
    pinnedIds: getPinnedIdsForProfile(storage, storage.layout.activeProfileId)
  };
}

async function reorderQuickDockPinned(
  payload: QuickDockReorderPinnedPayload
): Promise<{ pinned: true; profileId: string; pinnedIds: string[] }> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const profileId =
    payload.profileId && storage.profiles.some((entry) => entry.id === payload.profileId)
      ? payload.profileId
      : storage.layout.activeProfileId;
  const profile = storage.profiles.find((entry) => entry.id === profileId) ?? storage.profiles[0];
  if (!profile) {
    return {
      pinned: true,
      profileId,
      pinnedIds: []
    };
  }

  const currentPinnedIds = getPinnedIdsForProfile(storage, profile.id);
  const pinnedSet = new Set(currentPinnedIds);
  const seen = new Set<string>();
  const requestedIds = Array.isArray(payload.orderedIds) ? payload.orderedIds : [];

  const normalizedPinnedIds: string[] = [];
  for (const candidate of requestedIds) {
    const bookmarkId = typeof candidate === "string" ? candidate.trim() : "";
    if (!bookmarkId || seen.has(bookmarkId) || !pinnedSet.has(bookmarkId)) {
      continue;
    }
    seen.add(bookmarkId);
    normalizedPinnedIds.push(bookmarkId);
  }
  for (const bookmarkId of currentPinnedIds) {
    if (seen.has(bookmarkId)) {
      continue;
    }
    seen.add(bookmarkId);
    normalizedPinnedIds.push(bookmarkId);
  }

  const profileTail = profile.itemIds.filter((bookmarkId) => !pinnedSet.has(bookmarkId));
  profile.itemIds = [...normalizedPinnedIds, ...profileTail];
  profile.updatedAt = nowIso();

  const orderMap = new Map<string, number>(normalizedPinnedIds.map((bookmarkId, index) => [bookmarkId, index + 1]));
  for (const [bookmarkId, pref] of storage.prefsById.entries()) {
    if (!pref.pinned) {
      continue;
    }
    const nextOrder = orderMap.get(bookmarkId);
    if (!nextOrder) {
      continue;
    }
    storage.prefsById.set(bookmarkId, {
      ...pref,
      pinOrder: nextOrder
    });
  }

  await chrome.storage.local.set({
    [STORAGE_QUICKDOCK_PROFILES_KEY]: storage.profiles,
    [STORAGE_QUICKDOCK_PREFS_KEY]: serializeDockPreferences(storage.prefsById)
  });

  return {
    pinned: true,
    profileId: profile.id,
    pinnedIds: getPinnedIdsForProfile(storage, profile.id)
  };
}

async function dismissQuickDockItem(payload: QuickDockDismissPayload): Promise<{ dismissed: boolean; until: string }> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const days = Number.isFinite(payload.days) ? Math.max(1, Math.min(90, Number(payload.days))) : 30;
  const until = new Date(Date.now() + days * 86_400_000).toISOString();
  const current = storage.prefsById.get(payload.bookmarkId) ?? { bookmarkId: payload.bookmarkId };
  storage.prefsById.set(payload.bookmarkId, {
    ...current,
    pinned: false,
    pinOrder: undefined,
    dismissedUntil: until
  });

  storage.profiles = storage.profiles.map((profile) => {
    if (!profile.itemIds.includes(payload.bookmarkId)) {
      return profile;
    }
    return {
      ...profile,
      itemIds: profile.itemIds.filter((id) => id !== payload.bookmarkId),
      updatedAt: nowIso()
    };
  });

  await chrome.storage.local.set({
    [STORAGE_QUICKDOCK_PROFILES_KEY]: storage.profiles,
    [STORAGE_QUICKDOCK_PREFS_KEY]: serializeDockPreferences(storage.prefsById)
  });

  return { dismissed: true, until };
}

async function updateQuickDockLayout(payload: QuickDockUpdateLayoutPayload): Promise<{ layout: DockLayoutState }> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const selectedMode = normalizeQuickDockMode(payload.mode) ?? storage.layout.mode;
  const selectedProfileId = payload.activeProfileId && storage.profiles.some((entry) => entry.id === payload.activeProfileId)
    ? payload.activeProfileId
    : storage.layout.activeProfileId;
  const layout: DockLayoutState = {
    mode: selectedMode,
    pinned: typeof payload.pinned === "boolean" ? payload.pinned : storage.layout.pinned,
    activeProfileId: selectedProfileId,
    updatedAt: nowIso()
  };
  storage.layout = layout;
  await chrome.storage.local.set({
    [STORAGE_QUICKDOCK_LAYOUT_KEY]: layout
  });
  return { layout };
}

async function buildQuickDockEntries(input: {
  settings: ExtensionSettings;
  profileId: string;
  currentUrl?: string;
  limit: number;
  storage: QuickDockStorage;
}): Promise<DockEntry[]> {
  const limit = resolveQuickDockLimit(input.limit, input.settings.quickDockMaxItems);
  if (limit <= 0) {
    return [];
  }

  const candidates = await listQuickDockCandidates();
  const pinnedEntries = await listPinnedDockEntries(input.storage, input.profileId);

  const pinnedSet = new Set<string>(pinnedEntries.map((entry) => entry.id));
  const remainingSlots = Math.max(0, limit - pinnedEntries.length);
  const result: DockEntry[] = [...pinnedEntries];
  if (input.settings.quickDockPinMode === "manual_only") {
    return result.slice(0, limit);
  }

  if (remainingSlots > 0) {
    const activeItems = candidates.filter((item) => !pinnedSet.has(item.id));
    const ranked = rankQuickDockCandidates({
      items: activeItems,
      prefsById: input.storage.prefsById,
      currentUrl: input.currentUrl,
      limit: remainingSlots
    });

    for (const row of ranked) {
      result.push(createBookmarkDockEntry(row.item, false, row.ranking));
    }
  }

  return result.slice(0, limit);
}

async function listPinnedDockEntries(storage: QuickDockStorage, profileId: string): Promise<DockEntry[]> {
  const pinnedIds = getPinnedIdsForProfile(storage, profileId);
  if (!pinnedIds.length) {
    return [];
  }

  const bookmarks = await db.bookmarks.bulkGet(pinnedIds);
  const itemById = new Map<string, BookmarkItem>();
  for (const item of bookmarks) {
    if (!item || item.status === "trashed" || !isHttpUrl(item.url)) {
      continue;
    }
    itemById.set(item.id, item);
  }

  return pinnedIds.map((id) => itemById.get(id)).filter((item): item is BookmarkItem => Boolean(item)).map((item) => createBookmarkDockEntry(item, true));
}

function rankQuickDockCandidates(input: {
  items: BookmarkItem[];
  prefsById: Map<string, DockItemPreference>;
  currentUrl?: string;
  limit: number;
}): Array<{ item: BookmarkItem; ranking: DockRankingState }> {
  if (input.limit <= 0 || input.items.length === 0) {
    return [];
  }

  const maxRecentClicks = Math.max(
    1,
    ...input.items.map((item) => {
      const pref = input.prefsById.get(item.id);
      return getDockRecentClickCount(pref);
    })
  );

  return input.items
    .map((item) => {
      const pref = input.prefsById.get(item.id);
      const dismissedUntilMs = pref?.dismissedUntil ? Date.parse(pref.dismissedUntil) : Number.NaN;
      if (Number.isFinite(dismissedUntilMs) && dismissedUntilMs > Date.now()) {
        return undefined;
      }

      const clickCount = getDockRecentClickCount(pref);
      const clickScore = clamp01(Math.log1p(clickCount) / Math.log1p(maxRecentClicks));
      const openRecencyScore = computeTimeDecayScore(pref?.dockLastOpenedAt, 21);
      const saveRecencyScore = computeTimeDecayScore(item.lastSavedAt || item.updatedAt || item.createdAt, 28);
      const affinityScore = computeDomainAffinityScore(input.currentUrl, item);
      const score = clickScore * 0.45 + openRecencyScore * 0.3 + saveRecencyScore * 0.15 + affinityScore * 0.1;

      return {
        item,
        ranking: {
          score: clamp01(score),
          clickScore,
          openRecencyScore,
          saveRecencyScore,
          affinityScore
        } satisfies DockRankingState
      };
    })
    .filter((entry): entry is { item: BookmarkItem; ranking: DockRankingState } => Boolean(entry))
    .sort((left, right) => {
      if (right.ranking.score !== left.ranking.score) {
        return right.ranking.score - left.ranking.score;
      }
      return right.item.updatedAt.localeCompare(left.item.updatedAt);
    })
    .slice(0, input.limit);
}

async function listQuickDockCandidates(): Promise<BookmarkItem[]> {
  const all = await db.bookmarks.toArray();
  return all
    .filter((item) => item.status !== "trashed")
    .filter((item) => isHttpUrl(item.url))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, QUICKDOCK_CANDIDATE_LIMIT);
}

function createBookmarkDockEntry(item: BookmarkItem, pinned: boolean, ranking?: DockRankingState): DockEntry {
  return {
    id: item.id,
    kind: "bookmark",
    title: item.title || item.url,
    subtitle: item.domain,
    url: item.url,
    domain: item.domain,
    favIconUrl: item.favIconUrl,
    pinned,
    ranking
  };
}

async function ensureQuickDockStorage(settings: ExtensionSettings): Promise<QuickDockStorage> {
  const storage = await chrome.storage.local.get([
    STORAGE_QUICKDOCK_PROFILES_KEY,
    STORAGE_QUICKDOCK_PREFS_KEY,
    STORAGE_QUICKDOCK_LAYOUT_KEY
  ]);

  const profiles = sanitizeDockProfiles(storage[STORAGE_QUICKDOCK_PROFILES_KEY]);
  const prefsList = sanitizeDockPreferences(storage[STORAGE_QUICKDOCK_PREFS_KEY]);
  const layout = sanitizeDockLayout(storage[STORAGE_QUICKDOCK_LAYOUT_KEY], profiles, settings);
  const prefsById = new Map(prefsList.map((item) => [item.bookmarkId, item]));

  const shouldWriteProfiles =
    !Array.isArray(storage[STORAGE_QUICKDOCK_PROFILES_KEY]) ||
    JSON.stringify(storage[STORAGE_QUICKDOCK_PROFILES_KEY]) !== JSON.stringify(profiles);
  const shouldWritePrefs =
    !Array.isArray(storage[STORAGE_QUICKDOCK_PREFS_KEY]) ||
    JSON.stringify(storage[STORAGE_QUICKDOCK_PREFS_KEY]) !== JSON.stringify(prefsList);
  const shouldWriteLayout =
    typeof storage[STORAGE_QUICKDOCK_LAYOUT_KEY] !== "object" ||
    storage[STORAGE_QUICKDOCK_LAYOUT_KEY] === null ||
    JSON.stringify(storage[STORAGE_QUICKDOCK_LAYOUT_KEY]) !== JSON.stringify(layout);

  if (shouldWriteProfiles || shouldWritePrefs || shouldWriteLayout) {
    await chrome.storage.local.set({
      ...(shouldWriteProfiles ? { [STORAGE_QUICKDOCK_PROFILES_KEY]: profiles } : {}),
      ...(shouldWritePrefs ? { [STORAGE_QUICKDOCK_PREFS_KEY]: prefsList } : {}),
      ...(shouldWriteLayout ? { [STORAGE_QUICKDOCK_LAYOUT_KEY]: layout } : {})
    });
  }

  return {
    profiles,
    prefsById,
    layout
  };
}

function sanitizeDockProfiles(raw: unknown): DockProfile[] {
  if (!Array.isArray(raw)) {
    return [buildDefaultDockProfile()];
  }

  const normalized: DockProfile[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<DockProfile>;
    const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : "";
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const name =
      typeof candidate.name === "string" && candidate.name.trim()
        ? candidate.name.trim().slice(0, 48)
        : id === QUICKDOCK_DEFAULT_PROFILE_ID
          ? "默认 Profile"
          : "QuickDock Profile";
    const itemIds = Array.isArray(candidate.itemIds)
      ? Array.from(
          new Set(
            candidate.itemIds
              .map((item) => (typeof item === "string" ? item.trim() : ""))
              .filter((item) => Boolean(item))
          )
        )
      : [];
    normalized.push({
      id,
      name,
      itemIds,
      createdAt: typeof candidate.createdAt === "string" && candidate.createdAt.trim() ? candidate.createdAt : nowIso(),
      updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : nowIso()
    });
  }

  if (!normalized.some((entry) => entry.id === QUICKDOCK_DEFAULT_PROFILE_ID)) {
    normalized.unshift(buildDefaultDockProfile());
  }
  if (normalized.length === 0) {
    normalized.push(buildDefaultDockProfile());
  }
  return normalized.slice(0, 12);
}

function sanitizeDockPreferences(raw: unknown): DockItemPreference[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const normalized: DockItemPreference[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Partial<DockItemPreference>;
    const bookmarkId = typeof candidate.bookmarkId === "string" ? candidate.bookmarkId.trim() : "";
    if (!bookmarkId || seen.has(bookmarkId)) {
      continue;
    }
    seen.add(bookmarkId);
    const events = Array.isArray(candidate.dockOpenEvents)
      ? candidate.dockOpenEvents
          .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
          .slice(-QUICKDOCK_MAX_EVENT_LOG)
      : undefined;
    normalized.push({
      bookmarkId,
      pinned: Boolean(candidate.pinned),
      pinOrder: Number.isFinite(candidate.pinOrder) ? Math.max(0, Number(candidate.pinOrder)) : undefined,
      dismissedUntil:
        typeof candidate.dismissedUntil === "string" && candidate.dismissedUntil.trim() ? candidate.dismissedUntil : undefined,
      dockOpenCount: Number.isFinite(candidate.dockOpenCount) ? Math.max(0, Number(candidate.dockOpenCount)) : 0,
      dockLastOpenedAt:
        typeof candidate.dockLastOpenedAt === "string" && candidate.dockLastOpenedAt.trim() ? candidate.dockLastOpenedAt : undefined,
      dockOpenEvents: events
    });
  }
  return normalized.sort((left, right) => Number(left.pinOrder ?? 0) - Number(right.pinOrder ?? 0));
}

function sanitizeDockLayout(raw: unknown, profiles: DockProfile[], settings: ExtensionSettings): DockLayoutState {
  const fallback: DockLayoutState = {
    mode: settings.quickDockCollapsedByDefault ? "collapsed" : "expanded",
    pinned: false,
    activeProfileId: profiles[0]?.id ?? QUICKDOCK_DEFAULT_PROFILE_ID,
    updatedAt: nowIso()
  };

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const candidate = raw as Partial<DockLayoutState>;
  const mode = normalizeQuickDockMode(candidate.mode) ?? fallback.mode;
  const activeProfileId =
    typeof candidate.activeProfileId === "string" && profiles.some((entry) => entry.id === candidate.activeProfileId)
      ? candidate.activeProfileId
      : fallback.activeProfileId;

  return {
    mode,
    pinned: Boolean(candidate.pinned),
    activeProfileId,
    updatedAt: typeof candidate.updatedAt === "string" && candidate.updatedAt.trim() ? candidate.updatedAt : nowIso()
  };
}

function buildDefaultDockProfile(): DockProfile {
  const now = nowIso();
  return {
    id: QUICKDOCK_DEFAULT_PROFILE_ID,
    name: "默认 Profile",
    itemIds: [],
    createdAt: now,
    updatedAt: now
  };
}

function serializeDockPreferences(prefsById: Map<string, DockItemPreference>): DockItemPreference[] {
  return Array.from(prefsById.values()).sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) {
      return left.pinned ? -1 : 1;
    }
    return Number(left.pinOrder ?? 0) - Number(right.pinOrder ?? 0);
  });
}

function getPinnedIdsForProfile(storage: QuickDockStorage, profileId: string): string[] {
  const profile = storage.profiles.find((entry) => entry.id === profileId) ?? storage.profiles[0];
  const pinnedByPref = new Set(
    Array.from(storage.prefsById.values())
      .filter((entry) => entry.pinned)
      .map((entry) => entry.bookmarkId)
  );

  const ordered: string[] = [];
  for (const bookmarkId of profile.itemIds) {
    if (pinnedByPref.has(bookmarkId)) {
      ordered.push(bookmarkId);
    }
  }

  const extras = Array.from(storage.prefsById.values())
    .filter((entry) => entry.pinned && !ordered.includes(entry.bookmarkId))
    .sort((left, right) => Number(left.pinOrder ?? 0) - Number(right.pinOrder ?? 0))
    .map((entry) => entry.bookmarkId);

  return Array.from(new Set([...ordered, ...extras]));
}

function resolveQuickDockLimit(input: number | undefined, fallback: number): number {
  const candidate = Number.isFinite(input) ? Number(input) : fallback;
  if (candidate <= 0) {
    return fallback;
  }
  return Math.max(2, Math.min(10, Math.round(candidate)));
}

function getDockRecentClickCount(pref: DockItemPreference | undefined): number {
  if (!pref) {
    return 0;
  }
  const threshold = Date.now() - QUICKDOCK_EVENT_WINDOW_DAYS * 86_400_000;
  const events = (pref.dockOpenEvents ?? []).filter((entry) => {
    const ms = Date.parse(entry);
    return Number.isFinite(ms) && ms >= threshold;
  });
  if (events.length > 0) {
    return events.length;
  }
  return Math.max(0, Number(pref.dockOpenCount ?? 0));
}

function computeTimeDecayScore(timestamp: string | undefined, halfLifeDays: number): number {
  if (!timestamp) {
    return 0;
  }
  const ms = Date.parse(timestamp);
  if (!Number.isFinite(ms)) {
    return 0;
  }
  const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
  return clamp01(Math.exp(-ageDays / Math.max(1, halfLifeDays)));
}

function computeDomainAffinityScore(currentUrl: string | undefined, item: BookmarkItem): number {
  const currentHost = tryParseUrl(currentUrl)?.hostname?.toLowerCase() || "";
  const candidateHost = (item.domain || tryParseUrl(item.url)?.hostname || "").toLowerCase();
  if (!currentHost || !candidateHost) {
    return 0;
  }
  if (currentHost === candidateHost) {
    return 1;
  }
  if (currentHost.endsWith(`.${candidateHost}`) || candidateHost.endsWith(`.${currentHost}`)) {
    return 0.7;
  }
  const currentRoot = getRootDomain(currentHost);
  const candidateRoot = getRootDomain(candidateHost);
  if (currentRoot && candidateRoot && currentRoot === candidateRoot) {
    return 0.45;
  }
  return 0;
}

function getRootDomain(hostname: string): string {
  const parts = hostname.split(".").filter(Boolean);
  if (parts.length <= 2) {
    return hostname;
  }
  return parts.slice(-2).join(".");
}

function normalizeQuickDockMode(mode: unknown): DockLayoutState["mode"] | undefined {
  if (mode === "collapsed" || mode === "peek" || mode === "expanded") {
    return mode;
  }
  return undefined;
}

async function updateBookmark(payload: UpdateBookmarkPayload): Promise<void> {
  const item = await db.bookmarks.get(payload.id);
  if (!item) {
    throw new Error("Bookmark does not exist.");
  }

  const settings = await getSettingsFromStorage();
  const rules = await listCategoryRules();
  const categoryInput = payload.category ?? item.category;
  const normalizedCategory = await normalizeCategoryWithRules(categoryInput, rules, settings);

  const updated: BookmarkItem = {
    ...item,
    category: normalizedCategory,
    tags: normalizeTags(payload.tags ?? item.tags),
    userNote: payload.userNote ?? item.userNote,
    status: payload.status ?? inferStatus(item.status, normalizedCategory, payload.tags ?? item.tags),
    pinned: payload.pinned ?? Boolean(item.pinned),
    locked: payload.locked ?? Boolean(item.locked),
    deletedAt: undefined,
    updatedAt: nowIso(),
    syncState: "dirty"
  };
  updated.deletedAt = updated.status === "trashed" ? item.deletedAt || nowIso() : undefined;

  updated.searchText = buildSearchText(updated);
  await db.bookmarks.put(updated);
  queueEmbeddingRefresh(updated.id);
}

async function moveBookmarkToTrash(id: string): Promise<void> {
  const item = await db.bookmarks.get(id);
  if (!item) {
    throw new Error("Bookmark not found.");
  }
  if (item.locked) {
    throw new Error("Bookmark is locked and cannot be moved to trash.");
  }

  await db.bookmarks.update(id, {
    status: "trashed",
    deletedAt: nowIso(),
    updatedAt: nowIso(),
    syncState: "dirty"
  });
}

async function restoreBookmark(id: string): Promise<void> {
  const item = await db.bookmarks.get(id);
  if (!item) {
    throw new Error("Bookmark not found.");
  }

  const restoredStatus: BookmarkStatus = inferStatus("inbox", item.category, item.tags);
  await db.bookmarks.update(id, {
    status: restoredStatus,
    deletedAt: undefined,
    updatedAt: nowIso(),
    syncState: "dirty"
  });
}

async function deleteBookmarkPermanently(id: string): Promise<void> {
  const item = await db.bookmarks.get(id);
  if (!item) {
    return;
  }
  if (item.locked) {
    throw new Error("Bookmark is locked and cannot be deleted.");
  }
  await deleteCloudRowsForBookmarks([item]);
  await db.bookmarks.delete(id);
}

async function emptyTrash(payload: { olderThanDays?: number } | undefined): Promise<{ deletedCount: number }> {
  const olderThanDays = Number.isFinite(payload?.olderThanDays) ? Number(payload?.olderThanDays) : 0;
  const nowMs = Date.now();
  const all = await db.bookmarks.where("status").equals("trashed").toArray();

  const toDelete = all.filter((item) => {
    if (item.pinned || item.locked) {
      return false;
    }
    if (!olderThanDays || olderThanDays <= 0) {
      return true;
    }
    const deletedAtMs = Date.parse(item.deletedAt || item.updatedAt || item.createdAt || nowIso());
    const ageDays = (nowMs - deletedAtMs) / 86_400_000;
    return ageDays >= olderThanDays;
  });

  await deleteCloudRowsForBookmarks(toDelete);
  await db.bookmarks.bulkDelete(toDelete.map((item) => item.id));
  return { deletedCount: toDelete.length };
}

async function retryAiClassification(id: string): Promise<void> {
  const item = await db.bookmarks.get(id);
  if (!item) {
    throw new Error("Bookmark not found.");
  }

  const settings = await getSettingsFromStorage();
  if (!settings.apiKey) {
    await markBookmarkError(id, "AI key is missing. Configure it in Options.", settings);
    return;
  }

  const excludedPattern = getMatchedExcludedPattern(item.url, settings.excludedUrlPatterns);
  if (excludedPattern) {
    const updated: BookmarkItem = {
      ...item,
      status: "inbox",
      updatedAt: nowIso(),
      syncState: "dirty",
      aiMeta: {
        provider: "openai_compatible",
        baseUrl: settings.baseUrl,
        model: settings.model,
        promptVersion: PROMPT_VERSION,
        stage1: item.aiMeta?.stage1,
        stage2: item.aiMeta?.stage2,
        lastError: `AI skipped by privacy rule: ${excludedPattern}`
      }
    };
    updated.searchText = buildSearchText(updated);
    await db.bookmarks.put(updated);
    return;
  }

  const updatedStatus: BookmarkItem = {
    ...item,
    status: "analyzing",
    updatedAt: nowIso(),
    syncState: "dirty",
    deletedAt: undefined
  };
  updatedStatus.searchText = buildSearchText(updatedStatus);
  await db.bookmarks.put(updatedStatus);

  const synthesizedCapture: CapturePayload = {
    sessionId: `retry-${id}`,
    url: item.url,
    canonicalUrl: item.canonicalUrl,
    title: item.title,
    domain: item.domain,
    favIconUrl: item.favIconUrl,
    selection: item.userNote ?? "",
    text: [item.title, item.domain, item.aiSummary ?? "", item.userNote ?? ""].filter(Boolean).join("\n\n"),
    textDigest: item.contentCapture?.textDigest ?? "",
    textChars: item.contentCapture?.textChars ?? 0,
    captureMode: item.contentCapture?.captureMode ?? "dom_text",
    wasTruncated: false
  };

  try {
    const stage1 = await analyzeWithAi(settings, synthesizedCapture);
    const { topCategories, topTags } = await getTopFacets(30, 50);
    const classify = await classifyWithAi({
      settings,
      bookmark: item,
      stage1,
      userNote: item.userNote ?? "",
      selectedCategory: item.category,
      selectedTags: item.tags,
      topCategories,
      topTags
    });

    await finalizeBookmarkClassification({
      bookmarkId: id,
      category: classify.category,
      tags: classify.tags,
      reason: classify.shortReason,
      confidence: classify.confidence,
      settings
    });
  } catch (error) {
    await markBookmarkError(id, toErrorMessage(error), settings);
  }
}

async function listCategoryRules(): Promise<CategoryRule[]> {
  const rules = await db.categoryRules.toArray();
  return rules
    .map((rule) => ({
      ...rule,
      canonical: normalizeCategory(rule.canonical) || "",
      aliases: normalizeTags(rule.aliases ?? [])
    }))
    .filter((rule) => rule.canonical)
    .sort((left, right) => {
      if (left.pinned !== right.pinned) {
        return left.pinned ? -1 : 1;
      }
      return left.canonical.localeCompare(right.canonical);
    });
}

async function cleanupEmptyCategoryRules(): Promise<{ deletedCount: number; deletedCanonicals: string[] }> {
  const rules = await listCategoryRules();
  if (rules.length === 0) {
    return {
      deletedCount: 0,
      deletedCanonicals: []
    };
  }

  const bookmarks = await db.bookmarks.toArray();
  const referenced = new Set(
    bookmarks
      .map((item) => normalizeCategory(item.category))
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeLookup(value))
  );

  const stale = rules.filter((rule) => !referenced.has(normalizeLookup(rule.canonical)));
  if (stale.length === 0) {
    return {
      deletedCount: 0,
      deletedCanonicals: []
    };
  }

  for (const rule of stale) {
    await db.categoryRules.delete(rule.id);
  }

  return {
    deletedCount: stale.length,
    deletedCanonicals: stale.map((rule) => rule.canonical)
  };
}

async function upsertCategoryRule(payload: {
  id?: string;
  canonical: string;
  aliases?: string[];
  pinned?: boolean;
  color?: string;
}): Promise<CategoryRule> {
  const canonical = normalizeCategory(payload.canonical);
  if (!canonical) {
    throw new Error("Canonical category is required.");
  }

  const existingRules = await listCategoryRules();
  const sameCanonical = existingRules.find((item) => normalizeLookup(item.canonical) === normalizeLookup(canonical));
  const id = payload.id || sameCanonical?.id || crypto.randomUUID();

  const mergedAliases = normalizeTags([...(sameCanonical?.aliases ?? []), ...(payload.aliases ?? [])]).filter(
    (alias) => normalizeLookup(alias) !== normalizeLookup(canonical)
  );

  const nextRule: CategoryRule = {
    id,
    canonical,
    aliases: mergedAliases,
    pinned: payload.pinned ?? sameCanonical?.pinned ?? false,
    color: payload.color ?? sameCanonical?.color,
    updatedAt: nowIso()
  };

  await db.categoryRules.put(nextRule);
  return nextRule;
}

async function deleteCategoryRule(payload: { id: string; reassignTo?: string }): Promise<void> {
  const rule = await db.categoryRules.get(payload.id);
  if (!rule) {
    return;
  }

  const normalizedReassign = normalizeCategory(payload.reassignTo);
  if (normalizedReassign) {
    const bookmarks = await db.bookmarks.where("category").equals(rule.canonical).toArray();
    const settings = await getSettingsFromStorage();
    const rules = await listCategoryRules();
    for (const bookmark of bookmarks) {
      const category = await normalizeCategoryWithRules(normalizedReassign, rules, settings);
      const updated: BookmarkItem = {
        ...bookmark,
        category,
        updatedAt: nowIso(),
        syncState: "dirty"
      };
      updated.searchText = buildSearchText(updated);
      await db.bookmarks.put(updated);
      queueEmbeddingRefresh(updated.id);
    }
  }

  await db.categoryRules.delete(payload.id);
}

async function importBookmarks(payload: { items: BookmarkItem[]; categoryRules?: CategoryRule[] }): Promise<void> {
  const incomingRules = payload.categoryRules ?? [];
  for (const rule of incomingRules) {
    await upsertCategoryRule(rule);
  }

  const settings = await getSettingsFromStorage();
  const rules = await listCategoryRules();

  for (const rawItem of payload.items ?? []) {
    const normalizedUrl = normalizeUrl(rawItem.canonicalUrl || rawItem.url);
    if (!normalizedUrl) {
      continue;
    }

    const existing = await findExistingBookmark(normalizedUrl, rawItem.url);

    const normalizedCategory = await normalizeCategoryWithRules(rawItem.category, rules, settings);
    const normalizedTags = normalizeTags(rawItem.tags ?? []);

    if (!existing) {
      const created: BookmarkItem = {
        ...rawItem,
        id: rawItem.id || crypto.randomUUID(),
        status: rawItem.status || "inbox",
        deletedAt: rawItem.status === "trashed" ? rawItem.deletedAt || nowIso() : undefined,
        createdAt: rawItem.createdAt || nowIso(),
        updatedAt: nowIso(),
        lastSavedAt: rawItem.lastSavedAt || rawItem.updatedAt || nowIso(),
        saveCount: Math.max(1, Number(rawItem.saveCount || 1)),
        pinned: Boolean(rawItem.pinned),
        locked: Boolean(rawItem.locked),
        syncState: "dirty",
        category: normalizedCategory,
        tags: normalizedTags,
        searchText: ""
      };
      created.searchText = buildSearchText(created);
      await db.bookmarks.put(created);
      queueEmbeddingRefresh(created.id);
      continue;
    }

    const merged: BookmarkItem = {
      ...existing,
      ...rawItem,
      id: existing.id,
      url: existing.url || rawItem.url,
      canonicalUrl: rawItem.canonicalUrl || existing.canonicalUrl,
      category: normalizedCategory || existing.category,
      tags: normalizeTags([...(existing.tags ?? []), ...normalizedTags]),
      saveCount: Math.max(existing.saveCount ?? 1, rawItem.saveCount ?? 1),
      pinned: Boolean(rawItem.pinned ?? existing.pinned),
      locked: Boolean(rawItem.locked ?? existing.locked),
      syncState: "dirty",
      updatedAt: nowIso(),
      lastSavedAt: rawItem.lastSavedAt || existing.lastSavedAt || nowIso(),
      deletedAt: rawItem.status === "trashed" ? rawItem.deletedAt || nowIso() : undefined
    };

    merged.searchText = buildSearchText(merged);
    await db.bookmarks.put(merged);
    queueEmbeddingRefresh(merged.id);
  }
}

async function backfillFavicons(payload?: { limit?: number }): Promise<{ scanned: number; updated: number }> {
  const limit = Number.isFinite(payload?.limit) ? Math.max(1, Math.min(1000, Number(payload?.limit))) : 400;
  const all = await db.bookmarks.toArray();
  const targets = all.filter((item) => !item.favIconUrl).slice(0, limit);
  let updated = 0;

  for (const item of targets) {
    const nextIcon = deriveFaviconFallback(item.url, item.domain);
    if (!nextIcon) {
      continue;
    }
    await db.bookmarks.update(item.id, {
      favIconUrl: nextIcon,
      updatedAt: nowIso(),
      syncState: "dirty"
    });
    updated += 1;
  }

  return {
    scanned: targets.length,
    updated
  };
}

async function backfillEmbeddings(payload?: { limit?: number; delayMs?: number; resetCursor?: boolean }): Promise<{
  processed: number;
  updated: number;
  skipped: number;
  failed: number;
}> {
  const limit = Number.isFinite(payload?.limit) ? Math.max(1, Math.min(1_000, Number(payload?.limit))) : 200;
  const delayMs = Number.isFinite(payload?.delayMs) ? Math.max(0, Number(payload?.delayMs)) : BACKFILL_BATCH_DELAY_MS;

  return runBackfillJob({
    source: "manual",
    limit,
    delayMs,
    resetCursor: Boolean(payload?.resetCursor)
  });
}

async function runBackfillJob(input: {
  source: "manual" | "alarm";
  limit: number;
  delayMs: number;
  resetCursor?: boolean;
}): Promise<{ processed: number; updated: number; skipped: number; failed: number }> {
  const lock = await acquireJobLock(BACKFILL_JOB_ID);
  if (!lock.acquired) {
    return { processed: 0, updated: 0, skipped: 0, failed: 0 };
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let cursorUpdatedAt = input.resetCursor ? undefined : lock.state.cursorUpdatedAt;
  let cursorId = input.resetCursor ? undefined : lock.state.cursorId;

  try {
    const settings = await getSettingsFromStorage();
    if (!settings.semanticSearchEnabled || !settings.apiKey) {
      await releaseJobLock(BACKFILL_JOB_ID, {
        lastError: "Semantic search disabled or missing API key.",
        cursorUpdatedAt,
        cursorId
      });
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    const allCandidates = (await db.bookmarks.toArray())
      .filter((item) => item.status !== "trashed")
      .filter((item) => !item.locked)
      .filter((item) => !getMatchedExcludedPattern(item.url, settings.excludedUrlPatterns))
      .filter((item) => !item.embedding || item.embeddingModel !== settings.embeddingModel)
      .sort(compareByUpdatedAtThenId);

    const startIndex = findStartIndexByCursor(allCandidates, cursorUpdatedAt, cursorId);
    const batch = allCandidates.slice(startIndex, startIndex + input.limit);

    if (batch.length === 0) {
      await releaseJobLock(BACKFILL_JOB_ID, {
        cursorUpdatedAt: undefined,
        cursorId: undefined,
        lastError: undefined
      });
      return { processed: 0, updated: 0, skipped: 0, failed: 0 };
    }

    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const checkpointUpdatedAt = item.updatedAt || item.createdAt || nowIso();
      const checkpointId = item.id;
      processed += 1;

      try {
        const updatedOk = await runEmbeddingRefresh(item, settings);
        if (updatedOk) {
          updated += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        await persistJobProgress(BACKFILL_JOB_ID, {
          lastError: toErrorMessage(error)
        });
      }

      cursorUpdatedAt = checkpointUpdatedAt;
      cursorId = checkpointId;

      if ((index + 1) % BACKFILL_BATCH_SIZE === 0 || index === batch.length - 1) {
        await persistJobProgress(BACKFILL_JOB_ID, {
          cursorUpdatedAt,
          cursorId
        });
        if (index < batch.length - 1) {
          await sleep(input.delayMs);
        }
      }
    }

    await releaseJobLock(BACKFILL_JOB_ID, {
      cursorUpdatedAt,
      cursorId,
      lastError: failed > 0 ? `${failed} items failed in current batch` : undefined
    });
    return { processed, updated, skipped, failed };
  } catch (error) {
    await releaseJobLock(BACKFILL_JOB_ID, {
      cursorUpdatedAt,
      cursorId,
      lastError: toErrorMessage(error)
    });
    throw error;
  }
}

async function runRetentionCleanupJob(): Promise<void> {
  const lock = await acquireJobLock(TRASH_CLEANUP_JOB_ID);
  if (!lock.acquired) {
    return;
  }

  try {
    const settings = await getSettingsFromStorage();
    const result = await emptyTrash({ olderThanDays: settings.trashRetentionDays });
    await chrome.storage.local.set({ [STORAGE_LAST_CLEANUP_KEY]: nowIso() });

    await releaseJobLock(TRASH_CLEANUP_JOB_ID, {
      lastError: undefined
    });

    if (result.deletedCount > 0) {
      await notifyUser(`MuseMark cleaned ${result.deletedCount} expired trash items.`);
    }
  } catch (error) {
    await releaseJobLock(TRASH_CLEANUP_JOB_ID, {
      lastError: toErrorMessage(error)
    });
  }
}

async function purgeDemoBookmarksOnce(): Promise<void> {
  const storage = await chrome.storage.local.get(STORAGE_DEMO_PURGED_KEY);
  if (storage[STORAGE_DEMO_PURGED_KEY]) {
    return;
  }

  const all = await db.bookmarks.toArray();
  const demoItems = all.filter(isDemoBookmark);
  if (demoItems.length > 0) {
    await deleteCloudRowsForBookmarks(demoItems);
    await db.bookmarks.bulkDelete(demoItems.map((item) => item.id));
  }

  await chrome.storage.local.set({ [STORAGE_DEMO_PURGED_KEY]: true });
}

function isDemoBookmark(item: BookmarkItem): boolean {
  const candidate = `${item.canonicalUrl || ""} ${item.url || ""} ${item.aiSummary || ""} ${item.contentCapture?.textDigest || ""}`.toLowerCase();
  return candidate.includes("demo.musemark.local") || candidate.includes("demo #") || candidate.includes("demo_digest_");
}

async function runTypeReclassifyJobIfNeeded(source: "install" | "startup" | "settings"): Promise<void> {
  const settings = await getSettingsFromStorage();
  if (settings.classificationMode !== "by_type") {
    return;
  }

  const storage = await chrome.storage.local.get(STORAGE_TYPE_RECLASSIFY_DONE_KEY);
  if (storage[STORAGE_TYPE_RECLASSIFY_DONE_KEY]) {
    return;
  }

  for (let round = 0; round < 40; round += 1) {
    const result = await runTypeReclassifyJob({
      source,
      limit: TYPE_RECLASSIFY_BATCH_SIZE,
      delayMs: TYPE_RECLASSIFY_BATCH_DELAY_MS
    });

    if (result.completed) {
      await chrome.storage.local.set({ [STORAGE_TYPE_RECLASSIFY_DONE_KEY]: true });
      return;
    }

    if (result.processed === 0) {
      return;
    }
  }
}

async function runTypeReclassifyJob(input: {
  source: "install" | "startup" | "settings";
  limit: number;
  delayMs: number;
  resetCursor?: boolean;
}): Promise<{ processed: number; updated: number; skipped: number; failed: number; completed: boolean }> {
  const lock = await acquireJobLock(TYPE_RECLASSIFY_JOB_ID);
  if (!lock.acquired) {
    return { processed: 0, updated: 0, skipped: 0, failed: 0, completed: false };
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let cursorUpdatedAt = input.resetCursor ? undefined : lock.state.cursorUpdatedAt;
  let cursorId = input.resetCursor ? undefined : lock.state.cursorId;

  try {
    const settings = await getSettingsFromStorage();
    const allCandidates = (await db.bookmarks.toArray())
      .filter((item) => item.status !== "trashed")
      .sort(compareByUpdatedAtThenId);

    const startIndex = findStartIndexByCursor(allCandidates, cursorUpdatedAt, cursorId);
    const batch = allCandidates.slice(startIndex, startIndex + input.limit);

    if (batch.length === 0) {
      await releaseJobLock(TYPE_RECLASSIFY_JOB_ID, {
        cursorUpdatedAt: undefined,
        cursorId: undefined,
        lastError: undefined
      });
      return { processed: 0, updated: 0, skipped: 0, failed: 0, completed: true };
    }

    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const checkpointUpdatedAt = item.updatedAt || item.createdAt || nowIso();
      const checkpointId = item.id;
      processed += 1;

      try {
        const result = await reclassifyBookmarkToType(item, settings);
        if (result) {
          updated += 1;
        } else {
          skipped += 1;
        }
      } catch (error) {
        failed += 1;
        await persistJobProgress(TYPE_RECLASSIFY_JOB_ID, {
          lastError: toErrorMessage(error)
        });
      }

      cursorUpdatedAt = checkpointUpdatedAt;
      cursorId = checkpointId;

      if ((index + 1) % BACKFILL_BATCH_SIZE === 0 || index === batch.length - 1) {
        await persistJobProgress(TYPE_RECLASSIFY_JOB_ID, {
          cursorUpdatedAt,
          cursorId
        });
        if (index < batch.length - 1) {
          await sleep(input.delayMs);
        }
      }
    }

    await releaseJobLock(TYPE_RECLASSIFY_JOB_ID, {
      cursorUpdatedAt,
      cursorId,
      lastError: failed > 0 ? `${failed} items failed in current batch` : undefined
    });

    return { processed, updated, skipped, failed, completed: false };
  } catch (error) {
    await releaseJobLock(TYPE_RECLASSIFY_JOB_ID, {
      cursorUpdatedAt,
      cursorId,
      lastError: toErrorMessage(error)
    });
    throw error;
  }
}

async function reclassifyBookmarkToType(item: BookmarkItem, settings: ExtensionSettings): Promise<boolean> {
  const excludedPattern = getMatchedExcludedPattern(item.url, settings.excludedUrlPatterns);
  let nextCategory = inferBookmarkTypeFromMetadata(item);
  let nextConfidence = clamp01(Number(item.classificationConfidence ?? 0.42));

  if (settings.apiKey && !excludedPattern) {
    try {
      const stage1: AnalyzeOutput = {
        summary: item.aiSummary || `${item.title} (${item.domain})`,
        keyTopics: tokenize(item.aiSummary || item.title).slice(0, 8),
        suggestedCategoryCandidates: [nextCategory],
        suggestedTags: normalizeTags(item.tags ?? []).slice(0, 8),
        language: "unknown",
        confidence: 0.5
      };
      const classify = await classifyWithAi({
        settings,
        bookmark: item,
        stage1,
        userNote: item.userNote ?? "",
        selectedCategory: undefined,
        selectedTags: item.tags ?? [],
        topCategories: [...BOOKMARK_TYPE_CATEGORIES],
        topTags: []
      });
      nextCategory = normalizeTypeCategory(classify.category);
      nextConfidence = clamp01(Number(classify.confidence ?? 0.55));
    } catch {
      nextCategory = inferBookmarkTypeFromMetadata(item);
      nextConfidence = clamp01(Number(item.classificationConfidence ?? 0.42));
    }
  }

  const currentCategory = normalizeTypeCategory(item.category);
  const nextStatus = inferStatus(item.status, nextCategory, item.tags);
  const unchanged = currentCategory === nextCategory && item.status === nextStatus;
  if (unchanged) {
    return false;
  }

  const updated: BookmarkItem = {
    ...item,
    category: nextCategory,
    status: nextStatus,
    classificationConfidence: nextConfidence,
    updatedAt: nowIso(),
    syncState: "dirty",
    aiMeta: {
      provider: "openai_compatible",
      baseUrl: settings.baseUrl,
      model: settings.model,
      promptVersion: PROMPT_VERSION,
      stage1: item.aiMeta?.stage1,
      stage2: {
        finishedAt: nowIso(),
        confidence: nextConfidence
      },
      lastError: excludedPattern ? `AI skipped by privacy rule: ${excludedPattern}` : undefined
    }
  };
  updated.searchText = buildSearchText(updated);
  await db.bookmarks.put(updated);
  queueEmbeddingRefresh(updated.id);
  return true;
}

async function acquireJobLock(jobId: string): Promise<{ acquired: boolean; state: JobState }> {
  const result = await db.transaction("rw", db.jobs, async () => {
    const nowMs = Date.now();
    const existing = await db.jobs.get(jobId);

    if (existing?.running && existing.leaseUntil > nowMs) {
      return {
        acquired: false,
        state: existing
      };
    }

    const nextState: JobState = {
      ...(existing ?? { id: jobId }),
      id: jobId,
      running: true,
      leaseUntil: nowMs + JOB_LEASE_MS,
      updatedAt: nowIso()
    };
    await db.jobs.put(nextState);
    return {
      acquired: true,
      state: nextState
    };
  });

  return result;
}

async function persistJobProgress(jobId: string, patch: Partial<JobState>): Promise<void> {
  const existing = await db.jobs.get(jobId);
  const merged: JobState = {
    ...(existing ?? {
      id: jobId,
      running: true,
      leaseUntil: 0,
      updatedAt: nowIso()
    }),
    ...patch,
    id: jobId,
    running: true,
    leaseUntil: Date.now() + JOB_LEASE_MS,
    updatedAt: nowIso()
  };
  await db.jobs.put(merged);
}

async function releaseJobLock(jobId: string, patch: Partial<JobState>): Promise<void> {
  const existing = await db.jobs.get(jobId);
  const merged: JobState = {
    ...(existing ?? {
      id: jobId,
      running: false,
      leaseUntil: 0,
      updatedAt: nowIso()
    }),
    ...patch,
    id: jobId,
    running: false,
    leaseUntil: 0,
    lastRunAt: nowIso(),
    updatedAt: nowIso()
  };
  await db.jobs.put(merged);
}

function queueEmbeddingRefresh(bookmarkId: string): void {
  if (embeddingInFlight.has(bookmarkId)) {
    return;
  }

  embeddingInFlight.add(bookmarkId);
  void (async () => {
    try {
      const item = await db.bookmarks.get(bookmarkId);
      const settings = await getSettingsFromStorage();
      if (!item) {
        return;
      }
      await runEmbeddingRefresh(item, settings);
    } catch {
      return;
    } finally {
      embeddingInFlight.delete(bookmarkId);
    }
  })();
}

async function runEmbeddingRefresh(item: BookmarkItem, settings: ExtensionSettings): Promise<boolean> {
  if (!settings.semanticSearchEnabled || !settings.apiKey) {
    return false;
  }
  if (item.status === "trashed") {
    return false;
  }
  if (getMatchedExcludedPattern(item.url, settings.excludedUrlPatterns)) {
    return false;
  }

  const sourceText = buildEmbeddingSource(item, settings);
  if (!sourceText) {
    return false;
  }

  const vector = await withTimeout(generateEmbedding(settings, sourceText), EMBEDDING_TIMEOUT_MS, "Embedding timed out");

  await db.bookmarks.update(item.id, {
    embedding: vector,
    embeddingModel: settings.embeddingModel,
    embeddingUpdatedAt: nowIso()
  });

  return true;
}

async function analyzeWithAi(settings: ExtensionSettings, capture: CapturePayload): Promise<AnalyzeOutput> {
  const cleanedContent = normalizeAiText(capture.text, settings.maxChars);
  const messageText = [
    `URL: ${capture.url}`,
    `Title: ${capture.title}`,
    `Domain: ${capture.domain}`,
    `Selection: ${capture.selection || "(none)"}`,
    "Content:",
    cleanedContent
  ].join("\n");

  const content = await callChatRaw(settings, [
    {
      role: "system",
      content:
        "You are a bookmark analyst. Return JSON only with keys: summary, keyTopics, suggestedCategoryCandidates, suggestedTags, language, confidence."
    },
    {
      role: "user",
      content: messageText
    }
  ]);

  return parseAnalyzeOutput(content, settings);
}

async function classifyWithAi(input: {
  settings: ExtensionSettings;
  bookmark: BookmarkItem;
  stage1: AnalyzeOutput;
  userNote: string;
  selectedCategory?: string;
  selectedTags: string[];
  topCategories: string[];
  topTags: string[];
}): Promise<ClassifyOutput> {
  const rules = await listCategoryRules();
  const classificationMode = input.settings.classificationMode === "by_content" ? "by_content" : "by_type";
  const isTypeMode = classificationMode === "by_type";

  const systemPrompt = isTypeMode
    ? `You classify bookmarks by LINK TYPE (site/source type), not by page topic. Return JSON only with keys: category, tags, shortReason, confidence. category must be exactly one of: ${BOOKMARK_TYPE_CATEGORIES.join(
        ", "
      )}. If uncertain pick ${BOOKMARK_TYPE_FALLBACK}. tags should be 2-6 concise tags.`
    : "You are an assistant for bookmark organization. Return JSON only with keys: category, tags, shortReason, confidence. category must be a short phrase. tags should be 3-8 concise tags. Prefer existing categories when semantically close.";

  const userPrompt = isTypeMode
    ? [
        `URL: ${input.bookmark.url}`,
        `Title: ${input.bookmark.title}`,
        `Domain: ${input.bookmark.domain}`,
        `Stage1 summary: ${input.stage1.summary}`,
        `Stage1 topics: ${input.stage1.keyTopics.join(", ")}`,
        `Suggested tags: ${input.stage1.suggestedTags.join(", ")}`,
        `User note: ${input.userNote || "(none)"}`,
        `User selected category: ${input.selectedCategory || "(none)"}`,
        `User selected tags: ${input.selectedTags.join(", ") || "(none)"}`,
        `Classify by bookmark link type: source/website nature (e.g., blog, docs, journal, tool), NOT by article topic.`
      ].join("\n")
    : [
        `URL: ${input.bookmark.url}`,
        `Title: ${input.bookmark.title}`,
        `Domain: ${input.bookmark.domain}`,
        `Stage1 summary: ${input.stage1.summary}`,
        `Stage1 topics: ${input.stage1.keyTopics.join(", ")}`,
        `Suggested categories: ${input.stage1.suggestedCategoryCandidates.join(", ")}`,
        `Suggested tags: ${input.stage1.suggestedTags.join(", ")}`,
        `User note: ${input.userNote || "(none)"}`,
        `User selected category: ${input.selectedCategory || "(none)"}`,
        `User selected tags: ${input.selectedTags.join(", ") || "(none)"}`,
        `Existing top categories: ${input.topCategories.join(", ") || "(none)"}`,
        `Existing top tags: ${input.topTags.join(", ") || "(none)"}`,
        `Category rules canonical: ${rules.map((rule) => rule.canonical).join(", ") || "(none)"}`
      ].join("\n");

  const raw = await callChatRaw(input.settings, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]);

  const parsed = await parseClassifyOutput(raw, input.settings);

  const chosenCategory = normalizeCategory(input.selectedCategory) || parsed.category;
  const normalizedCategory = isTypeMode
    ? normalizeTypeCategory(chosenCategory)
    : await normalizeCategoryWithRules(chosenCategory, rules, input.settings, input.topCategories);

  const tags = normalizeTags([...input.selectedTags, ...parsed.tags]);

  return {
    ...parsed,
    category: normalizedCategory || (isTypeMode ? BOOKMARK_TYPE_FALLBACK : "Uncategorized"),
    tags
  };
}

async function callChatRaw(
  settings: ExtensionSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<string> {
  await ensureUrlPermission(settings.baseUrl, {
    reason: "AI service",
    requestIfMissing: false
  });
  const endpoint = resolveChatCompletionsEndpoint(settings.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      messages
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`AI request failed (${response.status}): ${text.slice(0, 280)}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | Array<{ type?: string; text?: string }>;
      };
    }>;
  };

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content.map((part) => part.text ?? "").join("").trim();
    if (text) {
      return text;
    }
  }

  throw new Error("AI response did not contain text content.");
}

async function callWebSearchRaw(settings: ExtensionSettings, query: string): Promise<string> {
  await ensureUrlPermission(settings.baseUrl, {
    reason: "AI service",
    requestIfMissing: false
  });

  const endpoint = resolveResponsesEndpoint(settings.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      input: [
        {
          role: "system",
          content:
            "You analyze search intent for bookmark retrieval. Return JSON only with keys aliases, keywords, reason. aliases/keywords should be short strings."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Query: ${query}\nNeed: infer likely entities, aliases, and concrete keywords for better retrieval.`
            }
          ]
        }
      ],
      tools: [{ type: "web_search_preview" }],
      temperature: 0
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Web augment request failed (${response.status}): ${text.slice(0, 280)}`);
  }

  const data = (await response.json()) as {
    output_text?: string;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const fallbackText = (data.output ?? [])
    .flatMap((entry) => entry.content ?? [])
    .map((part) => (part.type === "text" || part.type === "output_text" ? part.text ?? "" : ""))
    .join("")
    .trim();

  if (fallbackText) {
    return fallbackText;
  }

  throw new Error("Web augment response is empty.");
}

async function generateEmbedding(settings: ExtensionSettings, text: string): Promise<number[]> {
  await ensureUrlPermission(settings.baseUrl, {
    reason: "AI service",
    requestIfMissing: false
  });
  const endpoint = resolveEmbeddingsEndpoint(settings.baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      input: text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding request failed (${response.status}): ${body.slice(0, 280)}`);
  }

  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };

  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0) {
    throw new Error("Embedding response is empty.");
  }

  return embedding;
}

async function parseAnalyzeOutput(raw: string, settings: ExtensionSettings): Promise<AnalyzeOutput> {
  const parsed = await parseJsonWithRepair(raw, settings);
  const value = parsed as Partial<AnalyzeOutput>;

  return {
    summary: (value.summary ?? "").toString().trim() || "No summary generated.",
    keyTopics: normalizeTags((value.keyTopics ?? []).map(String)),
    suggestedCategoryCandidates: normalizeTags((value.suggestedCategoryCandidates ?? []).map(String)).slice(0, 6),
    suggestedTags: normalizeTags((value.suggestedTags ?? []).map(String)).slice(0, 12),
    language: (value.language ?? "unknown").toString().slice(0, 32),
    confidence: clamp01(Number(value.confidence ?? 0.5))
  };
}

async function parseClassifyOutput(raw: string, settings: ExtensionSettings): Promise<ClassifyOutput> {
  const parsed = await parseJsonWithRepair(raw, settings);
  const value = parsed as Partial<ClassifyOutput>;

  return {
    category: normalizeCategory(value.category) || "Uncategorized",
    tags: normalizeTags((value.tags ?? []).map(String)),
    shortReason: (value.shortReason ?? "").toString().trim().slice(0, 240),
    confidence: clamp01(Number(value.confidence ?? 0.5))
  };
}

async function parseJsonWithRepair(raw: string, settings: ExtensionSettings): Promise<unknown> {
  try {
    return extractJson(raw);
  } catch {
    const repaired = await repairJson(raw, settings);
    return extractJson(repaired);
  }
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Empty model output.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error("Model output is not valid JSON.");
  }
}

async function repairJson(raw: string, settings: ExtensionSettings): Promise<string> {
  return callChatRaw(settings, [
    {
      role: "system",
      content: "You repair malformed JSON. Output valid JSON only. Do not add explanations."
    },
    {
      role: "user",
      content: raw
    }
  ]);
}

async function testAiConnection(): Promise<{ success: boolean; model: string }> {
  const settings = await getSettingsFromStorage();
  if (!settings.apiKey) {
    throw new Error("API key is missing.");
  }

  await callChatRaw(settings, [
    {
      role: "system",
      content: "You are a concise assistant."
    },
    {
      role: "user",
      content: "Reply with: ok"
    }
  ]);

  return { success: true, model: settings.model };
}

async function getTopFacets(categoryLimit: number, tagLimit: number): Promise<{ topCategories: string[]; topTags: string[] }> {
  const facets = await getFacetData("library");
  return {
    topCategories: facets.categories.slice(0, categoryLimit).map((entry) => entry.value),
    topTags: facets.tags.slice(0, tagLimit).map((entry) => entry.value)
  };
}

async function normalizeCategoryWithRules(
  category: string | undefined,
  rules: CategoryRule[],
  settings: ExtensionSettings,
  fallbackExisting: string[] = []
): Promise<string | undefined> {
  const trimmed = normalizeCategory(category);
  if (!trimmed) {
    return undefined;
  }

  const lookup = normalizeLookup(trimmed);

  for (const rule of rules) {
    if (normalizeLookup(rule.canonical) === lookup) {
      return rule.canonical;
    }

    if (rule.aliases.some((alias) => normalizeLookup(alias) === lookup)) {
      return rule.canonical;
    }
  }

  if (!settings.preferReuseCategories) {
    return trimmed;
  }

  const candidatePool = Array.from(new Set([...rules.map((rule) => rule.canonical), ...fallbackExisting].filter(Boolean)));
  if (candidatePool.length === 0) {
    return trimmed;
  }

  const nearest = findNearestCategory(trimmed, candidatePool);
  if (nearest && nearest.similarity >= 0.72) {
    return nearest.value;
  }

  return trimmed;
}

function normalizeTypeCategory(category: string | undefined): BookmarkTypeCategory {
  const normalized = normalizeLookup(category ?? "");
  if (!normalized) {
    return BOOKMARK_TYPE_FALLBACK;
  }

  for (const candidate of BOOKMARK_TYPE_CATEGORIES) {
    if (normalizeLookup(candidate) === normalized) {
      return candidate;
    }
  }

  const aliasMap: Record<BookmarkTypeCategory, string[]> = {
    个人博客: ["blog", "个人", "博客", "medium", "substack", "devto"],
    官方文档: ["docs", "documentation", "manual", "developer", "api reference", "官方文档"],
    网络安全: ["security", "infosec", "cve", "owasp", "攻防", "漏洞", "网络安全"],
    期刊论文: ["paper", "journal", "arxiv", "doi", "论文", "期刊"],
    科技工具: ["tool", "saas", "app", "platform", "科技工具", "软件"],
    资源网站: ["resource", "directory", "awesome", "link list", "导航", "资源"],
    新闻媒体: ["news", "media", "press", "报道", "新闻"],
    社区论坛: ["community", "forum", "discussion", "reddit", "hn", "社区", "论坛"],
    视频课程: ["course", "tutorial", "video", "youtube", "bilibili", "课程", "教程"],
    代码仓库: ["github", "gitlab", "repository", "repo", "源码", "代码仓库"]
  };

  for (const [candidate, aliases] of Object.entries(aliasMap) as Array<[BookmarkTypeCategory, string[]]>) {
    if (aliases.some((alias) => normalized.includes(normalizeLookup(alias)))) {
      return candidate;
    }
  }

  const nearest = findNearestCategory(normalized, [...BOOKMARK_TYPE_CATEGORIES]);
  if (nearest && nearest.similarity >= 0.5) {
    return nearest.value as BookmarkTypeCategory;
  }

  return BOOKMARK_TYPE_FALLBACK;
}

function inferBookmarkTypeFromMetadata(item: Pick<BookmarkItem, "url" | "domain" | "title" | "aiSummary">): BookmarkTypeCategory {
  const domain = (item.domain ?? "").toLowerCase();
  const url = (item.url ?? "").toLowerCase();
  const title = (item.title ?? "").toLowerCase();
  const summary = (item.aiSummary ?? "").toLowerCase();
  const text = `${domain} ${url} ${title} ${summary}`;

  const byDomainContains = (values: string[]): boolean => values.some((value) => domain.includes(value));
  const byTextContains = (values: string[]): boolean => values.some((value) => text.includes(value));

  if (byDomainContains(["github.com", "gitlab.com", "bitbucket.org"]) || byTextContains(["repository", "repo", "source code", "源码"])) {
    return "代码仓库";
  }
  if (
    byDomainContains(["arxiv.org", "ieeexplore.ieee.org", "acm.org", "nature.com", "sciencedirect.com", "springer.com"]) ||
    byTextContains(["journal", "paper", "preprint", "doi", "论文"])
  ) {
    return "期刊论文";
  }
  if (
    byDomainContains(["owasp.org", "cisa.gov", "nist.gov", "krebsonsecurity.com", "hackerone.com", "mitre.org"]) ||
    byTextContains(["cve", "vulnerability", "exploit", "security", "网络安全", "漏洞"])
  ) {
    return "网络安全";
  }
  if (
    byDomainContains(["developer.", "docs.", "readthedocs.io", "developers.", "learn.microsoft.com", "platform.openai.com"]) ||
    byTextContains(["documentation", "api reference", "guide", "/docs", "官方文档"])
  ) {
    return "官方文档";
  }
  if (
    byDomainContains(["youtube.com", "youtu.be", "bilibili.com", "coursera.org", "udemy.com", "edx.org"]) ||
    byTextContains(["course", "tutorial video", "lesson", "视频课程"])
  ) {
    return "视频课程";
  }
  if (
    byDomainContains(["reddit.com", "news.ycombinator.com", "stackoverflow.com", "lobste.rs", "discourse"]) ||
    byTextContains(["forum", "discussion", "ask", "community", "论坛"])
  ) {
    return "社区论坛";
  }
  if (
    byDomainContains(["nytimes.com", "reuters.com", "theverge.com", "techcrunch.com", "bbc.com", "wsj.com"]) ||
    byTextContains(["news", "breaking", "报道", "快讯"])
  ) {
    return "新闻媒体";
  }
  if (
    byDomainContains(["medium.com", "substack.com", "hashnode.com", "dev.to", "blog"]) ||
    byTextContains(["blog", "个人博客", "作者"])
  ) {
    return "个人博客";
  }
  if (
    byDomainContains(["figma.com", "notion.so", "linear.app", "slack.com", "zapier.com", "openai.com"]) ||
    byTextContains(["tool", "platform", "saas", "automation", "工具"])
  ) {
    return "科技工具";
  }
  if (byTextContains(["awesome", "resource", "directory", "library", "导航", "合集", "资源"])) {
    return "资源网站";
  }

  return "资源网站";
}

function findNearestCategory(input: string, categories: string[]): { value: string; similarity: number } | undefined {
  let best: { value: string; similarity: number } | undefined;

  for (const category of categories) {
    const similarity = bigramDiceSimilarity(normalizeLookup(input), normalizeLookup(category));
    if (!best || similarity > best.similarity) {
      best = { value: category, similarity };
    }
  }

  return best;
}

function compareByUpdatedAtThenId(left: BookmarkItem, right: BookmarkItem): number {
  const leftUpdated = left.updatedAt || left.createdAt || "";
  const rightUpdated = right.updatedAt || right.createdAt || "";
  const updatedCompare = leftUpdated.localeCompare(rightUpdated);
  if (updatedCompare !== 0) {
    return updatedCompare;
  }
  return left.id.localeCompare(right.id);
}

function findStartIndexByCursor(items: BookmarkItem[], cursorUpdatedAt?: string, cursorId?: string): number {
  if (!cursorUpdatedAt || !cursorId) {
    return 0;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const compareUpdated = (item.updatedAt || item.createdAt || "").localeCompare(cursorUpdatedAt);
    if (compareUpdated > 0) {
      return index;
    }
    if (compareUpdated === 0 && item.id.localeCompare(cursorId) > 0) {
      return index;
    }
  }

  return items.length;
}

function getMatchedExcludedPattern(url: string | undefined, patterns: string[]): string | undefined {
  if (!url || !Array.isArray(patterns) || patterns.length === 0) {
    return undefined;
  }

  for (const rawPattern of patterns) {
    const pattern = (rawPattern ?? "").trim();
    if (!pattern) {
      continue;
    }

    if (!pattern.includes("*")) {
      if (url.includes(pattern)) {
        return pattern;
      }
      continue;
    }

    try {
      const regex = wildcardPatternToRegExp(pattern);
      if (regex.test(url)) {
        return pattern;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

function wildcardPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

async function getAuthStorageState(): Promise<AuthStorageState> {
  if (authStorageCache) {
    return authStorageCache;
  }
  const raw = await chrome.storage.local.get(STORAGE_AUTH_STATE_KEY);
  const value = sanitizeAuthStorageState(raw[STORAGE_AUTH_STATE_KEY]);
  authStorageCache = value;
  return value;
}

async function saveAuthStorageState(next: AuthStorageState): Promise<AuthStorageState> {
  const normalized = sanitizeAuthStorageState(next);
  authStorageCache = normalized;
  await chrome.storage.local.set({ [STORAGE_AUTH_STATE_KEY]: normalized });
  return normalized;
}

function sanitizeAuthStorageState(raw: unknown): AuthStorageState {
  const value = (raw ?? {}) as Partial<AuthStorageState>;
  const session = value.session;
  const provider = session?.provider;
  const safeProvider: AuthProvider | undefined = provider === "google" || provider === "email_magic_link" ? provider : undefined;

  const safe: AuthStorageState = {
    syncStatus: value.syncStatus === "syncing" || value.syncStatus === "error" ? value.syncStatus : "idle",
    lastSyncAt: typeof value.lastSyncAt === "string" ? value.lastSyncAt : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError.slice(0, 500) : undefined,
    pendingState: typeof value.pendingState === "string" ? value.pendingState : undefined,
    pendingNonce: typeof value.pendingNonce === "string" ? value.pendingNonce : undefined,
    pendingStateExpiresAt: typeof value.pendingStateExpiresAt === "string" ? value.pendingStateExpiresAt : undefined
  };

  if (session && safeProvider && session.accessToken && session.user?.id && session.user?.email) {
    safe.session = {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      provider: safeProvider,
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
        avatarUrl: session.user.avatarUrl,
        provider: safeProvider
      }
    };
  }

  return safe;
}

async function ensureSyncMetaRow(): Promise<SyncMetaRow> {
  const existing = await db.syncMeta.get("main");
  if (existing) {
    return existing;
  }
  const created: SyncMetaRow = {
    id: "main",
    migrationDone: false,
    updatedAt: nowIso()
  };
  await db.syncMeta.put(created);
  return created;
}

async function updateSyncMeta(patch: Partial<SyncMetaRow>): Promise<SyncMetaRow> {
  const existing = await ensureSyncMetaRow();
  const next: SyncMetaRow = {
    ...existing,
    ...patch,
    id: "main",
    updatedAt: nowIso()
  };
  await db.syncMeta.put(next);
  return next;
}

async function getAuthState(): Promise<AuthState> {
  const auth = await getAuthStorageState();
  let session = auth.session;
  const settings = await getSettingsFromStorage();

  if (session && settings.cloudSyncEnabled) {
    try {
      session = await refreshAuthSessionIfNeeded(settings, session);
      if (session !== auth.session) {
        await saveAuthStorageState({
          ...auth,
          session
        });
      }
    } catch (error) {
      await saveAuthStorageState({
        ...auth,
        syncStatus: "error",
        lastError: toErrorMessage(error)
      });
    }
  }

  const meta = await ensureSyncMetaRow();
  if (!session) {
    return {
      mode: "guest",
      syncStatus: auth.syncStatus ?? "idle",
      lastSyncAt: auth.lastSyncAt,
      lastError: auth.lastError
    };
  }

  const needsMigration = meta.activeUserId !== session.user.id || !meta.migrationDone;
  return {
    mode: "authenticated",
    user: {
      ...session.user,
      provider: session.provider
    },
    syncStatus: auth.syncStatus ?? "idle",
    lastSyncAt: auth.lastSyncAt,
    lastError: auth.lastError,
    needsMigration
  };
}

async function getAuthDebugState(): Promise<Record<string, unknown>> {
  const auth = await getAuthStorageState();
  const meta = await ensureSyncMetaRow();
  const quickDock = await getQuickDockDebugSummary();
  return {
    hasSession: Boolean(auth.session),
    userId: auth.session?.user.id,
    email: auth.session?.user.email,
    provider: auth.session?.provider,
    expiresAt: auth.session?.expiresAt,
    accessToken: maskToken(auth.session?.accessToken),
    refreshToken: maskToken(auth.session?.refreshToken),
    syncStatus: auth.syncStatus,
    lastSyncAt: auth.lastSyncAt,
    lastError: auth.lastError,
    pendingState: auth.pendingState,
    pendingStateExpiresAt: auth.pendingStateExpiresAt,
    syncMeta: meta,
    quickDock
  };
}

async function getQuickDockDebugSummary(): Promise<Record<string, unknown>> {
  const settings = await getSettingsFromStorage();
  const storage = await ensureQuickDockStorage(settings);
  const prefs = Array.from(storage.prefsById.values());
  const pinnedCount = prefs.filter((entry) => entry.pinned).length;
  const dismissedCount = prefs.filter((entry) => {
    const ms = entry.dismissedUntil ? Date.parse(entry.dismissedUntil) : Number.NaN;
    return Number.isFinite(ms) && ms > Date.now();
  }).length;

  const topClicked = prefs
    .map((entry) => ({
      id: entry.bookmarkId,
      opens: getDockRecentClickCount(entry)
    }))
    .sort((left, right) => right.opens - left.opens)
    .slice(0, 5);

  return {
    enabled: settings.quickDockEnabled,
    profileCount: storage.profiles.length,
    activeProfileId: storage.layout.activeProfileId,
    pinnedCount,
    dismissedCount,
    mode: storage.layout.mode,
    topClicked
  };
}

async function signInOAuth(provider: "google"): Promise<{ state: AuthState }> {
  if (provider !== "google") {
    throw new Error("OAuth provider must be google.");
  }

  const settings = await getSettingsFromStorage();
  assertSupabaseConfigured(settings);
  await ensureUrlPermission(settings.supabaseUrl, {
    reason: "Supabase",
    requestIfMissing: false
  });

  try {
    const redirectUri = chrome.identity.getRedirectURL("auth-callback");
    const pkceStorage = createMemoryStorage();
    const supabase = createSupabaseAuthClient(settings, pkceStorage);
    const oauthResponse = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: redirectUri,
        scopes: "openid email profile",
        skipBrowserRedirect: true
      }
    });

    if (oauthResponse.error) {
      throw new Error(oauthResponse.error.message);
    }
    const authUrl = oauthResponse.data.url;
    if (!authUrl) {
      throw new Error("Supabase OAuth did not return authorize URL.");
    }

    const redirectedTo = await launchOAuthFlow(authUrl);
    const result = parseOAuthResult(redirectedTo);
    if (result.errorDescription || result.error) {
      throw new Error(result.errorDescription || result.error);
    }

    if (!result.code) {
      throw new Error("OAuth succeeded but no authorization code was returned.");
    }

    const exchanged = await supabase.auth.exchangeCodeForSession(result.code);
    if (exchanged.error) {
      throw new Error(exchanged.error.message);
    }
    const exchangedSession = exchanged.data.session;
    if (!exchangedSession?.access_token) {
      throw new Error("Code exchange succeeded but no access token was returned.");
    }

    const session = await buildSessionFromTokenResult(
      settings,
      {
        accessToken: exchangedSession.access_token,
        refreshToken: exchangedSession.refresh_token,
        expiresIn: exchangedSession.expires_in
      },
      provider
    );

    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      session,
      syncStatus: "idle",
      lastError: undefined,
      pendingState: undefined,
      pendingNonce: undefined,
      pendingStateExpiresAt: undefined
    });

    await updateSyncMeta({
      activeUserId: session.user.id,
      migrationDone: false
    });

    runBackgroundTask("syncNow(auth)", () => syncNow("auth"));

    return {
      state: await getAuthState()
    };
  } catch (error) {
    const friendly = toFriendlyAuthError(toErrorMessage(error));
    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      syncStatus: "error",
      lastError: friendly,
      pendingState: undefined,
      pendingNonce: undefined,
      pendingStateExpiresAt: undefined
    });
    throw new Error(friendly);
  }
}

async function sendMagicLink(email: string): Promise<{ sent: boolean; hint: string }> {
  const normalizedEmail = (email ?? "").trim().toLowerCase();
  if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw new Error("Please enter a valid email.");
  }

  const settings = await getSettingsFromStorage();
  assertSupabaseConfigured(settings);
  assertAuthBridgeConfigured(settings);
  await ensureUrlPermission(settings.supabaseUrl, {
    reason: "Supabase",
    requestIfMissing: false
  });

  const pendingState = crypto.randomUUID();
  const pendingNonce = crypto.randomUUID();
  await persistPendingBridgeState(pendingState, pendingNonce);

  const callbackUrl = new URL(`${settings.authBridgeUrl.replace(/\/+$/, "")}/auth/callback`);
  callbackUrl.searchParams.set("ext", chrome.runtime.id);
  callbackUrl.searchParams.set("state", pendingState);
  callbackUrl.searchParams.set("nonce", pendingNonce);
  callbackUrl.searchParams.set("supabase_url", settings.supabaseUrl);
  callbackUrl.searchParams.set("supabase_anon_key", settings.supabaseAnonKey);

  const response = await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, "/auth/v1/otp"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: settings.supabaseAnonKey
    },
    body: JSON.stringify({
      email: normalizedEmail,
      create_user: true,
      email_redirect_to: callbackUrl.toString()
    })
  });

  if (!response.ok) {
    const body = await response.text();
    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      pendingState: undefined,
      pendingNonce: undefined,
      pendingStateExpiresAt: undefined
    });
    throw new Error(`Magic Link request failed (${response.status}): ${body.slice(0, 240)}`);
  }

  return {
    sent: true,
    hint: "Magic Link 已发送，请在邮箱中点击后回到扩展完成登录。"
  };
}

async function signOut(): Promise<void> {
  const auth = await getAuthStorageState();
  const settings = await getSettingsFromStorage();
  const accessToken = auth.session?.accessToken;
  if (settings.supabaseUrl && settings.supabaseAnonKey && accessToken) {
    try {
      await ensureUrlPermission(settings.supabaseUrl, {
        reason: "Supabase",
        requestIfMissing: false
      });
      await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, "/auth/v1/logout"), {
        method: "POST",
        headers: {
          apikey: settings.supabaseAnonKey,
          Authorization: `Bearer ${accessToken}`
        }
      });
    } catch {
      // Keep local sign-out reliable even when network fails.
    }
  }

  await saveAuthStorageState({
    syncStatus: "idle",
    lastSyncAt: auth.lastSyncAt
  });
}

async function handleBridgeCompleteMessage(
  payload: {
    state?: string;
    nonce?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: string;
    expiresIn?: number;
    provider?: AuthProvider;
  },
  sender: chrome.runtime.MessageSender
): Promise<{ state: AuthState }> {
  const settings = await getSettingsFromStorage();
  assertSupabaseConfigured(settings);
  assertAuthBridgeConfigured(settings);
  ensureBridgeSenderAllowed(settings, sender);

  const auth = await getAuthStorageState();
  const expectedState = auth.pendingState;
  const expectedNonce = auth.pendingNonce;
  const expiry = auth.pendingStateExpiresAt ? Date.parse(auth.pendingStateExpiresAt) : 0;
  if (!expectedState || !expectedNonce || !expiry || Number.isNaN(expiry) || expiry < Date.now()) {
    throw new Error("Bridge callback has expired. Please request login again.");
  }

  validatePendingState(payload.state, expectedState, payload.nonce, expectedNonce, true);

  if (!payload.accessToken) {
    throw new Error("Bridge callback did not include access token.");
  }

  const provider = payload.provider === "google" ? payload.provider : "email_magic_link";
  const session = await buildSessionFromTokenResult(
    settings,
    {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAt: payload.expiresAt,
      expiresIn: payload.expiresIn
    },
    provider
  );

  await saveAuthStorageState({
    ...auth,
    session,
    syncStatus: "idle",
    lastError: undefined,
    pendingState: undefined,
    pendingNonce: undefined,
    pendingStateExpiresAt: undefined
  });

  await updateSyncMeta({
    activeUserId: session.user.id,
    migrationDone: false
  });

  runBackgroundTask("syncNow(bridge)", () => syncNow("bridge"));

  return {
    state: await getAuthState()
  };
}

async function migrateLocalToCloud(): Promise<{ success: boolean; stats: Record<string, number> }> {
  const settings = await getSettingsFromStorage();
  assertSupabaseConfigured(settings);
  const auth = await getAuthStorageState();
  if (!settings.cloudSyncEnabled) {
    throw new Error("Cloud sync is disabled in settings.");
  }
  if (!auth.session) {
    throw new Error("Please sign in first.");
  }

  const session = await refreshAuthSessionIfNeeded(settings, auth.session);
  await saveAuthStorageState({
    ...auth,
    session
  });

  const meta = await ensureSyncMetaRow();
  const pulled = await pullFromCloud(settings, session, meta.lastPullAt);

  let markedDirty = 0;
  await db.bookmarks.toCollection().modify((raw) => {
    const item = raw as BookmarkItem;
    item.syncState = "dirty";
    markedDirty += 1;
  });

  await updateSyncMeta({
    activeUserId: session.user.id,
    migrationDone: false,
    lastPullAt: pulled.lastPullAt
  });

  const syncResult = await syncNow("migration");
  await updateSyncMeta({
    activeUserId: session.user.id,
    migrationDone: true,
    lastMigrationAt: nowIso()
  });

  return {
    success: true,
    stats: {
      markedDirty,
      pushedBookmarks: syncResult.pushedBookmarks,
      pulledBookmarks: syncResult.pulledBookmarks
    }
  };
}

async function syncNow(source: "manual" | "alarm" | "startup" | "install" | "auth" | "bridge" | "migration"): Promise<{
  source: string;
  pushedBookmarks: number;
  pulledBookmarks: number;
  skipped: boolean;
}> {
  const settings = await getSettingsFromStorage();
  if (!settings.cloudSyncEnabled) {
    return { source, pushedBookmarks: 0, pulledBookmarks: 0, skipped: true };
  }
  if (!settings.supabaseUrl.trim() || !settings.supabaseAnonKey.trim()) {
    return { source, pushedBookmarks: 0, pulledBookmarks: 0, skipped: true };
  }

  const auth = await getAuthStorageState();
  if (!auth.session) {
    return { source, pushedBookmarks: 0, pulledBookmarks: 0, skipped: true };
  }

  const lock = await acquireJobLock(SYNC_JOB_ID);
  if (!lock.acquired) {
    return { source, pushedBookmarks: 0, pulledBookmarks: 0, skipped: true };
  }

  let pushedBookmarks = 0;
  let pulledBookmarks = 0;

  try {
    await saveAuthStorageState({
      ...auth,
      syncStatus: "syncing",
      lastError: undefined
    });

    const session = await refreshAuthSessionIfNeeded(settings, auth.session);
    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      session
    });

    const meta = await ensureSyncMetaRow();
    if (meta.activeUserId && meta.activeUserId !== session.user.id) {
      await updateSyncMeta({
        activeUserId: session.user.id,
        lastPullAt: undefined,
        lastPushAt: undefined,
        migrationDone: false
      });
    } else {
      await updateSyncMeta({
        activeUserId: session.user.id
      });
    }

    const pushed = await pushToCloud(settings, session);
    pushedBookmarks = pushed.pushedBookmarks;

    const latestMeta = await ensureSyncMetaRow();
    const pulled = await pullFromCloud(settings, session, latestMeta.lastPullAt);
    pulledBookmarks = pulled.pulledBookmarks;

    await updateSyncMeta({
      activeUserId: session.user.id,
      lastPushAt: nowIso(),
      lastPullAt: pulled.lastPullAt || latestMeta.lastPullAt
    });

    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      syncStatus: "idle",
      lastSyncAt: nowIso(),
      lastError: undefined
    });

    await releaseJobLock(SYNC_JOB_ID, {
      lastError: undefined
    });

    return {
      source,
      pushedBookmarks,
      pulledBookmarks,
      skipped: false
    };
  } catch (error) {
    const message = toErrorMessage(error);
    await saveAuthStorageState({
      ...(await getAuthStorageState()),
      syncStatus: "error",
      lastError: message
    });
    await releaseJobLock(SYNC_JOB_ID, {
      lastError: message
    });
    throw error;
  }
}

async function pushToCloud(settings: ExtensionSettings, session: AuthSession): Promise<{ pushedBookmarks: number }> {
  const dirty = await db.bookmarks.where("syncState").equals("dirty").limit(500).toArray();
  let pushedBookmarks = 0;

  if (dirty.length > 0) {
    const payload = dirty.map((item) => toCloudBookmarkRow(session.user.id, item));
    const rows = await requestSupabaseRest<CloudBookmarkRow[]>(
      settings,
      session.accessToken,
      `/rest/v1/bookmarks?on_conflict=user_id,dedupe_key`,
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify(payload)
      }
    );

    const updatedAtByKey = new Map<string, { id?: string; updatedAt: string }>();
    for (const row of rows ?? []) {
      updatedAtByKey.set(row.dedupe_key, {
        id: row.id,
        updatedAt: row.updated_at
      });
    }

    for (const item of dirty) {
      const key = dedupeKeyForBookmark(item);
      const cloud = updatedAtByKey.get(key);
      await db.bookmarks.update(item.id, {
        syncState: "synced",
        lastSyncedAt: nowIso(),
        cloudUpdatedAt: cloud?.updatedAt ?? nowIso(),
        cloudId: cloud?.id ?? item.cloudId
      });
      pushedBookmarks += 1;
    }
  }

  const rules = await listCategoryRules();
  await deleteCloudCategoryRulesMissingLocally(settings, session, rules);
  if (rules.length > 0) {
    const rulesPayload: CloudCategoryRuleRow[] = rules.map((rule) => ({
      user_id: session.user.id,
      canonical: rule.canonical,
      aliases: normalizeTags(rule.aliases ?? []),
      pinned: Boolean(rule.pinned),
      color: rule.color,
      updated_at: rule.updatedAt || nowIso()
    }));

    await requestSupabaseRest(
      settings,
      session.accessToken,
      "/rest/v1/category_rules?on_conflict=user_id,canonical",
      {
        method: "POST",
        headers: {
          Prefer: "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(rulesPayload)
      }
    );
  }

  const localSettings = await getSettingsFromStorage();
  const cloudSettings = buildCloudSettingsPayload(localSettings);
  await requestSupabaseRest(
    settings,
    session.accessToken,
    "/rest/v1/user_settings?on_conflict=user_id",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify([
        {
          user_id: session.user.id,
          settings: cloudSettings,
          updated_at: nowIso()
        }
      ])
    }
  );

  return {
    pushedBookmarks
  };
}

async function deleteCloudCategoryRulesMissingLocally(
  settings: ExtensionSettings,
  session: AuthSession,
  localRules: CategoryRule[]
): Promise<void> {
  const params = new URLSearchParams();
  params.set("user_id", `eq.${session.user.id}`);
  params.set("select", "canonical");
  params.set("limit", "500");
  const cloudRules = await requestSupabaseRest<Array<Pick<CloudCategoryRuleRow, "canonical">>>(
    settings,
    session.accessToken,
    `/rest/v1/category_rules?${params.toString()}`,
    { method: "GET" }
  );

  if (!Array.isArray(cloudRules) || cloudRules.length === 0) {
    return;
  }

  const localCanonicalSet = new Set(localRules.map((rule) => normalizeLookup(rule.canonical)));
  const staleCanonicals = Array.from(
    new Set(
      cloudRules
        .map((row) => normalizeCategory(row.canonical))
        .filter((value): value is string => Boolean(value))
        .filter((canonical) => !localCanonicalSet.has(normalizeLookup(canonical)))
    )
  );

  if (staleCanonicals.length === 0) {
    return;
  }

  const chunkSize = 100;
  for (let index = 0; index < staleCanonicals.length; index += chunkSize) {
    const chunk = staleCanonicals.slice(index, index + chunkSize);
    const deleteParams = new URLSearchParams();
    deleteParams.set("user_id", `eq.${session.user.id}`);
    deleteParams.set(
      "canonical",
      `in.(${chunk.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`
    );
    await requestSupabaseRest(
      settings,
      session.accessToken,
      `/rest/v1/category_rules?${deleteParams.toString()}`,
      {
        method: "DELETE",
        headers: {
          Prefer: "return=minimal"
        }
      }
    );
  }
}

async function pullFromCloud(
  settings: ExtensionSettings,
  session: AuthSession,
  sinceIso?: string
): Promise<{ pulledBookmarks: number; lastPullAt?: string }> {
  const params = new URLSearchParams();
  params.set("user_id", `eq.${session.user.id}`);
  params.set("select", "*");
  params.set("order", "updated_at.asc");
  params.set("limit", "500");
  if (sinceIso) {
    params.set("updated_at", `gt.${sinceIso}`);
  }

  const cloudRows = await requestSupabaseRest<CloudBookmarkRow[]>(
    settings,
    session.accessToken,
    `/rest/v1/bookmarks?${params.toString()}`,
    {
      method: "GET"
    }
  );

  let pulledBookmarks = 0;
  let lastPullAt = sinceIso;
  if (Array.isArray(cloudRows) && cloudRows.length > 0) {
    const localAll = await db.bookmarks.toArray();
    const localByKey = new Map<string, BookmarkItem>();
    for (const item of localAll) {
      localByKey.set(dedupeKeyForBookmark(item), item);
    }

    for (const row of cloudRows) {
      const cloudItem = fromCloudBookmarkRow(row);
      const key = row.dedupe_key || dedupeKeyForBookmark(cloudItem);
      const local = localByKey.get(key);
      const merged = mergeBookmarkByRecency(local, cloudItem);
      await db.bookmarks.put(merged);
      localByKey.set(key, merged);
      pulledBookmarks += 1;
      if (!lastPullAt || row.updated_at > lastPullAt) {
        lastPullAt = row.updated_at;
      }
    }
  }

  const ruleParams = new URLSearchParams();
  ruleParams.set("user_id", `eq.${session.user.id}`);
  ruleParams.set("select", "*");
  ruleParams.set("order", "updated_at.desc");
  ruleParams.set("limit", "300");
  const cloudRules = await requestSupabaseRest<CloudCategoryRuleRow[]>(
    settings,
    session.accessToken,
    `/rest/v1/category_rules?${ruleParams.toString()}`,
    { method: "GET" }
  );
  if (Array.isArray(cloudRules)) {
    const existing = await listCategoryRules();
    const existingByCanonical = new Map(existing.map((item) => [normalizeLookup(item.canonical), item]));
    for (const row of cloudRules) {
      const canonical = normalizeCategory(row.canonical);
      if (!canonical) {
        continue;
      }
      const current = existingByCanonical.get(normalizeLookup(canonical));
      if (current && current.updatedAt >= row.updated_at) {
        continue;
      }
      const next: CategoryRule = {
        id: current?.id || crypto.randomUUID(),
        canonical,
        aliases: normalizeTags(row.aliases ?? []),
        pinned: Boolean(row.pinned),
        color: row.color || undefined,
        updatedAt: row.updated_at || nowIso()
      };
      await db.categoryRules.put(next);
    }
  }

  const userSettingParams = new URLSearchParams();
  userSettingParams.set("user_id", `eq.${session.user.id}`);
  userSettingParams.set("select", "settings,updated_at");
  userSettingParams.set("order", "updated_at.desc");
  userSettingParams.set("limit", "1");
  const cloudSettingsRows = await requestSupabaseRest<Array<{ settings?: Partial<ExtensionSettings> }>>(
    settings,
    session.accessToken,
    `/rest/v1/user_settings?${userSettingParams.toString()}`,
    { method: "GET" }
  );
  const newest = cloudSettingsRows?.[0]?.settings;
  if (newest && typeof newest === "object") {
    const local = await getSettingsFromStorage();
    const merged: ExtensionSettings = {
      ...local,
      ...newest,
      apiKey: local.apiKey,
      supabaseUrl: local.supabaseUrl,
      supabaseAnonKey: local.supabaseAnonKey,
      authBridgeUrl: local.authBridgeUrl
    };
    await saveSettingsToStorage(merged);
  }

  return {
    pulledBookmarks,
    lastPullAt
  };
}

async function deleteCloudRowsForBookmarks(items: BookmarkItem[]): Promise<void> {
  if (!items.length) {
    return;
  }

  const settings = await getSettingsFromStorage();
  if (!settings.cloudSyncEnabled || !settings.supabaseUrl || !settings.supabaseAnonKey) {
    return;
  }

  const auth = await getAuthStorageState();
  if (!auth.session) {
    return;
  }

  let session: AuthSession;
  try {
    session = await refreshAuthSessionIfNeeded(settings, auth.session);
  } catch {
    return;
  }

  const keys = items.map((item) => dedupeKeyForBookmark(item)).filter(Boolean);
  if (!keys.length) {
    return;
  }

  const params = new URLSearchParams();
  params.set("user_id", `eq.${session.user.id}`);
  params.set("dedupe_key", `in.(${keys.map((value) => `"${value.replace(/"/g, '\\"')}"`).join(",")})`);

  try {
    await ensureUrlPermission(settings.supabaseUrl, {
      reason: "Supabase",
      requestIfMissing: false
    });
    await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, `/rest/v1/bookmarks?${params.toString()}`), {
      method: "DELETE",
      headers: {
        apikey: settings.supabaseAnonKey,
        Authorization: `Bearer ${session.accessToken}`,
        Prefer: "return=minimal"
      }
    });
  } catch {
    return;
  }
}

function mergeBookmarkByRecency(local: BookmarkItem | undefined, cloud: BookmarkItem): BookmarkItem {
  const cloudUpdatedAt = cloud.updatedAt || cloud.createdAt || nowIso();
  if (!local) {
    const created = {
      ...cloud,
      id: cloud.id || crypto.randomUUID(),
      syncState: "synced" as BookmarkSyncState,
      lastSyncedAt: nowIso(),
      cloudUpdatedAt: cloudUpdatedAt
    };
    created.searchText = buildSearchText(created);
    return created;
  }

  const localUpdatedAt = local.updatedAt || local.createdAt || nowIso();
  const cloudIsNewer = cloudUpdatedAt >= localUpdatedAt;
  const mergedTags = normalizeTags([...(local.tags ?? []), ...(cloud.tags ?? [])]);

  if (cloudIsNewer && local.syncState !== "dirty") {
    const merged: BookmarkItem = {
      ...local,
      ...cloud,
      id: local.id,
      tags: mergedTags,
      saveCount: Math.max(local.saveCount ?? 1, cloud.saveCount ?? 1),
      syncState: "synced",
      lastSyncedAt: nowIso(),
      cloudUpdatedAt: cloudUpdatedAt,
      cloudId: cloud.cloudId || local.cloudId
    };
    merged.searchText = buildSearchText(merged);
    return merged;
  }

  const merged: BookmarkItem = {
    ...local,
    tags: mergedTags,
    syncState: local.syncState === "dirty" && cloudIsNewer ? "conflict" : normalizeSyncState(local.syncState),
    cloudUpdatedAt: cloudUpdatedAt,
    cloudId: cloud.cloudId || local.cloudId
  };
  merged.searchText = buildSearchText(merged);
  return merged;
}

function dedupeKeyForBookmark(item: Pick<BookmarkItem, "canonicalUrl" | "url">): string {
  return normalizeUrl(item.canonicalUrl || item.url).toLowerCase();
}

function toCloudBookmarkRow(userId: string, item: BookmarkItem): CloudBookmarkRow {
  return {
    id: item.cloudId,
    user_id: userId,
    dedupe_key: dedupeKeyForBookmark(item),
    url: item.url,
    canonical_url: item.canonicalUrl ?? null,
    title: item.title,
    domain: item.domain,
    favicon_url: item.favIconUrl ?? null,
    status: normalizeBookmarkStatus(item.status),
    category: item.category ?? null,
    tags: normalizeTags(item.tags ?? []),
    user_note: item.userNote ?? null,
    ai_summary: item.aiSummary ?? null,
    created_at: item.createdAt || nowIso(),
    updated_at: item.updatedAt || nowIso(),
    deleted_at: item.deletedAt ?? null,
    save_count: Math.max(1, Number(item.saveCount ?? 1))
  };
}

function fromCloudBookmarkRow(row: CloudBookmarkRow): BookmarkItem {
  const created: BookmarkItem = {
    id: crypto.randomUUID(),
    cloudId: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url || undefined,
    title: row.title || row.url,
    domain: row.domain || tryParseUrl(row.url)?.hostname || "unknown.domain",
    favIconUrl: row.favicon_url || deriveFaviconFallback(row.url, row.domain),
    createdAt: row.created_at || nowIso(),
    updatedAt: row.updated_at || nowIso(),
    lastSavedAt: row.updated_at || row.created_at || nowIso(),
    saveCount: Math.max(1, Number(row.save_count ?? 1)),
    status: normalizeBookmarkStatus(row.status),
    deletedAt: row.deleted_at || undefined,
    userNote: row.user_note || undefined,
    aiSummary: row.ai_summary || undefined,
    category: normalizeCategory(row.category || undefined),
    tags: normalizeTags(row.tags ?? []),
    pinned: false,
    locked: false,
    syncState: "synced",
    lastSyncedAt: nowIso(),
    cloudUpdatedAt: row.updated_at || nowIso(),
    searchText: ""
  };
  created.searchText = buildSearchText(created);
  return created;
}

function buildCloudSettingsPayload(settings: ExtensionSettings): Partial<ExtensionSettings> {
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    embeddingModel: settings.embeddingModel,
    embeddingContentMode: settings.embeddingContentMode,
    embeddingMaxChars: settings.embeddingMaxChars,
    temperature: settings.temperature,
    maxChars: settings.maxChars,
    quickDockEnabled: settings.quickDockEnabled,
    quickDockCollapsedByDefault: settings.quickDockCollapsedByDefault,
    quickDockPosition: settings.quickDockPosition,
    quickDockMaxItems: settings.quickDockMaxItems,
    quickDockPinMode: settings.quickDockPinMode,
    classificationMode: settings.classificationMode,
    preferReuseCategories: settings.preferReuseCategories,
    semanticSearchEnabled: settings.semanticSearchEnabled,
    searchFallbackMode: settings.searchFallbackMode,
    webAugmentEnabled: settings.webAugmentEnabled,
    clarifyOnLowConfidence: settings.clarifyOnLowConfidence,
    lowConfidenceThreshold: settings.lowConfidenceThreshold,
    maxWebAugmentPerQuery: settings.maxWebAugmentPerQuery,
    excludedUrlPatterns: settings.excludedUrlPatterns,
    rankingWeights: settings.rankingWeights,
    trashRetentionDays: settings.trashRetentionDays
  };
}

async function requestSupabaseRest<T>(
  settings: ExtensionSettings,
  accessToken: string,
  path: string,
  init: RequestInit
): Promise<T> {
  await ensureUrlPermission(settings.supabaseUrl, {
    reason: "Supabase",
    requestIfMissing: false
  });
  const response = await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, path), {
    ...init,
    headers: {
      apikey: settings.supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase REST failed (${response.status}): ${body.slice(0, 320)}`);
  }
  if (response.status === 204) {
    return [] as T;
  }
  const text = await response.text();
  if (!text) {
    return [] as T;
  }
  return JSON.parse(text) as T;
}

function assertSupabaseConfigured(settings: ExtensionSettings): void {
  if (!settings.supabaseUrl.trim()) {
    throw new Error("Supabase URL is missing. Set it in Options.");
  }
  if (!settings.supabaseAnonKey.trim()) {
    throw new Error("Supabase anon key is missing. Set it in Options.");
  }
}

function assertAuthBridgeConfigured(settings: ExtensionSettings): void {
  if (!settings.authBridgeUrl.trim()) {
    throw new Error("Auth bridge URL is missing. Set it in Options.");
  }
}

function resolveSupabaseEndpoint(baseUrl: string, path: string): string {
  const cleanedBase = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const cleanedPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanedBase}${cleanedPath}`;
}

async function requestNetworkPermissionsForSettings(
  current: ExtensionSettings,
  next: ExtensionSettings
): Promise<void> {
  const targets: Array<{ url: string; reason: string }> = [];
  const baseOriginChanged = normalizeOrigin(current.baseUrl) !== normalizeOrigin(next.baseUrl);
  const aiCredentialsChanged = current.apiKey !== next.apiKey;
  if (next.baseUrl.trim() && (baseOriginChanged || aiCredentialsChanged || next.apiKey.trim().length > 0)) {
    targets.push({ url: next.baseUrl, reason: "AI service" });
  }
  const supabaseOriginChanged = normalizeOrigin(current.supabaseUrl) !== normalizeOrigin(next.supabaseUrl);
  const supabaseCredentialsChanged = current.supabaseAnonKey !== next.supabaseAnonKey;
  if (
    next.supabaseUrl.trim() &&
    next.cloudSyncEnabled &&
    (supabaseOriginChanged || supabaseCredentialsChanged || next.supabaseAnonKey.trim().length > 0)
  ) {
    targets.push({ url: next.supabaseUrl, reason: "Supabase" });
  }

  for (const target of targets) {
    await ensureUrlPermission(target.url, {
      reason: target.reason,
      requestIfMissing: true
    });
  }
}

async function requestOriginPermission(payload: { url?: string; reason?: string }): Promise<{ granted: boolean; origin?: string }> {
  const pattern = toOriginPattern(payload.url);
  if (!pattern) {
    throw new Error("Invalid URL. Please use a full https:// domain.");
  }
  const granted = await ensureUrlPermission(payload.url ?? "", {
    reason: payload.reason ?? "remote service",
    requestIfMissing: true
  });
  return { granted, origin: pattern };
}

async function checkOriginPermission(payload: { url?: string }): Promise<{ granted: boolean; origin?: string }> {
  const pattern = toOriginPattern(payload.url);
  if (!pattern) {
    return { granted: false };
  }
  return {
    granted: await hasOriginPermission(pattern),
    origin: pattern
  };
}

async function ensureUrlPermission(
  url: string,
  input: {
    reason: string;
    requestIfMissing: boolean;
  }
): Promise<boolean> {
  const pattern = toOriginPattern(url);
  if (!pattern) {
    throw new Error(`Invalid ${input.reason} URL: ${url}`);
  }

  const granted = await hasOriginPermission(pattern);
  if (granted) {
    return true;
  }

  if (!input.requestIfMissing) {
    throw new Error(
      `Missing permission for ${input.reason} origin ${pattern}. Open Options and save settings to grant access.`
    );
  }

  const grantedByUser = await chrome.permissions.request({ origins: [pattern] });
  if (!grantedByUser) {
    throw new Error(`Permission for ${input.reason} origin ${pattern} was denied.`);
  }

  return true;
}

async function hasOriginPermission(originPattern: string): Promise<boolean> {
  return chrome.permissions.contains({ origins: [originPattern] });
}

function toOriginPattern(url: string | undefined): string | undefined {
  if (!url?.trim()) {
    return undefined;
  }
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:") {
      return undefined;
    }
    return `${parsed.origin}/*`;
  } catch {
    return undefined;
  }
}

function normalizeOrigin(url: string | undefined): string {
  return toOriginPattern(url) ?? "";
}

async function refreshAuthSessionIfNeeded(settings: ExtensionSettings, session: AuthSession): Promise<AuthSession> {
  if (!session.expiresAt) {
    return session;
  }

  const expiryMs = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs - Date.now() > 60_000) {
    return session;
  }

  if (!session.refreshToken) {
    throw new Error("Session expired and refresh token is missing.");
  }

  await ensureUrlPermission(settings.supabaseUrl, {
    reason: "Supabase",
    requestIfMissing: false
  });
  const response = await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, "/auth/v1/token?grant_type=refresh_token"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: settings.supabaseAnonKey
    },
    body: JSON.stringify({
      refresh_token: session.refreshToken
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Session refresh failed (${response.status}): ${body.slice(0, 240)}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: {
      id: string;
      email?: string;
      user_metadata?: Record<string, unknown>;
      app_metadata?: Record<string, unknown>;
    };
  };
  if (!payload.access_token) {
    throw new Error("Session refresh returned empty access token.");
  }

  const fallbackUser = payload.user
    ? mapSupabaseUser(payload.user, session.provider)
    : await fetchSupabaseUser(settings, payload.access_token, session.provider);
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || session.refreshToken,
    expiresAt: calculateExpiry(payload.access_token, undefined, payload.expires_in),
    provider: session.provider,
    user: fallbackUser
  };
}

async function buildSessionFromTokenResult(
  settings: ExtensionSettings,
  token: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: string;
    expiresIn?: number;
  },
  provider: AuthProvider
): Promise<AuthSession> {
  const user = await fetchSupabaseUser(settings, token.accessToken, provider);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: calculateExpiry(token.accessToken, token.expiresAt, token.expiresIn),
    provider,
    user
  };
}

async function fetchSupabaseUser(settings: ExtensionSettings, accessToken: string, provider: AuthProvider): Promise<AuthSessionUser> {
  await ensureUrlPermission(settings.supabaseUrl, {
    reason: "Supabase",
    requestIfMissing: false
  });
  const response = await fetch(resolveSupabaseEndpoint(settings.supabaseUrl, "/auth/v1/user"), {
    method: "GET",
    headers: {
      apikey: settings.supabaseAnonKey,
      Authorization: `Bearer ${accessToken}`
    }
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Fetch user failed (${response.status}): ${body.slice(0, 240)}`);
  }
  const payload = (await response.json()) as {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
  };
  return mapSupabaseUser(payload, provider);
}

function mapSupabaseUser(
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
  },
  provider: AuthProvider
): AuthSessionUser {
  return {
    id: user.id,
    email: user.email || "unknown@musemark.local",
    displayName:
      stringOrUndefined(user.user_metadata?.full_name) ||
      stringOrUndefined(user.user_metadata?.name) ||
      stringOrUndefined(user.user_metadata?.preferred_username),
    avatarUrl: stringOrUndefined(user.user_metadata?.avatar_url),
    provider
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function calculateExpiry(accessToken: string, expiresAt?: string, expiresIn?: number): string | undefined {
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  if (Number.isFinite(expiresIn)) {
    return new Date(Date.now() + Number(expiresIn) * 1000).toISOString();
  }
  const jwtExpiry = parseJwtExpiry(accessToken);
  if (jwtExpiry) {
    return jwtExpiry;
  }
  return undefined;
}

function parseJwtExpiry(token: string): string | undefined {
  const segments = token.split(".");
  if (segments.length < 2) {
    return undefined;
  }
  try {
    const payload = JSON.parse(decodeBase64Url(segments[1])) as { exp?: number };
    if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
      return new Date(payload.exp * 1000).toISOString();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return atob(padded);
}

function parseOAuthResult(urlValue: string): {
  code?: string;
  state?: string;
  error?: string;
  errorDescription?: string;
} {
  const parsed = new URL(urlValue);
  const hash = new URLSearchParams(parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash);
  const query = parsed.searchParams;

  const code = query.get("code") || hash.get("code") || undefined;
  const state = hash.get("state") || query.get("state") || undefined;
  const error = hash.get("error") || query.get("error") || undefined;
  const errorDescription = hash.get("error_description") || query.get("error_description") || undefined;

  return {
    code,
    state,
    error,
    errorDescription
  };
}

function createMemoryStorage(): SupportedStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    }
  };
}

function createSupabaseAuthClient(settings: ExtensionSettings, storage: SupportedStorage) {
  return createClient(settings.supabaseUrl, settings.supabaseAnonKey, {
    auth: {
      flowType: "pkce",
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
      storage,
      storageKey: `${LEGACY_PREFIX}-auth-${chrome.runtime.id}`
    }
  });
}

function launchOAuthFlow(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          "OAuth callback timed out. Verify Supabase redirect allowlist includes the Chrome redirect URL returned by chrome.identity.getRedirectURL()."
        )
      );
    }, 120_000);

    chrome.identity.launchWebAuthFlow(
      {
        url,
        interactive: true
      },
      (redirectedTo) => {
        clearTimeout(timeout);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "OAuth flow failed."));
          return;
        }
        if (!redirectedTo) {
          reject(new Error("OAuth flow returned empty redirect URL."));
          return;
        }
        resolve(redirectedTo);
      }
    );
  });
}

async function persistPendingBridgeState(state: string, nonce: string): Promise<void> {
  const auth = await getAuthStorageState();
  await saveAuthStorageState({
    ...auth,
    pendingState: state,
    pendingNonce: nonce,
    pendingStateExpiresAt: new Date(Date.now() + BRIDGE_STATE_TTL_MS).toISOString()
  });
}

function validatePendingState(
  actualState: string | undefined,
  expectedState: string,
  actualNonce: string | undefined,
  expectedNonce: string,
  strictNonce = false
): void {
  if (!actualState || actualState !== expectedState) {
    throw new Error("OAuth state mismatch. Please retry login.");
  }
  if (strictNonce && !actualNonce) {
    throw new Error("OAuth nonce is missing. Please retry login.");
  }
  if (actualNonce && actualNonce !== expectedNonce) {
    throw new Error("OAuth nonce mismatch. Please retry login.");
  }
}

function ensureBridgeSenderAllowed(settings: ExtensionSettings, sender: chrome.runtime.MessageSender): void {
  const allowedOrigin = tryParseUrl(settings.authBridgeUrl)?.origin;
  const senderOrigin = sender.origin || tryParseUrl(sender.url)?.origin;
  if (!allowedOrigin || !senderOrigin || senderOrigin !== allowedOrigin) {
    throw new Error("Blocked external auth callback from untrusted origin.");
  }
}

function maskToken(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  if (token.length < 10) {
    return "***";
  }
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

async function ensureBackgroundAlarms(): Promise<void> {
  await chrome.alarms.create(ALARM_BACKFILL, {
    delayInMinutes: 0.5,
    periodInMinutes: 5
  });
  await chrome.alarms.create(ALARM_TRASH_CLEANUP, {
    delayInMinutes: 1,
    periodInMinutes: 60
  });
  await chrome.alarms.create(ALARM_SYNC, {
    delayInMinutes: 2,
    periodInMinutes: 15
  });
}

async function runMigrationSelfCheckIfNeeded(force: boolean): Promise<void> {
  const now = Date.now();
  const storage = await chrome.storage.local.get(STORAGE_AUDIT_KEY);
  const lastAudit = Number(storage[STORAGE_AUDIT_KEY] ?? 0);

  if (!force && now - lastAudit < 6 * 60 * 60 * 1000) {
    return;
  }

  await runMigrationSelfCheck();
  await chrome.storage.local.set({ [STORAGE_AUDIT_KEY]: now });
}

async function runMigrationSelfCheck(): Promise<void> {
  const sample = await db.bookmarks.orderBy("updatedAt").reverse().limit(20).toArray();
  if (sample.length === 0) {
    return;
  }

  let repairedCount = 0;
  for (const item of sample) {
    const next: BookmarkItem = {
      ...item,
      status: normalizeBookmarkStatus(item.status),
      tags: normalizeTags(item.tags ?? []),
      syncState: normalizeSyncState(item.syncState),
      saveCount: Math.max(1, Number(item.saveCount ?? 1)),
      pinned: Boolean(item.pinned),
      locked: Boolean(item.locked),
      updatedAt: item.updatedAt || item.createdAt || nowIso(),
      createdAt: item.createdAt || nowIso(),
      lastSavedAt: item.lastSavedAt || item.updatedAt || item.createdAt || nowIso()
    };

    if (next.status === "trashed" && !next.deletedAt) {
      next.deletedAt = nowIso();
    }
    if (next.status !== "trashed" && next.deletedAt) {
      next.deletedAt = undefined;
    }
    if (!next.embedding || next.embedding.length === 0) {
      next.embedding = undefined;
      next.embeddingModel = undefined;
      next.embeddingUpdatedAt = undefined;
    } else if (!next.embeddingUpdatedAt) {
      next.embeddingUpdatedAt = next.updatedAt;
    }

    next.searchText = buildSearchText(next);

    const hasDiff =
      next.status !== item.status ||
      next.syncState !== item.syncState ||
      next.searchText !== item.searchText ||
      next.tags.join("|") !== (item.tags ?? []).join("|") ||
      next.lastSavedAt !== item.lastSavedAt ||
      next.saveCount !== item.saveCount ||
      next.pinned !== item.pinned ||
      next.locked !== item.locked ||
      next.deletedAt !== item.deletedAt ||
      next.embeddingModel !== item.embeddingModel ||
      next.embeddingUpdatedAt !== item.embeddingUpdatedAt;

    if (hasDiff) {
      repairedCount += 1;
      await db.bookmarks.put(next);
    }
  }

  if (repairedCount > 0) {
    console.info(`MuseMark migration self-check repaired ${repairedCount} sampled records.`);
  }
}

function applyScope(items: BookmarkItem[], scope: ManagerScope): BookmarkItem[] {
  if (scope === "trash") {
    return items.filter((item) => item.status === "trashed");
  }
  if (scope === "inbox") {
    return items.filter((item) => item.status !== "classified" && item.status !== "trashed");
  }
  return items.filter((item) => item.status !== "trashed");
}

async function queryByScope(scope: ManagerScope, status?: BookmarkStatus | "all"): Promise<BookmarkItem[]> {
  const requestedStatus = status && status !== "all" ? status : undefined;
  if (requestedStatus) {
    if (scope === "trash" && requestedStatus !== "trashed") {
      return [];
    }
    if (scope !== "trash" && requestedStatus === "trashed") {
      return [];
    }
    return db
      .bookmarks.where("[status+updatedAt]")
      .between([requestedStatus, Dexie.minKey], [requestedStatus, Dexie.maxKey])
      .reverse()
      .toArray();
  }

  if (scope === "trash") {
    return db
      .bookmarks.where("[status+updatedAt]")
      .between(["trashed", Dexie.minKey], ["trashed", Dexie.maxKey])
      .reverse()
      .toArray();
  }

  if (scope === "library") {
    const byStatus = await Promise.all(
      (["inbox", "analyzing", "classified", "error"] as BookmarkStatus[]).map((itemStatus) =>
        db.bookmarks
          .where("[status+updatedAt]")
          .between([itemStatus, Dexie.minKey], [itemStatus, Dexie.maxKey])
          .reverse()
          .toArray()
      )
    );
    return byStatus.flat();
  }

  const byStatus = await Promise.all(
    (["inbox", "analyzing", "error"] as BookmarkStatus[]).map((itemStatus) =>
      db.bookmarks
        .where("[status+updatedAt]")
        .between([itemStatus, Dexie.minKey], [itemStatus, Dexie.maxKey])
        .reverse()
        .toArray()
    )
  );
  return byStatus.flat();
}

function detectSearchIntent(query: string, clarificationAnswer: string): SearchTrace["intentType"] {
  if (!query.trim()) {
    return "empty";
  }
  if (clarificationAnswer.trim()) {
    return "explicit";
  }
  return detectAmbiguousIntent(query) ? "ambiguous" : "explicit";
}

function detectAmbiguousIntent(query: string): boolean {
  const normalized = normalizeLookup(query);
  if (!normalized) {
    return false;
  }

  const temporalHints = ["最近", "最新", "很火", "爆火", "热门", "today", "recent", "latest", "hot", "trending"];
  if (temporalHints.some((token) => normalized.includes(token))) {
    return true;
  }

  const pronounHints = ["那个", "这个", "那个网站", "that one", "this one"];
  if (pronounHints.some((token) => normalized.includes(token))) {
    return true;
  }

  const genericEntityHints = ["智能体", "agent", "ai", "模型", "大模型", "工具", "教程", "article", "news"];
  const tokens = tokenize(normalized);
  const hasSpecificToken = tokens.some((token) => /[a-z0-9]{4,}/i.test(token) && !genericEntityHints.includes(token));
  const hasGenericHint = genericEntityHints.some((token) => normalized.includes(token));

  if (hasGenericHint && !hasSpecificToken && tokens.length <= 4) {
    return true;
  }

  return false;
}

function computeSearchConfidence(rows: SearchRankRow[]): number {
  if (rows.length === 0) {
    return 0;
  }

  const top = rows[0];
  const second = rows[1];
  const topFinal = clamp01(top.finalScore);
  const gapRatio = second ? clamp01((top.finalScore - second.finalScore) / Math.max(0.01, top.finalScore)) : 1;
  const strongestSignal = Math.max(
    top.exactMatchTier >= 2 ? 1 : 0,
    clamp01(top.lexicalScore),
    clamp01(top.semanticScore),
    clamp01(top.taxonomyScore)
  );
  const signalAgreement = clamp01(
    ((top.lexicalScore >= 0.25 ? 1 : 0) + (top.semanticScore >= 0.25 ? 1 : 0) + (top.taxonomyScore >= 0.25 ? 1 : 0)) / 3
  );

  let confidence = topFinal * 0.42 + gapRatio * 0.28 + strongestSignal * 0.2 + signalAgreement * 0.1;

  if (top.exactMatchTier >= 2) {
    confidence += 0.12;
  }
  if (top.semanticScore < 0.15 && top.lexicalScore < 0.15) {
    confidence -= 0.1;
  }

  return clamp01(confidence);
}

function buildClarifyOptions(rows: SearchRankRow[]): string[] {
  const options: string[] = [];

  for (const row of rows.slice(0, 5)) {
    const item = row.item;
    const shortTitle = (item.title || "").trim().slice(0, 36);
    if (shortTitle) {
      options.push(shortTitle);
    }
    if (item.category) {
      options.push(item.category);
    }
    if (item.domain) {
      options.push(item.domain);
    }
    if (item.tags?.[0]) {
      options.push(item.tags[0]);
    }
  }

  return Array.from(new Set(options.map((entry) => entry.trim()).filter(Boolean))).slice(0, 4);
}

function createClarifySession(input: { query: string; scope: ManagerScope; options: string[] }): string {
  const id = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 64);
  const session: ClarifySession = {
    id,
    query: input.query,
    scope: input.scope,
    options: input.options,
    createdAt: Date.now()
  };
  clarifySessions.set(id, session);
  pruneClarifySessions();
  return id;
}

function getClarifySession(sessionId: string): ClarifySession | undefined {
  pruneClarifySessions();
  const session = clarifySessions.get(sessionId);
  if (!session) {
    return undefined;
  }
  if (Date.now() - session.createdAt > SEARCH_CLARIFY_SESSION_TTL_MS) {
    clarifySessions.delete(sessionId);
    return undefined;
  }
  return session;
}

function pruneClarifySessions(): void {
  const now = Date.now();
  for (const [id, session] of clarifySessions.entries()) {
    if (now - session.createdAt > SEARCH_CLARIFY_SESSION_TTL_MS) {
      clarifySessions.delete(id);
    }
  }
}

async function augmentIntentWithWeb(settings: ExtensionSettings, query: string, maxCalls: number): Promise<WebAugmentResult> {
  if (!settings.apiKey?.trim()) {
    return {
      terms: [],
      reason: "未配置 API key，跳过联网补充",
      used: false,
      degraded: true
    };
  }

  if (maxCalls <= 0) {
    return {
      terms: [],
      reason: "maxWebAugmentPerQuery=0，跳过联网补充",
      used: false,
      degraded: true
    };
  }

  try {
    const raw = await withTimeout(callWebSearchRaw(settings, query), WEB_AUGMENT_TIMEOUT_MS, "Web augment timed out");
    const parsed = extractJson(raw) as Partial<{ aliases: string[]; keywords: string[]; reason: string }>;
    const aliases = Array.isArray(parsed.aliases) ? parsed.aliases.map(String) : [];
    const keywords = Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [];
    const mergedTerms = normalizeTags([...aliases, ...keywords]).slice(0, 12);
    return {
      terms: mergedTerms,
      reason: (parsed.reason ?? "").toString().trim() || "联网补充完成",
      used: mergedTerms.length > 0,
      degraded: false
    };
  } catch (error) {
    return {
      terms: [],
      reason: toErrorMessage(error),
      used: false,
      degraded: true
    };
  }
}

function buildWhyMatched(row: SearchRankRow): string {
  const reasons: string[] = [];

  if (row.exactMatchTier >= 3) {
    reasons.push("标题精准命中");
  } else if (row.exactMatchTier === 2) {
    reasons.push("URL 精准命中");
  } else if (row.exactMatchTier === 1) {
    reasons.push("标题短语命中");
  }

  if (row.semanticScore >= 0.5) {
    reasons.push("语义相近");
  }
  if (row.lexicalScore >= 0.35) {
    reasons.push("关键词相关");
  }
  if (row.taxonomyScore >= 0.3) {
    reasons.push("命中分类/标签");
  }
  if (row.recencyScore >= 0.6) {
    reasons.push("最近保存");
  }

  if (reasons.length === 0) {
    reasons.push("综合匹配");
  }

  return reasons.join(" + ");
}

function computeExactMatchTier(item: BookmarkItem, normalizedQuery: string, queryLooksLikeUrl: boolean): number {
  if (!normalizedQuery) {
    return 0;
  }

  const title = normalizeLookup(item.title ?? "");
  if (title && title === normalizedQuery) {
    return 3;
  }

  const rawUrl = (item.url ?? "").trim().toLowerCase();
  if (queryLooksLikeUrl && rawUrl) {
    const normalizedItemUrl = normalizeUrl(item.canonicalUrl || item.url).toLowerCase();
    const normalizedQueryUrl = normalizeUrl(normalizedQuery).toLowerCase();
    if (
      normalizedItemUrl === normalizedQueryUrl ||
      normalizedItemUrl.startsWith(normalizedQueryUrl) ||
      rawUrl === normalizedQuery ||
      rawUrl.startsWith(normalizedQuery)
    ) {
      return 2;
    }
  }

  if (title && title.includes(normalizedQuery)) {
    return 1;
  }

  return 0;
}

function lexicalScore(item: BookmarkItem, query: string, tokenSet: Set<string>): number {
  const queryLower = query.toLowerCase();
  const title = (item.title ?? "").toLowerCase();
  const domain = (item.domain ?? "").toLowerCase();
  const text = item.searchText || "";

  let score = 0;

  if (text.includes(queryLower)) {
    score += 0.5;
  }
  if (title.includes(queryLower)) {
    score += 0.35;
  }
  if (domain.includes(queryLower)) {
    score += 0.25;
  }

  for (const token of tokenSet) {
    if (!token) {
      continue;
    }

    if (title.includes(token)) {
      score += 0.13;
    }
    if (domain.includes(token)) {
      score += 0.09;
    }
    if (text.includes(token)) {
      score += 0.07;
    }
  }

  return clamp01(score);
}

function taxonomyScore(item: BookmarkItem, tokenSet: Set<string>): number {
  const category = (item.category ?? "").toLowerCase();
  const tags = normalizeTags(item.tags ?? []).map((tag) => tag.toLowerCase());

  let score = 0;
  for (const token of tokenSet) {
    if (category && category.includes(token)) {
      score += 0.28;
    }

    if (tags.some((tag) => tag.includes(token))) {
      score += 0.2;
    }
  }

  return clamp01(score);
}

function localHybridSemanticScore(item: BookmarkItem, query: string, tokenSet: Set<string>): number {
  const text = item.searchText || "";
  if (!text) {
    return 0;
  }

  const queryTokens = Array.from(tokenSet);
  if (queryTokens.length === 0) {
    return text.includes(query.toLowerCase()) ? 0.45 : 0;
  }

  let matched = 0;
  for (const token of queryTokens) {
    if (text.includes(token)) {
      matched += 1;
    }
  }

  const ratio = matched / queryTokens.length;
  const phraseBoost = text.includes(query.toLowerCase()) ? 0.3 : 0;
  return clamp01(ratio * 0.9 + phraseBoost);
}

function recencyScore(item: BookmarkItem): number {
  const updatedMs = Date.parse(item.updatedAt || item.createdAt || nowIso());
  if (!Number.isFinite(updatedMs)) {
    return 0;
  }

  const days = Math.max(0, (Date.now() - updatedMs) / 86_400_000);
  return clamp01(Math.exp(-days / 45));
}

function resolveRankingWeights(settings: ExtensionSettings, semanticAvailable: boolean): RankingWeights {
  const baseline = settings.rankingWeights ?? DEFAULT_SETTINGS.rankingWeights;
  const semantic = semanticAvailable ? Number(baseline.semantic ?? 0) : 0;
  const lexical = Number(baseline.lexical ?? 0);
  const taxonomy = Number(baseline.taxonomy ?? 0);
  const recency = Number(baseline.recency ?? 0);

  const clamped = {
    semantic: Math.max(0, semantic),
    lexical: Math.max(0, lexical),
    taxonomy: Math.max(0, taxonomy),
    recency: Math.max(0, recency)
  };

  const total = clamped.semantic + clamped.lexical + clamped.taxonomy + clamped.recency;
  if (total <= 0) {
    if (semanticAvailable) {
      return { semantic: 0.55, lexical: 0.25, taxonomy: 0.1, recency: 0.1 };
    }
    return { semantic: 0, lexical: 0.5, taxonomy: 0.3, recency: 0.2 };
  }

  return {
    semantic: clamped.semantic / total,
    lexical: clamped.lexical / total,
    taxonomy: clamped.taxonomy / total,
    recency: clamped.recency / total
  };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return clamp01(dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm)));
}

function buildExpandedTokenSet(query: string, useSynonyms = true): Set<string> {
  const tokens = tokenize(query);
  const expanded = new Set<string>(tokens);

  const synonymMap: Record<string, string[]> = {
    ai: ["agent", "llm", "gpt", "model", "人工智能", "大模型"],
    agent: ["ai", "workflow", "automation", "智能体"],
    dev: ["engineering", "code", "开发"],
    product: ["pm", "roadmap", "产品"],
    design: ["ux", "ui", "视觉", "交互"],
    finance: ["investment", "market", "金融"],
    news: ["资讯", "快讯", "报道"]
  };

  if (useSynonyms) {
    for (const token of tokens) {
      const aliases = synonymMap[token] ?? [];
      for (const alias of aliases) {
        expanded.add(alias);
      }
    }
  }

  return expanded;
}

function tokenize(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  const base = normalized.split(" ").filter(Boolean);
  if (base.length === 1 && normalized.length > 2) {
    return [normalized];
  }
  return base;
}

function normalizeAiText(text: string, maxChars: number): string {
  const normalized = text
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cap = Number.isFinite(maxChars) ? Math.max(1000, Math.min(200_000, Math.round(maxChars))) : 8_000;
  return normalized.slice(0, cap);
}

function buildEmbeddingSource(item: BookmarkItem, settings: ExtensionSettings): string {
  const compact = [
    `Title: ${item.title}`,
    `Domain: ${item.domain}`,
    `Category: ${item.category ?? ""}`,
    `Tags: ${(item.tags ?? []).join(", ")}`,
    `Summary: ${item.aiSummary ?? ""}`,
    `Note: ${item.userNote ?? ""}`
  ];

  const fullCapture = [
    ...compact,
    `SearchText: ${item.searchText || ""}`,
    `URL: ${item.url}`
  ];

  const selected = settings.embeddingContentMode === "full_capture" ? fullCapture : compact;
  const joined = selected
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n");

  return normalizeAiText(joined, settings.embeddingMaxChars);
}

function buildSearchText(item: Partial<BookmarkItem>): string {
  return [
    item.title,
    item.url,
    item.domain,
    item.aiSummary,
    item.userNote,
    item.category,
    ...(item.tags ?? [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function inferStatus(current: BookmarkStatus, category?: string, tags?: string[]): BookmarkStatus {
  if (current === "trashed") {
    return "trashed";
  }
  if ((category && category.trim()) || (tags && tags.length > 0)) {
    return "classified";
  }
  return current;
}

function normalizeBookmarkStatus(status: BookmarkStatus | string | undefined): BookmarkStatus {
  if (status === "inbox" || status === "analyzing" || status === "classified" || status === "error" || status === "trashed") {
    return status;
  }
  return "inbox";
}

function normalizeSyncState(value: BookmarkSyncState | string | undefined): BookmarkSyncState {
  if (value === "dirty" || value === "synced" || value === "conflict") {
    return value;
  }
  return "dirty";
}

function normalizeCategory(category?: string): string | undefined {
  const trimmed = (category ?? "").trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, 80) : undefined;
}

function normalizeTags(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).slice(0, 24);
}

function normalizeTag(tag?: string): string {
  return (tag ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalizeLookup(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function bigramDiceSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }

  const leftBigrams = toBigrams(left);
  const rightBigrams = toBigrams(right);
  if (leftBigrams.length === 0 || rightBigrams.length === 0) {
    return 0;
  }

  let overlap = 0;
  const rightCounter = new Map<string, number>();
  for (const bigram of rightBigrams) {
    rightCounter.set(bigram, (rightCounter.get(bigram) ?? 0) + 1);
  }

  for (const bigram of leftBigrams) {
    const count = rightCounter.get(bigram) ?? 0;
    if (count > 0) {
      overlap += 1;
      rightCounter.set(bigram, count - 1);
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function toBigrams(value: string): string[] {
  if (value.length < 2) {
    return [value];
  }
  const result: string[] = [];
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2));
  }
  return result;
}

function normalizeUrl(url?: string): string {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

async function findExistingBookmark(primaryUrl: string, fallbackUrl: string): Promise<BookmarkItem | undefined> {
  const normalizedPrimary = normalizeUrl(primaryUrl);
  const normalizedFallback = normalizeUrl(fallbackUrl);
  const list = await db.bookmarks.toArray();

  return list.find((item) => {
    const canonical = normalizeUrl(item.canonicalUrl);
    const regular = normalizeUrl(item.url);

    return (
      canonical === normalizedPrimary ||
      regular === normalizedPrimary ||
      canonical === normalizedFallback ||
      regular === normalizedFallback
    );
  });
}

function resolveChatCompletionsEndpoint(baseUrl: string): string {
  const cleaned = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/chat/completions")) {
    return cleaned;
  }
  if (cleaned.endsWith("/v1")) {
    return `${cleaned}/chat/completions`;
  }
  return `${cleaned}/v1/chat/completions`;
}

function resolveEmbeddingsEndpoint(baseUrl: string): string {
  const cleaned = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/embeddings")) {
    return cleaned;
  }
  if (cleaned.endsWith("/v1")) {
    return `${cleaned}/embeddings`;
  }
  return `${cleaned}/v1/embeddings`;
}

function resolveResponsesEndpoint(baseUrl: string): string {
  const cleaned = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (cleaned.endsWith("/responses")) {
    return cleaned;
  }
  if (cleaned.endsWith("/v1")) {
    return `${cleaned}/responses`;
  }
  return `${cleaned}/v1/responses`;
}

function deriveFaviconFallback(pageUrl?: string, domain?: string): string | undefined {
  const parsed = tryParseUrl(pageUrl);
  if (parsed) {
    return `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(parsed.origin)}`;
  }

  const safeDomain = (domain ?? "").trim();
  if (safeDomain) {
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(safeDomain)}`;
  }

  return undefined;
}

function tryParseUrl(value?: string): URL | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutRef: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutRef = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutRef !== undefined) {
      clearTimeout(timeoutRef);
    }
  }
}

async function openManagerTab(): Promise<void> {
  await chrome.tabs.create({ url: chrome.runtime.getURL("manager/index.html") });
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function isHttpUrl(url?: string): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

async function sendMessageToTab(tabId: number, type: string, payload?: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, {
      protocolVersion: PROTOCOL_VERSION,
      type,
      payload
    });
  } catch {
    return;
  }
}

async function notifyUser(message: string): Promise<void> {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon-128.png",
      title: "MuseMark",
      message
    });
  } catch {
    return;
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}

function toFriendlyAuthError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("bad_oauth_state") || lower.includes("state not found or expired")) {
    return "Google 登录失败：OAuth state 已失效。请重试；若仍失败，请在 Supabase 的 Redirect URLs 中加入 chrome.identity.getRedirectURL() 返回的地址。";
  }
  if (lower.includes("oauth callback timed out")) {
    return "Google 登录超时：扩展没有收到回调地址。请检查 Supabase Redirect URLs 是否包含 chrome.identity.getRedirectURL() 的值。";
  }
  return message;
}
