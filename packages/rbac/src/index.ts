/**
 * Single source of truth for authorization across API, admin web and mobile apps.
 * Model: role -> permissions (resource:action), plus a scope describing WHICH
 * resources the role may touch (platform-wide, one merchant, one outlet, or self).
 */

export const ROLES = [
  'SUPER_ADMIN',
  'PLATFORM_ADMIN',
  'SUPPORT_AGENT',
  'MERCHANT_OWNER',
  'MERCHANT_MANAGER',
  'CASHIER',
  'CUSTOMER',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'user:read',
  'user:manage',
  'merchant:read',
  'merchant:manage',
  'outlet:read',
  'outlet:manage',
  'staff:read',
  'staff:manage',
  'device:read',
  'device:manage',
  'customer:read',
  'customer:manage',
  'points:earn',
  'points:redeem',
  'points:reverse',
  'points:adjust',
  'wallet:read',
  'transaction:read',
  'campaign:read',
  'campaign:manage',
  'report:read',
  'audit:read',
  'settings:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Where a role's permissions apply. */
export type Scope = 'PLATFORM' | 'MERCHANT' | 'OUTLET' | 'SELF';

const ALL: readonly Permission[] = PERMISSIONS;

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: ALL,
  PLATFORM_ADMIN: ALL.filter((p) => p !== 'settings:manage' && p !== 'points:adjust'),
  SUPPORT_AGENT: [
    'user:read',
    'merchant:read',
    'outlet:read',
    'customer:read',
    'wallet:read',
    'transaction:read',
    'points:reverse',
  ],
  MERCHANT_OWNER: [
    'merchant:read',
    'outlet:read',
    'outlet:manage',
    'staff:read',
    'staff:manage',
    'device:read',
    'device:manage',
    'customer:read',
    'points:earn',
    'points:redeem',
    'points:reverse',
    'transaction:read',
    'campaign:read',
    'campaign:manage',
    'report:read',
  ],
  MERCHANT_MANAGER: [
    'outlet:read',
    'staff:read',
    'device:read',
    'customer:read',
    'points:earn',
    'points:redeem',
    'points:reverse',
    'transaction:read',
    'campaign:read',
    'report:read',
  ],
  CASHIER: ['customer:read', 'points:earn', 'points:redeem', 'transaction:read'],
  CUSTOMER: ['wallet:read', 'transaction:read', 'campaign:read'],
};

export const ROLE_SCOPE: Record<Role, Scope> = {
  SUPER_ADMIN: 'PLATFORM',
  PLATFORM_ADMIN: 'PLATFORM',
  SUPPORT_AGENT: 'PLATFORM',
  MERCHANT_OWNER: 'MERCHANT',
  MERCHANT_MANAGER: 'MERCHANT',
  CASHIER: 'OUTLET',
  CUSTOMER: 'SELF',
};

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function canAll(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(role, p));
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Identity + tenancy of the caller. */
export interface Principal {
  userId: string;
  role: Role;
  merchantId?: string | null;
  outletId?: string | null;
}

/** Ownership of the resource being accessed. */
export interface ResourceRef {
  ownerUserId?: string;
  merchantId?: string;
  outletId?: string;
}

/**
 * Permission AND scope. A merchant owner with `points:earn` still cannot
 * touch another merchant's resources (tenant isolation).
 */
export function authorize(
  principal: Principal,
  permission: Permission,
  resource?: ResourceRef,
): boolean {
  if (!can(principal.role, permission)) return false;
  if (!resource) return true;
  switch (ROLE_SCOPE[principal.role]) {
    case 'PLATFORM':
      return true;
    case 'MERCHANT':
      return !resource.merchantId || resource.merchantId === principal.merchantId;
    case 'OUTLET':
      return (
        (!resource.merchantId || resource.merchantId === principal.merchantId) &&
        (!resource.outletId || resource.outletId === principal.outletId)
      );
    case 'SELF':
      return !!resource.ownerUserId && resource.ownerUserId === principal.userId;
  }
}
