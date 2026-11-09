// Builds and merges the text of a folder's index note. Pure.

export const START = '<!-- folder-index:start -->';
export const END = '<!-- folder-index:end -->';

export interface IndexItem {
  /** What the entries are sorted by (file or folder name). */
  name: string;
  /** The finished Markdown link, made by Obsidian so link settings apply. */
  link: string;
}

export type SortOrder = 'name' | 'name-desc';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortItems(items: readonly IndexItem[], order: SortOrder): IndexItem[] {
  const sorted = [...items].sort((a, b) => collator.compare(a.name, b.name));
  return order === 'name-desc' ? sorted.reverse() : sorted;
}

/** The file name of a folder's index note, from the template. */
export function indexFileName(folderName: string, template: string): string {
  const base = template.split('{{folder}}').join(folderName).replace(/[\\/:*?"<>|]/g, '-').trim() || `_Index of ${folderName}`;
  return /\.md$/i.test(base) ? base : `${base}.md`;
}

export interface BlockOptions {
  folders: readonly IndexItem[];
  notes: readonly IndexItem[];
  order: SortOrder;
  foldersHeading: string;
  notesHeading: string;
}

/** The generated section, markers included. */
export function buildBlock(o: BlockOptions): string {
  const lines: string[] = [START];
  const folders = sortItems(o.folders, o.order);
  const notes = sortItems(o.notes, o.order);
  if (folders.length > 0) {
    if (o.foldersHeading) lines.push(`## ${o.foldersHeading}`, '');
    lines.push(...folders.map((i) => `- ${i.link}`), '');
  }
  if (notes.length > 0) {
    if (o.notesHeading) lines.push(`## ${o.notesHeading}`, '');
    lines.push(...notes.map((i) => `- ${i.link}`), '');
  }
  if (folders.length === 0 && notes.length === 0) lines.push('_Nothing here yet._', '');
  lines.push(END);
  return lines.join('\n');
}

/**
 * The note's new text. With markers, only what is between them changes.
 * Without, the block is added at the end so nothing the user wrote is lost.
 * `existing` null means the note does not exist yet.
 */
export function applyBlock(existing: string | null, block: string): string {
  if (existing === null) return `${block}\n`;
  const end = existing.indexOf(END);
  // The nearest start before the end: a start left over from a deleted end marker is skipped.
  const start = end >= 0 ? existing.lastIndexOf(START, end) : -1;
  if (start >= 0 && end > start) return existing.slice(0, start) + block + existing.slice(end + END.length);
  const trimmed = existing.replace(/\s+$/, '');
  return `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`;
}

/** Whether `text` already holds exactly this block, so a write can be skipped. */
export function upToDate(existing: string, block: string): boolean {
  return applyBlock(existing, block) === existing;
}

/** Folder paths a rule list excludes. A rule ending in `/*` covers the whole subtree. */
export function isExcluded(folderPath: string, rules: readonly string[]): boolean {
  return rules.some((raw) => {
    const rule = raw.trim().replace(/^\/+|\/+$/g, '');
    if (!rule) return false;
    if (rule.endsWith('/*')) {
      const base = rule.slice(0, -2);
      return folderPath === base || folderPath.startsWith(`${base}/`);
    }
    return folderPath === rule;
  });
}

/** One rule per line, blanks dropped. */
export function parseRules(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The folder part of a vault path ("" for the vault root). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}
