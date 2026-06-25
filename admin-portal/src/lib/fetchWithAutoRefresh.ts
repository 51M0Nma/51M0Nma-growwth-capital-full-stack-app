export type TokenPair = { accessToken: string; refreshToken: string };

/** Bound API fetch used by admin shell and panels (Bearer + refresh on 401). */
export type AdminApiFetch = (url: string, init?: RequestInit) => Promise<Response>;

function withBearer(headers: HeadersInit | undefined, accessToken: string): Headers {
  const h = new Headers(headers ?? undefined);
  h.set("Authorization", `Bearer ${accessToken}`);
  return h;
}

let refreshInFlight: Promise<TokenPair | null> | null = null;

/**
 * Performs fetch with Bearer auth; on 401, rotates tokens via /api/auth/refresh once and retries.
 * Concurrent 401s share one refresh so parallel calls (e.g. Promise.all) do not revoke the same refresh twice.
 */
export async function fetchWithAutoRefresh(
  apiBaseUrl: string,
  url: string,
  init: RequestInit,
  getTokens: () => TokenPair,
  setTokens: (next: TokenPair) => void
): Promise<Response> {
  const first = getTokens();
  const res = await fetch(url, { ...init, headers: withBearer(init.headers, first.accessToken) });
  if (res.status !== 401 || !first.refreshToken) return res;

  refreshInFlight ??= (async (): Promise<TokenPair | null> => {
    try {
      const rt = getTokens().refreshToken;
      if (!rt) return null;
      const refreshRes = await fetch(`${apiBaseUrl}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!refreshRes.ok) return null;
      const data = (await refreshRes.json()) as { accessToken?: string; refreshToken?: string };
      if (!data.accessToken || !data.refreshToken) return null;
      const next: TokenPair = { accessToken: data.accessToken, refreshToken: data.refreshToken };
      setTokens(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  const next = await refreshInFlight;
  if (!next) return res;
  return fetch(url, { ...init, headers: withBearer(init.headers, next.accessToken) });
}

export function createAdminApiFetch(
  apiBaseUrl: string,
  getTokens: () => TokenPair,
  setTokens: (next: TokenPair) => void
): AdminApiFetch {
  return (url, init) => fetchWithAutoRefresh(apiBaseUrl, url, init ?? {}, getTokens, setTokens);
}
