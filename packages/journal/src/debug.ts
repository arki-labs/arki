import { debug } from '@arki/log/debug';

/** Enable with `DEBUG=arki:journal:*`. */
export const debugWrite = debug('arki:journal:write');
export const debugReplay = debug('arki:journal:replay');
export const debugDrain = debug('arki:journal:drain');
export const debugWorker = debug('arki:journal:worker');
