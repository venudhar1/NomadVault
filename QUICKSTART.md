# VaultKey Quick Start

This project currently ships as a Windows Electron app backed by Turso.

## 1. Create A Turso Database

Create a Turso database and get its URL and auth token. You will paste these into the app as a vault profile.

Each person should use their own Turso database/profile. Do not give your personal profile token to a friend.

## 2. Install Dependencies

```powershell
npm.cmd install
```

## 3. Test Locally

Run the production-style Electron app:

```powershell
npm.cmd run electron-prod
```

Or run the dev version:

```powershell
npm.cmd run electron-dev
```

## 4. Create The Installer

```powershell
npm.cmd run electron-build
```

The installer is created at:

```text
release/VaultKey Setup 1.0.0.exe
```

The unpacked app is created at:

```text
release/win-unpacked/VaultKey.exe
```

## 5. Install On Your PCs

Copy this file to each trusted Windows laptop or PC:

```text
release/VaultKey Setup 1.0.0.exe
```

Install it, open VaultKey, and unlock with the same master password on every device.

## 6. First Use

1. Open VaultKey.
2. Click `New profile`.
3. Enter a profile name, Turso database URL, Turso auth token, and keep the default vault user id unless needed.
4. Save the profile.
5. Enter a strong master password.
6. Click `Unlock vault`.
7. Switch to `Edit`.
8. Click `+ Add password`.
9. Save a test credential.
10. Open VaultKey on another PC, create the same profile, and use the same master password.
11. Click `Sync` or wait for automatic refresh.

The credential should appear after it is pulled from Turso.

## Sync Behavior

- Adds and deletes sync immediately.
- `Sync` pulls from Turso manually.
- The app refreshes every 30 seconds while visible.
- The app refreshes when the window regains focus.
- Switching profiles switches to that profile's Turso database.

## Recovery

Your encrypted data is in Turso:

```text
users
vault_entries
```

Recovery requires:

- Turso database access
- the same master password
- a saved profile or equivalent Turso URL/token

If you forget the master password, the saved credentials cannot be decrypted.

## Troubleshooting

### Cannot unlock

- Make sure you are using the same master password used when the vault was first created.
- Check that the selected profile points to the correct Turso database and vault user id.

### Sync does not work

- Confirm the PC has internet access.
- Confirm the Turso URL/token in the selected profile.
- Edit the profile if the token changes.

### Windows warns during install

The current installer is unsigned. SmartScreen warnings are expected until a code-signing certificate is added.
