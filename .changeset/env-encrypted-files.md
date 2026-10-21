---
'@arki/env': minor
---

Encrypted env files in the dotenvx 2.x format. New `@arki/env/node`: `loadEnvFiles()` reads `.env.<environment>` and `.env.local` from the repository root down to the working directory, decrypts `encrypted:` values (via `eciesjs`, byte-compatible with dotenvx), resolves `op://`, `infisical://` and `doppler://` references, and writes what the real environment does not set into it (real values win; differing ones are reported as shadowed). Also the codec and file edits behind `dot env`. New side-effect entry `@arki/env/node/register`. `@arki/env/core` adds `describeEnv`, `isSecretSchema` and `SECRET_SCHEMA`, and `defineEnv` now refuses a value that is still `encrypted:` instead of accepting ciphertext as a string. New codes `ARKI_ENV_FILES_E001`–`E003`.
