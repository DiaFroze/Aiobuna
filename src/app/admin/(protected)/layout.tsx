import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/session";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await getCurrentAdmin();
  if (!admin) redirect("/admin/login");

  return (
    <div className="min-h-screen flex bg-bg">
      <AdminSidebar admin={{ email: admin.email, roleKey: admin.roleKey }} />
      <div className="flex-1 min-w-0">
        <main className="mx-auto max-w-6xl p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
