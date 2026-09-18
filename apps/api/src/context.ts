import type { Database } from '@financialos/db';
import type { Keyring } from '@financialos/security/crypto';
import type { AgentScope } from '@financialos/contracts';
import type { Clock } from './clock';
import type { RuntimeConfig } from './config';
import type { AppProviders } from './providers';
import type { AuditService } from './auth/audit';
import type { SessionService } from './auth/sessions';
import type { ThrottleService } from './auth/throttle';
import type { SettingsStore } from './auth/store';
import type { WebAuthnService } from './auth/webauthn';
import type { McpToolRegistry } from './mcp/registry';

/** Enqueues durable background work. Jobs outlive the web session that started them. */
export interface JobEnqueuer {
  /** Returns the pg-boss job id, or null when a job with the same singleton key is already queued. */
  enqueue(queue: string, data: Record<string, unknown>, options?: { singletonKey?: string; startAfterSeconds?: number }): Promise<{ jobId: string | null }>;
}

export const unavailableJobEnqueuer: JobEnqueuer = {
  async enqueue() {
    throw new Error('Background jobs are not available in this process');
  },
};

export interface ReadinessResult {
  name: string;
  ok: boolean;
  detail: string;
}
export type ReadinessCheck = () => Promise<ReadinessResult>;

/** Everything request handlers need. Available as `app.fos` and `request.server.fos`. */
export interface AppContext {
  config: RuntimeConfig;
  db: Database;
  clock: Clock;
  keyring: Keyring;
  /** Secret used for CSRF tokens, recovery-code hashes, and IP hashes. */
  pepper: Buffer;
  jobs: JobEnqueuer;
  providers: AppProviders;
  mcpTools: McpToolRegistry;
  audit: AuditService;
  sessions: SessionService;
  throttle: ThrottleService;
  settings: SettingsStore;
  webauthn: WebAuthnService;
  /** `chrome-extension://<id>` origins allowed to use /api/ext/*. */
  extensionOrigins: string[];
  /** Precomputed Argon2id hash used to equalise work when no owner exists. */
  dummyPasswordHash: string;
}

/** The authenticated owner session attached by `requireOwner`. */
export interface OwnerSession {
  id: string;
  tokenHash: string;
  authMethod: 'password_totp' | 'password_recovery_code' | 'passkey';
  authenticatedAt: Date;
  absoluteExpiresAt: Date;
  idleExpiresAt: Date;
  csrfToken: string;
}

export interface AgentPrincipal {
  id: string;
  name: string;
  scopes: AgentScope[];
  entityIds: string[];
}

export interface DevicePrincipal {
  id: string;
  extensionOrigin: string;
  scopes: string[];
  revealedFields: string[];
}

declare module 'fastify' {
  interface FastifyInstance {
    fos: AppContext;
  }
  interface FastifyRequest {
    session: OwnerSession | null;
    agent: AgentPrincipal | null;
    device: DevicePrincipal | null;
  }
}
