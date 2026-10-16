---
'@arki/admin': minor
---

One environment vocabulary: `prod`, `staging`, `dev`. The manifest `app.environment`, the audience (`novelette:prod`) and the receipts namespace now accept only these. `production`, `development` and `preview` are refused. New exports: `foremanEnvironmentSchema`, `ForemanEnvironment` (`@arki/admin/server`) and `foremanEnvironmentFromNodeEnv(nodeEnv, override?)` (`@arki/admin/env`), which maps `production` to `prod` and anything else to `dev`. New optional env var `FOREMAN_ENVIRONMENT` (in `foremanEnvShape`) overrides it, for staging. `createForemanHandlerFromEnv` and `foreman()` take `environment: ForemanEnvironment`. Migrate: use the helper, and rename audiences and receipt namespaces in your committed identities.
