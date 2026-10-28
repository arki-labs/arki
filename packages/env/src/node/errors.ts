import { z } from 'zod';

import { defineFailure } from '@arki/failure';

/** A dotenv value has no lossless quoting.
 * @fix Use encryption or a value supported by dotenv quoting.
 * @verify bun run test
 */
export const UnrepresentableValue = defineFailure('env.unrepresentable_value', {
  message: 'The value cannot be stored losslessly in dotenv text',
  status: 422,
  remediation: 'Encrypt the value or remove the unsupported combination of quotes and line breaks.',
});
/** Cryptographic encryption failed.
 * @fix Verify the public key and runtime crypto support.
 * @verify bun run test
 */
export const EncryptionFailed = defineFailure('env.encryption_failed', {
  message: 'Cannot encrypt the env value',
  status: 500,
  remediation: 'Verify the public key and runtime crypto support.',
});
/** Ciphertext authentication or decoding failed.
 * @fix Restore the correct private key or reset the damaged value.
 * @verify bun run test
 */
export const DecryptionFailed = defineFailure('env.decryption_failed', {
  message: 'Cannot decrypt the env value',
  status: 422,
  remediation: 'Restore the correct private key or reset the damaged encrypted value.',
});
/** The runtime could not generate a keypair.
 * @fix Restore runtime crypto support.
 * @verify bun run test
 */
export const KeyGenerationFailed = defineFailure('env.key_generation_failed', {
  message: 'Cannot generate an env keypair',
  status: 500,
  remediation: 'Restore runtime crypto support before retrying.',
});
/** An env file could not be read.
 * @fix Check the path, file type and access permissions.
 * @verify bun run test
 */
export const FileReadFailed = defineFailure('env.file_read_failed', {
  data: z.object({ file: z.string() }),
  message: 'Cannot read env file {file}',
  status: 500,
  remediation: 'Check the file path, type and access permissions.',
});
/** An env file could not be replaced.
 * @fix Check disk space and parent-directory permissions.
 * @verify bun run test
 */
export const FileWriteFailed = defineFailure('env.file_write_failed', {
  data: z.object({ file: z.string() }),
  message: 'Cannot write env file {file}',
  status: 500,
  remediation: 'Check disk space and parent-directory permissions before retrying.',
});
/** The target file has no public key.
 * @fix Initialize the file before encrypting values.
 * @verify bun run test
 */
export const MissingPublicKey = defineFailure('env.missing_public_key', {
  data: z.object({ file: z.string() }),
  message: 'Env file {file} has no public key header',
  remediation: 'Initialize the file before encrypting values.',
});
/** No private key is available.
 * @fix Restore the environment key from its backup.
 * @verify bun run test
 */
export const MissingPrivateKey = defineFailure('env.missing_private_key', {
  data: z.object({ file: z.string() }),
  message: 'No private key is available for {file}',
  remediation: 'Restore the environment private key from its backup or shell variable.',
});
/** Rotation stopped after its recovery keys were saved.
 * @fix Keep the staged key file and retry rotation.
 * @verify bun run test
 */
export const RotationIncomplete = defineFailure('env.rotation_incomplete', {
  data: z.object({
    keysFile: z.string(),
    completedFiles: z.number().int().nonnegative(),
    totalFiles: z.number().int().nonnegative(),
  }),
  message: 'Env rotation stopped; recovery keys are saved in {keysFile}',
  status: 500,
  remediation:
    'Keep the staged key file: it contains keys for both old and new ciphertext. Repair the filesystem and retry rotation.',
});
/** A secret provider rejected a read.
 * @fix Check the provider CLI installation, login and reference.
 * @verify bun run test
 */
export const ReferenceFailed = defineFailure('env.reference_failed', {
  data: z.object({ scheme: z.string() }),
  message: 'Cannot resolve the {scheme} secret reference',
  status: 502,
  remediation: 'Check the provider CLI installation, login and reference; inspect the local cause privately.',
});
/** Loading was cancelled.
 * @fix Handle cancellation at the calling boundary.
 * @verify bun run test
 */
export const EnvCancelled = defineFailure('env.cancelled', {
  message: 'Env loading was cancelled',
  status: 499,
  remediation: 'Honor cancellation at the calling boundary.',
});
/** The aggregate load deadline elapsed.
 * @fix Increase the budget or restore provider responsiveness.
 * @verify bun run test
 */
export const EnvDeadline = defineFailure('env.deadline', {
  message: 'The env loading deadline elapsed',
  status: 504,
  remediation: 'Increase the load budget or restore provider responsiveness.',
});

/** Loader problem codes are derived from their canonical definitions. */
export const ENV_FILES_ERROR_CODES = {
  missingPrivateKey: MissingPrivateKey.code,
  cannotDecrypt: DecryptionFailed.code,
  unresolvedReference: ReferenceFailed.code,
  cannotRead: FileReadFailed.code,
  cancelled: EnvCancelled.code,
  deadline: EnvDeadline.code,
} as const;
const problem = z.object({
  code: z.enum(Object.values(ENV_FILES_ERROR_CODES)),
  message: z.string(),
  file: z.string(),
  key: z.string().optional(),
});
/** One or more env entries could not be loaded. Public data excludes values and raw causes.
 * @fix Address each named problem before starting the app.
 * @verify bun run test
 */
export const EnvFilesFailed = defineFailure('env.files_failed', {
  data: z.object({ environment: z.string(), errors: z.array(problem) }),
  message: 'Cannot load the env files',
  status: 500,
  remediation: 'Address each named file/key problem before starting the application.',
});
