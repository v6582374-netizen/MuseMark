import type { ExtensionSettings } from "./types";

export const SETTINGS_STORAGE_KEY = "musemark_settings";
const LEGACY_SETTINGS_STORAGE_KEY = `${["auto", "note"].join("")}_settings`;

export const DEFAULT_SETTINGS: ExtensionSettings = {
  baseUrl: "https://api.openai.com",
  apiKey: "",
  model: "gpt-4.1-mini",
  supabaseUrl: "",
  supabaseAnonKey: "",
  authBridgeUrl: "https://bridge.musemark.app",
  cloudSyncEnabled: true,
  embeddingModel: "text-embedding-3-small",
  embeddingContentMode: "readability_only",
  embeddingMaxChars: 8_000,
  temperature: 0.2,
  maxChars: 50_000,
  quickDockEnabled: true,
  quickDockCollapsedByDefault: false,
  quickDockPosition: "right",
  quickDockMaxItems: 10,
  quickDockPinMode: "manual_first",
  classificationMode: "by_type",
  preferReuseCategories: true,
  semanticSearchEnabled: true,
  searchFallbackMode: "local_hybrid",
  webAugmentEnabled: true,
  clarifyOnLowConfidence: true,
  lowConfidenceThreshold: 0.72,
  maxWebAugmentPerQuery: 1,
  excludedUrlPatterns: [],
  rankingWeights: {
    semantic: 0.55,
    lexical: 0.25,
    taxonomy: 0.1,
    recency: 0.1
  },
  trashRetentionDays: 30
};

export async function getSettingsFromStorage(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get([SETTINGS_STORAGE_KEY, LEGACY_SETTINGS_STORAGE_KEY]);
  const currentSettings = result[SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  const legacySettings = result[LEGACY_SETTINGS_STORAGE_KEY] as Partial<ExtensionSettings> | undefined;
  const sourceSettings = mergeStoredSettings(currentSettings, legacySettings);
  const merged = {
    ...DEFAULT_SETTINGS,
    ...(sourceSettings ?? {})
  } as ExtensionSettings;

  // Compatibility bridge: keep both keys in sync after conflict-resolving merge.
  if (sourceSettings) {
    await chrome.storage.local.set({
      [SETTINGS_STORAGE_KEY]: sourceSettings,
      [LEGACY_SETTINGS_STORAGE_KEY]: sourceSettings
    });
  }
  return normalizeSettings(merged);
}

export async function saveSettingsToStorage(settings: ExtensionSettings): Promise<ExtensionSettings> {
  const normalized = normalizeSettings(settings);
  await chrome.storage.local.set({
    [SETTINGS_STORAGE_KEY]: normalized,
    [LEGACY_SETTINGS_STORAGE_KEY]: normalized
  });
  return normalized;
}

function normalizeSettings(settings: ExtensionSettings): ExtensionSettings {
  return {
    ...settings,
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    apiKey: (settings.apiKey ?? "").trim(),
    model: (settings.model ?? DEFAULT_SETTINGS.model).trim() || DEFAULT_SETTINGS.model,
    supabaseUrl: normalizeOptionalUrl(settings.supabaseUrl),
    supabaseAnonKey: (settings.supabaseAnonKey ?? "").trim(),
    authBridgeUrl: normalizeOptionalUrl(settings.authBridgeUrl) || DEFAULT_SETTINGS.authBridgeUrl,
    cloudSyncEnabled: Boolean(settings.cloudSyncEnabled),
    embeddingModel: (settings.embeddingModel ?? DEFAULT_SETTINGS.embeddingModel).trim() || DEFAULT_SETTINGS.embeddingModel,
    embeddingContentMode: settings.embeddingContentMode === "full_capture" ? "full_capture" : "readability_only",
    embeddingMaxChars: Number.isFinite(settings.embeddingMaxChars)
      ? Math.max(1_000, Math.min(120_000, Math.round(settings.embeddingMaxChars)))
      : DEFAULT_SETTINGS.embeddingMaxChars,
    temperature: Number.isFinite(settings.temperature) ? settings.temperature : DEFAULT_SETTINGS.temperature,
    maxChars: Number.isFinite(settings.maxChars) ? Math.max(1_000, Math.min(200_000, settings.maxChars)) : DEFAULT_SETTINGS.maxChars,
    quickDockEnabled: Boolean(settings.quickDockEnabled),
    quickDockCollapsedByDefault: Boolean(settings.quickDockCollapsedByDefault),
    quickDockPosition: settings.quickDockPosition === "bottom_center" ? "bottom_center" : "right",
    quickDockMaxItems: normalizeQuickDockMaxItems(settings.quickDockMaxItems),
    quickDockPinMode: settings.quickDockPinMode === "manual_only" ? "manual_only" : "manual_first",
    classificationMode: settings.classificationMode === "by_content" ? "by_content" : "by_type",
    preferReuseCategories: Boolean(settings.preferReuseCategories),
    semanticSearchEnabled: Boolean(settings.semanticSearchEnabled),
    searchFallbackMode: settings.searchFallbackMode === "lexical_only" ? "lexical_only" : "local_hybrid",
    webAugmentEnabled: Boolean(settings.webAugmentEnabled),
    clarifyOnLowConfidence: Boolean(settings.clarifyOnLowConfidence),
    lowConfidenceThreshold: Number.isFinite(settings.lowConfidenceThreshold)
      ? Math.max(0.4, Math.min(0.95, Number(settings.lowConfidenceThreshold)))
      : DEFAULT_SETTINGS.lowConfidenceThreshold,
    maxWebAugmentPerQuery: Number.isFinite(settings.maxWebAugmentPerQuery)
      ? Math.max(0, Math.min(3, Math.round(Number(settings.maxWebAugmentPerQuery))))
      : DEFAULT_SETTINGS.maxWebAugmentPerQuery,
    excludedUrlPatterns: normalizeExcludedPatterns(settings.excludedUrlPatterns),
    rankingWeights: normalizeRankingWeights(settings.rankingWeights),
    trashRetentionDays: Number.isFinite(settings.trashRetentionDays)
      ? Math.max(1, Math.min(365, Math.round(settings.trashRetentionDays)))
      : DEFAULT_SETTINGS.trashRetentionDays
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  const fallback = DEFAULT_SETTINGS.baseUrl;
  const trimmed = (baseUrl ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeOptionalUrl(url: string | undefined): string {
  const trimmed = (url ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeExcludedPatterns(patterns: string[] | undefined): string[] {
  if (!Array.isArray(patterns)) {
    return [];
  }
  return Array.from(
    new Set(
      patterns
        .map((entry) => (entry ?? "").trim())
        .filter(Boolean)
        .slice(0, 200)
    )
  );
}

function normalizeRankingWeights(weights: ExtensionSettings["rankingWeights"] | undefined): ExtensionSettings["rankingWeights"] {
  const raw = {
    semantic: Number(weights?.semantic ?? DEFAULT_SETTINGS.rankingWeights.semantic),
    lexical: Number(weights?.lexical ?? DEFAULT_SETTINGS.rankingWeights.lexical),
    taxonomy: Number(weights?.taxonomy ?? DEFAULT_SETTINGS.rankingWeights.taxonomy),
    recency: Number(weights?.recency ?? DEFAULT_SETTINGS.rankingWeights.recency)
  };

  const safe = {
    semantic: clampWeight(raw.semantic),
    lexical: clampWeight(raw.lexical),
    taxonomy: clampWeight(raw.taxonomy),
    recency: clampWeight(raw.recency)
  };

  const total = safe.semantic + safe.lexical + safe.taxonomy + safe.recency;
  if (total <= 0) {
    return { ...DEFAULT_SETTINGS.rankingWeights };
  }

  return {
    semantic: roundWeight(safe.semantic / total),
    lexical: roundWeight(safe.lexical / total),
    taxonomy: roundWeight(safe.taxonomy / total),
    recency: roundWeight(safe.recency / total)
  };
}

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function roundWeight(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeQuickDockMaxItems(value: number): number {
  // Force migration from legacy presets (4/6/8) to the new default 10 slots.
  if (value === 10 || value === 4 || value === 6 || value === 8) {
    return 10;
  }
  return DEFAULT_SETTINGS.quickDockMaxItems;
}

function mergeStoredSettings(
  current: Partial<ExtensionSettings> | undefined,
  legacy: Partial<ExtensionSettings> | undefined
): Partial<ExtensionSettings> | undefined {
  if (!current && !legacy) {
    return undefined;
  }
  if (!current) {
    return legacy;
  }
  if (!legacy) {
    return current;
  }

  const pickMaybeDefaultString = (cur: string | undefined, old: string | undefined, defaultValue: string): string | undefined => {
    const currentTrimmed = (cur ?? "").trim();
    const legacyTrimmed = (old ?? "").trim();
    if (!currentTrimmed) {
      return legacyTrimmed || cur || old;
    }
    if (currentTrimmed === defaultValue && legacyTrimmed && legacyTrimmed !== defaultValue) {
      return old;
    }
    return cur;
  };

  const pickSensitiveString = (cur: string | undefined, old: string | undefined): string | undefined => {
    const currentTrimmed = (cur ?? "").trim();
    const legacyTrimmed = (old ?? "").trim();
    if (currentTrimmed) {
      return cur;
    }
    if (legacyTrimmed) {
      return old;
    }
    return cur ?? old;
  };

  return {
    ...legacy,
    ...current,
    baseUrl: pickMaybeDefaultString(current.baseUrl, legacy.baseUrl, DEFAULT_SETTINGS.baseUrl),
    model: pickMaybeDefaultString(current.model, legacy.model, DEFAULT_SETTINGS.model),
    authBridgeUrl: pickMaybeDefaultString(current.authBridgeUrl, legacy.authBridgeUrl, DEFAULT_SETTINGS.authBridgeUrl),
    embeddingModel: pickMaybeDefaultString(current.embeddingModel, legacy.embeddingModel, DEFAULT_SETTINGS.embeddingModel),
    apiKey: pickSensitiveString(current.apiKey, legacy.apiKey),
    supabaseUrl: pickSensitiveString(current.supabaseUrl, legacy.supabaseUrl),
    supabaseAnonKey: pickSensitiveString(current.supabaseAnonKey, legacy.supabaseAnonKey),
    excludedUrlPatterns:
      Array.isArray(current.excludedUrlPatterns) && current.excludedUrlPatterns.length > 0
        ? current.excludedUrlPatterns
        : legacy.excludedUrlPatterns,
    rankingWeights: current.rankingWeights ?? legacy.rankingWeights
  };
}
