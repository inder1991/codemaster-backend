// Knowledge write — 1:1 port of codemaster/api/admin/knowledge.py (update_learning_body /
// approve_proposal / reject_proposal) + the KnowledgeApprovalWorkflow signal contract.
//
// PUT applies an optimistic-concurrency (If-Match on core.learnings.version) update and writes a
// core.learnings_revisions row in the SAME transaction. approve/reject validate the proposal
// preconditions (state machine + self-approval) and let the route signal the workflow — the workflow,
// not this code, persists the proposal's terminal state (1:1 with the Python ApprovalSignalPort split).

import { type Kysely, sql } from "kysely";

// ─── Errors ─────────────────────────────────────────────────────────────────────────────────────

/** Locked 409 — the frontend renders the collision-diff modal with current_body/current_version. */
export class KnowledgeStaleWriteError extends Error {
  public constructor(
    public readonly current_body: string,
    public readonly current_version: number,
  ) {
    super("stale write");
    this.name = "KnowledgeStaleWriteError";
  }
}

export class ProposalNotFoundError extends Error {
  public constructor() {
    super("proposal not found");
    this.name = "ProposalNotFoundError";
  }
}

/** The proposal already left `pending_approval` (approved/rejected/expired/superseded). */
export class ProposalAlreadyDecidedError extends Error {
  public constructor(public readonly current_state: string) {
    super(`already decided: ${current_state}`);
    this.name = "ProposalAlreadyDecidedError";
  }
}

/** The approver is the same user who proposed the learning. */
export class SelfApprovalRefusedError extends Error {
  public constructor() {
    super("cannot approve your own proposal");
    this.name = "SelfApprovalRefusedError";
  }
}

/** Reject reason failed length validation (trimmed length outside [10, 2048]). */
export class RejectReasonInvalidError extends Error {
  public constructor() {
    super("reject reason failed validation");
    this.name = "RejectReasonInvalidError";
  }
}

// ─── SQL rows ─────────────────────────────────────────────────────────────────────────────────────

/** core.learnings row as returned by the CAS UPDATE. bigint columns deserialize to strings. */
type LearningRow = {
  learning_id: string;
  installation_id: string;
  title: string;
  body_markdown: string;
  version: number;
  state: string;
  repo_id: string | null;
  fired_count: string | number;
  accepted_count: string | number;
  feedback_count: string | number;
  last_fired_at: Date | null;
};

/** core.learning_proposals row (subset used for approve/reject validation). */
export type ProposalRow = {
  proposal_id: string;
  installation_id: string;
  title: string;
  body: string;
  repo_id: string | null;
  proposed_by_user_id: string;
  state: string;
  created_at: Date;
};

const LEARNING_COLS = sql`
  learning_id, installation_id, title, body_markdown, version, state,
  repo_id, fired_count, accepted_count, feedback_count, last_fired_at
`;

const PROPOSAL_COLS = sql`
  proposal_id, installation_id, title, body, repo_id,
  proposed_by_user_id, state, created_at
`;

// ─── Repository functions ───────────────────────────────────────────────────────────────────────

/**
 * Update a learning's body via optimistic concurrency (If-Match on `version`). Atomic: the version
 * bump on core.learnings and the core.learnings_revisions insert run in one transaction. Throws
 * KnowledgeStaleWriteError (carrying the server's current body/version) on a version mismatch.
 */
export async function updateLearningBody(
  db: Kysely<unknown>,
  args: {
    learningId: string;
    installationId: string;
    newBodyMarkdown: string;
    ifMatchVersion: number;
    editedByUserId: string;
    now: Date;
  },
): Promise<LearningRow> {
  return db.transaction().execute(async (tx) => {
    const updateResult = await sql<LearningRow>`
      UPDATE core.learnings
      SET body_markdown = ${args.newBodyMarkdown},
          version = version + 1,
          updated_at = ${args.now}
      WHERE learning_id = ${args.learningId}
        AND installation_id = ${args.installationId}
        AND version = ${args.ifMatchVersion}
      RETURNING ${LEARNING_COLS}
    `.execute(tx);

    if (updateResult.rows.length === 0) {
      // CAS miss: re-read current state to return in the 409 envelope (or surface a true 404).
      const current = await sql<LearningRow>`
        SELECT ${LEARNING_COLS}
        FROM core.learnings
        WHERE learning_id = ${args.learningId}
          AND installation_id = ${args.installationId}
        LIMIT 1
      `.execute(tx);
      const existing = current.rows[0];
      if (existing === undefined) {
        throw new Error(`learning ${args.learningId} not found`);
      }
      throw new KnowledgeStaleWriteError(existing.body_markdown, Number(existing.version));
    }

    const updated = updateResult.rows[0]!;

    // Atomic revision insert (new version = ifMatchVersion + 1) in the same transaction.
    await sql`
      INSERT INTO core.learnings_revisions
        (learning_id, installation_id, body_markdown, version, edited_by_user_id, edited_at)
      VALUES (${args.learningId}, ${args.installationId}, ${args.newBodyMarkdown},
              ${args.ifMatchVersion + 1}, ${args.editedByUserId}, ${args.now})
    `.execute(tx);

    return { ...updated, version: Number(updated.version) };
  });
}

/**
 * Get a proposal by id within the installation (any state), for approve/reject validation. Returns
 * null when the proposal is absent or outside the tenant.
 */
export async function getProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
  },
): Promise<ProposalRow | null> {
  const rows = await sql<ProposalRow>`
    SELECT ${PROPOSAL_COLS}
    FROM core.learning_proposals
    WHERE proposal_id = ${args.proposalId}
      AND installation_id = ${args.installationId}
    LIMIT 1
  `.execute(db);
  return rows.rows[0] ?? null;
}

/**
 * Validate approval preconditions. Does NOT persist state (the workflow does, on the `approve`
 * signal). Throws ProposalNotFoundError / ProposalAlreadyDecidedError / SelfApprovalRefusedError.
 */
export async function validateApproveProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
    approverUserId: string;
  },
): Promise<ProposalRow> {
  const proposal = await getProposal(db, {
    proposalId: args.proposalId,
    installationId: args.installationId,
  });

  if (proposal === null) {
    throw new ProposalNotFoundError();
  }
  if (proposal.state !== "pending_approval") {
    throw new ProposalAlreadyDecidedError(proposal.state);
  }
  if (proposal.proposed_by_user_id === args.approverUserId) {
    throw new SelfApprovalRefusedError();
  }
  return proposal;
}

/**
 * Validate reject preconditions + reason bounds (trimmed 10..2048). Does NOT persist state. Throws
 * RejectReasonInvalidError / ProposalNotFoundError / ProposalAlreadyDecidedError.
 */
export async function validateRejectProposal(
  db: Kysely<unknown>,
  args: {
    proposalId: string;
    installationId: string;
    reason: string;
  },
): Promise<ProposalRow> {
  const trimmed = args.reason.trim();
  if (trimmed.length < 10 || trimmed.length > 2048) {
    throw new RejectReasonInvalidError();
  }

  const proposal = await getProposal(db, {
    proposalId: args.proposalId,
    installationId: args.installationId,
  });

  if (proposal === null) {
    throw new ProposalNotFoundError();
  }
  if (proposal.state !== "pending_approval") {
    throw new ProposalAlreadyDecidedError(proposal.state);
  }
  return proposal;
}

// ─── Temporal signal helpers ──────────────────────────────────────────────────────────────────────

/**
 * Proposal workflow ID format: `knowledge-approval-{proposal_id}` (1:1 with
 * codemaster/workflows/knowledge_approval.py::workflow_id_for / WORKFLOW_ID_PREFIX).
 */
export function workflowIdFor(proposalId: string): string {
  return `knowledge-approval-${proposalId}`;
}
