import { prisma } from "@/lib/db";
import { PageHeader, Table } from "@/components/admin/ui";
import { formatDate } from "@/lib/format";
import { createAdminAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function AdminsPage() {
  const [admins, roles] = await Promise.all([
    prisma.admin.findMany({ include: { role: true }, orderBy: { createdAt: "desc" } }),
    prisma.role.findMany(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader title="Администраторы" subtitle="Учётные записи и роли (RBAC)." />
      <Table head={["Email", "Имя", "Роль", "Активен", "Создан"]}>
        {admins.map((a) => (
          <tr key={a.id} className="border-b last:border-0">
            <td className="px-4 py-3">{a.email}</td>
            <td className="px-4 py-3">{a.name ?? "—"}</td>
            <td className="px-4 py-3">{a.role.name}</td>
            <td className="px-4 py-3">{a.isActive ? "да" : "нет"}</td>
            <td className="px-4 py-3 text-muted">{formatDate(a.createdAt)}</td>
          </tr>
        ))}
      </Table>

      <div className="card p-5 max-w-md">
        <h3 className="font-semibold mb-3">Добавить администратора</h3>
        <form action={createAdminAction} className="space-y-3">
          <input name="email" type="email" required placeholder="Email" className="input" />
          <input name="name" placeholder="Имя" className="input" />
          <input name="password" type="password" required placeholder="Пароль (мин. 8)" className="input" />
          <select name="roleId" className="input">
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <button className="btn-primary">Создать</button>
        </form>
      </div>
    </div>
  );
}
