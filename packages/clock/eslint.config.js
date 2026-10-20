import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [...library(), failure.configs.recommended];
