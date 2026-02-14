/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_PRIVATE_KEY: string;
  readonly VITE_TRADING_MODE: string;
  readonly VITE_PAPER_BALANCE: string;
  readonly VITE_CLAUDE_API_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}