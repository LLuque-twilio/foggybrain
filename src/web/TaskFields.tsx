import type { Dispatch, SetStateAction } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { inferExternalLinkType } from '../external-links';
import type { ExternalLink, ExternalLinkType, GithubPr, GithubStatus, TaskKind } from '../shared';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { LoadingField } from './LoadingField';
import { SearchableSelect } from './SearchableSelect';

const externalLinkTypes: { value: ExternalLinkType; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'jira', label: 'Jira' },
  { value: 'google-doc', label: 'Google Doc' },
  { value: 'generic', label: 'Generic' },
];

export type ExternalLinkDraft = Omit<ExternalLink, 'type'> & {
  type: ExternalLinkType | '';
  inferType: boolean;
};

export function ExternalLinkFields({
  links,
  setLinks,
}: {
  links: ExternalLinkDraft[];
  setLinks: Dispatch<SetStateAction<ExternalLinkDraft[]>>;
}) {
  return (
    <>
      {links.map((link, index) => (
        <div className="external-link-editor" key={index}>
          <div className="external-link-editor-heading">
            <strong>Resource {index + 1}</strong>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="icon-button"
              aria-label={`Remove resource ${index + 1}`}
              onClick={() => setLinks((current) => current.filter((_, item) => item !== index))}
            >
              <Trash2 size={14} />
            </Button>
          </div>
          <label>
            URL
            <Input
              type="url"
              required
              maxLength={2048}
              aria-label={`Resource ${index + 1} URL`}
              placeholder="https://..."
              value={link.url}
              onChange={(event) => {
                const nextUrl = event.target.value;
                setLinks((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          url: nextUrl,
                          type: item.inferType ? inferExternalLinkType(nextUrl) : item.type,
                        }
                      : item,
                  ),
                );
              }}
            />
          </label>
          <label>
            Label <span className="optional">optional</span>
            <Input
              maxLength={100}
              aria-label={`Resource ${index + 1} label`}
              placeholder="e.g. Design document"
              value={link.label}
              onChange={(event) =>
                setLinks((current) =>
                  current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, label: event.target.value } : item,
                  ),
                )
              }
            />
          </label>
          <SearchableSelect
            label={`Resource ${index + 1} type`}
            options={externalLinkTypes}
            value={link.type}
            required
            onChange={(type) =>
              setLinks((current) =>
                current.map((item, itemIndex) =>
                  itemIndex === index
                    ? { ...item, type: type as ExternalLinkType | '', inferType: false }
                    : item,
                ),
              )
            }
          />
        </div>
      ))}
      {links.length < 5 && (
        <Button
          type="button"
          className="button full add-external-link"
          onClick={() =>
            setLinks((current) => [
              ...current,
              { url: '', label: '', type: 'generic', inferType: true },
            ])
          }
        >
          <Plus size={15} />
          Add external resource
        </Button>
      )}
    </>
  );
}

export function PrUrlFields({
  kind,
  url,
  setUrl,
  prs,
  github,
  onSelect,
}: {
  kind: Exclude<TaskKind, 'container'>;
  url: string;
  setUrl: (url: string) => void;
  prs: GithubPr[];
  github: GithubStatus | null;
  onSelect?: (pr: GithubPr) => void;
}) {
  const githubLoading = !github || github.syncing;
  return (
    <>
      <label>
        Your open pull requests
        <LoadingField loading={githubLoading}>
          <select
            aria-busy={githubLoading}
            aria-describedby="pr-discovery-hint"
            value={prs.some((pr) => pr.url === url) ? url : ''}
            onChange={(event) => {
              const selected = prs.find((pr) => pr.url === event.target.value);
              setUrl(event.target.value);
              if (selected) onSelect?.(selected);
            }}
          >
            <option value="">Select a PR or enter a URL below</option>
            {prs.map((pr) => (
              <option key={pr.url} value={pr.url}>
                {pr.repository} #{pr.number}: {pr.title}
                {pr.draft ? ' (draft)' : ''}
              </option>
            ))}
          </select>
        </LoadingField>
      </label>
      <p className="form-hint" id="pr-discovery-hint" role="status">
        {!github
          ? 'Loading GitHub status... You can also enter a URL below.'
          : !github.configured
            ? 'GitHub is not connected. You can still enter a PR URL below.'
            : github.error
              ? `GitHub sync failed: ${github.error}. Listed PRs may be stale; you can enter a URL below.`
              : github.syncing
                ? 'Refreshing your open pull requests... You can also enter a URL below.'
                : !prs.length
                  ? 'No authored open pull requests found. Enter a PR URL below.'
                  : 'Choose one of your authored PRs, or enter any GitHub PR URL below.'}
      </p>
      <label>
        GitHub PR URL
        {kind === 'manual' && <span className="optional">optional</span>}
        <Input
          type="url"
          required={kind === 'pr'}
          placeholder="https://github.com/owner/repo/pull/123"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      {kind === 'manual' && (
        <p className="form-hint">
          With a PR gate, both your manual work and a verified PR merge are required. Clear the URL
          to remove the gate.
        </p>
      )}
    </>
  );
}
