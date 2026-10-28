/**
 * `@dotenvx/primitives` ships no types. The interop tests call these three functions only, with the
 * signatures read from its bundle (private key or public key first, then the value).
 */
declare module '@dotenvx/primitives' {
  const primitives: {
    keypair(): { publicKey: string; privateKey: string };
    encrypt(publicKey: string, value: string): string;
    decrypt(privateKey: string, value: string): string;
    keyringSync(options: { fk: string; processEnv: Readonly<Record<string, string | undefined>> }): Readonly<Record<string, string>>;
  };
  export default primitives;
}
