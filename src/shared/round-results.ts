import type { VersionRef } from './project-flow';

export interface RoundResultFile {
  path: string;
  kind: 'added' | 'modified' | 'deleted' | 'unchanged';
  deliverable: boolean;
}
export interface RoundResults {
  projectId: string;
  roundId: string;
  integrationId?: string;
  version?: VersionRef;
  availability: 'ready' | 'missing' | 'changed' | 'pending';
  detail: string;
  applied: boolean;
  files: RoundResultFile[];
}
export interface ResultPreview {
  path: string;
  source: 'submitted' | 'current' | 'previous';
  kind: 'text' | 'image' | 'file';
  size: number;
  content?: string;
  language?: string;
  truncated?: boolean;
  imageUrl?: string;
  comparison?: 'same' | 'changed' | 'not-in-submission';
}
export interface ReportSystemNote {
  kind: 'review-skipped' | 'unverified' | 'exit-code' | 'evidence-conflict' | 'user-check';
  text: string;
  eventIds?: string[];
}
export const RESULT_READS = ['projectFlow.round.results', 'projectFlow.round.preview'] as const;
export const OPENABLE_DOCUMENT = /\.(?:txt|md|json|ya?ml|csv|log|png|jpe?g|webp|gif|pdf|docx|xlsx|pptx|mp4|zip)$/i;

/** Normalize local Markdown targets without allowing network URLs or UNC shares. */
export function projectFileLink(target: string): string | undefined {
  let value = target.trim().replace(/^<(.+)>$/, '$1');
  value = value.replace(/^file:\/\/(?=\/(?!\/))/i, '');
  try { value = decodeURIComponent(value); } catch { /* Keep a literal percent sign. */ }
  value = value.replace(/^\/(?=[a-z]:[/\\])/i, '');
  if (!value || /^[#?]/.test(value) || /^[\\/]{2}/.test(value)) return undefined;
  if (value.includes(':') && !/^[a-z]:[/\\][^:]*$/i.test(value)) return undefined;
  return value;
}
