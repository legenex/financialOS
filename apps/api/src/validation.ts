import type { z } from 'zod';
import { errors } from './errors';

/**
 * Validates input with a contracts schema. Error details name the offending fields and rules
 * but never echo submitted values.
 */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code }));
  throw errors.badRequest('The request is not valid.', { issues });
}

export const parseQuery = parseBody;
