import libraryConfig from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

export default [...libraryConfig, failure.configs.recommended];
