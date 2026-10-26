-- Pause the Boise crawlers (2026-10-26). No users in Boise yet, so the
-- biweekly/yearly Boise runs were only spending Anthropic credits. The jobs
-- are paused rather than unscheduled, so turning Boise back on is just the
-- same statement with active := true. Existing Boise rows in activities
-- are left as they are.
select cron.alter_job(jobid, active := false)
from cron.job
where command like '%"region": "boise"%';
