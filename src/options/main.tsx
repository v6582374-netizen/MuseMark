import { render } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { sendRuntimeMessage } from "../shared/runtime";
import type { DockEntry, ExtensionSettings } from "../shared/types";
import "./styles.css";

type QuickDockControlDataResponse = {
  enabled: boolean;
  profileId: string;
  maxItems: number;
  pinnedEntries: DockEntry[];
  suggestedEntries: DockEntry[];
};

function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [excludedText, setExcludedText] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("Loading...");
  const [dockControlLoading, setDockControlLoading] = useState(true);
  const [dockControlError, setDockControlError] = useState("");
  const [dockEnabled, setDockEnabled] = useState(true);
  const [dockPinnedEntries, setDockPinnedEntries] = useState<DockEntry[]>([]);
  const [dockSuggestedEntries, setDockSuggestedEntries] = useState<DockEntry[]>([]);

  const weights = useMemo(() => settings.rankingWeights, [settings.rankingWeights]);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await sendRuntimeMessage<ExtensionSettings>("settings/get");
        setSettings(loaded);
        setExcludedText((loaded.excludedUrlPatterns ?? []).join("\n"));
        setStatus("Ready.");
      } catch (error) {
        setStatus(toErrorMessage(error));
      }
    })();
  }, []);

  useEffect(() => {
    void reloadDockControlData();
  }, []);

  function buildSettingsPayload(): ExtensionSettings {
    const excludedUrlPatterns = excludedText
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    return {
      ...settings,
      excludedUrlPatterns
    };
  }

  async function saveSettings() {
    setSaving(true);
    setStatus("Saving...");
    try {
      const payload = buildSettingsPayload();
      const saved = await sendRuntimeMessage<ExtensionSettings>("settings/save", payload);
      setSettings(saved);
      setExcludedText((saved.excludedUrlPatterns ?? []).join("\n"));
      setStatus("Saved.");
    } catch (error) {
      setStatus(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setSaving(true);
    setStatus("Testing AI connection...");
    try {
      const result = await sendRuntimeMessage<{ success: boolean; model: string }>("settings/test");
      setStatus(result.success ? `Connection successful (${result.model}).` : "Connection failed.");
    } catch (error) {
      setStatus(toErrorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function resetRankingWeights() {
    setSettings({
      ...settings,
      rankingWeights: { ...DEFAULT_SETTINGS.rankingWeights }
    });
  }

  function updateWeight(key: keyof ExtensionSettings["rankingWeights"], value: number) {
    setSettings({
      ...settings,
      rankingWeights: {
        ...settings.rankingWeights,
        [key]: Number.isFinite(value) ? value : 0
      }
    });
  }

  async function reloadDockControlData() {
    setDockControlLoading(true);
    setDockControlError("");
    try {
      const response = await sendRuntimeMessage<QuickDockControlDataResponse>("quickDock/controlData", {
        suggestedLimit: 20
      });
      setDockEnabled(Boolean(response.enabled));
      setDockPinnedEntries(Array.isArray(response.pinnedEntries) ? response.pinnedEntries : []);
      setDockSuggestedEntries(Array.isArray(response.suggestedEntries) ? response.suggestedEntries : []);
    } catch (error) {
      setDockControlError(toErrorMessage(error));
      setDockPinnedEntries([]);
      setDockSuggestedEntries([]);
    } finally {
      setDockControlLoading(false);
    }
  }

  async function handlePinToDock(entry: DockEntry) {
    if (entry.kind !== "bookmark") {
      return;
    }
    try {
      await sendRuntimeMessage("quickDock/pin", {
        bookmarkId: entry.id
      });
      await reloadDockControlData();
    } catch (error) {
      setDockControlError(toErrorMessage(error));
    }
  }

  async function handleUnpinFromDock(entry: DockEntry) {
    if (entry.kind !== "bookmark") {
      return;
    }
    try {
      await sendRuntimeMessage("quickDock/unpin", {
        bookmarkId: entry.id
      });
      await reloadDockControlData();
    } catch (error) {
      setDockControlError(toErrorMessage(error));
    }
  }

  async function handleUnpinFromSuggested(entry: DockEntry) {
    if (entry.kind !== "bookmark") {
      return;
    }
    setDockSuggestedEntries((current) => current.filter((candidate) => candidate.id !== entry.id));
    try {
      await sendRuntimeMessage("quickDock/dismiss", {
        bookmarkId: entry.id,
        days: 30
      });
      await reloadDockControlData();
    } catch (error) {
      setDockControlError(toErrorMessage(error));
      await reloadDockControlData();
    }
  }

  async function handleOpenDockEntry(entry: DockEntry) {
    try {
      await sendRuntimeMessage("quickDock/open", {
        id: entry.id,
        url: entry.url
      });
    } catch (error) {
      setDockControlError(toErrorMessage(error));
    }
  }

  return (
    <div class="wrap">
      <section class="panel">
        <div class="panel-head">
          <h1>MuseMark Settings</h1>
          <p>Configure API, privacy/cost limits, and semantic ranking behavior.</p>
        </div>

        <div class="form">
          <div class="field full">
            <label>Base URL</label>
            <input
              value={settings.baseUrl}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  baseUrl: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="https://api.openai.com"
            />
            <small>Saving settings will request runtime permission only for this domain.</small>
          </div>

          <div class="field full">
            <label>API Key</label>
            <input
              type="password"
              value={settings.apiKey}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  apiKey: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="sk-..."
            />
            <small>Security: API Key is local-only and will never be synced to cloud.</small>
          </div>

          <div class="field">
            <label>Cloud sync</label>
            <select
              value={settings.cloudSyncEnabled ? "on" : "off"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  cloudSyncEnabled: (event.currentTarget as HTMLSelectElement).value === "on"
                })
              }
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div class="field">
            <label>Auth bridge URL</label>
            <input
              value={settings.authBridgeUrl}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  authBridgeUrl: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="https://bridge.musemark.app"
            />
          </div>

          <div class="field full">
            <label>Supabase URL</label>
            <input
              value={settings.supabaseUrl}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  supabaseUrl: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="https://xxxx.supabase.co"
            />
            <small>Cloud sync/auth uses runtime permission for this domain only.</small>
          </div>

          <div class="field full">
            <label>Supabase anon key</label>
            <input
              type="password"
              value={settings.supabaseAnonKey}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  supabaseAnonKey: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="eyJhbGci..."
            />
          </div>

          <div class="field">
            <label>Model</label>
            <input
              value={settings.model}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  model: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="gpt-4.1-mini"
            />
          </div>

          <div class="field">
            <label>Embedding model</label>
            <input
              value={settings.embeddingModel}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  embeddingModel: (event.currentTarget as HTMLInputElement).value
                })
              }
              placeholder="text-embedding-3-small"
            />
          </div>

          <div class="field">
            <label>Temperature</label>
            <input
              type="number"
              min="0"
              max="1"
              step="0.1"
              value={settings.temperature}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  temperature: Number((event.currentTarget as HTMLInputElement).value)
                })
              }
            />
          </div>

          <div class="field">
            <label>Max chars for capture</label>
            <input
              type="number"
              min="1000"
              max="200000"
              step="1000"
              value={settings.maxChars}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  maxChars: Number((event.currentTarget as HTMLInputElement).value)
                })
              }
            />
          </div>

          <div class="field">
            <label>Embedding content mode</label>
            <select
              value={settings.embeddingContentMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  embeddingContentMode: (event.currentTarget as HTMLSelectElement).value as "readability_only" | "full_capture"
                })
              }
            >
              <option value="readability_only">Readability summary only</option>
              <option value="full_capture">Full capture text (capped)</option>
            </select>
          </div>

          <div class="field">
            <label>Embedding max chars</label>
            <input
              type="number"
              min="1000"
              max="120000"
              step="1000"
              value={settings.embeddingMaxChars}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  embeddingMaxChars: Number((event.currentTarget as HTMLInputElement).value)
                })
              }
            />
          </div>

          <div class="field">
            <label>Semantic search</label>
            <select
              value={settings.semanticSearchEnabled ? "on" : "off"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  semanticSearchEnabled: (event.currentTarget as HTMLSelectElement).value === "on"
                })
              }
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div class="field">
            <label>Fallback mode</label>
            <select
              value={settings.searchFallbackMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  searchFallbackMode: (event.currentTarget as HTMLSelectElement).value as "local_hybrid" | "lexical_only"
                })
              }
            >
              <option value="local_hybrid">Local hybrid</option>
              <option value="lexical_only">Lexical only</option>
            </select>
          </div>

          <div class="field">
            <label>Web augment for ambiguous query</label>
            <select
              value={settings.webAugmentEnabled ? "on" : "off"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  webAugmentEnabled: (event.currentTarget as HTMLSelectElement).value === "on"
                })
              }
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div class="field">
            <label>Clarify on low confidence</label>
            <select
              value={settings.clarifyOnLowConfidence ? "on" : "off"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  clarifyOnLowConfidence: (event.currentTarget as HTMLSelectElement).value === "on"
                })
              }
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div class="field">
            <label>Low confidence threshold</label>
            <input
              type="number"
              min="0.4"
              max="0.95"
              step="0.01"
              value={settings.lowConfidenceThreshold}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  lowConfidenceThreshold: Number((event.currentTarget as HTMLInputElement).value)
                })
              }
            />
          </div>

          <div class="field">
            <label>Max web augment calls/query</label>
            <select
              value={String(settings.maxWebAugmentPerQuery)}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  maxWebAugmentPerQuery: Number((event.currentTarget as HTMLSelectElement).value)
                })
              }
            >
              <option value="0">0</option>
              <option value="1">1</option>
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </div>

          <div class="field">
            <label>Trash retention days</label>
            <input
              type="number"
              min="1"
              max="365"
              step="1"
              value={settings.trashRetentionDays}
              onInput={(event) =>
                setSettings({
                  ...settings,
                  trashRetentionDays: Number((event.currentTarget as HTMLInputElement).value)
                })
              }
            />
          </div>

          <div class="field">
            <label>QuickDock</label>
            <select
              value={settings.quickDockEnabled ? "on" : "off"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  quickDockEnabled: (event.currentTarget as HTMLSelectElement).value === "on"
                })
              }
            >
              <option value="on">Enabled</option>
              <option value="off">Disabled</option>
            </select>
          </div>

          <div class="field">
            <label>QuickDock default visibility</label>
            <select
              value={settings.quickDockCollapsedByDefault ? "collapsed" : "expanded"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  quickDockCollapsedByDefault: (event.currentTarget as HTMLSelectElement).value === "collapsed"
                })
              }
            >
              <option value="expanded">Visible</option>
              <option value="collapsed">Hidden</option>
            </select>
          </div>

          <div class="field">
            <label>QuickDock max items</label>
            <select
              value={String(settings.quickDockMaxItems)}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  quickDockMaxItems: Number((event.currentTarget as HTMLSelectElement).value)
                })
              }
            >
              <option value="10">10</option>
            </select>
          </div>

          <div class="field">
            <label>QuickDock pin mode</label>
            <select
              value={settings.quickDockPinMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  quickDockPinMode: (event.currentTarget as HTMLSelectElement).value as "manual_first" | "manual_only"
                })
              }
            >
              <option value="manual_first">Manual first + adaptive</option>
              <option value="manual_only">Manual only</option>
            </select>
          </div>

          <div class="field">
            <label>Classification mode</label>
            <select
              value={settings.classificationMode}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  classificationMode: (event.currentTarget as HTMLSelectElement).value as "by_type" | "by_content"
                })
              }
            >
              <option value="by_type">By bookmark type</option>
              <option value="by_content">By page content</option>
            </select>
          </div>

          <div class="field">
            <label>Prefer reusing existing categories</label>
            <select
              value={settings.preferReuseCategories ? "yes" : "no"}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  preferReuseCategories: (event.currentTarget as HTMLSelectElement).value === "yes"
                })
              }
            >
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>

          <div class="field full">
            <label>Exclude URL patterns (one per line, supports * wildcard)</label>
            <textarea
              rows={4}
              value={excludedText}
              onInput={(event) => setExcludedText((event.currentTarget as HTMLTextAreaElement).value)}
              placeholder="https://mail.google.com/*\nhttps://bank.example.com/*"
            />
          </div>

          <div class="field full">
            <label>Ranking weights (semantic / lexical / taxonomy / recency)</label>
            <div class="weights-grid">
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={weights.semantic}
                onInput={(event) => updateWeight("semantic", Number((event.currentTarget as HTMLInputElement).value))}
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={weights.lexical}
                onInput={(event) => updateWeight("lexical", Number((event.currentTarget as HTMLInputElement).value))}
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={weights.taxonomy}
                onInput={(event) => updateWeight("taxonomy", Number((event.currentTarget as HTMLInputElement).value))}
              />
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={weights.recency}
                onInput={(event) => updateWeight("recency", Number((event.currentTarget as HTMLInputElement).value))}
              />
            </div>
            <button class="btn" type="button" onClick={resetRankingWeights}>
              Restore default weights
            </button>
          </div>
        </div>

        <section class="dock-control">
          <div class="dock-control-head">
            <h2>Dock Control</h2>
            <span>
              {dockEnabled ? "Enabled" : "Disabled"} · Max {settings.quickDockMaxItems}
            </span>
          </div>
          {dockControlError && <div class="dock-control-error">{dockControlError}</div>}

          <div class="dock-section">
            <div class="dock-section-head">
              <strong>Pinned to Dock</strong>
              <span>{dockPinnedEntries.length}</span>
            </div>
            {dockControlLoading ? (
              <div class="dock-empty">Loading pinned bookmarks...</div>
            ) : dockPinnedEntries.length === 0 ? (
              <div class="dock-empty">No pinned bookmarks.</div>
            ) : (
              <div class="dock-list">
                {dockPinnedEntries.map((entry) => (
                  <div class="dock-row" key={`pinned-${entry.id}`}>
                    <div class="dock-row-main">
                      {entry.favIconUrl ? (
                        <img class="dock-favicon" src={entry.favIconUrl} alt={entry.domain || entry.title} />
                      ) : (
                        <span class="dock-favicon dock-fallback">{(entry.domain || entry.title || "?").slice(0, 1).toUpperCase()}</span>
                      )}
                      <div class="dock-row-copy">
                        <strong>{entry.title || entry.url || entry.id}</strong>
                        <small>{entry.domain || entry.url || "No URL"}</small>
                      </div>
                    </div>
                    <div class="dock-row-actions">
                      <button class="btn" type="button" onClick={() => void handleOpenDockEntry(entry)} disabled={!entry.url}>
                        Open
                      </button>
                      <button class="btn" type="button" onClick={() => void handleUnpinFromDock(entry)}>
                        Unpin
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div class="dock-divider" />

          <div class="dock-section">
            <div class="dock-section-head">
              <strong>Suggested for Dock</strong>
              <span>{dockSuggestedEntries.length}</span>
            </div>
            {dockControlLoading ? (
              <div class="dock-empty">Loading suggestions...</div>
            ) : dockSuggestedEntries.length === 0 ? (
              <div class="dock-empty">No suggested bookmarks right now.</div>
            ) : (
              <div class="dock-list">
                {dockSuggestedEntries.map((entry) => (
                  <div class="dock-row" key={`suggested-${entry.id}`}>
                    <div class="dock-row-main">
                      {entry.favIconUrl ? (
                        <img class="dock-favicon" src={entry.favIconUrl} alt={entry.domain || entry.title} />
                      ) : (
                        <span class="dock-favicon dock-fallback">{(entry.domain || entry.title || "?").slice(0, 1).toUpperCase()}</span>
                      )}
                      <div class="dock-row-copy">
                        <strong>{entry.title || entry.url || entry.id}</strong>
                        <small>{entry.domain || entry.url || "No URL"}</small>
                      </div>
                    </div>
                    <div class="dock-row-actions">
                      <button class="btn" type="button" onClick={() => void handleOpenDockEntry(entry)} disabled={!entry.url}>
                        Open
                      </button>
                      <button class="btn" type="button" onClick={() => void handlePinToDock(entry)}>
                        Pin
                      </button>
                      <button class="btn" type="button" onClick={() => void handleUnpinFromSuggested(entry)}>
                        Unpin
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <div class="footer">
          <button class="btn primary" onClick={() => void saveSettings()} disabled={saving}>
            Save settings
          </button>
          <button class="btn" onClick={() => void testConnection()} disabled={saving}>
            Test connection
          </button>
          <div class="hint">{status}</div>
        </div>
      </section>
    </div>
  );
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error ?? "Unknown error");
}

render(<App />, document.getElementById("app")!);
