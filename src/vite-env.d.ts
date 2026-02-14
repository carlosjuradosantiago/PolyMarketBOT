/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_TRADING_MODE: string;
  readonly VITE_PAPER_BALANCE: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}