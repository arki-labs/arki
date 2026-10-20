# Handle ID generation failures

Journal now uses browser-safe `@arki/contracts` declarations for its event, job,
command, correlation, attempt, operation, workflow, webhook and lease identities.
Prefixes and the 24-character lowercase letter/alphanumeric body format stay
compatible with stored rows. Generation requires Web Crypto and has no weak
randomness fallback.

`jobId()` returns the successful ID or `IdGenerationFailure`. Journal's affected
write, command, worker, workflow, job-operator and webhook methods preserve these
original canonical failures. Check `isFailure` before assuming a result is a row,
an applied operation or a job count. Infer outcomes from the method, rather than
copying success-only signatures. `ID_GENERATION_FAILURES` from `@arki/contracts`
is the canonical definition tuple for adapters.

```ts run
import { isFailure } from '@arki/failure';
import { jobId } from '@arki/journal';

const result = jobId();
if (isFailure(result)) throw new Error(result.message); // Return or handle in the owning app operation.
if (!result.startsWith('job_')) throw new Error('Stored prefix changed');
```

Generation failures before a command or claim prevent its effects. Failures during
writes and operators roll back their transaction/savepoint; no success receipt,
wake or webhook acknowledgement should follow the refusal. Archive operations
reserve their audit identity before calling the external sink. Existing retry
and uncertain-outcome rules remain in effect.

The affected Foreman actions declare canonical failures and return them unchanged
to Admin. Admin validates declared returned failures, records failed receipts and
replays safe public errors. Throwing a failure is supervised as an unexpected
defect; return an expected refusal instead. Queue and Mail outbox callers must
also handle the new generation outcomes. Dot producers infer the complete
outcome directly from the outbox service.

This migration does not nominally brand every Journal ID column or external input.
Those domains still need canonical schema declarations and validated boundary
reconstruction. Other low-level Journal exceptions and crypto operations remain
separate T08 migration work.
