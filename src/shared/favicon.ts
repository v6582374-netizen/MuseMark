export type FaviconCandidateInput = {
  favIconUrl?: string;
  url?: string;
  domain?: string;
};

// Source icon shape: Tabler Icons "world" (MIT License), color adapted for MuseMark dark UI.
const UNIFIED_FALLBACK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#98A2B3" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0 0-18a9 9 0 0 0 0 18"/><path d="M3.6 9h16.8"/><path d="M3.6 15h16.8"/><path d="M11.5 3a17 17 0 0 0 0 18"/><path d="M12.5 3a17 17 0 0 1 0 18"/></svg>`;

export const UNIFIED_FALLBACK_ICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(UNIFIED_FALLBACK_ICON_SVG)}`;

export function buildFaviconCandidates(input: FaviconCandidateInput): string[] {
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

  addCandidate(UNIFIED_FALLBACK_ICON_DATA_URL);

  return Array.from(unique);
}

export function nextCandidateOrFallback(candidates: string[], currentIndex: number): {
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
