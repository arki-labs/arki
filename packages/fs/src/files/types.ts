/** The file identity and upload request, with no Zod, so the server entries' declarations stay free of it. */
import type { IdOf } from '@arki/contracts';
import { defineId } from '@arki/contracts';

/** The id of a stored file: `fil_` plus 24 random characters. */
export const fileId = defineId('fil_');
export type FileId = IdOf<typeof fileId>;

/** What a client asks for before it uploads. An exact type test locks `uploadRequest` to this type. */
export type UploadRequest = { mime: string; size: number };
