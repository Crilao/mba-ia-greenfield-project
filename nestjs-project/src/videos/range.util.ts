export interface ByteRange {
  start: number;
  end: number;
}

export interface ParsedRange {
  range: ByteRange | null;
  satisfiable: boolean;
}

/**
 * Parses an HTTP `Range: bytes=...` header against a known total size.
 * Returns `null` when the header is absent or malformed (caller serves a
 * `200` full-body response). Returns `{ range, satisfiable: true }` for a
 * valid single range, or `{ range: null, satisfiable: false }` when the
 * range is unsatisfiable (caller responds `416`).
 */
export function parseRange(
  header: string | undefined,
  total: number,
): ParsedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;
  if (startStr === '' && endStr === '') return null;

  if (startStr === '') {
    // Suffix range `bytes=-N`: last N bytes.
    const suffix = Number(endStr);
    if (suffix <= 0) return { range: null, satisfiable: false };
    const start = Math.max(total - suffix, 0);
    return { range: { start, end: total - 1 }, satisfiable: true };
  }

  const start = Number(startStr);
  if (start >= total) return { range: null, satisfiable: false };
  const end = endStr === '' ? total - 1 : Math.min(Number(endStr), total - 1);
  if (end < start) return { range: null, satisfiable: false };
  return { range: { start, end }, satisfiable: true };
}
