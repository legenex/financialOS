import { clsx, type ClassValue } from 'clsx';

/** Joins class names. Thin wrapper so components share one import. */
export function cx(...values: ClassValue[]): string {
  return clsx(values);
}
