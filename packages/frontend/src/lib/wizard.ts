import { getCurrentDictionary } from '../i18n/current';
import { validateRam, type RamPair } from './ram';
import type { CreateServerInput, Loader, ServerView } from './types';

export const WIZARD_STEPS = ['basics', 'version', 'resources', 'review'] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export interface WizardDraft extends RamPair {
  name: string;
  loader: Loader | null;
  mcVersion: string;
  loaderVersion: string;
  port: string;
  eulaAccepted: boolean;
}

export interface WizardContext {
  totalMemoryMb: number;
  // ports of existing servers, to catch a clash before the start does
  servers: readonly Pick<ServerView, 'name' | 'port'>[];
  // vanilla has no loader version; everything else needs one
  loaderNeedsVersion: boolean;
}

export type WizardErrors = Partial<Record<'name' | 'loader' | 'mcVersion' | 'loaderVersion' | 'port' | 'minRamMb' | 'maxRamMb', string>>;

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
    if (draft.loader === null) errors.loader = messages.loaderMissing;
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
  return WIZARD_STEPS.reduce<WizardErrors>((all, step) => ({ ...all, ...validateStep(step, draft, context) }), {});
}

export function firstInvalidStep(draft: WizardDraft, context: WizardContext): WizardStep | null {
  return WIZARD_STEPS.find((step) => Object.keys(validateStep(step, draft, context)).length > 0) ?? null;
}

export function buildRequest(draft: WizardDraft): CreateServerInput {
  const port = parsePort(draft.port);
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
