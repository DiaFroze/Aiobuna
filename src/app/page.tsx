import { redirect } from "next/navigation";

// The public storefront was removed — this project is now admin-only.
export default function RootPage() {
  redirect("/admin");
}
