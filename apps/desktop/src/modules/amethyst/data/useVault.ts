import { useCallback, useEffect, useRef, useState } from "react";
import { readDir, readTextFile, stat, watchImmediate } from "@tauri-apps/plugin-fs";
import type { KbNote, KbVault } from "../types";
import {
  splitFrontmatter,
  extractWikiTargets,
  extractTags,
  makeTitle,
  resolveTarget,
} from "./parse";

const MD_RE = /\.md$/i;
const IMG_RE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const MAX_DEPTH = 32;

interface RawFile {
  abs: string;
  rel: string;
  name: string;
  mtimeMs: number;
}

async function walk(dir: string, prefix: string, md: RawFile[], img: RawFile[], depth = 0): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readDir(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
    if (e.isSymlink) continue;
    const abs = `${dir}/${e.name}`;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory) {
      await walk(abs, rel, md, img, depth + 1);
    } else if (e.isFile) {
      if (MD_RE.test(e.name)) md.push({ abs, rel, name: e.name, mtimeMs: 0 });
      else if (IMG_RE.test(e.name)) img.push({ abs, rel, name: e.name, mtimeMs: 0 });
    }
  }
}

async function buildVault(root: string): Promise<KbVault> {
  const mdFiles: RawFile[] = [];
  const imgFiles: RawFile[] = [];
  await walk(root, "", mdFiles, imgFiles);

  const notes: KbNote[] = [];
  for (const f of mdFiles) {
    let raw = "";
    try {
      raw = await readTextFile(f.abs);
    } catch {
      continue;
    }
    let mtimeMs = 0;
    try {
      const info = await stat(f.abs);
      mtimeMs = info.mtime ? info.mtime.getTime() : 0;
    } catch {
      /* stat optional */
    }
    const { fm, body } = splitFrontmatter(raw);
    const basename = f.name.replace(MD_RE, "");
    const id = f.rel.replace(MD_RE, "");
    const dir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
    notes.push({
      id,
      path: f.abs,
      rel: f.rel,
      basename,
      dir,
      title: makeTitle(fm, body, basename),
      frontmatter: fm,
      body,
      links: [], // filled after resolve map exists
      tags: extractTags(fm, body),
      mtimeMs,
    });
  }

  // resolve map: full id + basename (both lowercased). First writer wins on
  // basename collisions (full-path links always resolve exactly).
  const resolve = new Map<string, KbNote>();
  for (const n of notes) resolve.set(n.id.toLowerCase(), n);
  for (const n of notes) {
    const b = n.basename.toLowerCase();
    if (!resolve.has(b)) resolve.set(b, n);
  }

  // outgoing links + backlinks
  const backlinks = new Map<string, string[]>();
  for (const n of notes) {
    const seen = new Set<string>();
    for (const t of extractWikiTargets(n.body)) {
      const tgt = resolveTarget(t, resolve);
      if (tgt && tgt.id !== n.id) seen.add(tgt.id);
    }
    n.links = [...seen];
    for (const targetId of n.links) {
      const arr = backlinks.get(targetId) ?? [];
      if (!arr.includes(n.id)) arr.push(n.id);
      backlinks.set(targetId, arr);
    }
  }

  const attachments = new Map<string, string>();
  for (const f of imgFiles) attachments.set(f.name.toLowerCase(), f.abs);

  notes.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { root, notes, resolve, backlinks, attachments };
}

export function useKbVault(root: string | null) {
  const [vault, setVault] = useState<KbVault | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!root) {
      setVault(null);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    buildVault(root)
      .then((v) => {
        if (alive) {
          setVault(v);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [root, tick]);

  // Debounced filesystem watcher — live-reload when notes change on disk.
  useEffect(() => {
    if (!root) return;
    let stop: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    (async () => {
      try {
        const s = await watchImmediate(
          root,
          () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(reload, 800);
          },
          { recursive: true },
        );
        if (cancelled) s();
        else stop = s;
      } catch {
        /* watch unavailable — manual refresh still works */
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (stop) stop();
    };
  }, [root, reload]);

  return { vault, loading, error, reload };
}
