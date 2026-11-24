import { getCurrentDictionary } from '../i18n/current';
import { validateRam, type RamPair } from './ram';
import type { CreateServerInput, Loader, ServerView } from './types';

export const WIZARD_STEPS = ['basics', 'version', 'resources', 'review'] as const;
// a server from a Modrinth modpack picks the pack instead of loader and versions
export const MODPACK_STEPS = ['basics', 'modpack', 'resources', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number] | (typeof MODPACK_STEPS)[number];

export type WizardSource = 'manual' | 'modpack';

// the pack chosen in the assistant, with what the review shows about the version
export interface SelectedPack {
  projectId: string;
  title: string;
  iconUrl: string | null;
}

export interface SelectedPackVersion {
  id: string;
  versionNumber: string;
  loaders: string[];
  gameVersions: string[];
}

export interface WizardDraft extends RamPair {
  name: string;
  loader: Loader | null;
  mcVersion: string;
  loaderVersion: string;
  port: string;
  eulaAccepted: boolean;
  // missing means 'manual'
  source?: WizardSource;
  pack?: SelectedPack | null;
  packVersion?: SelectedPackVersion | null;
}

export const stepsFor = (draft: Pick<WizardDraft, 'source'>): readonly WizardStep[] => (draft.source === 'modpack' ? MODPACK_STEPS : WIZARD_STEPS);

export interface WizardContext {
  totalMemoryMb: number;
  // ports of existing servers, to catch a clash before the start does
  servers: readonly Pick<ServerView, 'name' | 'port'>[];
  // vanilla has no loader version; everything else needs one
  loaderNeedsVersion: boolean;
}

export type WizardErrors = Partial<Record<'name' | 'loader' | 'mcVersion' | 'loaderVersion' | 'pack' | 'packVersion' | 'port' | 'minRamMb' | 'maxRamMb', string>>;

export const NAME_MAX = 60;

export function nextFreePort(servers: readonly Pick<ServerView, 'port'>[], start = 25565): number {
  const used = new Set(servers.map((server) => server.port));
  let port = start;
  while (used.has(port) && port < 65535) port++;
  return port;
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= 1 && value <= 65535 ? value : null;
}

export function validateStep(step: WizardStep, draft: WizardDraft, context: WizardContext): WizardErrors {
  const messages = getCurrentDictionary().wizard.validation;
  const errors: WizardErrors = {};
  if (step === 'basics') {
    const name = draft.name.trim();
    if (name === '') errors.name = messages.nameMissing;
    else if (name.length > NAME_MAX) errors.name = messages.nameTooLong(NAME_MAX);
    if (draft.source !== 'modpack' && draft.loader === null) errors.loader = messages.loaderMissing;
  }
  if (step === 'modpack') {
    if (draft.pack === null || draft.pack === undefined) errors.pack = messages.packMissing;
    else if (draft.packVersion === null || draft.packVersion === undefined) errors.packVersion = messages.packVersionMissing;
  }
  if (step === 'version') {
    if (draft.mcVersion.trim() === '') errors.mcVersion = messages.versionMissing;
    if (context.loaderNeedsVersion && draft.loaderVersion.trim() === '') errors.loaderVersion = messages.loaderVersionMissing;
  }
  if (step === 'resources') {
    const port = parsePort(draft.port);
    if (port === null) errors.port = messages.portInvalid;
    else {
      const clash = context.servers.find((server) => server.port === port);
      if (clash !== undefined) errors.port = messages.portTaken(port, clash.name);
    }
    Object.assign(errors, validateRam(draft, context.totalMemoryMb));
  }
  return errors;
}

export function validateAll(draft: WizardDraft, context: WizardContext): WizardErrors {
  return stepsFor(draft).reduce<WizardErrors>((all, step) => ({ ...all, ...validateStep(step, draft, context) }), {});
}

export function firstInvalidStep(draft: WizardDraft, context: WizardContext): WizardStep | null {
  return stepsFor(draft).find((step) => Object.keys(validateStep(step, draft, context)).length > 0) ?? null;
}

export function buildRequest(draft: WizardDraft): CreateServerInput {
  const port = parsePort(draft.port);
  if (draft.source === 'modpack') {
    if (draft.pack === null || draft.pack === undefined || draft.packVersion === null || draft.packVersion === undefined || port === null) {
      throw new Error(getCurrentDictionary().wizard.validation.draftIncomplete);
    }
    return {
      name: draft.name.trim(),
      modpack: { projectId: draft.pack.projectId, versionId: draft.packVersion.id },
      port,
      minRamMb: draft.minRamMb,
      maxRamMb: draft.maxRamMb,
      eulaAccepted: draft.eulaAccepted,
    };
  }
  if (draft.loader === null || port === null) throw new Error(getCurrentDictionary().wizard.validation.draftIncomplete);
  return {
    name: draft.name.trim(),
    loader: draft.loader,
    mcVersion: draft.mcVersion.trim(),
    ...(draft.loaderVersion.trim() === '' ? {} : { loaderVersion: draft.loaderVersion.trim() }),
    port,
    minRamMb: draft.minRamMb,
    maxRamMb: draft.maxRamMb,
    eulaAccepted: draft.eulaAccepted,
  };
}

// Modpacks need more memory than a plain server: 6 GB when the machine has room for it, otherwise the usual default
export function modpackRam(totalMemoryMb: number): RamPair {
  const usable = Math.floor((totalMemoryMb * 0.75) / 128) * 128;
  const maxRamMb = Math.max(2048, Math.min(6144, usable));
  if (maxRamMb > totalMemoryMb) return { minRamMb: Math.min(1024, totalMemoryMb), maxRamMb: totalMemoryMb };
  return { minRamMb: Math.min(2048, maxRamMb), maxRamMb };
}
