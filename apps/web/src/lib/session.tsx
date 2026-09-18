import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_WARNING_SECONDS, SessionInfo } from '@financialos/contracts';
import { abortAllRequests, api, ApiError, setCsrfToken, setPrivateRequestsEnabled, setSessionEndedHandler } from './api';
import { closeAllStreams } from './sse';
import { resetAllStores } from './stores';

/**
 * Session UX (the server is the authority; these timers are presentation):
 *
 * - Loads GET /api/auth/session in the background and aligns expiry with the server clock (serverNow).
 * - Shows a discreet warning 60 s before the deadline. It is NOT a keep-alive: signing in again creates a new
 *   session.
 * - At expiry (client timer or any 401) it clears the query cache, resets in-memory stores, unmounts private
 *   routes, navigates to /locked, and broadcasts `locked` to other tabs.
 * - Re-checks on visibilitychange, pageshow (incl. back/forward cache), focus and online, with a neutral cover
 *   hiding private content until the check completes after a resume.
 */

export type SessionStatus = 'checking' | 'authenticated' | 'anonymous' | 'locked' | 'offline' | 'error';
export type LockReason = 'expired' | 'signed_out' | 'other_tab' | 'signed_out_elsewhere';

export interface SessionTiming {
  /** Client-clock milliseconds. */
  absolute: number;
  idle: number;
  deadline: number;
  deadlineKind: 'absolute' | 'idle';
  /** serverNow − client request start, in ms (conservative: expiry is computed slightly early). */
  offset: number;
  checkedAt: number;
}

export interface SessionContextValue {
  status: SessionStatus;
  session: SessionInfo | null;
  timing: SessionTiming | null;
  lockReason: LockReason | null;
  /** True while a resumed page waits for its session check. */
  covered: boolean;
  warning: boolean;
  /** Increments whenever private state must be discarded (lock) or rebuilt (new login). */
  epoch: number;
  /** Set when another tab signed in while this one was locked. */
  signedInElsewhere: boolean;
  reauthOpen: boolean;
  setReauthOpen: (open: boolean) => void;
  refresh: () => Promise<SessionStatus>;
  /** Adopt a session returned by a login. `requestStartedAt` is Date.now() captured before the request. */
  adopt: (session: SessionInfo, requestStartedAt: number) => void;
  lock: (reason: LockReason) => void;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export type SessionMessage = { type: 'locked' | 'logout' | 'login' };

export interface ChannelLike {
  postMessage: (message: SessionMessage) => void;
  close: () => void;
  onmessage: ((event: MessageEvent<SessionMessage>) => void) | null;
}

export const SESSION_CHANNEL = 'fos-session';
const PUBLIC_PATHS = ['/login', '/locked', '/setup'];
const WARNING_MS = SESSION_WARNING_SECONDS * 1000;

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function defaultChannel(): ChannelLike | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  return new BroadcastChannel(SESSION_CHANNEL) as unknown as ChannelLike;
}

export function computeTiming(info: SessionInfo, requestStartedAt: number, checkedAt = Date.now()): SessionTiming {
  const offset = Date.parse(info.serverNow) - requestStartedAt;
  const absolute = Date.parse(info.absoluteExpiresAt) - offset;
  const idle = Date.parse(info.idleExpiresAt) - offset;
  const deadlineKind = idle < absolute ? 'idle' : 'absolute';
  return { absolute, idle, deadline: Math.min(absolute, idle), deadlineKind, offset, checkedAt };
}

export interface SessionProviderProps {
  children: ReactNode;
  createChannel?: () => ChannelLike | null;
  /** Hidden longer than this → cover content on return until the session is re-checked. */
  coverAfterMs?: number;
}

export function SessionProvider({ children, createChannel = defaultChannel, coverAfterMs = 15_000 }: SessionProviderProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  const [status, setStatus] = useState<SessionStatus>('checking');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [timing, setTiming] = useState<SessionTiming | null>(null);
  const [lockReason, setLockReason] = useState<LockReason | null>(null);
  const [covered, setCovered] = useState(false);
  const [warning, setWarning] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [reauthOpen, setReauthOpen] = useState(false);
  const [signedInElsewhere, setSignedInElsewhere] = useState(false);

  const statusRef = useRef(status);
  const timingRef = useRef(timing);
  const pathRef = useRef(location.pathname);
  const lastPrivatePath = useRef<string | null>(null);
  useLayoutEffect(() => {
    statusRef.current = status;
    timingRef.current = timing;
  }, [status, timing]);
  useLayoutEffect(() => {
    pathRef.current = location.pathname;
    if (!isPublicPath(location.pathname) && location.pathname !== '/') {
      lastPrivatePath.current = `${location.pathname}${location.search}`;
    }
  }, [location.pathname, location.search]);
  const lockedRef = useRef(false);
  const channelRef = useRef<ChannelLike | null>(null);
  const refreshing = useRef<Promise<SessionStatus> | null>(null);
  const hiddenAt = useRef<number | null>(null);
  const lastCheck = useRef(0);

  const setCoverClass = (on: boolean) => {
    if (typeof document === 'undefined') return;
    document.documentElement.classList.toggle('fos-covered', on);
  };

  const cover = useCallback((on: boolean) => {
    setCoverClass(on);
    setCovered(on);
  }, []);

  const lockInternal = useCallback(
    (reason: LockReason, broadcast: boolean) => {
      const wasPrivate = statusRef.current === 'authenticated' || statusRef.current === 'checking';
      if (lockedRef.current && !wasPrivate) return;
      lockedRef.current = true;
      setPrivateRequestsEnabled(false);
      setCsrfToken(null);
      abortAllRequests();
      closeAllStreams();
      const apply = () => {
        setStatus(reason === 'signed_out' ? 'anonymous' : 'locked');
        statusRef.current = reason === 'signed_out' ? 'anonymous' : 'locked';
        setSession(null);
        setTiming(null);
        setLockReason(reason);
        setWarning(false);
        setReauthOpen(false);
        setSignedInElsewhere(false);
        setEpoch((e) => e + 1);
      };
      // Unmount private routes synchronously before dropping their data.
      try {
        flushSync(apply);
      } catch {
        apply();
      }
      void queryClient.cancelQueries();
      queryClient.clear();
      resetAllStores();
      cover(false);
      if (broadcast) channelRef.current?.postMessage({ type: reason === 'signed_out' ? 'logout' : 'locked' });
      if (!isPublicPath(pathRef.current)) {
        navigate(reason === 'signed_out' ? '/login' : '/locked', { replace: true, state: { reason, from: lastPrivatePath.current } });
      }
    },
    [cover, navigate, queryClient],
  );

  const lock = useCallback((reason: LockReason) => lockInternal(reason, true), [lockInternal]);

  const adopt = useCallback((info: SessionInfo, requestStartedAt: number) => {
    const next = computeTiming(info, requestStartedAt);
    if (next.absolute <= Date.now()) {
      lockInternal('expired', false);
      return;
    }
    const wasPrivate = statusRef.current === 'authenticated';
    lockedRef.current = false;
    timingRef.current = next;
    setCsrfToken(info.csrfToken);
    setPrivateRequestsEnabled(true);
    setSession(info);
    setTiming(next);
    setLockReason(null);
    setSignedInElsewhere(false);
    setWarning(false);
    setStatus('authenticated');
    statusRef.current = 'authenticated';
    if (!wasPrivate) setEpoch((e) => e + 1);
  }, [lockInternal]);

  const refresh = useCallback((): Promise<SessionStatus> => {
    if (refreshing.current) return refreshing.current;
    const startedAt = Date.now();
    lastCheck.current = startedAt;
    const run = api('/api/auth/session', { schema: SessionInfo, background: true, public: true })
      .then((info): SessionStatus => {
        // A tab that was locked stays locked until the owner acts (Continue on the lock screen).
        if (statusRef.current === 'locked' && lockedRef.current) {
          setSignedInElsewhere(true);
          return 'locked';
        }
        adopt(info, startedAt);
        return 'authenticated';
      })
      .catch((error: unknown): SessionStatus => {
        if (error instanceof ApiError && error.status === 401) {
          if (statusRef.current === 'authenticated') {
            lockInternal('expired', true);
            return 'locked';
          }
          if (statusRef.current !== 'locked') {
            setStatus('anonymous');
            statusRef.current = 'anonymous';
          }
          return statusRef.current;
        }
        const t = timingRef.current;
        if (statusRef.current === 'authenticated') {
          // Cannot verify (offline or server error). Never keep content past the known deadline.
          if (t && Date.now() >= t.absolute) {
            lockInternal('expired', true);
            return 'locked';
          }
          return 'authenticated';
        }
        if (statusRef.current === 'checking') {
          const next = error instanceof ApiError && error.status === 0 ? 'offline' : 'error';
          setStatus(next);
          statusRef.current = next;
          return next;
        }
        return statusRef.current;
      })
      .finally(() => {
        refreshing.current = null;
      });
    refreshing.current = run;
    return run;
  }, [adopt, lockInternal]);

  /** Continue from the lock screen after signing in elsewhere. */
  const unlockFromElsewhere = useCallback(async () => {
    lockedRef.current = false;
    statusRef.current = 'checking';
    setStatus('checking');
    return refresh();
  }, [refresh]);

  // Wire the API client's 401 handler.
  useEffect(() => {
    setSessionEndedHandler(() => {
      if (statusRef.current === 'authenticated') lockInternal('expired', true);
    });
    return () => setSessionEndedHandler(null);
  }, [lockInternal]);

  // Initial check.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cross-tab messages.
  useEffect(() => {
    const channel = createChannel();
    channelRef.current = channel;
    if (!channel) return;
    channel.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'locked' || type === 'logout') {
        if (statusRef.current === 'authenticated' || statusRef.current === 'checking') {
          lockInternal(type === 'logout' ? 'signed_out_elsewhere' : 'other_tab', false);
        }
      } else if (type === 'login') {
        if (statusRef.current === 'authenticated') void refresh();
        else if (statusRef.current === 'locked') setSignedInElsewhere(true);
      }
    };
    return () => {
      channel.onmessage = null;
      channel.close();
      channelRef.current = null;
    };
  }, [createChannel, lockInternal, refresh]);

  // Warning and expiry timers.
  useEffect(() => {
    if (status !== 'authenticated' || !timing) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const warnAt = timing.deadline - WARNING_MS;
    const showWarningOrVerify = () => {
      if (timing.deadlineKind === 'absolute' || timing.checkedAt >= warnAt) setWarning(true);
      else void refresh(); // idle deadline may have moved because of activity; background check only
    };
    const expire = () => {
      if (timing.deadlineKind === 'absolute' || Date.now() >= timing.absolute) lockInternal('expired', true);
      else void refresh().then((s) => {
        const t = timingRef.current;
        if (s === 'authenticated' && t && Date.now() >= t.deadline) lockInternal('expired', true);
      });
    };
    const now = Date.now();
    if (now >= timing.deadline) {
      timers.push(setTimeout(expire, 0));
    } else {
      timers.push(setTimeout(showWarningOrVerify, Math.max(0, warnAt - now)));
      timers.push(setTimeout(expire, timing.deadline - now));
    }
    // Backstop for throttled timers in background tabs.
    const backstop = setInterval(() => {
      if (Date.now() >= timing.absolute) lockInternal('expired', true);
    }, 15_000);
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(backstop);
    };
  }, [status, timing, refresh, lockInternal]);

  // Resume checks.
  useEffect(() => {
    const deadlinePassed = () => {
      const t = timingRef.current;
      return !!t && Date.now() >= t.absolute;
    };
    const checkAfterResume = (forceCover: boolean) => {
      if (statusRef.current !== 'authenticated') return;
      if (deadlinePassed()) {
        lockInternal('expired', true);
        return;
      }
      if (forceCover) cover(true);
      void refresh().finally(() => {
        if (forceCover) cover(false);
      });
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = null;
      checkAfterResume(hiddenFor >= coverAfterMs);
    };
    const onPageHide = () => {
      // Hide private content before the page can enter the back/forward cache.
      if (statusRef.current === 'authenticated') setCoverClass(true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (statusRef.current !== 'authenticated') {
        setCoverClass(false);
        return;
      }
      // Restored from the back/forward cache (or re-shown): verify before revealing anything.
      if (event.persisted || document.visibilityState === 'visible') checkAfterResume(true);
    };
    const onFocus = () => {
      if (Date.now() - lastCheck.current < 5_000) return;
      checkAfterResume(false);
    };
    const onOnline = () => {
      if (statusRef.current === 'offline' || statusRef.current === 'error') {
        statusRef.current = 'checking';
        setStatus('checking');
        void refresh();
      } else {
        checkAfterResume(false);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
    };
  }, [cover, coverAfterMs, lockInternal, refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/api/auth/logout', { method: 'POST', public: true });
    } catch {
      /* the local lock below still clears everything */
    }
    lockInternal('signed_out', true);
  }, [lockInternal]);

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      session,
      timing,
      lockReason,
      covered,
      warning: warning && status === 'authenticated',
      epoch,
      signedInElsewhere,
      reauthOpen,
      setReauthOpen,
      refresh: status === 'locked' ? unlockFromElsewhere : refresh,
      adopt,
      lock,
      logout,
    }),
    [status, session, timing, lockReason, covered, warning, epoch, signedInElsewhere, reauthOpen, refresh, unlockFromElsewhere, adopt, lock, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider');
  return value;
}

/** Broadcast a fresh login so sibling tabs pick up the new session (and its CSRF token). */
export function broadcastLogin(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage({ type: 'login' } satisfies SessionMessage);
  channel.close();
}

/** Server-aligned current time in ms. */
export function serverNow(timing: SessionTiming | null): number {
  return Date.now() + (timing?.offset ?? 0);
}
