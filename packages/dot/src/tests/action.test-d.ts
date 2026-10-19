import { expectTypeOf } from 'vitest';
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import { action } from '../action.js';
import { bindAction } from '../execute.js';

const Missing = defineFailure('catalog.missing', { status: 404, data: z.object({ id: z.string() }) });
const Other = defineFailure('catalog.other', { status: 409 });
const descriptor = action({
  id: 'catalog.lookup',
  input: z.object({ id: z.string() }),
  output: z.object({ title: z.string() }),
  failures: [Missing],
  policy: { exposure: ['http'], principal: 'optional', approval: 'none', retry: 'never' },
});
const _bound = bindAction(descriptor, input => {
  expectTypeOf(input).toEqualTypeOf<{ id: string }>();
  return input.id ? { title: input.id } : Missing({ id: input.id });
});
// @ts-expect-error A business failure must be listed by canonical definition.
bindAction(descriptor, () => Other());
// @ts-expect-error Successful output must match its canonical output schema.
bindAction(descriptor, () => ({ title: 42 }));
// @ts-expect-error Input is inferred from the schema, not from the implementation.
bindAction(descriptor, (input: { id: number }) => ({ title: String(input.id) }));
// @ts-expect-error Erasing an implementation's outcome as void cannot hide failures.
bindAction(descriptor, (): void => {
  return;
});
// @ts-expect-error Unknown output cannot hide business failures.
bindAction(descriptor, (): unknown => Other());
// @ts-expect-error Browser contracts never carry a bound implementation.
descriptor.run({ id: 'book' });
bindAction(descriptor, async (input, scope) => {
  const opened = await scope.acquire(
    () => 'session',
    // @ts-expect-error Owned cleanup failures must also be declared.
    () => Other(),
  );
  expectTypeOf(opened).not.toBeUnknown();
  expectTypeOf(input.id).toBeString();
  return Missing({ id: input.id });
});

expectTypeOf<Awaited<ReturnType<typeof _bound.run>>>().not.toBeAny();
expectTypeOf<Awaited<ReturnType<typeof _bound.run>>>().not.toBeUnknown();

expectTypeOf<Exclude<Awaited<ReturnType<typeof _bound.run>>, Failure>>().toEqualTypeOf<{ title: string }>();
// @ts-expect-error A generic Failure erases the canonical failure code.
bindAction(descriptor, (): Failure => Other());
const transformed = action({
  id: 'format',
  input: z.string().transform(value => value.length),
  output: z.number().transform(String),
  failures: [],
  policy: descriptor.policy,
});
const formatted = bindAction(transformed, input => {
  expectTypeOf(input).toBeNumber();
  return input;
});
expectTypeOf<Exclude<Awaited<ReturnType<typeof formatted.run>>, Failure>>().toEqualTypeOf<string>();
expectTypeOf<Exclude<Awaited<ReturnType<typeof formatted.handle>>, Failure>>().toEqualTypeOf<number>();
// @ts-expect-error Native handlers accept the already parsed input, never the wire input.
void formatted.handle('book', { binding: 'http', principal: 'anonymous', approval: 'absent' });
