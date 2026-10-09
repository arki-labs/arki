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


export {commonContracts} from './common.js';
export {urlContracts} from './urls.js';
export {parseContracts} from './parsing.js';