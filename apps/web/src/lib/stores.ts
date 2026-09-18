/**
 * Registry of in-memory stores that hold anything private. Each registers a reset function; the session layer
 * calls resetAllStores() on lock and logout. Nothing here ever touches web storage.
 */
type Reset = () => void;
const resets = new Set<Reset>();

export function registerStoreReset(reset: Reset): () => void {
  resets.add(reset);
  return () => {
    resets.delete(reset);
  };
}

export function resetAllStores(): void {
  for (const reset of [...resets]) {
    try {
      reset();
    } catch (error) {
      console.error('store reset failed', error);
    }
  }
}
