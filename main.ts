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
  /** Successful move edits, in order: [oldPath, newPath]. Used only to render `R` lines in the output. */
  readonly moves: [string, string][] = [];
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

/* ---------------- Files as lines (SPEC.md section 3) ---------------- */

interface FileModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function toModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br: '\n', fin: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

/* ---------------- Matching lines (SPEC.md section 5) ---------------- */

const rtrimST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimST(a) === rtrimST(b);
  return trimST(a) === trimST(b);
}

function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = Math.max(0, from); i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function tiersOf(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at or after `from`, with every occurrence there. */
function findMatch(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const t of tiersOf(strict)) {
    const ps = occurrences(lines, O, t, from);
    if (ps.length > 0) return { tier: t, positions: ps };
  }
  return null;
}

interface BodyLine {
  t: string; // ' ' context, '-' old, '+' new, '\\' backslash note
  text: string;
  blankLine?: boolean; // the patch line itself was empty (unified hunks)
}

type NItem = { ctx: number } | { text: string };

function buildON(body: BodyLine[]): { O: string[]; N: NItem[] } {
  const O: string[] = [];
  const N: NItem[] = [];
  for (const b of body) {
    if (b.t === ' ') {
      O.push(b.text);
      N.push({ ctx: O.length - 1 });
    } else if (b.t === '-') O.push(b.text);
    else if (b.t === '+') N.push({ text: b.text });
  }
  return { O, N };
}

/** Resolve N against a match at `pos`: context lines are the file's own; at tier 2 other lines are re-indented. */
function resolveN(N: NItem[], fileLines: string[], pos: number, O: string[], tier: number): string[] {
  const F = leadingWS(fileLines[pos] ?? '');
  const P = leadingWS(O[0] ?? '');
  return N.map((it) => {
    if ('ctx' in it) return fileLines[pos + it.ctx]!;
    let s = it.text;
    if (tier === 2 && s !== '' && !/^[ \t]*$/.test(s) && s.startsWith(P)) s = F + s.slice(P.length);
    return s;
  });
}

/** Whether a `\` line follows the body's last line of one of the given types. */
function backslashAfterLast(body: BodyLine[], types: string[]): boolean {
  let last = -1;
  body.forEach((b, idx) => {
    if (types.includes(b.t)) last = idx;
  });
  return last >= 0 && body[last + 1]?.t === '\\';
}

/* ---------------- Unified diffs (SPEC.md section 6) ---------------- */

interface UHunk {
  a: number;
  body: BodyLine[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  hdrOld?: string;
  hdrNew?: string;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDel: boolean;
  hunks: UHunk[];
}

function parsePathArg(raw: string): string {
  const tab = raw.indexOf('\t');
  let s = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  const n = lines.length;
  let i = 0;
  const isPairStart = (j: number): boolean => lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ');
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    let sec: USection | null = null;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = { isNew: false, isDel: false, hunks: [], gitOld: m[1]!, gitNew: m[2]! };
      i += 1;
    } else if (isPairStart(i)) {
      sec = { isNew: false, isDel: false, hunks: [] };
    } else {
      i += 1;
      continue;
    }
    // Section header, before its first hunk.
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('@@') || l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ')) {
        if (sec.hdrOld !== undefined) break;
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.hdrOld = parsePathArg(l.slice(4));
        sec.hdrNew = parsePathArg(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renameFrom = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renameTo = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.isNew = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.isDel = true;
        i += 1;
        continue;
      }
      i += 1; // any other header line is ignored
    }
    // Hunks.
    while (i < n && lines[i]!.startsWith('@@')) {
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i += 1;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ') || isPairStart(i)) break;
        if (bl === '') {
          body.push({ t: ' ', text: '', blankLine: true });
          i += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ t: c, text: bl.slice(1) });
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.blankLine === true) body.pop();
      sec.hunks.push({ a, body });
    }
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(sec: USection, strict: boolean): Edit {
  let oldP: string | undefined;
  let newP: string | undefined;
  if (sec.hdrOld !== undefined) {
    oldP = sec.hdrOld;
    newP = sec.hdrNew;
  } else if (sec.renameFrom !== undefined || sec.renameTo !== undefined) {
    oldP = sec.renameFrom;
    newP = sec.renameTo;
  } else {
    oldP = sec.gitOld;
    newP = sec.gitNew;
  }
  const creation = sec.isNew || oldP === '/dev/null';
  const deletion = !creation && (sec.isDel || newP === '/dev/null');
  return (tree) => {
    for (const p of [oldP, newP]) {
      if (p !== undefined && p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (creation) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        h.body.forEach((b, idx) => {
          if (b.t === '+') {
            plus.push(b.text);
            noBreak = h.body[idx + 1]?.t === '\\';
          }
        });
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (deletion) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = (oldP ?? newP)!;
    const isMove = oldP !== undefined && newP !== undefined && oldP !== newP;
    const dst = isMove ? newP! : src;
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
    const model = toModel(before);
    let d = 0;
    for (const h of sec.hunks) {
      const { O, N } = buildON(h.body);
      if (O.length === 0) {
        const ins = N.map((it) => ('text' in it ? it.text : ''));
        const pos = Math.max(0, Math.min(h.a + d, model.lines.length));
        const atEnd = pos === model.lines.length;
        model.lines.splice(pos, 0, ...ins);
        if (atEnd && ins.length > 0 && backslashAfterLast(h.body, ['+'])) model.fin = false;
        else if (atEnd && ins.length > 0) model.fin = true;
        d += ins.length;
      } else {
        const found = findMatch(model.lines, O, strict);
        if (found === null) throw new Fail('no-match', src);
        const target = h.a - 1 + d;
        let pos = found.positions[0]!;
        let best = Math.abs(pos - target);
        for (const cand of found.positions) {
          const dist = Math.abs(cand - target);
          if (dist < best) {
            best = dist;
            pos = cand;
          }
        }
        const repl = resolveN(N, model.lines, pos, O, found.tier);
        const runsToEnd = pos + O.length === model.lines.length;
        model.lines.splice(pos, O.length, ...repl);
        if (runsToEnd) model.fin = !backslashAfterLast(h.body, [' ', '+']);
        d += N.length - O.length;
      }
    }
    const text = fromModel(model);
    if (isMove) {
      tree.now.set(dst, text);
      tree.now.set(src, null);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, text);
    }
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------------- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | undefined;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | undefined;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === undefined) {
      if (prevPath !== undefined) path = prevPath;
      else throw new Exit2(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rp = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rp = j;
        break;
      }
    }
    if (rp < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rp);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = toModel(before);
      const found = findMatch(model.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const repl = resolveN(newLines.map((t) => ({ text: t })), model.lines, pos, oldLines, found.tier);
      model.lines.splice(pos, oldLines.length, ...repl);
      tree.now.set(p, fromModel(model));
    });
    prevPath = path;
    prevEnd = rp;
    i = rp + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---------------- V4A patches (SPEC.md section 8) ---------------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  addLines: string[];
  moveTo?: string;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const nonBlank: number[] = [];
  lines.forEach((l, idx) => {
    if (!blank(l)) nonBlank.push(idx);
  });
  if (nonBlank.length === 0) throw new Exit2('error: parse 1');
  const first = nonBlank[0]!;
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = nonBlank[nonBlank.length - 1]!;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const kind = secStart(l);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const prefix = kind === 'add' ? '*** Add File: ' : kind === 'del' ? '*** Delete File: ' : '*** Update File: ';
    const path = l.slice(prefix.length).trim();
    const secLine = i + 1;
    i += 1;
    const raw: { text: string; no: number }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && raw[raw.length - 1]!.text.trim() === '') raw.pop();
    if (kind === 'del') {
      const bad = raw.find((r) => r.text.trim() !== '');
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
      sections.push({ kind, path, addLines: [], chunks: [] });
      continue;
    }
    if (kind === 'add') {
      const addLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) addLines.push(r.text.slice(1));
        else if (r.text === '') addLines.push('');
        else throw new Exit2(`error: parse ${r.no}`);
      }
      sections.push({ kind, path, addLines, chunks: [] });
      continue;
    }
    // Update File.
    let moveTo: string | undefined;
    let idx = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
      idx = 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    let closed = false;
    for (; idx < raw.length; idx += 1) {
      const r = raw[idx]!;
      if (r.text.startsWith('@@')) {
        cur = { anchor: r.text.slice(2).trim() || null, eof: false, body: [] };
        chunks.push(cur);
        closed = false;
        continue;
      }
      if (r.text === '*** End of File') {
        if (cur === null) {
          cur = { anchor: null, eof: true, body: [] };
          chunks.push(cur);
        } else cur.eof = true;
        cur = null;
        closed = true;
        continue;
      }
      const c = r.text[0];
      if (r.text === '' || c === ' ' || c === '-' || c === '+') {
        if (cur === null) {
          if (closed || chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        }
        cur.body.push({ t: r.text === '' ? ' ' : c!, text: r.text === '' ? '' : r.text.slice(1) });
        continue;
      }
      throw new Exit2(`error: parse ${r.no}`);
    }
    if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${secLine}`);
    sections.push({ kind, path, addLines: [], moveTo, chunks });
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  const p = sec.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const anchor = ch.anchor;
        let foundPos = -1;
        for (const t of tiersOf(strict)) {
          for (let q = cursor; q < model.lines.length; q += 1) {
            if (lineEq(model.lines[q]!, anchor, t)) {
              foundPos = q;
              break;
            }
          }
          if (foundPos >= 0) break;
        }
        if (foundPos < 0) throw new Fail('no-match', p);
        cursor = foundPos + 1;
      }
      const { O, N } = buildON(ch.body);
      if (O.length === 0) {
        const ins = N.map((it) => ('text' in it ? it.text : ''));
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
      } else {
        let chosen: { tier: number; pos: number } | null = null;
        for (const t of tiersOf(strict)) {
          const ps = occurrences(model.lines, O, t, cursor).filter((q) => !ch.eof || q + O.length === model.lines.length);
          if (ps.length > 0) {
            chosen = { tier: t, pos: ps[0]! };
            break;
          }
        }
        if (chosen === null) throw new Fail('no-match', p);
        const repl = resolveN(N, model.lines, chosen.pos, O, chosen.tier);
        model.lines.splice(chosen.pos, O.length, ...repl);
        cursor = chosen.pos + repl.length;
      }
    }
    const text = fromModel(model);
    if (sec.moveTo !== undefined) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const byPath = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` };
    rows.push(row);
    byPath.set(p, row);
  }
  const afterOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  for (const [o, nw] of tree.moves) {
    const ro = byPath.get(o);
    const rn = byPath.get(nw);
    if (ro === undefined || rn === undefined || ro === rn) continue;
    if (!ro.text.startsWith('D ') || !rn.text.startsWith('A ')) continue;
    if (tree.original(o) === null || afterOf(o) !== null || tree.original(nw) !== null || afterOf(nw) === null) continue;
    rows.splice(rows.indexOf(ro), 1);
    rows.splice(rows.indexOf(rn), 1);
    byPath.delete(o);
    byPath.delete(nw);
    rows.push({ key: nw, text: `R ${o} -> ${nw}` });
  }
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
