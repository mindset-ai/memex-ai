-- spec-520 t-13 (ac-30) — validate the tenant FK added NOT VALID in 0139.
--
-- Separate FILE, therefore a separate transaction (the runner wraps each file in its own
-- sql.begin), which is the whole point: VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE
-- and blocks neither reads nor writes, so the emission path keeps running while the scan
-- proceeds. Merged into 0139 it would have inherited that file's ACCESS EXCLUSIVE lock for
-- the duration of the scan.
--
-- The scan can only fail on an orphan row — a rollup row whose memex_id names no memex.
-- None can exist: the column has always been written from the resolved emitting Memex
-- (std-32, never parsed from subject_ref), and there is no tenant-deletion path in
-- production that could have stranded one. A failure here would therefore be real news
-- about the write path, not migration noise, and it should stop the deploy.

SET LOCAL lock_timeout = '3s';

ALTER TABLE test_run_daily VALIDATE CONSTRAINT test_run_daily_memex_id_fkey;
