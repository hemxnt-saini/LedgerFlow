/// <reference types="vite/client" />

/**
 * The build-time knobs. Declared so a typo in an env var name is a compile
 * error rather than a silently-undefined base URL that falls back to
 * localhost in production.
 */
interface ImportMetaEnv {
  /** Base URL for the payment service. Empty locally, /api/write in production. */
  readonly VITE_WRITE_URL?: string;
  /** Base URL for the query service. Empty locally, /api/read in production. */
  readonly VITE_READ_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
