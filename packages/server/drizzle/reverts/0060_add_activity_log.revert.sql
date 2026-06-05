-- Revert b-60 t-1: drop the activity_log table (indexes drop with it).
DROP TABLE IF EXISTS activity_log;
