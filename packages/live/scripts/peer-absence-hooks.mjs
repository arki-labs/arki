// Module hooks for `peer-absence.mjs`: every optional peer resolves as if it
// were not installed, the way it is in an app that never added it.

let peers = [];

export function initialize(data) {
  peers = data.peers;
}

const blocked = specifier => peers.some(peer => specifier === peer || specifier.startsWith(`${peer}/`));

export async function resolve(specifier, context, next) {
  if (blocked(specifier)) {
    const error = new Error(`Cannot find package '${specifier}' (an optional peer, absent on purpose)`);
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return next(specifier, context);
}
