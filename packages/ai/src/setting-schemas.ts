/**
 * Schemas for settings that are read in more than one place: the whole `@arki/ai` env, and a service
 * that reads only its own variables so an unrelated bad variable cannot stop it.
 *
 * @module setting-schemas
 */
import { z } from '@arki/contracts';

/** `AI_DETERMINISTIC_SEED`: a whole number. Tests only: every call then runs at temperature 0 with this seed. */
export const deterministicSeedSchema = z.coerce.number().int().optional();
