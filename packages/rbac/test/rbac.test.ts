import { describe, expect, it } from 'vitest';
import { PERMISSIONS, ROLES, authorize, can, permissionsFor } from '../src/index';

describe('rbac', () => {
  it('every permission granted to a role is a known permission', () => {
    for (const r of ROLES) for (const p of permissionsFor(r)) expect(PERMISSIONS).toContain(p);
  });

  it('customers cannot earn or redeem points', () => {
    expect(can('CUSTOMER', 'points:earn')).toBe(false);
    expect(can('CUSTOMER', 'points:redeem')).toBe(false);
  });

  it('only super admin can adjust points', () => {
    expect(ROLES.filter((r) => can(r, 'points:adjust'))).toEqual(['SUPER_ADMIN']);
  });

  it('cashier cannot manage staff', () => {
    expect(can('CASHIER', 'staff:manage')).toBe(false);
  });

  it('enforces merchant tenant isolation', () => {
    const owner = { userId: 'u1', role: 'MERCHANT_OWNER', merchantId: 'm1' } as const;
    expect(authorize(owner, 'outlet:manage', { merchantId: 'm1' })).toBe(true);
    expect(authorize(owner, 'outlet:manage', { merchantId: 'm2' })).toBe(false);
  });

  it('enforces outlet isolation for cashiers', () => {
    const c = { userId: 'u2', role: 'CASHIER', merchantId: 'm1', outletId: 'o1' } as const;
    expect(authorize(c, 'points:earn', { merchantId: 'm1', outletId: 'o1' })).toBe(true);
    expect(authorize(c, 'points:earn', { merchantId: 'm1', outletId: 'o2' })).toBe(false);
  });

  it('customers only see their own resources', () => {
    const cu = { userId: 'c1', role: 'CUSTOMER' } as const;
    expect(authorize(cu, 'wallet:read', { ownerUserId: 'c1' })).toBe(true);
    expect(authorize(cu, 'wallet:read', { ownerUserId: 'c2' })).toBe(false);
    expect(authorize(cu, 'wallet:read', {})).toBe(false);
  });
});
