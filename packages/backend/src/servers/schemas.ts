import { z } from 'zod';
import { LOADERS } from '../db/enums.js';

export const MIN_RAM_MB = 256;

const ramField = z.number().int().min(MIN_RAM_MB).max(4_194_304);

export const CreateServerSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    loader: z.enum(LOADERS),
    mcVersion: z.string().trim().min(1).max(64),
    loaderVersion: z.string().trim().min(1).max(64).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    minRamMb: ramField.optional(),
    maxRamMb: ramField.optional(),
    eulaAccepted: z.boolean().optional(),
  })
  .strict();

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
export type UpdateServerInput = z.infer<typeof UpdateServerSchema>;
