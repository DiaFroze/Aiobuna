import { prisma } from "@/lib/db";
import { PageHeader, Table } from "@/components/admin/ui";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const logs = await prisma.auditLog.findMany({
    include: { admin: true },
    orderBy: { createdAt: "desc" },
    take: 150,
  });
  return (
    <div>
      <PageHeader title="Audit logs" subtitle="Все чувствительные действия. Метаданные очищены от секретов." />
      <Table head={["Админ", "Действие", "Сущность", "ID", "Дата"]}>
        {logs.map((l) => (
          <tr key={l.id} className="border-b last:border-0">
            <td className="px-4 py-3">{l.admin?.email ?? "система"}</td>
            <td className="px-4 py-3 font-mono text-xs">{l.action}</td>
            <td className="px-4 py-3 text-muted">{l.entityType}</td>
            <td className="px-4 py-3 font-mono text-xs text-muted">{l.entityId?.slice(0, 8) ?? "—"}</td>
            <td className="px-4 py-3 text-muted">{formatDate(l.createdAt)}</td>
          </tr>
        ))}
        {logs.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">Записей нет.</td></tr>}
      </Table>
    </div>
  );
}
