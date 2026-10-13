---
'@arki/queue': minor
---

Real jobs now work in schedules and flows without a cast. `q.schedule....job(job)` and `q.flow....step(id, { job, data })` used to ask for `JobDefinition<TInput, unknown, unknown>`, which no built job matches (its handler's context parameter is typed), so callers wrote `job as never` and lost every check.

- `.job(job)` takes `JobDefinition<TInput, unknown, TContextOut>`: the job's input type flows into `.data()`, and a job whose context the schedule does not provide is a type error. The schedule worker runs the schedule's own middleware, not the job's; add the same `.use(...)` to the schedule when the job needs it.
- `.step(id, { job, data })` accepts any built job (a step job runs on its own worker, with its own middleware), and `data` must now return the job's input type.

May surface new type errors: a step whose `data` returns something the job's input does not accept, or a scheduled job whose middleware the schedule lacks. Both were real bugs hidden by the cast.
