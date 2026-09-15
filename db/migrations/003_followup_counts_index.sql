-- 003_followup_counts_index.sql — index the follow-up counters.
--
-- Added after 002 was already committed. 001 and 002 are the frozen contract every agent
-- coded against, so this arrives as a new file rather than an edit to either.
--
-- Why. The follow-up screen shows the queue itself and, beside it, how many dated entries are
-- completed and how many are not applicable -- so that excluding the 1,129 NULL-completion
-- rows is VISIBLE rather than silent. The queue query rides the partial index from 002, but
-- the counters did not:
--
--   Aggregate -> Seq Scan on activity  Filter: (follow_up_on IS NOT NULL)
--     rows=5718, Rows Removed by Filter: 34282, 7.5 ms
--
-- That ran on every render, and its cost grows with the whole table rather than with the
-- dated subset -- a sequential scan on the follow-up path, which CLAUDE.md calls a defect.
--
-- The index. Partial on exactly the counters' predicate, so it holds only the ~5,700 dated
-- rows rather than all 40,000, and carries is_completed as its key so both FILTERed counts
-- are answered from the index alone. The tri-state matters here: NULL is a real value to be
-- counted, not an absence, and btree indexes NULLs, so they are all present.
CREATE INDEX IF NOT EXISTS activity_dated_completion_idx
  ON activity (is_completed)
  WHERE follow_up_on IS NOT NULL;

COMMENT ON INDEX activity_dated_completion_idx IS
  'Counters on the follow-up screen: completed-with-a-date and not-applicable-with-a-date. Partial on follow_up_on IS NOT NULL so it covers only dated rows; keyed on the tri-state is_completed, whose NULLs are counted, not skipped.';
