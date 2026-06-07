// Reusable opaque (ts, id) keyset cursor + in-memory DESC slice — the pagination scheme several admin reads
// share (integrations, knowledge, proposals): fetch all rows, sort DESC by (ts, id), then slice. The cursor
// is base64url(JSON {ts, id}) unpadded (Buffer's base64url is already unpadded). A null/empty ts sorts LAST
// (matches the Python's datetime.min sentinel for nullable timestamps under a DESC sort).

export class CursorInvalidError extends Error {
  public constructor() {
    super("invalid cursor");
    this.name = "CursorInvalidError";
  }
}

export function encodeTsIdCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify({ ts, id }), "utf-8").toString("base64url");
}

export function decodeTsIdCursor(cursor: string): { ts: string; id: string } {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as {
      ts?: unknown;
      id?: unknown;
    };
    if (typeof p.ts !== "string" || typeof p.id !== "string") {
      throw new CursorInvalidError();
    }
    return { ts: p.ts, id: p.id };
  } catch {
    throw new CursorInvalidError();
  }
}

/** Sort `rows` DESC by (ts, id), apply the cursor (start at the first row strictly < the cursor key), and
 *  return the `size`-sized page + the next cursor (null when the page reaches the end). */
export function keysetSlice<T>(
  rows: ReadonlyArray<T>,
  keyOf: (r: T) => { ts: string; id: string },
  cursor: string | null,
  size: number,
): { page: Array<T>; nextCursor: string | null } {
  const sorted = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka.ts !== kb.ts) {
      return ka.ts < kb.ts ? 1 : -1; // DESC on ts
    }
    return ka.id < kb.id ? 1 : ka.id > kb.id ? -1 : 0; // DESC on id
  });
  let start = 0;
  if (cursor !== null) {
    const c = decodeTsIdCursor(cursor);
    start = sorted.findIndex((r) => {
      const k = keyOf(r);
      return k.ts < c.ts || (k.ts === c.ts && k.id < c.id);
    });
    if (start === -1) {
      return { page: [], nextCursor: null };
    }
  }
  const page = sorted.slice(start, start + size);
  const last = page[page.length - 1];
  const nextCursor =
    last !== undefined && start + size < sorted.length
      ? encodeTsIdCursor(keyOf(last).ts, keyOf(last).id)
      : null;
  return { page, nextCursor };
}
