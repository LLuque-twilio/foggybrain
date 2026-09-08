export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result as T;
}

export type WorkspaceApi = typeof api;

export function workspaceApi(id: string): WorkspaceApi {
  const prefix = `/workspaces/${encodeURIComponent(id)}`;
  return (path, method, body) => api(`${prefix}${path}`, method, body);
}
