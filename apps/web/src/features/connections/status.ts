import type { ConnectionStatus } from '@financialos/contracts';
import type { Tone } from '@financialos/ui';

export function connectionStatusTone(status: ConnectionStatus): Tone {
  switch (status) {
    case 'connected':
      return 'positive';
    case 'error':
    case 'rate_limited':
      return 'negative';
    case 'needs_authorization':
    case 'stale':
    case 'partial_coverage':
      return 'caution';
    case 'paused':
    case 'revoked':
      return 'neutral';
    default:
      return 'info';
  }
}
