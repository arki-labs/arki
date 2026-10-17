// The fixture app's lint: the Dot feature-layer rules a real backend turns on.
// `orpc.dot.test.ts` runs it, to prove a transactional feature keeps its layers.
import tsParser from '@typescript-eslint/parser';

import { featureLayers } from '@arki/eslint-config/feature-layers';

export default [{ files: ['**/*.ts'], languageOptions: { parser: tsParser } }, ...featureLayers({ root: import.meta.dirname })];
