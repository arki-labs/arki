/**
 * Compile-time only (checked by `tsc`): rule and language types come from
 * their `const` objects, so adding a rule never needs a second type.
 */
import { expectTypeOf } from 'vitest';

import type { DocxRule, Example } from './doc-examples';
import type { DocRule } from './docs';

expectTypeOf<DocRule>().toEqualTypeOf<
  | 'DOC_E001'
  | 'DOC_E002'
  | 'DOC_E003'
  | 'DOC_E004'
  | 'DOC_E005'
  | 'DOC_E006'
  | 'DOC_E007'
  | 'DOC_E008'
  | 'DOC_E009'
  | 'DOC_E010'
  | 'DOC_E011'
  | 'DOC_E012'
  | 'DOC_E013'
  | 'DOC_W001'
  | 'DOC_W002'
>();
expectTypeOf<DocxRule>().toEqualTypeOf<
  'DOCX_E001' | 'DOCX_E002' | 'DOCX_E003' | 'DOCX_E004' | 'DOCX_E005' | 'DOCX_E006' | 'DOCX_E007' | 'DOCX_E008'
>();
expectTypeOf<Example['lang']>().toEqualTypeOf<'ts' | 'tsx' | 'js' | 'jsx'>();
