/** entrypoints/rpc.ts: browser-safe — oRPC contract and zod only. */
import { oc } from '@orpc/contract';
import { z } from 'zod';

export const digestSchema = z.object({ id: z.string(), items: z.array(z.string()) });

export const digestRpcContract = oc.router({ preview: oc.output(digestSchema.nullable()) });
