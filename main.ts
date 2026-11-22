// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old, new] pairs, for the `R` output lines. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---- SPEC.md sections 5 to 8: line matching, unified diffs, SEARCH/REPLACE, V4A ---- */

interface FileDoc {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

/** Split a file's text at its own line break (CRLF when the first LF follows a CR, else LF). */
function parseDoc(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at the given tier (occurrences may overlap). */
function tierOccurrences(lines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0 || o.length > lines.length) return pos;
  outer: for (let i = 0; i + o.length <= lines.length; i++) {
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) continue outer;
    }
    pos.push(i);
  }
  return pos;
}

/** The first tier (0, 1, 2) at which O occurs, with its occurrences; null when it never occurs. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = tierOccurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** Like findTier, but only occurrences at or after `from`; when `eof` only occurrences that end at the file's last line count. */
function findTierFrom(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
  eof: boolean,
): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = tierOccurrences(lines, o, t).filter((p) => p >= from && (!eof || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or an added line. */
type NLine = { ctx: true; oi: number } | { ctx: false; text: string };

/** Resolve the N lines for a match at `pos`: context lines come from the file, other lines are re-indented at tier 2. */
function resolveN(items: NLine[], lines: string[], pos: number, o: string[], tier: number): string[] {
  const out: string[] = [];
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = /^[ \t]*/.exec(lines[pos]!)![0];
    p = /^[ \t]*/.exec(o[0]!)![0];
  }
  for (const it of items) {
    if (it.ctx) {
      out.push(lines[pos + it.oi]!);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** Split a hunk/chunk body into its O lines and its N lines (context lines paired to O by index). */
function splitBody(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl === '' || bl.startsWith(' ')) {
      const text = bl === '' ? '' : bl.slice(1);
      o.push(text);
      n.push({ ctx: true, oi: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ ctx: false, text: bl.slice(1) });
    }
    // A `\` line refers to the body line before it; only the final-break rule reads it.
  }
  return { o, n };
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const bl = body[k]!;
    if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

/* ---- Unified diffs (section 6) ---- */

interface UniHunk {
  a: number;
  body: string[];
}
interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | null | undefined;
  renNew: string | null | undefined;
  gitOld: string;
  gitNew: string;
  createFlag: boolean;
  delFlag: boolean;
  hunks: UniHunk[];
}

/** A path from a `--- `/`+++ ` line: text after the four characters, up to the first tab, trimmed; null for /dev/null. */
function uniPath(t: string): string | null {
  const p = t.split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const gitRe = /^diff --git a\/(\S+) b\/(\S+)$/;
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: UniHunk | null = null;
  let state: 'out' | 'header' | 'between' | 'body' = 'out';
  let hasPair = false;
  const newSection = (gitOld: string, gitNew: string): UniSection => {
    const s: UniSection = {
      pairOld: undefined,
      pairNew: undefined,
      renOld: undefined,
      renNew: undefined,
      gitOld,
      gitNew,
      createFlag: false,
      delFlag: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      hunk = null;
    }
    state = 'between';
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (state === 'body') {
      if (l.startsWith('diff --git ')) endBody();
      else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) endBody();
      else if (l.startsWith('@@')) endBody();
      else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
        hunk!.body.push(l);
        continue;
      } else endBody();
    }
    if (l.startsWith('diff --git ')) {
      const m = gitRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = newSection(m[1]!, m[2]!);
      hasPair = false;
      state = 'header';
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && sec !== null && !hasPair) {
        sec.pairOld = uniPath(l.slice(4));
        sec.pairNew = uniPath(lines[i + 1]!.slice(4));
        hasPair = true;
        i++;
        continue;
      }
      sec = newSection('', '');
      sec.pairOld = uniPath(l.slice(4));
      sec.pairNew = uniPath(lines[i + 1]!.slice(4));
      hasPair = true;
      state = 'header';
      i++;
      continue;
    }
    if (state === 'header' && l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { a: parseInt(m[1]!, 10), body: [] };
      sec.hunks.push(hunk);
      state = 'body';
      continue;
    }
    if (state === 'header' && sec !== null) {
      if (l.startsWith('rename from ')) {
        sec.renOld = l.slice('rename from '.length).trim();
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renNew = l.slice('rename to '.length).trim();
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.createFlag = true;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delFlag = true;
        continue;
      }
      continue;
    }
    // Every other line outside a hunk body is ignored (prose, code fences, header lines).
  }
  if (state === 'body') endBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file's lines. */
function applyUniHunks(doc: FileDoc, hunks: UniHunk[], path: string, strict: boolean): FileDoc {
  const lines = [...doc.lines];
  let final = doc.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.body);
    const noEol = hunkNoEol(h.body);
    if (o.length > 0) {
      const found = findTier(lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const nLines = resolveN(n, lines, best, o, found.tier);
      const atEnd = best + o.length === lines.length;
      lines.splice(best, o.length, ...nLines);
      if (atEnd) final = !noEol;
      d += n.length - o.length;
    } else {
      const at = Math.min(h.a + d, lines.length);
      const nLines = resolveN(n, lines, at, o, 0);
      lines.splice(at, 0, ...nLines);
      if (at === lines.length) final = !noEol;
      d += n.length;
    }
  }
  return { lines, br: doc.br, final };
}

function unifiedSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld !== '' ? sec.gitOld : undefined;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew !== '' ? sec.gitNew : undefined;
    const isCreate = oldP === null || sec.createFlag;
    const isDelete = newP === null || sec.delFlag;
    if (isCreate && newP !== null && newP !== undefined) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const ls: string[] = [];
      for (const h of sec.hunks) {
        for (const bl of h.body) {
          if (bl.startsWith('+')) ls.push(bl.slice(1));
        }
      }
      let final = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.startsWith('+')) {
            const next = body[k + 1];
            if (next !== undefined && next.startsWith('\\')) final = false;
            break outer;
          }
        }
      }
      tree.now.set(newP, ls.length === 0 ? '' : ls.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete && oldP !== null && oldP !== undefined) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && oldP !== undefined && newP !== null && newP !== undefined && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const doc = applyUniHunks(parseDoc(before), sec.hunks, oldP, strict);
      tree.now.set(oldP, null);
      tree.now.set(newP, writeDoc(doc));
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP !== null && oldP !== undefined ? oldP : newP;
    if (p === null || p === undefined) return;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const doc = applyUniHunks(parseDoc(before), sec.hunks, p, strict);
    tree.now.set(p, writeDoc(doc));
  };
}

/* ---- SEARCH/REPLACE blocks (section 7) ---- */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseDoc(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const items: NLine[] = newLines.map((t) => ({ ctx: false, text: t }));
    const rep = resolveN(items, doc.lines, pos, oldLines, found.tier);
    const lines = [...doc.lines];
    lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, writeDoc({ lines, br: doc.br, final: doc.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchIdx = i;
      let eq = -1;
      let rep = -1;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      for (j = eq + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
        if (t === '<<<<<<< SEARCH') break;
      }
      if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      let path: string | null = null;
      for (let k = searchIdx - 1; k > prevEnd; k--) {
        const l = lines[k]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      const oldLines = lines.slice(searchIdx + 1, eq);
      const newLines = lines.slice(eq + 1, rep);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return edits;
}

/* ---- V4A patches (section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aSectionStart(l: string): 'add' | 'delete' | 'update' | null {
  if (l.startsWith('*** Add File: ') || l === '*** Add File:') return 'add';
  if (l.startsWith('*** Delete File: ') || l === '*** Delete File:') return 'delete';
  if (l.startsWith('*** Update File: ') || l === '*** Update File:') return 'update';
  return null;
}

function v4aSectionPath(l: string): string {
  const idx = l.indexOf(': ');
  return idx < 0 ? '' : l.slice(idx + 2).trim();
}

function applyV4aChunks(doc: FileDoc, chunks: V4aChunk[], path: string, strict: boolean): FileDoc {
  const lines = [...doc.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const a = findTierFrom(lines, [ch.anchor], cursor, strict, false);
      if (a === null) throw new Fail('no-match', path);
      cursor = a.occ[0]! + 1;
    }
    const { o, n } = splitBody(ch.body);
    if (o.length > 0) {
      const found = findTierFrom(lines, o, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const nLines = resolveN(n, lines, pos, o, found.tier);
      lines.splice(pos, o.length, ...nLines);
      cursor = pos + nLines.length;
    } else {
      const at = ch.eof ? lines.length : cursor;
      const nLines = resolveN(n, lines, at, o, 0);
      lines.splice(at, 0, ...nLines);
      cursor = at + nLines.length;
    }
  }
  return { lines, br: doc.br, final: doc.final };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    const kind = v4aSectionStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const path = v4aSectionPath(l);
    if (kind === 'add') {
      const addLines: string[] = [];
      i++;
      while (i < last) {
        const sl = lines[i]!;
        if (v4aSectionStart(sl) !== null) break;
        if (blank(sl)) {
          addLines.push('');
          i++;
          continue;
        }
        if (sl.startsWith('+')) {
          addLines.push(sl.slice(1));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (addLines.length > 0 && addLines[addLines.length - 1] === '') addLines.pop();
      edits.push(((p: string, ls: string[]): Edit => {
        return (tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
        };
      })(path, addLines));
      continue;
    }
    if (kind === 'delete') {
      edits.push(((p: string): Edit => {
        return (tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        };
      })(path));
      i++;
      continue;
    }
    // Update File section.
    const updateLine = i;
    let moveTo: string | null = null;
    const chunks: V4aChunk[] = [];
    let chunk: V4aChunk | null = null;
    let seenChunk = false;
    i++;
    while (i < last) {
      const sl = lines[i]!;
      if (blank(sl)) {
        if (chunk !== null) chunk.body.push(sl);
        i++;
        continue;
      }
      if (v4aSectionStart(sl) !== null) break;
      if (sl === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${i + 1}`);
        chunk.eof = true;
        chunks.push(chunk);
        chunk = null;
        i++;
        continue;
      }
      if (sl.startsWith('@@')) {
        if (chunk !== null) chunks.push(chunk);
        const a = sl.slice(2).trim();
        chunk = { anchor: a === '' ? null : a, body: [], eof: false };
        seenChunk = true;
        i++;
        continue;
      }
      if (sl.startsWith('*** Move to: ')) {
        if (moveTo === null && chunks.length === 0 && chunk === null && !seenChunk) {
          moveTo = sl.slice('*** Move to: '.length).trim();
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (sl.startsWith('***')) throw new Exit2(`error: parse ${i + 1}`);
      if (sl.startsWith(' ') || sl.startsWith('-') || sl.startsWith('+')) {
        if (chunk === null) {
          if (seenChunk) throw new Exit2(`error: parse ${i + 1}`);
          chunk = { anchor: null, body: [], eof: false };
          seenChunk = true;
        }
        chunk.body.push(sl);
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (chunk !== null) chunks.push(chunk);
    if (chunks.length > 0) {
      const lastChunk = chunks[chunks.length - 1]!;
      while (lastChunk.body.length > 0 && blank(lastChunk.body[lastChunk.body.length - 1]!)) lastChunk.body.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine + 1}`);
    edits.push(((p: string, mv: string | null, cs: V4aChunk[]): Edit => {
      return (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (mv !== null) {
          if (!safe(mv)) throw new Fail('unsafe', mv);
          if (tree.get(mv) !== null) throw new Fail('exists', mv);
        }
        const doc = applyV4aChunks(parseDoc(before), cs, p, strict);
        if (mv !== null) {
          tree.now.set(p, null);
          tree.now.set(mv, writeDoc(doc));
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, writeDoc(doc));
        }
      };
    })(path, moveTo, chunks));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const display: { key: string; text: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      display.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      movedOld.add(oldP);
      movedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    display.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  display.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const rows = display.map((d) => d.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
