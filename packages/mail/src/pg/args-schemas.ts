/**
 * The Zod schemas of a queued mail. Internal: `args.ts` and `testing.ts` read rows with them. The TS types
 * (`MailMessage`, `QueuedArgs`) are the source; `args.test-d.ts` locks each schema to its type both ways.
 */
import { z } from 'zod';

const addressesSchema = z.union([z.string(), z.array(z.string()).readonly()]);
const stringRecordSchema = z.record(z.string(), z.string()).readonly();

/**
 * A stored message, checked field by field: the row may predate a deploy or be edited by hand.
 * `args.test-d.ts` locks its output to `MailMessage`.
 */
export const mailMessageSchema = z
  .object({
    from: z.string(),
    subject: z.string(),
    text: z.string(),
    to: addressesSchema,
    html: z.string().exactOptional(),
    cc: addressesSchema.exactOptional(),
    bcc: addressesSchema.exactOptional(),
    replyTo: addressesSchema.exactOptional(),
    headers: stringRecordSchema.exactOptional(),
    tags: stringRecordSchema.exactOptional(),
    template: z.string().exactOptional(),
  })
  .readonly();

/** A `QueuedArgs` (`args.ts`): what a queue row holds. */
export const queuedArgsSchema = z
  .object({
    version: z.literal(1),
    message: mailMessageSchema,
    expiresAt: z.string().exactOptional(),
  })
  .readonly();
