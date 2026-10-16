import { describe, expect, it } from 'vitest';
import {
  domainEvent,
  earnPointsRequest,
  loginRequest,
  maskMobile,
  mobile,
  pointsForSpend,
} from '../src/index';

describe('contracts', () => {
  it('awards 1 point per ₹100, floored', () => {
    expect(pointsForSpend(0)).toBe(0);
    expect(pointsForSpend(9_999)).toBe(0);
    expect(pointsForSpend(10_000)).toBe(1);
    expect(pointsForSpend(250_050)).toBe(25);
  });

  it('rejects non-integer money', () => {
    expect(() => pointsForSpend(10.5)).toThrow(RangeError);
    expect(earnPointsRequest.safeParse({ amountPaise: 10.5 }).success).toBe(false);
  });

  it('validates Indian mobile numbers', () => {
    expect(mobile.safeParse('+919876543210').success).toBe(true);
    expect(mobile.safeParse('9876543210').success).toBe(false);
    expect(mobile.safeParse('+911234567890').success).toBe(false);
  });

  it('normalises email on login', () => {
    const r = loginRequest.parse({ email: ' Foo@Bar.COM ', password: 'longenough' });
    expect(r.email).toBe('foo@bar.com');
  });

  it('masks mobiles', () => {
    expect(maskMobile('+919876543210')).toBe('+91*******210');
  });

  it('parses a versioned event', () => {
    const e = domainEvent.parse({
      type: 'points.redeemed.v1',
      eventId: '3b241101-e2bb-4255-8caf-4136c566a962',
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
      transactionId: '3b241101-e2bb-4255-8caf-4136c566a962',
      customerId: '3b241101-e2bb-4255-8caf-4136c566a962',
      merchantId: '3b241101-e2bb-4255-8caf-4136c566a962',
      outletId: '3b241101-e2bb-4255-8caf-4136c566a962',
      points: 10,
    });
    expect(e.type).toBe('points.redeemed.v1');
  });
});
