// Revision 2 — Mend entry, hidden-spec-cli-01-run-20261122.
// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md:
// the command line, output and exit codes, safe paths, format detection, matching
// lines at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE
// blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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

// ---------------------------------------------------------------------------
// File model (SPEC.md section 3) and line matching (section 5)
// ---------------------------------------------------------------------------

interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function keyAt(line: string, tier: number): string {
  return tier === 0 ? line : tier === 1 ? trimEndWs(line) : trimWs(line);
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}
function reindent(line: string, p: string, f: string): string {
  if (line === '' || line.trim() === '') return line;
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

interface Found {
  tier: number;
  occ: number[];
}

function occurrences(o: string[], f: string[], tier: number, from: number, endOnly: boolean): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= f.length; i++) {
    if (endOnly && i + o.length !== f.length) continue;
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (keyAt(o[j]!, tier) !== keyAt(f[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(o: string[], f: string[], strict: boolean, from = 0, endOnly = false): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(o, f, t, from, endOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after `from` equal to `anchor` at the first tier where one is. */
function findSingle(anchor: string, f: string[], strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < f.length; i++) {
      if (keyAt(f[i]!, t) === keyAt(anchor, t)) return i;
    }
  }
  return null;
}

type BodyKind = ' ' | '-' | '+' | '\\';
interface BodyItem {
  kind: BodyKind;
  text: string;
  srcEmpty: boolean;
}

function bodyO(body: BodyItem[]): string[] {
  return body.filter((b) => b.kind === ' ' || b.kind === '-').map((b) => b.text);
}
function bodyN(body: BodyItem[]): string[] {
  return body.filter((b) => b.kind === ' ' || b.kind === '+').map((b) => b.text);
}

/**
 * Apply one hunk/chunk body to a file state. `pos` is the occurrence start
 * (replace) or the insertion position (insert). `finalRule` 'unified' applies
 * section 6's end-of-file break rule; 'keep' leaves the final break as it was.
 */
function applyBody(st: FileState, body: BodyItem[], pos: number, tier: number, insert: boolean, finalRule: 'unified' | 'keep'): FileState {
  const o = bodyO(body);
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f0 = !insert && o.length > 0 ? leadWs(st.lines[pos]!) : '';
  const out: string[] = [];
  let reachesEnd: boolean;
  if (insert) {
    out.push(...st.lines.slice(0, pos));
    for (const b of body) {
      if (b.kind === '+') out.push(tier === 2 ? reindent(b.text, p, f0) : b.text);
    }
    out.push(...st.lines.slice(pos));
    reachesEnd = pos === st.lines.length;
  } else {
    out.push(...st.lines.slice(0, pos));
    let oi = pos;
    for (const b of body) {
      if (b.kind === ' ') {
        out.push(st.lines[oi]!);
        oi += 1;
      } else if (b.kind === '-') {
        oi += 1;
      } else if (b.kind === '+') {
        out.push(tier === 2 ? reindent(b.text, p, f0) : b.text);
      }
    }
    out.push(...st.lines.slice(oi));
    reachesEnd = pos + o.length === st.lines.length;
  }
  let fin = st.final;
  if (finalRule === 'unified' && reachesEnd) {
    let last = -1;
    for (let k = 0; k < body.length; k++) {
      if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
    }
    const bs = last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
    fin = !bs;
  }
  return { br: st.br, lines: out, final: fin };
}

/** SEARCH/REPLACE replacement: O/N are plain line lists, final break stays. */
function applySR(st: FileState, o: string[], n: string[], pos: number, tier: number): FileState {
  const p = leadWs(o[0]!);
  const f0 = leadWs(st.lines[pos]!);
  const out = [...st.lines.slice(0, pos), ...n.map((l) => (tier === 2 ? reindent(l, p, f0) : l)), ...st.lines.slice(pos + o.length)];
  return { br: st.br, lines: out, final: st.final };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyItem[];
}
interface USection {
  oldPath: string | null;
  newPath: string | null;
  newFile: boolean;
  deletedFile: boolean;
  headerPair: boolean;
  hunks: UHunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function pathFromMarker(line: string): string {
  // Text after the four characters, up to the first tab, surrounding spaces removed.
  const raw = line.slice(4).split('\t')[0]!;
  return stripAB(raw.trim());
}

function parseDiffGit(line: string, num: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${num}`);
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) throw new Exit2(`error: parse ${num}`);
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3).trimEnd();
  if (x === '' || y === '') throw new Exit2(`error: parse ${num}`);
  return [x, y];
}

function parseHunkHeader(line: string, num: number): number {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${num}`);
  return Number(m[1]);
}

/** Collect a hunk body starting at index `i`; returns the body and the next index. */
function collectBody(lines: string[], i: number): { body: BodyItem[]; next: number } {
  const body: BodyItem[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    // A `--- ` line followed by a `+++ ` line ends the body (new section).
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '', srcEmpty: true });
      j += 1;
    } else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l[0] as BodyKind, text: l.slice(1), srcEmpty: false });
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1]!.srcEmpty) body.pop();
  return { body, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let state: 'seek' | 'header' | 'between' = 'seek';
  const startSection = (oldP: string | null, newP: string | null): USection => {
    const s: USection = { oldPath: oldP, newPath: newP, newFile: false, deletedFile: false, headerPair: false, hunks: [] };
    sections.push(s);
    cur = s;
    state = 'header';
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    const num = i + 1;
    if (l.startsWith('diff --git ')) {
      const [x, y] = parseDiffGit(l, num);
      startSection(x, y);
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (state === 'header' && cur !== null && !cur.headerPair) {
        cur.oldPath = pathFromMarker(l);
        cur.newPath = pathFromMarker(lines[i + 1]!);
        cur.headerPair = true;
      } else {
        const oldP = pathFromMarker(l);
        const newP = pathFromMarker(lines[i + 1]!);
        startSection(oldP, newP);
        cur!.headerPair = true;
      }
      i += 2;
      continue;
    }
    if (state === 'seek') {
      if (l.startsWith('@@')) throw new Exit2(`error: parse ${num}`);
      i += 1;
      continue;
    }
    if (state === 'header') {
      if (l.startsWith('--- ')) {
        // A `--- ` line not followed by a `+++ ` line, inside a section's header.
        throw new Exit2(`error: parse ${num + 1}`);
      }
      if (l.startsWith('+++ ')) {
        if (cur!.newPath === null) cur!.newPath = pathFromMarker(l);
        i += 1;
        continue;
      }
      if (l.startsWith('@@')) {
        const a = parseHunkHeader(l, num);
        const { body, next } = collectBody(lines, i + 1);
        cur!.hunks.push({ a, body });
        state = 'between';
        i = next;
        continue;
      }
      if (l.startsWith('new file mode')) cur!.newFile = true;
      else if (l.startsWith('deleted file mode')) cur!.deletedFile = true;
      else if (l.startsWith('rename from ')) {
        if (cur!.oldPath === null) cur!.oldPath = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur!.newPath === null) cur!.newPath = l.slice('rename to '.length).trim();
      }
      // index / modes / any other header line: ignored.
      i += 1;
      continue;
    }
    // state === 'between'
    if (l.startsWith('@@')) {
      const a = parseHunkHeader(l, num);
      const { body, next } = collectBody(lines, i + 1);
      cur!.hunks.push({ a, body });
      i = next;
      continue;
    }
    // Prose, code fences and any other line outside bodies: ignored.
    i += 1;
  }
  return sections.map((sec) => unifiedEdit(sec, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === '/dev/null' || sec.newFile;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.deletedFile);
    // Section 10: every path the edit names is checked for safety first.
    for (const p of [oldP, newP]) {
      if (p !== null && p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const target = newP!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const plus: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) {
          if (b.kind === '+') plus.push(b.text);
        }
      }
      // A created file ends with a line break unless a `\` follows its last `+` line.
      let noBreak = false;
      let lastPlus = -1;
      let lastHunk: UHunk | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k]!.kind === '+') {
            lastPlus = k;
            lastHunk = h;
          }
        }
      }
      if (lastHunk !== null) {
        const after = lastHunk.body[lastPlus + 1];
        noBreak = after !== undefined && after.kind === '\\';
      }
      tree.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const target = oldP!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const target = oldP!;
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    if (isMove) {
      if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
    }
    let st = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const o = bodyO(h.body);
      const n = bodyN(h.body);
      if (o.length === 0) {
        const insertPos = Math.min(h.a + d, st.lines.length);
        st = applyBody(st, h.body, insertPos, 0, true, 'unified');
      } else {
        const found = findTier(o, st.lines, strict);
        if (found === null) throw new Fail('no-match', target);
        const want = h.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - want);
        for (const p of found.occ) {
          const dist = Math.abs(p - want);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        st = applyBody(st, h.body, best, found.tier, false, 'unified');
      }
      d += n.length - o.length;
    }
    const out = serializeFile(st);
    if (isMove) {
      tree.now.set(target, null);
      tree.now.set(newP!, out);
      tree.moves.push([target, newP!]);
    } else {
      tree.now.set(target, out);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0; // index just after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    // Path: nearest line before SEARCH, after the previous block, not blank
    // and not starting with three backticks.
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    // Find ======= then >>>>>>> REPLACE.
    let eq = -1;
    let j = searchIdx + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    j = eq + 1;
    while (j < lines.length) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

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
    const st = parseFile(before);
    const found = findTier(oldLines, st.lines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    tree.now.set(path, serializeFile(applySR(st, oldLines, newLines, found.occ[0]!, found.tier)));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
  updateLine: number;
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith(V_ADD)) {
      kind = 'add';
      path = l.slice(V_ADD.length).trim();
    } else if (l.startsWith(V_DEL)) {
      kind = 'delete';
      path = l.slice(V_DEL.length).trim();
    } else if (l.startsWith(V_UPD)) {
      kind = 'update';
      path = l.slice(V_UPD.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    i += 1;
    // Collect the section's raw lines (with numbers) until the next section
    // start or the End Patch line. Blank lines at the end are not part of it.
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last) {
      const t = lines[i]!;
      if (t.startsWith(V_ADD) || t.startsWith(V_DEL) || t.startsWith(V_UPD)) break;
      raw.push({ text: t, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(vAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (r.text !== '') throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(vDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let content = raw;
      if (content.length > 0 && content[0]!.text.startsWith(V_MOVE)) {
        moveTo = content[0]!.text.slice(V_MOVE.length).trim();
        content = content.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      for (const r of content) {
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          firstChunk = false;
        } else if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
        } else if (t.startsWith(V_MOVE)) {
          throw new Exit2(`error: parse ${r.num}`);
        } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (!firstChunk) {
              if (blank(t)) continue; // blank line between chunks: ignored
              throw new Exit2(`error: parse ${r.num}`);
            }
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
            firstChunk = false;
          }
          cur.body.push({ kind: t === '' ? ' ' : (t[0] as BodyKind), text: t === '' ? '' : t.slice(1), srcEmpty: t === '' });
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function vAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function vDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findSingle(ch.anchor, st.lines, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      } else if (ch.anchor !== null && ch.anchor === '') {
        // Empty anchor: no anchor.
      }
      const o = bodyO(ch.body);
      const n = bodyN(ch.body);
      if (o.length === 0) {
        const insertPos = ch.eof ? st.lines.length : cursor;
        st = applyBody(st, ch.body, insertPos, 0, true, 'keep');
        cursor = insertPos + n.length;
      } else {
        const found = findTier(o, st.lines, strict, cursor, ch.eof);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.occ[0]!;
        st = applyBody(st, ch.body, pos, found.tier, false, 'keep');
        cursor = pos + n.length;
      }
    }
    const out = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Run (sections 1, 2, 10)
// ---------------------------------------------------------------------------

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
    const beforeNow = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M per changed path; a move whose old path is gone and
  // whose new path is new is one `R <old> -> <new>` line, sorted by <new>.
  const movePairs: Array<[string, string]> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) movePairs.push([o, n]);
  }
  const movedOld = new Set(movePairs.map((p) => p[0]));
  const movedNew = new Set(movePairs.map((p) => p[1]));
  const rows: Array<{ key: string; text: string }> = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedOld.has(p) || movedNew.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of movePairs) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
