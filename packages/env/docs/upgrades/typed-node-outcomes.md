# Typed node operations

Node filesystem, crypto and provider operations return canonical failures. Replace exception-only handling with `isFailure(result)` checks and propagate the exact returned failure. `defineEnv` remains a lazy boot declaration whose invalid configuration throws.

`generateKeypair()` returns a keypair or `KeyGenerationFailed`. Parse external public/private strings with `parsePublicKey` / `parsePrivateKey`; their validated domains are distinct. Pass these keys to `encryptValue`, `decryptValue`, `publicKeyOf` and `writePrivateKey`. Encryption/decryption and lossless text edits return typed failures instead of throwing expected rejection.

`loadEnvFiles()` returns its successful report, `EnvFilesFailed`, `EnvCancelled` or `EnvDeadline`. Read `EnvFilesFailed.data.errors`; problem codes are now dotted canonical codes (`env.missing_private_key`, `env.decryption_failed`, `env.reference_failed`, `env.file_read_failed`). Failure applies no file values. Do not serialize successful report values or private failure causes. `formatEnvFilesErrors` accepts `EnvFilesFailed`. Explicit `node/register` converts these outcomes to a boot exception.

`timeoutMs` defaults to one 30-second aggregate budget. Custom synchronous resolvers accept a second options argument with remaining timeout and optional signal, and return a string or canonical provider/cancellation/deadline failure. Thrown custom resolver errors are sanitized at the loader boundary. Abort is checked between synchronous callbacks; native child processes enforce the timeout.

Storage/ciphertext algorithms and bytes remain dotenvx-compatible. Rotation stages the root and every existing candidate local `.env.keys` store before any ciphertext changes. Each variable temporarily stores the existing comma-separated multi-key shape: new key first, followed by previous generations. Each file remains decryptable during partial rotation. Keep that file after `RotationIncomplete`, repair the filesystem and retry with the staged keys. Previous keys retire only after every new file reads back exactly as planned. Atomic temp-file replacement protects against partial writes on process interruption; it is not an fsync/power-loss durability guarantee.

Node load/edit/provider execution emits OpenTelemetry spans and durations without installing an SDK. Configure telemetry in the application; no path, reference, value, key or raw cause is recorded.
