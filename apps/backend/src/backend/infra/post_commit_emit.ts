/**
 * Post-commit emit helper — fires OTel side-effects only after a successful transaction commit.
 * 1:1 behavioral port of the frozen Python `codemaster/infra/post_commit_emit.py`.
 *
 * Counter / histogram / up-down-counter mutations are non-rollback-safe: once `counter.add(1)` has
 * run, no DB rollback can undo it. Every spine primitive that emits OTel inside an open transaction
 * is vulnerable to drift between OTel and DB row counts whenever the transaction rolls back.
 *
 * ## Why a collector, not an event listener
 *
 * The Python source registers a SQLAlchemy `after_commit` / `after_rollback` listener pair on the
 * session: the queued callables fire only if the transaction COMMITS, and are dropped on rollback.
 * Kysely has NO event system, and `db.transaction().execute(fn)` already resolves AFTER the commit
 * has landed (and rejects — without ever resolving — on rollback). So the TS equivalent is a tiny
 * "pending emits" collector:
 *
 *   1. The caller creates a {@link PendingEmits} BEFORE opening the transaction.
 *   2. It passes the collector down to every primitive that wants a post-commit emit; each primitive
 *      calls {@link emitAfterCommit} to PUSH a no-arg callable (it does NOT fire it).
 *   3. AFTER `db.transaction().execute(...)` RESOLVES successfully, the caller calls
 *      {@link PendingEmits.drain} exactly once to fire every queued callable.
 *   4. If the transaction THROWS / rolls back, the caller never reaches `drain()` — the queued
 *      callables are simply dropped (GC'd with the collector). This reproduces the Python
 *      `after_rollback` "drop unfired" semantics: no commit ⇒ no emit.
 *
 * The collector is single-transaction-scoped by construction (one collector per transaction attempt),
 * so the per-transaction queue isolation the Python helper achieves by popping `info[_PENDING_KEY]`
 * is here just "make a fresh collector per transaction." A drained or never-drained collector should
 * not be reused.
 *
 * ## The "must not raise" contract
 *
 * A queued emit callable MUST NOT raise — but if a buggy one does, {@link PendingEmits.drain}
 * swallows + logs it (via `console.error`, the no-dep logging analogue) and continues draining the
 * rest, so one broken instrument cannot suppress the others or surface a spurious failure to a
 * caller that has already committed. This mirrors the Python `try/except Exception: _LOG.exception`
 * around each `emit_fn()`.
 */

/** A no-arg callable that performs a single OTel emit (e.g. `() => counter.add(1, { site })`). */
export type EmitFn = () => void;

/**
 * A single-transaction-scoped collector of post-commit emit callables. Create one BEFORE opening a
 * transaction, thread it through the primitives that want post-commit emits, and call {@link drain}
 * exactly once AFTER the transaction has resolved (committed). Never call {@link drain} when the
 * transaction rolled back — that is what gives the "drop unfired on rollback" semantics.
 */
export class PendingEmits {
  private readonly queue: Array<EmitFn> = [];
  private drained = false;

  /**
   * Queue `fn` to fire on the next {@link drain}. Order is preserved (FIFO); all queued callables
   * fire together (or are dropped together if the transaction rolls back and `drain` is never called).
   */
  public push(fn: EmitFn): void {
    this.queue.push(fn);
  }

  /** Number of currently-queued callables (test/diagnostic visibility). */
  public get size(): number {
    return this.queue.length;
  }

  /**
   * Fire every queued callable in FIFO order, swallowing + logging any throw per the "must not raise"
   * contract, then clear the queue. Idempotent: a second `drain()` is a no-op (the queue is already
   * empty), and we mark the collector drained so accidental reuse is observable in diagnostics.
   *
   * Call this ONLY after the transaction committed. If the transaction rolled back, do not call it —
   * letting the collector be discarded with its queue intact is the "drop unfired" path.
   */
  public drain(): void {
    this.drained = true;
    // Splice out the whole queue first so a callable that (illegally) re-enters push() during drain
    // cannot grow the list we are iterating.
    const emits = this.queue.splice(0, this.queue.length);
    for (const emit of emits) {
      try {
        emit();
      } catch (err) {
        // The emit contract is "must not raise"; a buggy emit cannot break the chain or fail a
        // caller that already committed. No dep is added — console.error is the logging analogue of
        // the Python `_LOG.exception("post-commit emit failed")`.
        console.error("post-commit emit failed", err);
      }
    }
  }

  /** True once {@link drain} has been called at least once (diagnostic; reuse is discouraged). */
  public get isDrained(): boolean {
    return this.drained;
  }
}

/**
 * Queue `fn` on `pending` to be fired once the caller's transaction commits and the caller drains.
 * The TS analogue of the Python `emit_after_commit(session, fn)`: it does NOT fire `fn` here — it
 * only enqueues it. The caller fires the whole queue via {@link PendingEmits.drain} after the
 * transaction resolves; on rollback the caller never drains and `fn` is dropped.
 *
 * @param pending The transaction-scoped collector the caller created before opening the transaction.
 * @param fn      A no-arg OTel emit. Must not raise; a throw is swallowed + logged at drain time.
 */
export function emitAfterCommit(pending: PendingEmits, fn: EmitFn): void {
  pending.push(fn);
}
