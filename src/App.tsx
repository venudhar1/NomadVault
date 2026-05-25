import React, { useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  base64ToBytes,
  bytesToBase64,
  computeHMACSHA256,
  decryptAES256GCM,
  deriveKeys,
  encryptAES256GCM,
  generateRandomId,
} from './crypto';
import {
  AdapterFactory,
  StorageAdapter,
  StorageConfig,
  VaultEntry,
} from './storage-adapter';
import './app.css';
import {
  loadProfileStore,
  saveProfileStore,
  type VaultProfile,
} from './profile-storage';
import {
  exportProfilesToFile,
  importProfilesFromFile,
  mergeImportedProfiles,
  parseExportBundle,
  safeExportFileName,
  type ProfileExportBundle,
} from './profile-transfer';

const DEFAULT_USER_ID = 'primary-vault';
const AUTH_CHALLENGE = 'vaultkey:user-auth:v1';

interface PasswordEntry {
  id: string;
  site: string;
  username: string;
  password: string;
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

type SyncState = 'idle' | 'syncing' | 'synced' | 'error';

type AppState =
  | {
      authenticated: false;
      masterPassword: string;
    }
  | {
      authenticated: true;
      entries: PasswordEntry[];
      encryptionKey: CryptoKey;
      authKey: Uint8Array;
      adapter: StorageAdapter;
      profile: VaultProfile;
      mode: 'readonly' | 'edit';
      syncState: SyncState;
      lastSyncAt: number | null;
    };

function profileToStorageConfig(profile: VaultProfile): StorageConfig {
  return {
    provider: 'turso',
    turso: {
      dbUrl: profile.dbUrl.trim(),
      authToken: profile.authToken.trim(),
    },
  };
}

async function unlockVault(
  masterPassword: string,
  adapter: StorageAdapter,
  userId: string
): Promise<{
  encryptionKey: CryptoKey;
  authKey: Uint8Array;
  entries: PasswordEntry[];
}> {
  const existingUser = await adapter.getUser(userId);
  const derived = existingUser
    ? await deriveKeys(masterPassword, base64ToBytes(existingUser.salt))
    : await deriveKeys(masterPassword);

  const authHash = await computeHMACSHA256(AUTH_CHALLENGE, derived.authKey);

  if (existingUser) {
    if (authHash !== existingUser.authHash) {
      throw new Error('Wrong master password for this profile');
    }
  } else {
    await adapter.saveUser({
      userId,
      authHash,
      salt: bytesToBase64(derived.salt),
      createdAt: Date.now(),
    });
  }

  const encryptedEntries = await adapter.pull(userId);
  const entries = await Promise.all(
    encryptedEntries.map(async entry => decryptVaultEntry(entry, derived.encryptionKey))
  );

  return {
    encryptionKey: derived.encryptionKey,
    authKey: derived.authKey,
    entries,
  };
}

async function encryptVaultEntry(
  entry: PasswordEntry,
  encryptionKey: CryptoKey
): Promise<VaultEntry> {
  return {
    id: entry.id,
    encryptedData: await encryptAES256GCM(JSON.stringify(entry), encryptionKey),
    updatedAt: entry.updatedAt,
  };
}

async function decryptVaultEntry(
  entry: VaultEntry,
  encryptionKey: CryptoKey
): Promise<PasswordEntry> {
  const plaintext = await decryptAES256GCM(entry.encryptedData, encryptionKey);
  return JSON.parse(plaintext) as PasswordEntry;
}

export function PasswordManager() {
  const [profiles, setProfiles] = useState<VaultProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  const [profilesReady, setProfilesReady] = useState(false);
  const [state, setState] = useState<AppState>({
    authenticated: false,
    masterPassword: '',
  });

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferNotice, setTransferNotice] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [importPreview, setImportPreview] = useState<ProfileExportBundle | null>(null);

  useEffect(() => {
    let cancelled = false;

    void loadProfileStore().then(store => {
      if (cancelled) {
        return;
      }

      setProfiles(store.profiles);
      setSelectedProfileId(store.selectedProfileId);
      setProfilesReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === selectedProfileId) || null,
    [profiles, selectedProfileId]
  );

  const persistProfiles = (nextProfiles: VaultProfile[], nextSelectedId?: string) => {
    const selectedId = nextSelectedId ?? selectedProfileId;
    const resolvedSelectedId = nextProfiles.some(profile => profile.id === selectedId)
      ? selectedId
      : nextProfiles[0]?.id || '';

    setProfiles(nextProfiles);
    setSelectedProfileId(resolvedSelectedId);

    void saveProfileStore({
      version: 1,
      profiles: nextProfiles,
      selectedProfileId: resolvedSelectedId,
    }).catch(err => {
      console.error('Failed to save profiles:', err);
      setError('Could not save vault profiles to disk. Your changes may not persist.');
    });
  };

  const handleSaveProfile = (profileInput: ProfileFormData) => {
    const now = Date.now();
    const profile: VaultProfile = {
      id: profileInput.id || generateRandomId(),
      name: profileInput.name.trim(),
      dbUrl: profileInput.dbUrl.trim(),
      authToken: profileInput.authToken.trim(),
      vaultUserId: profileInput.vaultUserId.trim() || DEFAULT_USER_ID,
      createdAt: profileInput.createdAt || now,
      updatedAt: now,
    };

    if (!profile.name || !profile.dbUrl || !profile.authToken || !profile.vaultUserId) {
      setError('Profile name, Turso URL, auth token, and vault user id are required.');
      return;
    }

    const nextProfiles = profiles.some(existing => existing.id === profile.id)
      ? profiles.map(existing => (existing.id === profile.id ? profile : existing))
      : [...profiles, profile];

    persistProfiles(nextProfiles, profile.id);
    setError('');
  };

  const handleDeleteProfile = (profileId: string) => {
    const nextProfiles = profiles.filter(profile => profile.id !== profileId);
    persistProfiles(nextProfiles);
    setError('');
  };

  const handleSelectProfile = (profileId: string) => {
    setSelectedProfileId(profileId);
    void saveProfileStore({
      version: 1,
      profiles,
      selectedProfileId: profileId,
    }).catch(err => {
      console.error('Failed to save selected profile:', err);
    });
  };

  const handleExportProfiles = async (profilesToExport: VaultProfile[]) => {
    if (profilesToExport.length === 0) {
      setTransferNotice({ type: 'error', message: 'No vault selected to export.' });
      return;
    }

    setTransferBusy(true);
    setTransferNotice(null);
    setError('');

    try {
      const fileName =
        profilesToExport.length === 1
          ? `vaultkey-${safeExportFileName(profilesToExport[0].name)}.json`
          : `vaultkey-all-vaults-${new Date().toISOString().slice(0, 10)}.json`;

      const result = await exportProfilesToFile(profilesToExport, fileName);
      if (result.cancelled) {
        return;
      }
      if (!result.ok) {
        throw new Error('Export failed. Try another folder or check disk permissions.');
      }

      setTransferNotice({
        type: 'success',
        message:
          profilesToExport.length === 1
            ? `Exported "${profilesToExport[0].name}" — copy this file to your other PC and import it there.`
            : `Exported ${profilesToExport.length} vaults — copy this file to your other PC and import it there.`,
      });
    } catch (err) {
      setTransferNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Export failed.',
      });
    } finally {
      setTransferBusy(false);
    }
  };

  const handleImportFileContent = (raw: string) => {
    setTransferNotice(null);
    setError('');

    try {
      setImportPreview(parseExportBundle(raw));
    } catch (err) {
      setTransferNotice({
        type: 'error',
        message: err instanceof Error ? err.message : 'Import failed.',
      });
    }
  };

  const handleConfirmImport = () => {
    if (!importPreview) {
      return;
    }

    const { profiles: merged, firstImportedId } = mergeImportedProfiles(
      profiles,
      importPreview.profiles
    );
    persistProfiles(merged, firstImportedId);
    setImportPreview(null);
    setTransferNotice({
      type: 'success',
      message: `Imported ${importPreview.profiles.length} vault${
        importPreview.profiles.length === 1 ? '' : 's'
      }. Select it and unlock with your master password.`,
    });
  };

  const updateSyncState = (syncState: SyncState, lastSyncAt?: number) => {
    setState(prev => {
      if (!prev.authenticated) {
        return prev;
      }

      return {
        ...prev,
        syncState,
        lastSyncAt: lastSyncAt ?? prev.lastSyncAt,
      };
    });
  };

  const handleMasterPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.authenticated) {
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      if (!selectedProfile) {
        throw new Error('Create or select a vault profile first.');
      }

      const config = profileToStorageConfig(selectedProfile);
      const adapter = await AdapterFactory.create(config);
      await adapter.connect(config);
      const unlocked = await unlockVault(
        state.masterPassword,
        adapter,
        selectedProfile.vaultUserId
      );

      setState({
        authenticated: true,
        entries: unlocked.entries,
        encryptionKey: unlocked.encryptionKey,
        authKey: unlocked.authKey,
        adapter,
        profile: selectedProfile,
        mode: 'readonly',
        syncState: 'synced',
        lastSyncAt: Date.now(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unlock vault.');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddEntry = async (entry: PasswordEntry) => {
    if (!state.authenticated) {
      return;
    }

    const now = Date.now();
    const newEntry: PasswordEntry = {
      ...entry,
      id: generateRandomId(),
      createdAt: now,
      updatedAt: now,
    };

    try {
      updateSyncState('syncing');
      const encryptedEntry = await encryptVaultEntry(newEntry, state.encryptionKey);
      await state.adapter.push(state.profile.vaultUserId, [encryptedEntry]);

      setState(prev => {
        if (!prev.authenticated) {
          return prev;
        }

        return {
          ...prev,
          entries: [newEntry, ...prev.entries],
          syncState: 'synced',
          lastSyncAt: Date.now(),
        };
      });
      setError('');
    } catch (err) {
      updateSyncState('error');
      setError(err instanceof Error ? err.message : 'Failed to sync new password.');
      console.error(err);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    if (!state.authenticated) {
      return;
    }

    try {
      updateSyncState('syncing');
      await state.adapter.delete(state.profile.vaultUserId, entryId);

      setState(prev => {
        if (!prev.authenticated) {
          return prev;
        }

        return {
          ...prev,
          entries: prev.entries.filter(entry => entry.id !== entryId),
          syncState: 'synced',
          lastSyncAt: Date.now(),
        };
      });
      setError('');
    } catch (err) {
      updateSyncState('error');
      setError(err instanceof Error ? err.message : 'Failed to delete password.');
      console.error(err);
    }
  };

  const handleRefreshFromTurso = async () => {
    if (!state.authenticated) {
      return;
    }

    try {
      updateSyncState('syncing');
      const encryptedEntries = await state.adapter.pull(state.profile.vaultUserId);
      const entries = await Promise.all(
        encryptedEntries.map(entry => decryptVaultEntry(entry, state.encryptionKey))
      );

      setState(prev => {
        if (!prev.authenticated) {
          return prev;
        }

        return {
          ...prev,
          entries,
          syncState: 'synced',
          lastSyncAt: Date.now(),
        };
      });
      setError('');
    } catch (err) {
      updateSyncState('error');
      setError(err instanceof Error ? err.message : 'Failed to refresh from Turso.');
      console.error(err);
    }
  };

  const handleLogout = async () => {
    if (state.authenticated) {
      await state.adapter.disconnect();
    }

    setState({
      authenticated: false,
      masterPassword: '',
    });
  };

  useEffect(() => {
    if (!state.authenticated) {
      return undefined;
    }

    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible') {
        void handleRefreshFromTurso();
      }
    };

    const intervalId = window.setInterval(refreshIfVisible, 30000);
    window.addEventListener('focus', refreshIfVisible);
    document.addEventListener('visibilitychange', refreshIfVisible);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('focus', refreshIfVisible);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [state.authenticated]);

  if (!state.authenticated) {
    if (!profilesReady) {
      return (
        <div className="login-container">
          <div className="login-shell login-loading">
            <p>Loading vault profiles…</p>
          </div>
        </div>
      );
    }

    return (
      <>
        <LoginScreen
          profiles={profiles}
          selectedProfileId={selectedProfileId}
          masterPassword={state.masterPassword}
          onProfileSelect={handleSelectProfile}
          onProfileSave={handleSaveProfile}
          onProfileDelete={handleDeleteProfile}
          onExportProfile={profileId => {
            const profile = profiles.find(p => p.id === profileId);
            if (profile) {
              void handleExportProfiles([profile]);
            }
          }}
          onImportFileContent={handleImportFileContent}
          onPasswordChange={pwd =>
            setState(prev => ({
              ...prev,
              masterPassword: pwd,
            }))
          }
          onSubmit={handleMasterPasswordSubmit}
          isLoading={isLoading}
          transferBusy={transferBusy}
          transferNotice={transferNotice}
          onDismissTransferNotice={() => setTransferNotice(null)}
          error={error}
        />

        {importPreview && (
          <ImportPreviewModal
            bundle={importPreview}
            existingProfiles={profiles}
            onConfirm={handleConfirmImport}
            onCancel={() => setImportPreview(null)}
          />
        )}
      </>
    );
  }

  return (
    <VaultScreen
      entries={state.entries}
      mode={state.mode}
      syncState={state.syncState}
      lastSyncAt={state.lastSyncAt}
      profile={state.profile}
      error={error}
      onAddEntry={handleAddEntry}
      onDeleteEntry={handleDeleteEntry}
      onRefresh={handleRefreshFromTurso}
      onModeChange={mode =>
        setState(prev => {
          if (!prev.authenticated) {
            return prev;
          }

          return { ...prev, mode };
        })
      }
      onLogout={handleLogout}
    />
  );
}

interface ProfileFormData {
  id: string;
  name: string;
  dbUrl: string;
  authToken: string;
  vaultUserId: string;
  createdAt?: number;
}

interface LoginScreenProps {
  profiles: VaultProfile[];
  selectedProfileId: string;
  masterPassword: string;
  onProfileSelect: (profileId: string) => void;
  onProfileSave: (profile: ProfileFormData) => void;
  onProfileDelete: (profileId: string) => void;
  onExportProfile: (profileId: string) => void;
  onImportFileContent: (raw: string) => void;
  onPasswordChange: (pwd: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
  transferBusy: boolean;
  transferNotice: { type: 'success' | 'error'; message: string } | null;
  onDismissTransferNotice: () => void;
  error: string;
}

function profileInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return 'V';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

interface LoginProfileCardProps {
  profile: VaultProfile;
  isSelected: boolean;
  isOpen: boolean;
  isLoading: boolean;
  transferBusy: boolean;
  onSelect: () => void;
  onToggleMenu: () => void;
  onExport: () => void;
  onDelete: () => void;
}

function LoginProfileCard(props: LoginProfileCardProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuCoords, setMenuCoords] = useState<{ top: number; right: number } | null>(null);

  useEffect(() => {
    if (props.isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuCoords({
        top: rect.bottom + window.scrollY + 6,
        right: window.innerWidth - rect.right - window.scrollX,
      });
    } else {
      setMenuCoords(null);
    }
  }, [props.isOpen]);

  return (
    <li role="option" aria-selected={props.isSelected}>
      <div className={`profile-card-wrapper${props.isOpen ? ' kebab-open' : ''}`}>
        <button
          type="button"
          className={`profile-card profile-card-full${props.isSelected ? ' profile-card-selected' : ''}`}
          onClick={props.onSelect}
          disabled={props.isLoading}
        >
          <span className="profile-avatar" aria-hidden="true">
            {profileInitials(props.profile.name)}
          </span>
          <span className="profile-card-body">
            <span className="profile-card-name">{props.profile.name}</span>
            <span className="profile-card-hint">Personal vault</span>
          </span>
        </button>
        <div className="profile-card-kebab">
          <button
            ref={buttonRef}
            type="button"
            className="btn-icon-kebab"
            aria-label="Profile options"
            aria-expanded={props.isOpen}
            aria-haspopup="menu"
            disabled={props.isLoading || props.transferBusy}
            onClick={e => {
              e.stopPropagation();
              props.onToggleMenu();
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {props.isOpen && menuCoords && createPortal(
            <div
              className="profile-menu-dropdown profile-kebab-dropdown"
              role="menu"
              style={{
                position: 'fixed',
                top: `${menuCoords.top}px`,
                right: `${menuCoords.right}px`,
                margin: 0,
              }}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                role="menuitem"
                className="profile-menu-action"
                aria-label="Export vault"
                disabled={props.transferBusy}
                onClick={props.onExport}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </button>
              <button
                type="button"
                role="menuitem"
                className="profile-menu-action profile-menu-action-delete"
                aria-label="Delete vault"
                disabled={props.transferBusy}
                onClick={props.onDelete}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  <line x1="10" y1="11" x2="10" y2="17" />
                  <line x1="14" y1="11" x2="14" y2="17" />
                </svg>
              </button>
            </div>,
            document.body
          )}
        </div>
      </div>
    </li>
  );
}

function LoginScreen(props: LoginScreenProps) {
  const selectedProfile =
    props.profiles.find(profile => profile.id === props.selectedProfileId) || null;
  const [showModal, setShowModal] = useState(false);
  const [editingProfile, setEditingProfile] = useState<VaultProfile | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLockOn, setCapsLockOn] = useState(false);
  const [kebabOpenProfileId, setKebabOpenProfileId] = useState<string | null>(null);
  const [confirmDeleteProfileId, setConfirmDeleteProfileId] = useState<string | null>(null);

  // Close kebab dropdown when clicking anywhere outside or when pressing Escape
  useEffect(() => {
    if (kebabOpenProfileId === null) return;

    const handleDocClick = () => setKebabOpenProfileId(null);
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setKebabOpenProfileId(null);
    };

    document.addEventListener('click', handleDocClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleDocClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [kebabOpenProfileId]);

  useEffect(() => {
    if (props.profiles.length === 0) {
      setShowModal(true);
    }
  }, [props.profiles.length]);

  const openNewProfileModal = () => {
    setEditingProfile(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingProfile(null);
  };

  const closeKebab = () => setKebabOpenProfileId(null);
  const toggleKebab = (profileId: string) =>
    setKebabOpenProfileId(current => (current === profileId ? null : profileId));
  const handleExportProfile = (profileId: string) => {
    closeKebab();
    props.onExportProfile(profileId);
  };
  const requestDeleteProfile = (profileId: string) => {
    closeKebab();
    setConfirmDeleteProfileId(profileId);
  };
  return (
    <div className="login-container">
      <div className="login-shell">
        <header className="login-brand">
          <span className="login-logo" aria-hidden="true" style={{ color: 'var(--color-primary)', display: 'inline-flex' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <circle cx="12" cy="11" r="2" />
              <path d="M12 13v4" />
            </svg>
          </span>
          <h1>VaultKey</h1>
        </header>

        {props.transferNotice && (
          <div
            className={`transfer-notice transfer-notice-${props.transferNotice.type}`}
            role="status"
          >
            <p>{props.transferNotice.message}</p>
            <button
              type="button"
              className="btn-notice-dismiss"
              onClick={props.onDismissTransferNotice}
              aria-label="Dismiss message"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        <div className="login-layout">
          <aside className="login-column login-profiles">
            <div className="login-column-header">
              <h2 className="vault-list-title">Your vaults</h2>
              <div className="vault-header-actions">
                <button
                  type="button"
                  className="btn-icon-action btn-add-vault"
                  aria-label="New vault"
                  title="New vault"
                  onClick={openNewProfileModal}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="btn-icon-action btn-import-vault"
                  aria-label="Import vault"
                  title="Import vault"
                  disabled={props.transferBusy}
                  onClick={() => setShowImportModal(true)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                </button>
              </div>
            </div>

            {props.profiles.length > 0 ? (
              <ul className="profile-list" role="listbox" aria-label="Vault profiles">
                {props.profiles.map(profile => {
                  const isSelected = profile.id === props.selectedProfileId;
                  const isKebabOpen = kebabOpenProfileId === profile.id;
                  return (
                    <LoginProfileCard
                      key={profile.id}
                      profile={profile}
                      isSelected={isSelected}
                      isOpen={isKebabOpen}
                      isLoading={props.isLoading}
                      transferBusy={props.transferBusy}
                      onSelect={() => props.onProfileSelect(profile.id)}
                      onToggleMenu={() => toggleKebab(profile.id)}
                      onExport={() => handleExportProfile(profile.id)}
                      onDelete={() => requestDeleteProfile(profile.id)}
                    />
                  );
                })}
              </ul>
            ) : (
              <div className="empty-profile-state">
                <p>No vaults yet. Add your Turso connection to get started.</p>
                <button type="button" className="btn-secondary" onClick={openNewProfileModal}>
                  Add your first vault
                </button>
              </div>
            )}

            {confirmDeleteProfileId && (
              <div className="confirm-backdrop" role="dialog" aria-modal="true">
                <div className="confirm-modal">
                  <p>Delete this vault? This cannot be undone.</p>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="btn-text btn-danger"
                      onClick={() => {
                        props.onProfileDelete(confirmDeleteProfileId);
                        setConfirmDeleteProfileId(null);
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="btn-text"
                      onClick={() => setConfirmDeleteProfileId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}
          </aside>

          <section className="login-column login-unlock login-unlock-primary">
            {selectedProfile ? (
              <div className="vault-hero">
                <span className="profile-avatar profile-avatar-lg" aria-hidden="true">
                  {profileInitials(selectedProfile.name)}
                </span>
                <div className="vault-hero-text">
                  <p className="unlock-greeting">
                    Welcome back, <strong>{selectedProfile.name}</strong>
                  </p>
                  <p className="unlock-subtitle">Unlock your secure workspace</p>
                </div>
              </div>
            ) : (
              <div className="vault-hero vault-hero-empty">
                <p className="unlock-greeting">Welcome to VaultKey</p>
                <p className="unlock-subtitle unlock-selected-muted">
                  Select a vault to unlock your secure workspace
                </p>
              </div>
            )}

            <form
              className={`unlock-form${props.error ? ' unlock-form-error' : ''}`}
              onSubmit={props.onSubmit}
            >
              <div className="form-group">
                <label htmlFor="master-pwd">Master password</label>
                <div className="password-input-wrap">
                  <input
                    id="master-pwd"
                    type={showPassword ? 'text' : 'password'}
                    className="password-input"
                    value={props.masterPassword}
                    onChange={e => props.onPasswordChange(e.target.value)}
                    onKeyDown={e => setCapsLockOn(e.getModifierState('CapsLock'))}
                    onKeyUp={e => setCapsLockOn(e.getModifierState('CapsLock'))}
                    placeholder="Enter your master password"
                    disabled={props.isLoading || !selectedProfile}
                    autoComplete="current-password"
                    required
                  />
                  <button
                    type="button"
                    className="btn-password-toggle"
                    onClick={() => setShowPassword(v => !v)}
                    disabled={props.isLoading || !selectedProfile}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {capsLockOn && (
                  <p className="caps-lock-warning" role="status">
                    Caps Lock is on
                  </p>
                )}
              </div>

              {props.error && (
                <div className="error-message error-message-shake" role="alert">
                  {props.error}
                </div>
              )}

              <button
                type="submit"
                disabled={props.isLoading || !props.masterPassword || !selectedProfile}
                className="btn-primary btn-unlock btn-block"
              >
                {props.isLoading ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Unlocking...
                  </>
                ) : (
                  <>
                    Unlock vault
                    <span aria-hidden="true">→</span>
                  </>
                )}
              </button>
            </form>

          </section>
        </div>
      </div>

      {showModal && (
        <ProfileModal
          profile={editingProfile}
          onSave={profile => {
            props.onProfileSave(profile);
            closeModal();
          }}
          onCancel={closeModal}
        />
      )}

      {showImportModal && (
        <ImportVaultModal
          busy={props.transferBusy}
          onFile={raw => {
            props.onImportFileContent(raw);
            setShowImportModal(false);
          }}
          onCancel={() => setShowImportModal(false)}
        />
      )}
    </div>
  );
}

function ImportVaultModal(props: {
  busy: boolean;
  onFile: (raw: string) => void;
  onCancel: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [props.onCancel]);

  const readFile = (file: File) => {
    setLocalError('');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        props.onFile(reader.result);
      } else {
        setLocalError('Could not read that file.');
      }
    };
    reader.onerror = () => setLocalError('Could not read that file.');
    reader.readAsText(file);
  };

  const handleChooseFile = async () => {
    setLocalError('');
    const raw = await importProfilesFromFile();
    if (raw) {
      props.onFile(raw);
    }
  };

  return (
    <div
      className="profile-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div
        className="profile-modal import-drop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-modal-title"
      >
        <h2 id="import-modal-title">Import vault</h2>
        <p className="modal-body-text">
          Move a vault from another PC—no need to re-enter Turso URL or token.
        </p>
        <div
          className={`import-drop-zone${dragOver ? ' import-drop-zone-active' : ''}`}
          onDragOver={e => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) {
              readFile(file);
            }
          }}
        >
          <span className="import-drop-icon" aria-hidden="true" style={{ display: 'inline-flex', justifyContent: 'center', alignItems: 'center', color: 'var(--color-primary)' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </span>
          <p>Drop your .json file here</p>
          <button
            type="button"
            className="btn-secondary"
            disabled={props.busy}
            onClick={() => void handleChooseFile()}
          >
            Choose file
          </button>
        </div>
        {localError && (
          <p className="modal-warning-text" role="alert">
            {localError}
          </p>
        )}
        <button type="button" className="btn-text btn-text-center" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ImportPreviewModal(props: {
  bundle: ProfileExportBundle;
  existingProfiles: VaultProfile[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const existingIds = new Set(props.existingProfiles.map(profile => profile.id));
  const existingNames = new Set(props.existingProfiles.map(profile => profile.name));

  return (
    <div
      className="profile-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div
        className="profile-modal import-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-preview-title"
      >
        <h2 id="import-preview-title">Import vault profiles</h2>
        <p className="import-preview-desc">
          These vault connection settings will be added to this device. Your master password is not
          included—you will unlock as usual after import.
        </p>
        <ul className="import-preview-list">
          {props.bundle.profiles.map(profile => {
            const idConflict = existingIds.has(profile.id);
            const nameConflict = existingNames.has(profile.name);
            return (
              <li key={profile.id}>
                <span className="profile-avatar" aria-hidden="true">
                  {profileInitials(profile.name)}
                </span>
                <span className="import-preview-item-body">
                  <strong>{profile.name}</strong>
                  <span>Personal vault</span>
                  {(idConflict || nameConflict) && (
                    <span className="import-preview-hint">
                      Will import as a copy (existing vault with same{' '}
                      {idConflict ? 'id' : 'name'} detected)
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="modal-warning-text">
          Export files may contain Turso tokens. Only import files you trust.
        </p>
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={props.onConfirm}>
            Import {props.bundle.profiles.length} vault
            {props.bundle.profiles.length === 1 ? '' : 's'}
          </button>
          <button type="button" className="btn-text" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfileModal(props: {
  profile: VaultProfile | null;
  onSave: (profile: ProfileFormData) => void;
  onCancel: () => void;
}) {
  const isEditing = Boolean(props.profile);
  const [formData, setFormData] = useState<ProfileFormData>(() => ({
    id: props.profile?.id || '',
    name: props.profile?.name || '',
    dbUrl: props.profile?.dbUrl || '',
    authToken: props.profile?.authToken || '',
    vaultUserId: props.profile?.vaultUserId || DEFAULT_USER_ID,
    createdAt: props.profile?.createdAt,
  }));
  const [advancedOpen, setAdvancedOpen] = useState(isEditing);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onCancel();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [props.onCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!advancedOpen && (!formData.dbUrl || !formData.authToken)) {
      setAdvancedOpen(true);
      return;
    }
    props.onSave(formData);
  };

  return (
    <div
      className="profile-modal-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) {
          props.onCancel();
        }
      }}
    >
      <div
        className="profile-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-modal-title"
      >
        <h2 id="profile-modal-title">{isEditing ? 'Edit vault' : 'Add vault'}</h2>

        <form className="profile-modal-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="profile-name">Profile name</label>
            <input
              id="profile-name"
              type="text"
              value={formData.name}
              onChange={e => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="My vault"
              required
              autoFocus
            />
          </div>

          <div className="collapsible-section">
            <button
              type="button"
              className="collapsible-trigger"
              aria-expanded={advancedOpen}
              aria-controls="profile-connection-details"
              onClick={() => setAdvancedOpen(open => !open)}
            >
              Connection details
              <span className="collapsible-chevron" aria-hidden="true">
                {advancedOpen ? '−' : '+'}
              </span>
            </button>

            <div
              id="profile-connection-details"
              className={`collapsible-content${advancedOpen ? '' : ' collapsible-content-hidden'}`}
              hidden={!advancedOpen}
            >
              <div className="form-group">
                <label htmlFor="profile-db-url">Turso database URL</label>
                <input
                  id="profile-db-url"
                  type="text"
                  value={formData.dbUrl}
                  onChange={e => setFormData(prev => ({ ...prev, dbUrl: e.target.value }))}
                  placeholder="libsql://your-database.turso.io"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="profile-token">Turso auth token</label>
                <input
                  id="profile-token"
                  type="password"
                  value={formData.authToken}
                  onChange={e => setFormData(prev => ({ ...prev, authToken: e.target.value }))}
                  placeholder="Paste Turso auth token"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="profile-user-id">Vault user id</label>
                <input
                  id="profile-user-id"
                  type="text"
                  value={formData.vaultUserId}
                  onChange={e => setFormData(prev => ({ ...prev, vaultUserId: e.target.value }))}
                  placeholder={DEFAULT_USER_ID}
                  required
                />
                <small>
                  Keep the default unless you want multiple separate vaults in one Turso DB.
                </small>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button type="submit" className="btn-secondary">
              Save vault
            </button>
            <button type="button" className="btn-text" onClick={props.onCancel}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface VaultScreenProps {
  entries: PasswordEntry[];
  mode: 'readonly' | 'edit';
  syncState: SyncState;
  lastSyncAt: number | null;
  profile: VaultProfile;
  error: string;
  onAddEntry: (entry: PasswordEntry) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onModeChange: (mode: 'readonly' | 'edit') => void;
  onLogout: () => void;
}

function VaultScreen(props: VaultScreenProps) {
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <div className="vault-container">
      <header className="vault-header">
        <div className="header-content">
          <div>
            <h1>VaultKey</h1>
            <small>{props.profile.name}</small>
            <SyncBadge syncState={props.syncState} lastSyncAt={props.lastSyncAt} />
          </div>
          <div className="header-controls">
            <button
              className={`btn-mode ${props.mode === 'readonly' ? 'active' : ''}`}
              onClick={() => props.onModeChange('readonly')}
            >
              Read-only
            </button>
            <button
              className={`btn-mode ${props.mode === 'edit' ? 'active' : ''}`}
              onClick={() => props.onModeChange('edit')}
            >
              Edit
            </button>
            <button
              className="btn-secondary"
              onClick={props.onRefresh}
              disabled={props.syncState === 'syncing'}
            >
              Sync
            </button>
            <button className="btn-logout" onClick={props.onLogout}>
              Logout
            </button>
          </div>
        </div>
      </header>

      <main className="vault-main">
        {props.error && <div className="error-message">{props.error}</div>}

        <div className="recovery-panel">
          <div>
            <strong>Recovery location</strong>
            <p>Profile: {props.profile.name}</p>
            <p>Turso database: {props.profile.dbUrl}</p>
            <p>User id: {props.profile.vaultUserId}. Tables: users, vault_entries.</p>
          </div>
          <div>
            <strong>{props.entries.length}</strong>
            <span>saved entries</span>
          </div>
        </div>

        {props.mode === 'edit' && (
          <div className="add-entry-section">
            <button
              className="btn-add"
              onClick={() => setShowAddForm(!showAddForm)}
              disabled={props.syncState === 'syncing'}
            >
              + Add password
            </button>
            {showAddForm && (
              <AddPasswordForm
                isSaving={props.syncState === 'syncing'}
                onAdd={async entry => {
                  await props.onAddEntry(entry);
                  setShowAddForm(false);
                }}
                onCancel={() => setShowAddForm(false)}
              />
            )}
          </div>
        )}

        <div className="entries-grid">
          {props.entries.length === 0 ? (
            <div className="empty-state">
              <p>No passwords yet. {props.mode === 'edit' ? 'Add one to get started.' : ''}</p>
            </div>
          ) : (
            props.entries.map(entry => (
              <PasswordEntryCard
                key={entry.id}
                entry={entry}
                mode={props.mode}
                isBusy={props.syncState === 'syncing'}
                onDelete={() => props.onDeleteEntry(entry.id)}
              />
            ))
          )}
        </div>
      </main>
    </div>
  );
}

function SyncBadge(props: { syncState: SyncState; lastSyncAt: number | null }) {
  const label =
    props.syncState === 'syncing'
      ? 'Syncing to Turso...'
      : props.syncState === 'error'
        ? 'Sync needs attention'
        : props.lastSyncAt
          ? `Synced ${new Date(props.lastSyncAt).toLocaleString()}`
          : 'Ready';

  return <small className={`sync-badge sync-${props.syncState}`}>{label}</small>;
}

interface AddPasswordFormProps {
  isSaving: boolean;
  onAdd: (entry: PasswordEntry) => Promise<void>;
  onCancel: () => void;
}

function AddPasswordForm(props: AddPasswordFormProps) {
  const [formData, setFormData] = useState({
    site: '',
    username: '',
    password: '',
    notes: '',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await props.onAdd({
      id: '',
      ...formData,
      createdAt: 0,
      updatedAt: 0,
    });
    setFormData({ site: '', username: '', password: '', notes: '' });
  };

  return (
    <form className="add-form" onSubmit={handleSubmit}>
      <div className="form-grid">
        <input
          type="text"
          placeholder="Site/Service"
          value={formData.site}
          onChange={e => setFormData(prev => ({ ...prev, site: e.target.value }))}
          disabled={props.isSaving}
          required
        />
        <input
          type="text"
          placeholder="Username/Email"
          value={formData.username}
          onChange={e => setFormData(prev => ({ ...prev, username: e.target.value }))}
          disabled={props.isSaving}
          required
        />
        <input
          type="password"
          placeholder="Password"
          value={formData.password}
          onChange={e => setFormData(prev => ({ ...prev, password: e.target.value }))}
          disabled={props.isSaving}
          required
        />
        <input
          type="text"
          placeholder="Notes (optional)"
          value={formData.notes}
          onChange={e => setFormData(prev => ({ ...prev, notes: e.target.value }))}
          disabled={props.isSaving}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="btn-primary" disabled={props.isSaving}>
          {props.isSaving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={props.onCancel}
          disabled={props.isSaving}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

interface PasswordEntryCardProps {
  entry: PasswordEntry;
  mode: 'readonly' | 'edit';
  isBusy: boolean;
  onDelete: () => Promise<void>;
}

function PasswordEntryCard(props: PasswordEntryCardProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className={`entry-card mode-${props.mode}`}>
      <div className="entry-header">
        <h3>{props.entry.site}</h3>
        {props.mode === 'edit' && (
          <button
            className="btn-delete"
            onClick={props.onDelete}
            disabled={props.isBusy}
            title="Delete password"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      <div className="entry-body">
        <div className="entry-field">
          <label>Username</label>
          <code>{props.entry.username}</code>
        </div>
        <div className="entry-field">
          <label>Password</label>
          <div className="password-field">
            <code>{showPassword ? props.entry.password : '*'.repeat(props.entry.password.length)}</code>
            <button
              className="btn-toggle-password"
              onClick={() => setShowPassword(!showPassword)}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {props.entry.notes && (
          <div className="entry-field">
            <label>Notes</label>
            <p>{props.entry.notes}</p>
          </div>
        )}
      </div>
      <div className="entry-footer">
        <small>{new Date(props.entry.updatedAt).toLocaleString()}</small>
      </div>
    </div>
  );
}
