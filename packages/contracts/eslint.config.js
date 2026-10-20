import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [...library({ adapters: ['src/drizzle.ts', 'src/orpc.ts'] }), failure.configs.recommended];
