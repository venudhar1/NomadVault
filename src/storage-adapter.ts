import { EncryptedBlob } from './crypto';

export interface VaultEntry {
  id: string;
  encryptedData: EncryptedBlob;
  updatedAt: number;
}

export interface StorageAdapter {
  connect(config: StorageConfig): Promise<void>;
  getUser(userId: string): Promise<StoredUser | null>;
  saveUser(user: StoredUser): Promise<void>;
  push(userId: string, entries: VaultEntry[]): Promise<void>;
  pull(userId: string): Promise<VaultEntry[]>;
  delete(userId: string, entryId: string): Promise<void>;
  healthCheck(): Promise<boolean>;
  disconnect(): Promise<void>;
}

export interface StoredUser {
  userId: string;
  authHash: string;
  salt: string;
  createdAt: number;
}

export interface StorageConfig {
  provider: 'turso' | 'supabase' | 'local' | 'custom';
  turso?: {
    dbUrl: string;
    authToken: string;
  };
  supabase?: {
    projectUrl: string;
    anonKey: string;
  };
  local?: {
    dbPath: string;
  };
  custom?: Record<string, any>;
}

export class AdapterFactory {
  static async create(config: StorageConfig): Promise<StorageAdapter> {
    switch (config.provider) {
      case 'turso':
        const { TursoAdapter } = await import('./adapters/turso');
        return new TursoAdapter();
      default:
        throw new Error(`Unknown storage provider: ${config.provider}`);
    }
  }
}
