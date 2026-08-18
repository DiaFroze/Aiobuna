"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// Refresh the server component's data on an interval so the poll counts stay
// live without the admin reloading the page.
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
