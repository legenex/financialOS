import { registerStoreReset } from './stores';

/**
 * Server-sent event streams (coach answers, job progress). Every open stream is tracked so the session layer
 * can close them all at lock. A `session-expired` event closes the stream and notifies the caller.
 */
export interface StreamHandlers {
  onEvent: (event: string, data: unknown) => void;
  onSessionExpired: () => void;
  onError: (message: string) => void;
  onClose?: () => void;
}

const open = new Set<EventSource>();

registerStoreReset(() => closeAllStreams());

export function closeAllStreams(): void {
  for (const source of open) source.close();
  open.clear();
}

function parse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

function messageOf(data: unknown): string {
  if (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string') {
    return (data as { message: string }).message;
  }
  return typeof data === 'string' && data ? data : 'The answer could not be completed.';
}

export function openStream(url: string, events: string[], handlers: StreamHandlers): () => void {
  if (typeof EventSource === 'undefined') {
    handlers.onError('This browser cannot receive streamed answers.');
    return () => undefined;
  }
  const source = new EventSource(url);
  open.add(source);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
    open.delete(source);
    handlers.onClose?.();
  };
  for (const name of events) {
    source.addEventListener(name, (event) => {
      handlers.onEvent(name, parse((event as MessageEvent<string>).data));
    });
  }
  source.addEventListener('message', (event) => handlers.onEvent('message', parse(event.data)));
  source.addEventListener('session-expired', () => {
    close();
    handlers.onSessionExpired();
  });
  source.addEventListener('error', (event) => {
    // A server-sent `event: error` carries data; a transport failure does not. Either way, stop: EventSource
    // would otherwise reconnect by itself, and a reconnect must never outlive the session.
    const data = (event as MessageEvent<string>).data;
    close();
    handlers.onError(data ? messageOf(parse(data)) : 'The connection to FinancialOS was interrupted.');
  });
  return close;
}
