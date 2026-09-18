import { describe, expect, it } from 'vitest';
// Must be imported before zod is used, exactly as the bundle orders it.
import { ZOD_JITLESS } from './zod-jitless';
import * as z from 'zod';

describe('zod jitless mode', () => {
  it('is on, so no schema is ever compiled with new Function', () => {
    expect(ZOD_JITLESS).toBe(true);
    expect(z.config().jitless).toBe(true);
  });

  it('still validates correctly with the interpreter', () => {
    const schema = z.object({ a: z.string(), b: z.number().int() });
    expect(schema.safeParse({ a: 'x', b: 1 }).success).toBe(true);
    expect(schema.safeParse({ a: 1, b: 'x' }).success).toBe(false);
  });
});
