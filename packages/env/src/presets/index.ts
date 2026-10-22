/** Ready-made Zod presets for ports, URLs, lists, JSON and other common variable shapes. */
import { commonPresets } from './common.js';
import { parsePresets } from './parsing.js';
import { urlPresets } from './urls.js';

// Unified presets export
export const presets = {
  ...commonPresets,
  ...urlPresets,
  ...parsePresets,
};

// Individual category exports


export {commonPresets} from './common.js';
export {urlPresets} from './urls.js';
export {parsePresets} from './parsing.js';