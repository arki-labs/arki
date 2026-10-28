/**
 * Encrypted env files in the dotenvx 2.x format, for Node, Bun and Deno: load them into the
 * environment (`loadEnvFiles`), edit them (`initEnvFile`, `setEnvFileValue`, ...), and the codec
 * underneath. The Dot CLI's `dot env` commands are built on these.
 */
export {
  decryptValue,
  ENCRYPTED_PREFIX,
  encryptValue,
  envHeader,
  envValues,
  generateKeypair,
  isEncrypted,
  isKeyName,
  keyNamesFor,
  parseEnv,
  publicKeyOf,
  readEnvValue,
  removeEnvValue,
  setEnvValue,
} from './codec.js';
export type { EnvDocument, EnvEntry, EnvKeypair } from './codec.js';
export { decryptEnvFile, encryptEnvFile, initEnvFile, publicKeyIn, rotateEnvFiles, setEnvFileValue } from './edit.js';
export type { InitResult, RotateResult } from './edit.js';
export { findPrivateKey, KEYS_FILE, keysFileCandidates, writePrivateKey } from './keys.js';
export type { FoundPrivateKey, PrivateKeySource } from './keys.js';
export { envDirs, ENV_FILES_ERROR_CODES, findRoot, formatEnvFilesErrors, loadEnvFiles, secretValues } from './load.js';
export type { EnvFilesError, EnvFilesReport, EnvFileValue, EnvValueKind, LoadEnvFilesOptions } from './load.js';
export { DEFAULT_RESOLVERS, referenceScheme } from './references.js';
export type { ReferenceResolver } from './references.js';
export type { ReferenceOptions } from './references.js';
export {
  DecryptionFailed,
  EncryptionFailed,
  EnvCancelled,
  EnvDeadline,
  EnvFilesFailed,
  FileReadFailed,
  FileWriteFailed,
  KeyGenerationFailed,
  MissingPrivateKey,
  MissingPublicKey,
  ReferenceFailed,
  RotationIncomplete,
  UnrepresentableValue,
} from './errors.js';
export { envPrivateKeySchema, envPublicKeySchema, parsePrivateKey, parsePublicKey } from './key-schemas.js';
export type { EnvPrivateKey, EnvPublicKey } from './key-schemas.js';
