import { z } from 'zod';

import { AdminInvalidRequest } from '../../failures.ts';
import { timingSafeEqual } from './constant-time.ts';

/** What a webhook claims to be about. It is a claim, never a fact. */
export type CoolifyHintKind = 'deployment' | 'application' | 'server' | 'unknown';

/** A webhook reduced to "go and look at this resource". */
export type CoolifyHint = {
  kind: CoolifyHintKind;
  /** Deployment, application or server uuid as the sender wrote it. Unverified. */
  resourceUuid: string;
  receivedAt: Date;
};

const payloadSchema = z.looseObject({
  event: z.string().optional(),
  title: z.string().optional(),
  deployment_uuid: z.string().optional(),
  application_uuid: z.string().optional(),
  server_uuid: z.string().optional(),
  uuid: z.string().optional(),
});

const uuidShape = /^[\w-]{4,64}$/;

function kindOf(text: string): CoolifyHintKind {
  const t = text.toLowerCase();
  if (t.includes('deploy')) return 'deployment';
  if (t.includes('server') || t.includes('unreachable') || t.includes('disk')) return 'server';
  if (t.includes('status') || t.includes('application') || t.includes('container')) return 'application';
  return 'unknown';
}

/**
 * Compare a shared secret (for example the `?secret=` of the webhook URL the founder pasted into
 * Coolify) in constant time. Coolify's webhook channel is unsigned, so this is a cheap gate
 * in front of the real defence, which is {@link confirmHint}.
 */
export function verifyWebhookSecret(provided: string | null | undefined, expected: string): boolean {
  if (provided === null || provided === undefined || expected.length === 0) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Turn a webhook body into a hint. Returns {@link AdminInvalidRequest} when the body is not an object or
 * names no resource: ignore that delivery.
 * Nothing in the result is trusted: it only says where to look.
 */
export function parseWebhookHint(body: unknown, receivedAt: Date): CoolifyHint | ReturnType<typeof AdminInvalidRequest> {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    return AdminInvalidRequest({ detail: 'The Coolify webhook body is not a JSON object. Ignore this delivery.' });
  }
  const p = parsed.data;
  const label = `${p.event ?? ''} ${p.title ?? ''}`;
  const candidates: [CoolifyHintKind, string | undefined][] = [
    ['deployment', p.deployment_uuid],
    ['application', p.application_uuid],
    ['server', p.server_uuid],
    [kindOf(label), p.uuid],
  ];
  for (const [kind, uuid] of candidates) {
    if (uuid !== undefined && uuidShape.test(uuid)) return { kind, resourceUuid: uuid, receivedAt };
  }
  return AdminInvalidRequest({ detail: 'The Coolify webhook body names no resource uuid. Ignore this delivery.' });
}
