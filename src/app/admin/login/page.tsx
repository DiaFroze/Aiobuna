import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/auth/session";
import { LoginForm } from "@/components/admin/LoginForm";
import { getT } from "@/i18n/strings";

const t = getT("ru");

export default async function AdminLoginPage() {
  const admin = await getCurrentAdmin();
  if (admin) redirect("/admin");

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg px-4">
      <div className="card p-8 w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand text-brand-fg text-lg font-bold mb-2">
            SB
          </div>
          <h1 className="text-xl font-bold">{t("admin.login")}</h1>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
