-- 0004_review_runs_superseded_fk_deferrable
--
-- Make the self-referential FK core.review_runs.superseded_by_run_id -> core.review_runs(run_id)
-- DEFERRABLE INITIALLY DEFERRED.
--
-- WHY: the SERIAL+SUPERSEDE review-run allocator (AD-2, apps/backend/src/ingest/_review_run_allocator.ts)
-- and the INSERT-free supersede primitive (apps/backend/src/workflow/_supersede.ts) cancel the OLD active
-- run — stamping `superseded_by_run_id = <the NEW run_id>` (with cancel_reason='superseded', which the
-- ck_review_runs_supersede_reason CHECK requires paired) — BEFORE the NEW run row is inserted. Superseding
-- first is what keeps supersede_run INSERT-free + reusable by non-allocator callers. With an IMMEDIATE FK
-- that ordering trips the constraint at the supersede UPDATE; deferring the check to COMMIT (by which point
-- the allocator's single transaction has inserted the new run) is exactly what the design needs.
--
-- The squashed baseline (0001_baseline.sql) carried this FK as IMMEDIATE — the deferrable attribute the
-- frozen-Python allocator relies on was lost in the squash. Empirically: the allocate->supersede->allocate
-- integration test violates the FK at the supersede UPDATE with an immediate constraint and passes once
-- deferred (test/integration/ingest/_review_run_allocator.integration.test.ts).
--
-- The sibling self-FKs (supersedes_run_id, parent_run_id) point at rows that ALREADY exist when written
-- (the old run / the parent), so they stay immediate — only superseded_by_run_id needs deferral.
--
-- node-pg-migrate runs this whole .sql file as the up migration (the project's migrations are up-only).

ALTER TABLE core.review_runs DROP CONSTRAINT review_runs_superseded_by_run_id_fkey;

ALTER TABLE core.review_runs
  ADD CONSTRAINT review_runs_superseded_by_run_id_fkey
  FOREIGN KEY (superseded_by_run_id) REFERENCES core.review_runs(run_id)
  DEFERRABLE INITIALLY DEFERRED;
