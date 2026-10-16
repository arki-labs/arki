import { getLogger } from '@arki/log';

/** Enable with `DEBUG=arki:live:*`. */
export const debugHub = getLogger('arki:live:hub');

/** Enable with `DEBUG=arki:live:pg`. */
export const debugSource = getLogger('arki:live:pg');
