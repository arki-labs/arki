interface ImportMetaEnv {
  readonly VITE_BUILD_ID?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
