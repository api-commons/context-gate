// Where APIs come from: upload/paste (handled in main), APIs.io search, and GitHub
// code search. Read-only; the user's own token is used for GitHub and never stored.
const APISIO = 'https://apis.io/api/v1';

export interface SearchHit { source: 'apisio' | 'github'; id: string; name: string; provider?: string; url: string; fetch: () => Promise<string>; }

// ---- APIs.io (no key) -------------------------------------------------------
export async function searchApisIo(q: string, limit = 25): Promise<SearchHit[]> {
  const u = new URL(`${APISIO}/openapis`);
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`APIs.io returned ${res.status}`);
  const data = await res.json();
  return ((data?.data ?? []) as any[]).map((h) => ({
    source: 'apisio' as const, id: h.aid || h.url, name: h.name || h.provider_name || h.aid, provider: h.provider_name, url: h.url,
    fetch: () => loadApisIoContent(h),
  }));
}
async function loadApisIoContent(hit: any): Promise<string> {
  if (hit.aid) {
    try {
      const u = new URL(`${APISIO}/apis/${encodeURIComponent(hit.aid)}`);
      u.searchParams.set('include', 'content');
      if (hit.type) u.searchParams.set('artifact_types', hit.type);
      const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
      if (res.ok) { const data = await res.json(); const props: any[] = data?.properties ?? []; const match = props.find((p) => p.url === hit.url) ?? props[0]; if (match?.content) return String(match.content); }
    } catch { /* fall through */ }
  }
  const r = await fetch(hit.url); if (!r.ok) throw new Error(`Could not fetch (${r.status})`); return r.text();
}

// ---- GitHub code search (user token) ---------------------------------------
export async function searchGitHub(q: string, token: string, limit = 25): Promise<SearchHit[]> {
  if (!token) throw new Error('A GitHub token is required for code search.');
  const query = `${q} openapi in:file (extension:yaml OR extension:yml OR extension:json)`;
  const u = new URL('https://api.github.com/search/code');
  u.searchParams.set('q', query);
  u.searchParams.set('per_page', String(limit));
  const res = await fetch(u.toString(), { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}${res.status === 401 ? ' (check your token)' : res.status === 403 ? ' (rate limited)' : ''}`);
  const data = await res.json();
  return ((data?.items ?? []) as any[]).map((it) => ({
    source: 'github' as const, id: it.url, name: it.name, provider: it.repository?.full_name, url: it.html_url,
    fetch: async () => { const r = await fetch(it.url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw' } }); if (!r.ok) throw new Error(`Could not fetch file (${r.status})`); return r.text(); },
  }));
}
