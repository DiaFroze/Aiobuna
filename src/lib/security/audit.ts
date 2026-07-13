import "server-only";
import { prisma } from "../db";
import { redactSecrets } from "./crypto";

/**
 * Append an audit log entry. Metadata is redacted of anything secret-looking
 * before storage. Never pass raw API keys/passwords here.
 */
export async function audit(params: {
  adminId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  const safeMeta = params.metadata
    ? JSON.parse(redactSecrets(JSON.stringify(params.metadata)))
    : undefined;
  await prisma.auditLog.create({
    data: {
      adminId: params.adminId ?? null,
      action: params.action,
      entityType: params.entityType,
      entityId: params.entityId ?? null,
      metadata: safeMeta,
      ip: params.ip ?? null,
    },
  });
}
