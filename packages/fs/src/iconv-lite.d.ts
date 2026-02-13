declare module 'iconv-lite' {
  export function decode(buffer: Buffer, encoding: string, options?: Options): string;
  export function encode(content: string, encoding: string, options?: Options): Buffer;
  export function encodingExists(encoding: string): boolean;
  export function decodeStream(encoding: string, options?: Options): NodeJS.ReadWriteStream;
  export function encodeStream(encoding: string, options?: Options): NodeJS.ReadWriteStream;

  export type Options = {
    stripBOM?: boolean;
    addBOM?: boolean;
    defaultEncoding?: string;
  }
}
