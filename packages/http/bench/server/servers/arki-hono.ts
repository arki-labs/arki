// @arki/http on the Hono engine alone (the engine before compiled.ts; still available as buildHonoEngine).
import { buildHonoEngine, listen } from '@arki/http';

import { bundles } from './arki.ts';
import { PORT, ready } from './shared.ts';

await listen(buildHonoEngine(bundles), { port: PORT, hostname: '127.0.0.1' });
ready();
