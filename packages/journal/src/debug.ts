import { getLogger } from '@arki/log';

/** Enable with `DEBUG=arki:journal:*`. */
export const debugWrite = getLogger('arki:journal:write');
export const debugCommand = getLogger('arki:journal:command');
export const debugReplay = getLogger('arki:journal:replay');
export const debugDrain = getLogger('arki:journal:drain');
export const debugWorker = getLogger('arki:journal:worker');
