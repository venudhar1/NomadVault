import { createClient } from '@libsql/client/web';
import {
  StorageAdapter,
  StorageConfig,
  StoredUser,
  VaultEntry,
} from '../storage-adapter';

export class TursoAdapter implements StorageAdapter {
  private client: ReturnType<typeof createClient> | null = null;
  private initialized = false;

  async connect(config: StorageConfig): Promise<void> {
    if (!config.turso?.dbUrl || !config.turso.authToken) {
      throw new Error('Turso config required');
    }

    this.client = createClient({
      url: config.turso.dbUrl,
      authToken: config.turso.authToken,
    });

    await this.initializeSchema();
    this.initialized = true;
  }

  async getUser(userId: string): Promise<StoredUser | null> {
    const client = this.requireClient();
    const result = await client.execute({
      sql: `
        SELECT user_id, auth_hash, salt, created_at
        FROM users
        WHERE user_id = ?
      `,
      args: [userId],
    });

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: String(row.user_id),
      authHash: String(row.auth_hash),
      salt: String(row.salt),
      createdAt: Number(row.created_at),
    };
  }

  async saveUser(user: StoredUser): Promise<void> {
    const client = this.requireClient();
    await client.execute({
      sql: `
        INSERT INTO users (user_id, auth_hash, salt, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          auth_hash = excluded.auth_hash,
          salt = excluded.salt
      `,
      args: [user.userId, user.authHash, user.salt, user.createdAt],
    });
  }

  async push(userId: string, entries: VaultEntry[]): Promise<void> {
    const client = this.requireClient();

    for (const entry of entries) {
      await client.execute({
        sql: `
          INSERT INTO vault_entries (id, user_id, ciphertext, nonce, salt, timestamp, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            user_id = excluded.user_id,
            ciphertext = excluded.ciphertext,
            nonce = excluded.nonce,
            salt = excluded.salt,
            timestamp = excluded.timestamp,
            updated_at = excluded.updated_at
        `,
        args: [
          entry.id,
          userId,
          entry.encryptedData.ciphertext,
          entry.encryptedData.nonce,
          entry.encryptedData.salt,
          entry.encryptedData.timestamp,
          entry.updatedAt,
        ],
      });
    }
  }

  async pull(userId: string): Promise<VaultEntry[]> {
    const client = this.requireClient();
    const result = await client.execute({
      sql: `
        SELECT id, ciphertext, nonce, salt, timestamp, updated_at
        FROM vault_entries
        WHERE user_id = ?
        ORDER BY updated_at DESC
      `,
      args: [userId],
    });

    return result.rows.map(row => ({
      id: String(row.id),
      encryptedData: {
        ciphertext: String(row.ciphertext),
        nonce: String(row.nonce),
        salt: String(row.salt),
        timestamp: Number(row.timestamp),
      },
      updatedAt: Number(row.updated_at),
    }));
  }

  async delete(userId: string, entryId: string): Promise<void> {
    const client = this.requireClient();
    await client.execute({
      sql: 'DELETE FROM vault_entries WHERE id = ? AND user_id = ?',
      args: [entryId, userId],
    });
  }

  async healthCheck(): Promise<boolean> {
    try {
      const client = this.requireClient();
      const result = await client.execute('SELECT 1 AS ok');
      return result.rows.length > 0;
    } catch {
      return false;
    }
  }

  async disconnect(): Promise<void> {
    this.client?.close();
    this.initialized = false;
  }

  private async initializeSchema(): Promise<void> {
    const client = this.requireClient(false);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        auth_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        ciphertext TEXT NOT NULL,
        nonce TEXT NOT NULL,
        salt TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(user_id)
      )
    `);

    await client.execute(`
      CREATE INDEX IF NOT EXISTS idx_vault_entries_user_id
      ON vault_entries (user_id)
    `);
  }

  private requireClient(requireInitialized = true): ReturnType<typeof createClient> {
    if (!this.client || (requireInitialized && !this.initialized)) {
      throw new Error('Adapter not connected');
    }

    return this.client;
  }
}
