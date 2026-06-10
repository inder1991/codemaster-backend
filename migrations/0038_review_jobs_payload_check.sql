-- 0038_review_jobs_payload_check.sql — F7 (external-review remediation): protect core.review_jobs'
-- payload-store columns at the DB, not just in app code (ReviewJobsRepo.enqueue). A manual edit or a
-- future migration must not be able to write a storage-envelope version other than 1
-- (JOB_PAYLOAD_SCHEMA_VERSION — apps/backend/src/runner/review_jobs_repo.ts) or a payload_sha256 that is
-- not 64 lowercase hex chars (the sha256hex output shape). ADR-0077.
--
-- review_jobs is NOT a hot table (hot = core.outbox / audit.workflow_events / core.review_runs /
-- core.pull_request_reviews) and is low-volume, so a direct ADD CONSTRAINT CHECK is acceptable — it takes
-- a brief ACCESS EXCLUSIVE lock + a full scan, both negligible at this table's size. Migration 0037
-- already dead-letters any pre-payload rows and DROPs the payload column defaults, so every existing row
-- carries job_payload_schema_version=1 and a real 64-hex payload_sha256 — the constraints validate clean.
ALTER TABLE core.review_jobs
  ADD CONSTRAINT ck_review_jobs_payload_schema_version
    CHECK (job_payload_schema_version = 1),          -- a future bump changes this via a NEW migration
  ADD CONSTRAINT ck_review_jobs_payload_sha256_hex
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$');        -- 64 lowercase hex chars: the sha256hex shape
