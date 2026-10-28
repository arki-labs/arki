import baseConfig from '@arki/eslint-config/base';
import failure from '@arki/failure/eslint';

export default [...baseConfig, failure.configs.recommended];
