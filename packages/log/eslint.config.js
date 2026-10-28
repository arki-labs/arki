import { library } from '@arki/eslint-config/library';
import failure from '@arki/failure/eslint';

// `src/node` is the Node entry and `src/otel` the OpenTelemetry one; both may use runtime-specific builtins.
export default [...library({ adapters: ['src/node/**', 'src/otel/**'] }), failure.configs.recommended];
