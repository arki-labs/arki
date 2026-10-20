import { describe, expect, it, vi } from 'vitest';

import { z } from '@arki/contracts';

import { QueueAcceptanceUnknown, triggerValidated } from './trigger.ts';

const input = z.object({ n: z.number() });

describe('enqueue acknowledgement', () => {
  it('does not invent success when the provider omits its acknowledgement', async () => {
    const send = vi.fn<Parameters<typeof triggerValidated>[3]>();
    expect(await triggerValidated(input, { n: 1 }, 'opaque-key', send)).toMatchObject({
      code: QueueAcceptanceUnknown.code,
    });
    expect(send).toHaveBeenCalledWith('opaque-key');
  });

  it('retains ambiguous acceptance after an attempted send throws', async () => {
    const send = vi.fn(() => Promise.reject(new Error('ack lost')));
    expect(await triggerValidated(input, { n: 1 }, 'opaque-key', send)).toMatchObject({
      code: QueueAcceptanceUnknown.code,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
