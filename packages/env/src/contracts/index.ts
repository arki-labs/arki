import { commonContracts } from './common.js';
import { parseContracts } from './parsing.js';
import { urlContracts } from './urls.js';

// Unified contracts export
export const contracts = {
  ...commonContracts,
  ...urlContracts,
  ...parseContracts,
};

// Individual category exports
export { commonContracts, urlContracts, parseContracts };
