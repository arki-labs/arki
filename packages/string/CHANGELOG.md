# @arki/string

## 1.0.0

### Major Changes

- Wave 1 stable release — initial public publication of the ARKI foundation packages at v1.0.0.

  This is the first stable npm release of the `@arki/*` foundation: zero-dependency utilities and runtime primitives (`assert`, `clock`, `contracts`, `date`, `env`, `log`, `resilience`, `slugify`, `string`, `ts`). They ship together because they're consumed together by every downstream wave (DOT kernel, infrastructure adapters).

  Why 1.0.0 and not 0.x.x: every package in this wave passes the full release scorecard (metadata, privacy, dependencies, build-output, packlist, docs, fixtures, DOT gates, agent-native gates) and the public-tree materializer produces installable tarballs with no `workspace:*` or `catalog:` leaks. The stable-v1 commitment is "no breaking changes except in a major bump" — which we earn through the gate, not promise prematurely. Future ARKI development reserves breaking changes for the v2.0.0 channel.

  Wave 2 (`@arki/dot`) and Wave 3 (`@arki/db`, `@arki/kv`, `@arki/event-sourcing`) publish in subsequent releases once their inter-package transitive resolution against the public npm registry is verified.
