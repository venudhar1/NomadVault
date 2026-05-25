import { generateRandomId } from './crypto';
import type { VaultProfile } from './profile-storage';

export const PROFILE_EXPORT_KIND = 'vaultkey-profile-export';
export const PROFILE_EXPORT_VERSION = 1;

export interface ProfileExportBundle {
  kind: typeof PROFILE_EXPORT_KIND;
  version: number;
  exportedAt: number;
  profiles: VaultProfile[];
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

export function buildExportBundle(profiles: VaultProfile[]): ProfileExportBundle {
  const now = Date.now();
  return {
    kind: PROFILE_EXPORT_KIND,
    version: PROFILE_EXPORT_VERSION,
    exportedAt: now,
    profiles: profiles.filter(isValidProfile).map(profile => ({
      ...profile,
      updatedAt: now,
    })),
  };
}

export function serializeExportBundle(bundle: ProfileExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function parseExportBundle(raw: string): ProfileExportBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid file: not valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid file: unexpected format.');
  }

  const record = parsed as Partial<ProfileExportBundle> & { profiles?: unknown };

  if (record.kind !== PROFILE_EXPORT_KIND) {
    throw new Error('Invalid file: not a VaultKey profile export.');
  }

  if (!Array.isArray(record.profiles) || record.profiles.length === 0) {
    throw new Error('Invalid file: no vault profiles found.');
  }

  const profiles = record.profiles.filter(isValidProfile) as VaultProfile[];
  if (profiles.length === 0) {
    throw new Error('Invalid file: vault profiles are incomplete or corrupted.');
  }

  return {
    kind: PROFILE_EXPORT_KIND,
    version: record.version ?? PROFILE_EXPORT_VERSION,
    exportedAt: record.exportedAt ?? Date.now(),
    profiles,
  };
}

function uniqueProfileName(existingNames: Set<string>, name: string): string {
  if (!existingNames.has(name)) {
    return name;
  }

  let candidate = `${name} (imported)`;
  let counter = 2;
  while (existingNames.has(candidate)) {
    candidate = `${name} (imported ${counter})`;
    counter += 1;
  }
  return candidate;
}

export function mergeImportedProfiles(
  existing: VaultProfile[],
  incoming: VaultProfile[]
): { profiles: VaultProfile[]; firstImportedId: string } {
  const now = Date.now();
  const byId = new Map(existing.map(profile => [profile.id, profile]));
  const names = new Set(existing.map(profile => profile.name));
  let firstImportedId = '';

  for (const profile of incoming.filter(isValidProfile)) {
    let id = profile.id;
    let name = profile.name;

    if (byId.has(id)) {
      id = generateRandomId();
      name = uniqueProfileName(names, profile.name);
    } else if (names.has(name)) {
      name = uniqueProfileName(names, profile.name);
    }

    const merged: VaultProfile = {
      ...profile,
      id,
      name,
      createdAt: profile.createdAt || now,
      updatedAt: now,
    };

    byId.set(id, merged);
    names.add(name);

    if (!firstImportedId) {
      firstImportedId = id;
    }
  }

  const profiles = Array.from(byId.values());
  return {
    profiles,
    firstImportedId: firstImportedId || profiles[0]?.id || '',
  };
}

export function safeExportFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'vault';
}

function downloadJsonInBrowser(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function pickJsonFileInBrowser(): Promise<string | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}

export async function exportProfilesToFile(
  profiles: VaultProfile[],
  fileName: string
): Promise<{ ok: boolean; cancelled: boolean }> {
  const bundle = buildExportBundle(profiles);
  const content = serializeExportBundle(bundle);

  if (window.vaultKey?.transfer?.exportToFile) {
    return window.vaultKey.transfer.exportToFile({ content, fileName });
  }

  downloadJsonInBrowser(content, fileName);
  return { ok: true, cancelled: false };
}

export async function importProfilesFromFile(): Promise<string | null> {
  if (window.vaultKey?.transfer?.importFromFile) {
    const result = await window.vaultKey.transfer.importFromFile();
    if (result.cancelled || !result.ok) {
      return null;
    }
    return result.content ?? null;
  }

  return pickJsonFileInBrowser();
}
