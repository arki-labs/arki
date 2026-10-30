import { describe, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { eventMapDocumentSchema, eventMapGraphSchema, eventMapMetaSchema } from './event-map-schema.js';
import type { EventMapDocument, EventMapGraph, EventMapMeta } from './projection.js';

describe('the event-map graph', () => {
  it('reads back exactly the type the journal writes: the schemas are locked to the types', () => {
    expectTypeOf<z.output<typeof eventMapGraphSchema>>().toEqualTypeOf<EventMapGraph>();
    expectTypeOf<EventMapGraph>().toEqualTypeOf<z.output<typeof eventMapGraphSchema>>();
    // `EventMapMeta` and `EventMapDocument` extend the graph with an intersection, which `toEqualTypeOf` reads
    // as a different shape from the schema's flat object; assignable both ways is the same check for them.
    expectTypeOf<z.output<typeof eventMapMetaSchema>>().toExtend<EventMapMeta>();
    expectTypeOf<EventMapMeta>().toExtend<z.output<typeof eventMapMetaSchema>>();
    expectTypeOf<z.output<typeof eventMapDocumentSchema>>().toExtend<EventMapDocument>();
    expectTypeOf<EventMapDocument>().toExtend<z.output<typeof eventMapDocumentSchema>>();
  });
});
