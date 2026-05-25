# VaultKey - Electron Password Manager

VaultKey is a standalone Electron password manager backed by Turso. It keeps the core zero-knowledge idea intact: the master password stays on your device, credentials are encrypted locally with AES-256-GCM, and Turso stores only opaque encrypted blobs.

## Current State

- Windows Electron app with installer output in `release/`
- Turso cloud sync through `@libsql/client`
- Master password unlock using PBKDF2-SHA256 with 600,000 iterations
- Local encryption/decryption with WebCrypto
- Add, view, delete, manual sync, and automatic refresh
- Multi-PC use through saved vault profiles
- Multiple profiles so friends can use their own Turso databases
- Recovery location shown in the app after unlock

## Data Model

The app creates these Turso tables automatically:

```sql
users:
- user_id TEXT PRIMARY KEY
- auth_hash TEXT NOT NULL
- salt TEXT NOT NULL
- created_at INTEGER NOT NULL

vault_entries:
- id TEXT PRIMARY KEY
- user_id TEXT NOT NULL
- ciphertext TEXT NOT NULL
- nonce TEXT NOT NULL
- salt TEXT NOT NULL
- timestamp INTEGER NOT NULL
- updated_at INTEGER NOT NULL
```

The current single vault user id is:

```text
primary-vault
```

Each saved credential is serialized as JSON and encrypted as one blob before sync. Site, username, password, and notes are not stored as plaintext columns.

## Security Model

1. The master password is used only on the local device.
2. PBKDF2 derives two keys:
   - encryption key for AES-256-GCM
   - auth key for the local unlock verification hash
3. On first unlock, the app stores the salt and auth hash in Turso.
4. On later unlocks, the same master password must reproduce the auth hash.
5. Vault entries are encrypted locally before `push` to Turso.
6. Pulled entries are decrypted locally after unlock.

If Turso data is copied or exposed, an attacker sees encrypted blobs. They still need the master password to decrypt saved credentials.

## Profiles

The app no longer requires `.env.local` at runtime. On the login screen, create a vault profile with:

- profile name
- Turso database URL
- Turso auth token
- vault user id, default `primary-vault`

Profiles are stored locally in the installed app's browser storage. They are connection settings, not decrypted vault data. Do not enter your personal Turso profile on a friend's computer unless you intend that computer to access your encrypted vault rows.

Each friend should create their own Turso database and add their own profile.

## Security Caveat

Anyone with a profile's Turso token may be able to read, overwrite, or delete encrypted rows in that Turso database. They should not be able to read plaintext credentials without the master password, but data corruption is still a risk.

Future hardening should move Turso access behind a small private backend API or use restricted per-device tokens.

## Setup

Install dependencies:

```powershell
npm.cmd install
```

## Development

Run the Vite browser app:

```powershell
npm.cmd run dev
```

Run Electron with the Vite dev server:

```powershell
npm.cmd run electron-dev
```

Run Electron against the production `dist/` build:

```powershell
npm.cmd run electron-prod
```

## Build And Ship

Build the Windows installer:

```powershell
npm.cmd run electron-build
```

The installer is created here:

```text
release/VaultKey Setup 1.0.0.exe
```

An unpacked executable is also created here:

```text
release/win-unpacked/VaultKey.exe
```

Copy `release/VaultKey Setup 1.0.0.exe` to each Windows laptop or PC and install it. Each user creates their own vault profile on first launch.

## Multi-Device Sync

Installed copies sync with whichever profile is selected.

- Add/delete syncs to Turso immediately.
- The `Sync` button pulls the latest encrypted entries.
- The app also refreshes every 30 seconds while visible.
- The app refreshes when the window regains focus.

Use the same profile and master password across your own devices. Friends should use their own profile, Turso database, and master password.

## Recovery

To recover saved credentials on another machine, you need:

- the same Turso database data
- the same Turso URL/auth token saved as a profile
- the same master password

In Turso, the recoverable encrypted data is in:

```text
users
vault_entries
```

If the master password is lost, saved credentials cannot be decrypted.

## Verification

Useful checks:

```powershell
npm.cmd run type-check
npm.cmd run build
npm.cmd run electron-prod
```

The current build has been verified with:

- TypeScript type-check
- Vite production build
- Electron production launch
- Windows installer creation through electron-builder

## Notes

- This is currently an unsigned Windows build, so SmartScreen may warn on first install.
- No app icon is configured yet, so Electron's default icon is used.
- There is no local offline cache yet; Turso is the source of truth.
- There is no edit-in-place yet; current vault actions are add, view, delete, and sync.
- Profile tokens are stored locally by Electron/browser storage; use OS account protection and disk encryption on shared machines.
