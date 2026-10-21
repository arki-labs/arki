#!/usr/bin/env node
// The `dot` binary. It lives in the source tree so package managers link it at install time:
// bun skips a bin whose target is missing, and `dist/` is only built after install (Docker,
// fresh clones). It runs the built CLI.
import { run } from '@arki/cli';

import { program } from '../dist/cli/index.js';

await run(program);
