"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getT } from "@/i18n/strings";

const t = getT("ru");

export function LoginForm() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    setLoading(false);
    if (res.ok) {
      router.push("/admin");
      router.refresh();
    } else {
      setError("Неверный email или пароль");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div>
        <label className="text-sm text-muted">{t("admin.username")}</label>
        <input name="email" type="text" required className="input mt-1" autoComplete="username" />
      </div>
      <div>
        <label className="text-sm text-muted">{t("admin.password")}</label>
        <input name="password" type="password" required className="input mt-1" autoComplete="current-password" />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <button disabled={loading} className="btn-primary w-full">
        {loading ? t("common.loading") : t("admin.signIn")}
      </button>
    </form>
  );
}
