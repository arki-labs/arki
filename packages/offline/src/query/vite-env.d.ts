// These must stay interfaces: they merge into the global `ImportMetaEnv` and `ImportMeta` declarations from Vite.
// `env` is optional: Vite defines it, but plain Node, Deno and an Expo app (whose `import.meta` has only `url`) do not.
/* eslint-disable @typescript-eslint/consistent-type-definitions -- global declaration merging needs `interface` */
interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
