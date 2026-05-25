export interface VaultProfile {
  id: string;
  name: string;
  dbUrl: string;
  authToken: string;
  vaultUserId: string;
  createdAt: number;
  updatedAt: number;
}

const PROFILES_STORAGE_KEY = 'vaultkey:profiles:v1';
const SELECTED_PROFILE_STORAGE_KEY = 'vaultkey:selected-profile:v1';
const STORE_VERSION = 1;

export interface ProfileStore {
  version: number;
  profiles: VaultProfile[];
  selectedProfileId: string;
}

function isValidProfile(profile: VaultProfile): boolean {
  return Boolean(
    profile &&
      profile.id &&
      profile.name &&
      profile.dbUrl &&
      profile.authToken &&
      profile.vaultUserId
  );
}

function resolveSelectedId(profiles: VaultProfile[], selectedId: string): string {
  if (selectedId && profiles.some(profile => profile.id === selectedId)) {
    return selectedId;
  }
  return profiles[0]?.id || '';
}

function loadFromLocalStorage(): ProfileStore {
  let profiles: VaultProfile[] = [];

  try {
    const raw = localStorage.getItem(PROFILES_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as VaultProfile[];
      profiles = Array.isArray(parsed) ? parsed.filter(isValidProfile) : [];
    }
  } catch {
    profiles = [];
  }

  let selectedProfileId = '';
  try {
    const storedId = localStorage.getItem(SELECTED_PROFILE_STORAGE_KEY);
    if (storedId) {
      selectedProfileId = storedId;
    }
  } catch {
    selectedProfileId = '';
  }

  return {
    version: STORE_VERSION,
    profiles,
    selectedProfileId: resolveSelectedId(profiles, selectedProfileId),
  };
}

function saveToLocalStorage(store: ProfileStore): void {
  localStorage.setItem(PROFILES_STORAGE_KEY, JSON.stringify(store.profiles));
  if (store.selectedProfileId) {
    localStorage.setItem(SELECTED_PROFILE_STORAGE_KEY, store.selectedProfileId);
  } else {
    localStorage.removeItem(SELECTED_PROFILE_STORAGE_KEY);
  }
}

function normalizeStore(data: unknown): ProfileStore | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const record = data as Partial<ProfileStore>;
  const profiles = Array.isArray(record.profiles)
    ? record.profiles.filter(isValidProfile)
    : [];

  return {
    version: STORE_VERSION,
    profiles,
    selectedProfileId: resolveSelectedId(profiles, record.selectedProfileId || ''),
  };
}

export async function loadProfileStore(): Promise<ProfileStore> {
  const fromDisk = window.vaultKey?.profiles
    ? normalizeStore(await window.vaultKey.profiles.load())
    : null;

  if (fromDisk && fromDisk.profiles.length > 0) {
    return fromDisk;
  }

  const fromLocal = loadFromLocalStorage();

  if (window.vaultKey?.profiles && fromLocal.profiles.length > 0) {
    await window.vaultKey.profiles.save(fromLocal);
  }

  if (fromDisk && fromDisk.profiles.length === 0 && fromLocal.profiles.length === 0) {
    return fromDisk;
  }

  return fromLocal;
}

export async function saveProfileStore(store: ProfileStore): Promise<void> {
  const normalized: ProfileStore = {
    version: STORE_VERSION,
    profiles: store.profiles.filter(isValidProfile),
    selectedProfileId: resolveSelectedId(store.profiles, store.selectedProfileId),
  };

  if (window.vaultKey?.profiles) {
    await window.vaultKey.profiles.save(normalized);
  }

  saveToLocalStorage(normalized);
}
