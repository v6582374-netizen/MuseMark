export type BookmarkStatus = "inbox" | "analyzing" | "classified" | "error" | "trashed";

export type CaptureMode = "readability" | "dom_text" | "selection_only";
export type AuthProvider = "google" | "email_magic_link";
export type BookmarkSyncState = "dirty" | "synced" | "conflict";

export interface AuthSessionUser {
  id: string;
  email: string;
  displayName?: string;
  avatarUrl?: string;
  provider?: AuthProvider;
}

export interface AuthState {
  mode: "guest" | "authenticated";
  user?: AuthSessionUser;
  lastSyncAt?: string;
  syncStatus?: "idle" | "syncing" | "error";
  lastError?: string;
  needsMigration?: boolean;
}

export interface AnalyzeOutput {
  summary: string;
  keyTopics: string[];
  suggestedCategoryCandidates: string[];
  suggestedTags: string[];
  language: string;
  confidence: number;
}

export interface ClassifyOutput {
  category: string;
  tags: string[];
  shortReason: string;
  confidence: number;
}

export interface ContentCaptureMeta {
  textDigest: string;
  textChars: number;
  captureMode: CaptureMode;
}

export interface AiMeta {
  provider: "openai_compatible";
  baseUrl: string;
  model: string;
  promptVersion: string;
  stage1?: {
    finishedAt: string;
    confidence?: number;
  };
  stage2?: {
    finishedAt: string;
    confidence?: number;
  };
  lastError?: string;
}

export interface SearchSignals {
  lexicalScore?: number;
  semanticScore?: number;
  taxonomyScore?: number;
  recencyScore?: number;
}

export interface SearchScoreBreakdown {
  bookmarkId: string;
  title: string;
  finalScore: number;
  exactMatchTier: number;
  lexicalScore: number;
  semanticScore: number;
  taxonomyScore: number;
  recencyScore: number;
}

export interface SearchTrace {
  query: string;
  effectiveQuery: string;
  intentType: "empty" | "explicit" | "ambiguous";
  webUsed: boolean;
  webReason: string;
  expandedTerms: string[];
  decisionReason: string;
  scoreBreakdown: SearchScoreBreakdown[];
}

export interface RankingWeights {
  semantic: number;
  lexical: number;
  taxonomy: number;
  recency: number;
}

export interface DockProfile {
  id: string;
  name: string;
  itemIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DockItemPreference {
  bookmarkId: string;
  pinned?: boolean;
  pinOrder?: number;
  dismissedUntil?: string;
  dockOpenCount?: number;
  dockLastOpenedAt?: string;
  dockOpenEvents?: string[];
}

export interface DockLayoutState {
  mode: "collapsed" | "peek" | "expanded";
  pinned: boolean;
  activeProfileId: string;
  updatedAt: string;
}

export interface DockRankingState {
  score: number;
  clickScore: number;
  openRecencyScore: number;
  saveRecencyScore: number;
  affinityScore: number;
}

export interface DockEntry {
  id: string;
  kind: "bookmark" | "action";
  title: string;
  subtitle?: string;
  url?: string;
  domain?: string;
  favIconUrl?: string;
  pinned?: boolean;
  ranking?: DockRankingState;
  action?: "open_library" | "save_current_page";
}

export interface BookmarkItem {
  id: string;
  url: string;
  canonicalUrl?: string;
  title: string;
  domain: string;
  favIconUrl?: string;
  createdAt: string;
  updatedAt: string;
  lastSavedAt: string;
  saveCount: number;
  status: BookmarkStatus;
  pinned?: boolean;
  locked?: boolean;
  deletedAt?: string;
  userNote?: string;
  aiSummary?: string;
  category?: string;
  tags: string[];
  classificationConfidence?: number;
  embedding?: number[];
  embeddingModel?: string;
  embeddingUpdatedAt?: string;
  syncState?: BookmarkSyncState;
  lastSyncedAt?: string;
  cloudUpdatedAt?: string;
  cloudId?: string;
  whyMatched?: string;
  searchSignals?: SearchSignals;
  aiMeta?: AiMeta;
  contentCapture?: ContentCaptureMeta;
  searchText: string;
}

export interface CapturePayload {
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
  captureMode: CaptureMode;
  wasTruncated: boolean;
}

export interface ExtensionSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  authBridgeUrl: string;
  cloudSyncEnabled: boolean;
  embeddingModel: string;
  embeddingContentMode: "readability_only" | "full_capture";
  embeddingMaxChars: number;
  temperature: number;
  maxChars: number;
  quickDockEnabled: boolean;
  quickDockCollapsedByDefault: boolean;
  quickDockPosition: "right" | "bottom_center";
  quickDockMaxItems: number;
  quickDockPinMode: "manual_first" | "manual_only";
  classificationMode: "by_type" | "by_content";
  preferReuseCategories: boolean;
  semanticSearchEnabled: boolean;
  searchFallbackMode: "local_hybrid" | "lexical_only";
  webAugmentEnabled: boolean;
  clarifyOnLowConfidence: boolean;
  lowConfidenceThreshold: number;
  maxWebAugmentPerQuery: number;
  excludedUrlPatterns: string[];
  rankingWeights: RankingWeights;
  trashRetentionDays: number;
}

export interface CategoryRule {
  id: string;
  canonical: string;
  aliases: string[];
  pinned: boolean;
  color?: string;
  updatedAt: string;
}

export interface SemanticSearchItem extends BookmarkItem {
  whyMatched: string;
  searchSignals: SearchSignals;
}
