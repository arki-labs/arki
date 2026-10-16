import type { Clock } from '@arki/clock';
import { SystemClock } from '@arki/clock';

/** @internal The clock every helper uses when the caller passes none. */
export const systemClock: Clock = new SystemClock();
