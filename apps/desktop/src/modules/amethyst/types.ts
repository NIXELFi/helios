// Knowledge Base module — an in-Helios reader for an external Obsidian-style
// vault folder. Data lives OUTSIDE Helios: the user points at a folder on disk
// and we read markdown + attachments live (with a filesystem watcher). Nothing
// is copied into the app or synced to Supabase.

export interface KbNote {
  /** Stable id = relative path without the `.md` extension, forward-slashed,
   *  original case. Used as the routing key and wikilink target. */
  id: string;
  /** Absolute path on disk (for reads). */
  path: string;
  /** Relative path WITH extension (e.g. "SDM26/Engine/5 Intake.md"). */
  rel: string;
  /** File name without extension. */
  basename: string;
  /** Parent directory, relative (e.g. "SDM26/Engine"). "" at the root. */
  dir: string;
  /** Display title: frontmatter `title` -> first H1 -> basename. */
  title: string;
  /** Parsed YAML-ish frontmatter (shallow: scalars, inline/list arrays). */
  frontmatter: Record<string, string | string[]>;
  /** Markdown body (frontmatter stripped). */
  body: string;
  /** Short preview text (Summary callout or first paragraph). */
  summary: string;
  /** Resolved outgoing wikilink note-ids (deduped, resolvable only). */
  links: string[];
  /** Tags from frontmatter `tags` + inline #tags. */
  tags: string[];
  mtimeMs: number;
}

export interface KbVault {
  root: string;
  notes: KbNote[];
  /** id (lowercased) -> note, plus basename (lowercased) -> note for loose
   *  wikilink resolution. First writer wins on basename collisions. */
  resolve: Map<string, KbNote>;
  /** note id -> ids of notes that link to it. */
  backlinks: Map<string, string[]>;
  /** attachment filename (lowercased) -> absolute path. */
  attachments: Map<string, string>;
}

export interface OutlineItem {
  level: number;
  text: string;
  slug: string;
}
