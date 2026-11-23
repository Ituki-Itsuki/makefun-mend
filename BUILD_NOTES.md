# mend — build notes

Built on the kit starter: its sections 1–4, 9 and 10 (CLI parsing, output/exit codes, safe
paths, format detection, JSON edits, all-or-nothing write) are kept as-is; added are the three
remaining format readers (SPEC §6–§8), the three-tier line matching (§5), and `R` move lines
in the output (§2). `runner.ts` is byte-identical to the kit's (sha256
f946f8b6330b30e8bdde920e034ec2c24c01343afb7ca3906b0bd18d3b152750). Node 22, standard library
only, deterministic (no randomness, no timestamps, no network).

## How each format is parsed

- **Unified (§6)** — a scanner walks the patch once. A section starts at a `diff --git a/<X>
  b/<Y>` line (any other `diff --git` shape is `error: parse <line>`) or at a `--- `/`+++ `
  pair. Header lines are consumed until the first `@@`: `---`/`+++` paths (cut at the first
  tab, trimmed, one leading `a/` or `b/` stripped, `/dev/null` kept as a sentinel),
  `rename from/to`, `new file mode`, `deleted file mode`; everything else is ignored. A `--- `
  in a header not followed by `+++ ` is `error: parse <the line after it>`. Hunks match
  `@@ -A[,B] +C[,D] @@` (any other `@@` line anywhere is a parse error, including a hunk before
  any section); a body is lines starting with ` `, `-`, `+`, `\`, or empty (an empty line is an
  empty context line), ending at the first other line, a `diff --git` line, or a `--- `/`+++ `
  pair. The section is one edit — creation (`+` lines of all hunks, LF, final break unless a
  `\` follows its last `+` line), deletion (hunks unread), move, or change. Hunks apply in
  order with the cumulative offset `d`; a non-empty O takes the occurrence nearest to
  `A - 1 + d` (ties: earlier); an empty O inserts after the first `A + d` lines. When a match
  runs to the end of the file, the final break is dropped exactly when a `\` line follows the
  hunk's last context or `+` line.
- **SEARCH/REPLACE (§7)** — blocks are found by the three markers (compared with trailing
  whitespace removed). The path is the nearest preceding non-blank line after the previous
  block that does not start (trimmed) with three backticks; with no such line the block
  inherits the previous block's path, and the first block without one is a parse error at its
  SEARCH line. A missing `=======` (a `>>>>>>> REPLACE` first also counts) or a missing
  `>>>>>>> REPLACE` is a parse error at the SEARCH line. Empty old lines create the file
  (LF, final break); otherwise the old lines must occur exactly once at their tier, else
  `ambiguous`.
- **V4A (§8)** — first/last non-blank lines must be `*** Begin Patch` / `*** End Patch`
  (compared trimmed; a missing End Patch is `error: parse <patch lines + 1>`). Sections start
  at `*** Add File: `, `*** Delete File: `, `*** Update File: `; any other stray line is a
  parse error at its line. Add lines start with `+` or are empty; a Delete section with any
  non-blank line is a parse error. An Update section may open with `*** Move to: `, then
  chunks: an `@@` line starts a chunk (text after `@@`, trimmed, is its anchor), the first
  chunk may start at a body line, and `*** End of File` closes a chunk and anchors it to the
  end of the file. Chunks apply in order behind a cursor: an anchor first advances the cursor
  past the first line at/after it that matches at the first tier where one does; O is then
  the first occurrence at/after the cursor at its first tier (an end-of-file chunk only
  counts occurrences ending on the last line); an empty O inserts at the cursor (or at the
  end for an end-of-file chunk); the cursor ends just after the lines written.
- **JSON (§9)** — the starter's reader, unchanged (array form faults at the array's first
  line, JSON Lines faults at the offending line; exact string match for `str_replace`).

## Matching tiers (§5)

`findMatch` tries tier 0 (lines equal), tier 1 (equal after removing trailing spaces/tabs
from both sides), tier 2 (equal after removing leading and trailing spaces/tabs), and returns
every occurrence at the first tier that has one; `--strict` tries tier 0 only. Replacement
writes context lines as the file's own matched lines at every tier. At tier 2, each
non-context line of N that is not empty/whitespace-only and starts with P (the leading
spaces/tabs of O's first line) has that prefix replaced by F (the leading spaces/tabs of the
file's first matched line); other lines are written as-is. Files are modelled as
(lines, own break — CRLF iff the first LF follows a CR —, final-break flag) and serialised
back with their own break; created files use LF.

## Output moves (§2)

Move edits record (old, new) pairs. After all edits, a pair renders as one
`R <old> -> <new>` line (sorted by `<new>`, counted as 1 file) exactly when the old path
existed before the patch and does not after, and the new path did not exist before and does
after; otherwise the plain `D`/`A` lines stand. Failed edits roll back both the tree and the
move list, so a failed patch reports every failure and writes nothing.

## Ambiguities and the interpretation chosen

- **V4A "blank lines at the end of a section" (§8)**: read as *empty or only whitespace*
  (§4's definition of a blank line), not just empty. A whitespace-only trailing line is
  dropped from the section. This is forced by practice check v-cursor: its chunk body ends
  with a ` ` line whose empty context line would otherwise make the old lines unmatchable
  at the file's end. Unified §6 says "empty lines" instead, so there only literally empty
  patch lines are dropped from a body end (a ` ` line stays a context line).
- **`*** End of File` with no chunk open** (start of an Update section): treated as an empty
  end-of-file chunk rather than a parse error. Untested by the practice set.
- **A body line after an End-of-File-closed chunk** without a new `@@`: parse error at that
  line (only the *first* chunk may start at a body line).
- **SEARCH/REPLACE `=======` scan**: stops (parse error at the SEARCH line) if a
  `>>>>>>> REPLACE` marker comes first, instead of crossing into a later block.
- **Unified second `--- `/`+++ ` pair inside one header**: starts a new section; a stray
  `--- ` outside any section is ignored prose (the parse error is only raised inside a
  section header, as §6 words it).
- **Tier-2 re-indent when P is empty**: a non-blank N line "starts with" the empty prefix,
  so F is prepended — the literal reading of §5.
- **V4A Add File with no lines**: creates an empty file (the "ended by a line break" applies
  to its lines; a file of no lines is written empty, §3).

## Practice results (Node 22.23.5, `node check.ts program/generator/practice.json`)

- unified: **30 of 30 passed**
- search_replace: **20 of 20 passed**
- v4a: **20 of 20 passed**
- json: **15 of 15 passed**
- cli: **15 of 15 passed**
- total: **100 of 100 passed: practice score 1000**

Spot checks beyond the practice set (all as SPEC requires): SEARCH/REPLACE tier-2 re-indent
re-indents new lines to the file's depth; a unified change at EOF with `\ No newline` keeps
the file break-less; a V4A end-of-file chunk whose old lines do not end on the last line
fails `no-match` and writes nothing; `--strict` rejects a tier-1 (trailing-whitespace) match
that the default mode accepts.
