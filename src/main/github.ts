export interface Slug { owner: string; repo: string }
export interface Issue { number: number; title: string; body: string }

export function parseRemote(url: string): Slug | null {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'nexus-orca',
});

async function call<T>(f: typeof fetch, url: string, token: string, init: RequestInit = {}): Promise<T> {
  const res = await f(url, { ...init, headers: { ...headers(token), ...(init.headers ?? {}) } });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return (await res.json()) as T;
}

type RawIssue = { number: number; title: string; body: string | null; pull_request?: unknown };

export async function getIssue(s: Slug, number: number, token: string, f: typeof fetch = fetch): Promise<Issue> {
  const i = await call<RawIssue>(f, `https://api.github.com/repos/${s.owner}/${s.repo}/issues/${number}`, token);
  return { number: i.number, title: i.title, body: i.body ?? '' };
}

/** Open issues with a label; pull requests are excluded. */
export async function listIssues(s: Slug, label: string, token: string, f: typeof fetch = fetch): Promise<Issue[]> {
  const q = new URLSearchParams({ state: 'open', labels: label, per_page: '50' });
  const raw = await call<RawIssue[]>(f, `https://api.github.com/repos/${s.owner}/${s.repo}/issues?${q}`, token);
  return raw.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body ?? '' }));
}

export async function openDraftPr(
  s: Slug, token: string, pr: { head: string; base: string; title: string; body: string }, f: typeof fetch = fetch,
): Promise<string> {
  const out = await call<{ html_url: string }>(f, `https://api.github.com/repos/${s.owner}/${s.repo}/pulls`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...pr, draft: true }),
  });
  return out.html_url;
}
