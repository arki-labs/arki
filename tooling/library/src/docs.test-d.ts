/**
 * Compile-time only (checked by `tsc`): rule and language types come from
 * their `const` objects, so adding a rule never needs a second type. The
 * checks below are derived from those objects, so a rule added in parallel
 * work cannot break this file; only a rule that is renamed or removed can.
 */
import { expectTypeOf } from 'vitest';

import type { DOCX_RULES, DocxRule, Example } from './doc-examples';
import type { DOC_RULES, DocRule } from './docs';

expectTypeOf<DocRule>().toEqualTypeOf<keyof typeof DOC_RULES>();
expectTypeOf<DocRule>().toExtend<`DOC_${'E' | 'W'}${string}`>();
expectTypeOf<DocxRule>().toEqualTypeOf<keyof typeof DOCX_RULES>();
expectTypeOf<DocxRule>().toExtend<`DOCX_E${string}`>();

// Codes are public (baselines, docs and agents cite them): these must stay.
expectTypeOf<
  'DOC_E001' | 'DOC_E007' | 'DOC_E014' | 'DOC_E015' | 'DOC_E016' | 'DOC_E017' | 'DOC_E018' | 'DOC_E019' | 'DOC_W001'
>().toExtend<DocRule>();
expectTypeOf<'DOCX_E001' | 'DOCX_E008' | 'DOCX_E009' | 'DOCX_E010' | 'DOCX_E011' | 'DOCX_E012'>().toExtend<DocxRule>();

expectTypeOf<Example['lang']>().toEqualTypeOf<'ts' | 'tsx' | 'js' | 'jsx'>();
