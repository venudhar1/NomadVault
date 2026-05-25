# VaultKey Project Summary

VaultKey is now a working Electron password manager that syncs encrypted vault entries to Turso.

## What Works Now

- Electron desktop app for Windows
- Production-style Electron launch with `npm.cmd run electron-prod`
- Windows installer build with `npm.cmd run electron-build`
- Installer artifact at `release/VaultKey Setup 1.0.0.exe`
- Turso schema auto-creation
- First-run vault initialization
- Master password unlock
- Add/view/delete credentials
- Manual and automatic Turso sync
- Local vault profiles for separate Turso databases
- Recovery location shown inside the app

## Core Security Idea

The app keeps the master password local. It uses WebCrypto to derive keys and encrypt the credential JSON before storing it in Turso.

```text
Master password
  -> PBKDF2-SHA256, 600,000 iterations
  -> AES-GCM encryption key + HMAC auth key
  -> encrypted vault entry blob
  -> Turso vault_entries table
```

Turso stores encrypted blobs, not plaintext sites, usernames, passwords, or notes.

## Important Files

```text
src/App.tsx              Main vault UI and sync flow
src/crypto.ts            PBKDF2, AES-GCM, HMAC, base64 helpers
src/storage-adapter.ts   Storage adapter interface and factory
src/adapters/turso.ts    Turso/libSQL implementation
electron-main.js         Electron shell and production/dev loading
preload.cjs              Minimal Electron preload bridge
package.json             Scripts and electron-builder config
```

## Turso Tables

```text
users
  user_id
  auth_hash
  salt
  created_at

vault_entries
  id
  user_id
  ciphertext
  nonce
  salt
  timestamp
  updated_at
```

The current app uses this single vault id:

```text
primary-vault
```

## Build Outputs

```text
dist/                              Vite production bundle
release/VaultKey Setup 1.0.0.exe   Windows installer
release/win-unpacked/VaultKey.exe  Unpacked executable
```

## Multi-PC Behavior

Every installed app can store one or more local vault profiles. A profile contains the Turso database URL, auth token, and vault user id.

- Adds and deletes push immediately.
- Manual `Sync` pulls latest data.
- The app pulls every 30 seconds while visible.
- The app pulls when the window regains focus.

Use the same profile and master password on your own PCs. Friends should create their own profile with their own Turso database.

## Recovery

Recovery requires:

- access to the Turso database
- the same master password
- a saved profile or equivalent Turso connection details

The data to preserve is in the Turso `users` and `vault_entries` tables. If the master password is lost, credentials cannot be decrypted.

## Current Limitations

- Windows build is unsigned, so SmartScreen may warn.
- Turso auth tokens are stored in local profile storage on each installed machine.
- No local offline cache yet.
- No edit-in-place yet.
- No import/export yet.
- No app icon configured yet.

## Recommended Next Hardening

1. Add a code-signing certificate for Windows distribution.
2. Move Turso access behind a small private backend API or issue restricted per-device tokens.
3. Add encrypted export/import for recovery.
4. Add conflict handling for simultaneous edits from multiple PCs.
5. Add edit-in-place and password generation.
