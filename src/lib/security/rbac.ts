import "server-only";

// Permission catalogue. Roles are collections of these keys.
export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",
  PRODUCTS_READ: "products.read",
  PRODUCTS_WRITE: "products.write",
  CATEGORIES_WRITE: "categories.write",
  CANDIDATES_MANAGE: "candidates.manage",
  SUPPLIERS_READ: "suppliers.read",
  SUPPLIERS_WRITE: "suppliers.write",
  LINKS_MANAGE: "links.manage",
  PRICING_WRITE: "pricing.write",
  CONTENT_WRITE: "content.write",
  ORDERS_READ: "orders.read",
  ORDERS_WRITE: "orders.write",
  CUSTOMERS_READ: "customers.read",
  PAYMENTS_READ: "payments.read",
  ANALYTICS_VIEW: "analytics.view",
  SETTINGS_WRITE: "settings.write",
  ADMINS_MANAGE: "admins.manage",
  AUDIT_VIEW: "audit.view",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

// Built-in roles seeded on setup.
export const ROLE_PRESETS: Record<string, { name: string; permissions: PermissionKey[] }> = {
  superadmin: {
    name: "Супер-администратор",
    permissions: Object.values(PERMISSIONS),
  },
  manager: {
    name: "Менеджер",
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.PRODUCTS_WRITE,
      PERMISSIONS.CATEGORIES_WRITE,
      PERMISSIONS.CANDIDATES_MANAGE,
      PERMISSIONS.SUPPLIERS_READ,
      PERMISSIONS.LINKS_MANAGE,
      PERMISSIONS.PRICING_WRITE,
      PERMISSIONS.CONTENT_WRITE,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ORDERS_WRITE,
      PERMISSIONS.CUSTOMERS_READ,
      PERMISSIONS.ANALYTICS_VIEW,
    ],
  },
  viewer: {
    name: "Наблюдатель",
    permissions: [
      PERMISSIONS.DASHBOARD_VIEW,
      PERMISSIONS.PRODUCTS_READ,
      PERMISSIONS.SUPPLIERS_READ,
      PERMISSIONS.ORDERS_READ,
      PERMISSIONS.ANALYTICS_VIEW,
    ],
  },
};

export function hasPermission(perms: string[], required: PermissionKey): boolean {
  return perms.includes(required);
}
