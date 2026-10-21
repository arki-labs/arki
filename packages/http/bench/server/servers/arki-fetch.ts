// The compiled engine through Bun.serve's fetch only: what the native route table adds on top.
import { buildEngine } from '@arki/http';

import { bundles } from './arki.ts';
import { PORT, ready } from './shared.ts';

Bun.serve({ port: PORT, hostname: '127.0.0.1', fetch: buildEngine(bundles).fetch });
ready();
