import { z } from 'zod';
import { LOADERS } from '../db/enums.js';
import { GAME_IDS } from '../games/types.js';

export const MIN_RAM_MB = 256;

const ramField = z.number().int().min(MIN_RAM_MB).max(4_194_304);

const serverFields = {
  name: z.string().trim().min(1).max(60),
  // defaults to Minecraft, the only game of the first versions of the API
  game: z.enum(GAME_IDS).optional(),
  loader: z.enum(LOADERS),
  mcVersion: z.string().trim().min(1).max(64),
  loaderVersion: z.string().trim().min(1).max(64).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  minRamMb: ramField.optional(),
  maxRamMb: ramField.optional(),
  eulaAccepted: z.boolean().optional(),
};

// a server with a loader and versions chosen by hand (also the new server of a world import)
export const ManualServerSchema = z.object(serverFields).strict();

export const CreateServerSchema = z
  .object({
    ...serverFields,
    // loader and versions come from the pack when `modpack` is given
    loader: serverFields.loader.optional(),
    mcVersion: serverFields.mcVersion.optional(),
    // a Modrinth modpack: its loader, versions and files are installed with the server
    modpack: z
      .object({
        projectId: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/),
        versionId: z.string().trim().regex(/^[A-Za-z0-9]{1,64}$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => value.modpack !== undefined || (value.loader !== undefined && value.mcVersion !== undefined), {
    message: 'A loader and a Minecraft version, or a modpack, are required.',
  });

export const UpdateServerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    minRamMb: ramField,
    maxRamMb: ramField,
    javaPath: z.string().trim().min(1).max(1024).nullable(),
    useAikarFlags: z.boolean(),
    extraJvmArgs: z.string().max(2000),
    eulaAccepted: z.boolean(),
    autoStart: z.boolean(),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'No change was provided.' });

export type CreateServerInput = z.infer<typeof CreateServerSchema>;
export type ManualServerInput = z.infer<typeof ManualServerSchema>;
export type UpdateServerInput = z.infer<typeof UpdateServerSchema>;
