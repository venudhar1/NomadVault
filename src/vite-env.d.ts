/// <reference types="vite/client" />

import type { ProfileStore } from './profile-storage';

declare global {
  interface Window {
    vaultKey?: {
      profiles: {
        load: () => Promise<ProfileStore | null>;
        save: (store: ProfileStore) => Promise<boolean>;
      };
      transfer?: {
        exportToFile: (payload: {
          content: string;
          fileName: string;
        }) => Promise<{ ok: boolean; cancelled: boolean; filePath?: string }>;
        importFromFile: () => Promise<{
          ok: boolean;
          cancelled: boolean;
          content?: string;
        }>;
      };
    };
    electron?: {
      isElectron: boolean;
      version: string;
      getAppVersion: () => string;
    };
  }
}

export {};
