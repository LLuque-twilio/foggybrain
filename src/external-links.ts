import type { ExternalLinkType } from './shared.js';

export function inferExternalLinkType(url: string): ExternalLinkType {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'github.com' || hostname === 'www.github.com') return 'github';
    if (hostname.endsWith('.atlassian.net')) return 'jira';
    if (hostname === 'docs.google.com' && parsed.pathname.startsWith('/document/'))
      return 'google-doc';
  } catch {
    // Partial URLs remain generic while the user is typing.
  }
  return 'generic';
}
