/**
 * `@dotenvx/primitives` ships no types. The interop tests call these three functions only, with the
 * signatures read from its bundle (private key or public key first, then the value).
 */
declare module '@dotenvx/primitives' {
  const primitives: {
    keypair(): { publicKey: string; privateKey: string };
    encrypt(publicKey: string, value: string): string;
    decrypt(privateKey: string, value: string): string;
  };
  export default primitives;
}
