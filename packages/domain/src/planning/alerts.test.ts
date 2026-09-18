import { Notification } from '@financialos/contracts';
import { describe, expect, it } from 'vitest';
import {
  evaluateAlerts,
  inQuietHours,
  isoWeekKey,
  localClock,
  nextAllowedTime,
  parseClock,
  PRIVACY_SAFE_BODY,
  toNotification,
  zonedTimeToInstant,
  type AlertInput,
  type QuietHours,
} from './alerts';
import { PlanningError } from './shared';
import { deepFreeze, uid, zar } from './testing';

const TZ = 'Africa/Johannesburg';
const NIGHT: QuietHours = { enabled: true, start: '22:00', end: '07:00' };
const AFTERNOON: QuietHours = { enabled: true, start: '13:00', end: '15:00' };
const OFF: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

const BILL = uid(70);
const ACCOUNT = uid(71);
const CONNECTION = uid(72);
const ENTITY = uid(73);
const TRANSACTION = uid(74);

/** 12:00 local, well outside both quiet windows. */
const DAYTIME = '2026-03-10T10:00:00Z';

function input(overrides: Partial<AlertInput> = {}): AlertInput {
  return { now: DAYTIME, today: '2026-03-10', timezone: TZ, quietHours: OFF, ...overrides };
}

describe('clock helpers', () => {
  it('parses a wall clock and refuses anything else', () => {
    expect(parseClock('00:00')).toBe(0);
    expect(parseClock('07:30')).toBe(450);
    expect(parseClock('23:59')).toBe(1439);
    for (const bad of ['24:00', '7:30', '07:60', '', 'noon']) expect(() => parseClock(bad)).toThrow(PlanningError);
  });

  it('reads the local clock in the reporting time zone', () => {
    expect(localClock('2026-03-10T21:30:00Z', TZ)).toEqual({ date: '2026-03-10', minutes: 23 * 60 + 30 });
    expect(localClock('2026-03-10T22:30:00Z', TZ)).toEqual({ date: '2026-03-11', minutes: 30 });
    expect(() => localClock('not-a-time', TZ)).toThrow(PlanningError);
  });

  it('turns a local wall time back into an instant, across a daylight-saving change', () => {
    expect(zonedTimeToInstant('2026-03-11', 7 * 60, TZ)).toBe('2026-03-11T05:00:00.000Z');
    expect(zonedTimeToInstant('2026-01-15', 7 * 60, 'Europe/London')).toBe('2026-01-15T07:00:00.000Z');
    expect(zonedTimeToInstant('2026-07-15', 7 * 60, 'Europe/London')).toBe('2026-07-15T06:00:00.000Z');
  });

  it('knows whether a minute is inside a quiet window, including one that crosses midnight', () => {
    expect(inQuietHours(23 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(3 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(22 * 60, NIGHT)).toBe(true);
    expect(inQuietHours(7 * 60, NIGHT)).toBe(false);
    expect(inQuietHours(12 * 60, NIGHT)).toBe(false);
    expect(inQuietHours(14 * 60, AFTERNOON)).toBe(true);
    expect(inQuietHours(15 * 60, AFTERNOON)).toBe(false);
    expect(inQuietHours(12 * 60, AFTERNOON)).toBe(false);
    expect(inQuietHours(23 * 60, OFF)).toBe(false);
    expect(inQuietHours(23 * 60, { enabled: true, start: '22:00', end: '22:00' })).toBe(false);
  });

  it('defers to the end of a quiet window that crosses midnight', () => {
    // 23:30 local on the 10th moves to 07:00 local on the 11th.
    expect(nextAllowedTime('2026-03-10T21:30:00Z', NIGHT, TZ)).toBe('2026-03-11T05:00:00.000Z');
    // 04:00 local on the 11th moves to 07:00 local on the same day.
    expect(nextAllowedTime('2026-03-11T02:00:00Z', NIGHT, TZ)).toBe('2026-03-11T05:00:00.000Z');
    // Outside the window nothing moves.
    expect(nextAllowedTime(DAYTIME, NIGHT, TZ)).toBe(DAYTIME);
    expect(nextAllowedTime('2026-03-10T21:30:00Z', OFF, TZ)).toBe('2026-03-10T21:30:00Z');
  });

  it('defers to the end of a quiet window inside one day', () => {
    // 14:00 local moves to 15:00 local.
    expect(nextAllowedTime('2026-03-10T12:00:00Z', AFTERNOON, TZ)).toBe('2026-03-10T13:00:00.000Z');
  });

  it('computes ISO week keys, including week 53 and a year boundary', () => {
    expect(isoWeekKey('2026-01-01')).toBe('2026-W01');
    expect(isoWeekKey('2026-03-10')).toBe('2026-W11');
    expect(isoWeekKey('2026-03-09')).toBe('2026-W11');
    expect(isoWeekKey('2026-03-08')).toBe('2026-W10');
    expect(isoWeekKey('2027-01-01')).toBe('2026-W53');
  });
});

describe('alert rules', () => {
  it('announces a bill inside the lead window and marks an overdue one a warning', () => {
    const result = evaluateAlerts(
      input({ upcomingBills: deepFreeze([{ id: BILL, label: 'Example Insurance Ltd premium', dueOn: '2026-03-13', amount: zar('1250'), links: [] }]) }),
    );
    expect(result.alerts).toHaveLength(1);
    const alert = result.alerts[0]!;
    expect(alert.kind).toBe('upcoming_bill');
    expect(alert.severity).toBe('info');
    expect(alert.dedupeKey).toBe(`upcoming_bill:${BILL}:2026-03-13`);
    expect(alert.periodKey).toBe('2026-03-13');
    expect(alert.body).toContain('1250 ZAR');
    expect(alert.why).toBe('The due date 2026-03-13 is 3 day(s) away, inside your 5-day reminder window.');

    const overdue = evaluateAlerts(input({ upcomingBills: [{ id: BILL, label: 'Example Insurance Ltd premium', dueOn: '2026-03-07', amount: zar('1250') }] }));
    expect(overdue.alerts[0]!.severity).toBe('warning');
    expect(overdue.alerts[0]!.why).toContain('3 day(s) ago');
  });

  it('says nothing about a bill beyond the lead window, and respects a custom window', () => {
    expect(evaluateAlerts(input({ upcomingBills: [{ id: BILL, label: 'Later bill', dueOn: '2026-03-20', amount: zar('10') }] })).alerts).toEqual([]);
    expect(
      evaluateAlerts(input({ billLeadDays: 14, upcomingBills: [{ id: BILL, label: 'Later bill', dueOn: '2026-03-20', amount: zar('10') }] })).alerts,
    ).toHaveLength(1);
  });

  it('names an unknown bill amount instead of guessing it', () => {
    const result = evaluateAlerts(input({ upcomingBills: [{ id: BILL, label: 'Variable bill', dueOn: '2026-03-12', amount: null }] }));
    expect(result.alerts[0]!.body).toContain('an amount that is not known yet');
  });

  it('warns on a runway below the threshold and escalates below one month', () => {
    const warn = evaluateAlerts(input({ runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '2.4', thresholdMonths: '3' }] }));
    expect(warn.alerts[0]!.severity).toBe('warning');
    expect(warn.alerts[0]!.dedupeKey).toBe('runway_below_threshold:personal:2026-W11');
    expect(warn.alerts[0]!.why).toBe('Liquid balance divided by the average monthly net outflow gives 2.4 months, and your threshold is 3.');

    const critical = evaluateAlerts(input({ runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '0.8', thresholdMonths: '3' }] }));
    expect(critical.alerts[0]!.severity).toBe('critical');
  });

  it('says nothing about runway above the threshold or when it is not a finite number', () => {
    for (const runway of [
      { scopeId: 'personal', scopeLabel: 'Personal', status: 'finite' as const, months: '5', thresholdMonths: '3' },
      { scopeId: 'personal', scopeLabel: 'Personal', status: 'not_depleting' as const, months: null, thresholdMonths: '3' },
      { scopeId: 'personal', scopeLabel: 'Personal', status: 'insufficient_history' as const, months: null, thresholdMonths: '3' },
    ]) {
      expect(evaluateAlerts(input({ runway: [runway] })).alerts).toEqual([]);
    }
  });

  it('passes a subscription price change through with its own numbers', () => {
    const result = evaluateAlerts(
      input({
        priceChanges: [
          {
            seriesKey: 'sample software co|out|ZAR',
            name: 'Sample Software Co',
            counterparty: 'Sample Software Co',
            previousTypical: zar('100'),
            latest: zar('120'),
            changeShare: '0.2',
            direction: 'increase',
            changedOn: '2026-03-09',
            detail: 'Sample Software Co changed from about 100 to 120 ZAR on 2026-03-09 (20%).',
            links: [],
          },
        ],
      }),
    );
    expect(result.alerts[0]!.kind).toBe('subscription_price_change');
    expect(result.alerts[0]!.dedupeKey).toBe('subscription_price_change:sample software co|out|ZAR:2026-03-09');
    expect(result.alerts[0]!.why).toBe('The latest charge was 120 ZAR against a typical 100 ZAR: 20%.');
  });

  it('repeats an anomaly without escalating it', () => {
    const result = evaluateAlerts(
      input({
        anomalies: [
          {
            id: uid(80),
            kind: 'amount_outlier_category',
            severity: 'warning',
            transactionId: TRANSACTION,
            accountId: ACCOUNT,
            date: '2026-03-02',
            amount: zar('-4000'),
            amountInHome: zar('4000'),
            reason: '4000 ZAR is unusual for Groceries (money out).',
            note: 'Unusual compared with your own history.',
            numbers: {
              value: '4000',
              median: '300',
              scale: '14.825797',
              zScore: '249.565',
              sampleSize: 9,
              threshold: '3.5',
              currency: 'ZAR',
              comparedTo: 'Groceries (money out)',
              basis: 'mad',
            },
            relatedTransactionIds: [],
            links: [],
            exception: {
              kind: 'unusual_transaction',
              severity: 'warning',
              title: 'Unusual transaction',
              detail: 'x',
              subject: { type: 'transaction', id: TRANSACTION, label: null },
              entityId: null,
              dedupeKey: 'x',
            },
          },
        ],
      }),
    );
    expect(result.alerts[0]!.kind).toBe('unusual_transaction');
    expect(result.alerts[0]!.severity).toBe('warning');
    expect(result.alerts[0]!.title).toBe('A transaction is worth a look');
    expect(result.alerts[0]!.dedupeKey).toBe(`unusual_transaction:${TRANSACTION}:2026-03-02`);
    expect(result.alerts[0]!.why).toContain('robust z 249.565 against a threshold of 3.5');
  });

  it('warns about a coverage gap with the exact span', () => {
    const result = evaluateAlerts(
      input({ coverageGaps: [{ accountId: ACCOUNT, accountName: 'Everyday account', from: '2026-01-01', to: '2026-01-31', reason: 'No statement imported.' }] }),
    );
    expect(result.alerts[0]!.kind).toBe('coverage_gap');
    expect(result.alerts[0]!.dedupeKey).toBe(`coverage_gap:${ACCOUNT}:2026-01-01..2026-01-31`);
    expect(result.alerts[0]!.why).toBe('No statement imported. The gap runs from 2026-01-01 to 2026-01-31, which is 31 day(s).');
  });

  it('flags a connection by status or by age, and raises the severity when balances go unknown', () => {
    const neverSynced = evaluateAlerts(
      input({ connections: [{ id: CONNECTION, name: 'Sample Bank connection', status: 'not_configured', lastSuccessAt: null, accountsWithUnknownBalance: 2 }] }),
    );
    expect(neverSynced.alerts[0]!.severity).toBe('warning');
    expect(neverSynced.alerts[0]!.body).toContain('2 account balance(s) are unknown');
    expect(neverSynced.alerts[0]!.why).toBe('The connection status is not_configured and no successful sync has been recorded.');
    expect(neverSynced.alerts[0]!.dedupeKey).toBe(`stale_connection:${CONNECTION}:2026-W11`);

    const old = evaluateAlerts(
      input({ connections: [{ id: CONNECTION, name: 'Sample Bank connection', status: 'connected', lastSuccessAt: '2026-03-06T10:00:00Z', accountsWithUnknownBalance: 0 }] }),
    );
    expect(old.alerts[0]!.severity).toBe('info');
    expect(old.alerts[0]!.why).toContain('96 hour(s) ago, against a 48-hour limit');

    const healthy = evaluateAlerts(
      input({ connections: [{ id: CONNECTION, name: 'Sample Bank connection', status: 'connected', lastSuccessAt: '2026-03-10T08:00:00Z', accountsWithUnknownBalance: 0 }] }),
    );
    expect(healthy.alerts).toEqual([]);
  });

  it('raises a review only when it is due and not already done for that period', () => {
    const due = evaluateAlerts(input({ reviews: [{ kind: 'weekly', dueOn: '2026-03-09', lastCompletedPeriodEnd: '2026-03-01' }] }));
    expect(due.alerts[0]!.kind).toBe('weekly_review_due');
    expect(due.alerts[0]!.dedupeKey).toBe('weekly_review_due:weekly:2026-W11');

    const done = evaluateAlerts(input({ reviews: [{ kind: 'weekly', dueOn: '2026-03-09', lastCompletedPeriodEnd: '2026-03-09' }] }));
    expect(done.alerts).toEqual([]);

    const notYet = evaluateAlerts(input({ reviews: [{ kind: 'monthly', dueOn: '2026-04-01', lastCompletedPeriodEnd: null }] }));
    expect(notYet.alerts).toEqual([]);

    const monthly = evaluateAlerts(input({ reviews: [{ kind: 'monthly', dueOn: '2026-03-01', lastCompletedPeriodEnd: null }] }));
    expect(monthly.alerts[0]!.kind).toBe('monthly_close_due');
    expect(monthly.alerts[0]!.dedupeKey).toBe('monthly_close_due:monthly:2026-03');
    expect(monthly.alerts[0]!.why).toContain('the last completed period ended never');
  });

  it('passes a business cash warning through at its own severity', () => {
    const result = evaluateAlerts(
      input({
        businessWarnings: [{ entityId: ENTITY, entityName: 'Example Holdings Ltd', severity: 'critical', message: 'Payroll is due before the next receipt.', href: '/business' }],
      }),
    );
    expect(result.alerts[0]!.kind).toBe('business_cash_warning');
    expect(result.alerts[0]!.severity).toBe('critical');
    expect(result.alerts[0]!.dedupeKey).toBe(`business_cash_warning:${ENTITY}:2026-03`);
  });
});

describe('dedupe keys', () => {
  it('gives the same condition in the same period the same key on every run', () => {
    const facts: Partial<AlertInput> = {
      upcomingBills: [{ id: BILL, label: 'Example Insurance Ltd premium', dueOn: '2026-03-13', amount: zar('1250') }],
      runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '2.4', thresholdMonths: '3' }],
    };
    const monday = evaluateAlerts(input({ ...facts, now: '2026-03-09T06:00:00Z', today: '2026-03-09' }));
    const wednesday = evaluateAlerts(input({ ...facts, now: '2026-03-11T06:00:00Z', today: '2026-03-11' }));
    expect(wednesday.alerts.map((a) => a.dedupeKey)).toEqual(monday.alerts.map((a) => a.dedupeKey));
    expect(wednesday.alerts.map((a) => a.id)).toEqual(monday.alerts.map((a) => a.id));
  });

  it('gives a different period a different key', () => {
    const thisWeek = evaluateAlerts(input({ runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '2.4', thresholdMonths: '3' }] }));
    const nextWeek = evaluateAlerts(
      input({ now: '2026-03-17T06:00:00Z', today: '2026-03-17', runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '2.4', thresholdMonths: '3' }] }),
    );
    expect(nextWeek.alerts[0]!.dedupeKey).not.toBe(thisWeek.alerts[0]!.dedupeKey);
  });
});

describe('quiet hours', () => {
  const facts: Partial<AlertInput> = {
    upcomingBills: [{ id: BILL, label: 'Example Insurance Ltd premium', dueOn: '2026-03-13', amount: zar('1250') }],
    runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '0.5', thresholdMonths: '3' }],
  };

  it('defers non-critical alerts to the end of the window and delivers critical ones at once', () => {
    const result = evaluateAlerts(input({ ...facts, now: '2026-03-10T21:30:00Z', quietHours: NIGHT }));
    const critical = result.alerts.find((a) => a.severity === 'critical')!;
    const info = result.alerts.find((a) => a.severity === 'info')!;
    expect(critical.deliverAt).toBe('2026-03-10T21:30:00Z');
    expect(critical.deferred).toBe(false);
    expect(critical.deferredReason).toBeNull();
    expect(info.deliverAt).toBe('2026-03-11T05:00:00.000Z');
    expect(info.deferred).toBe(true);
    expect(info.deferredReason).toBe('Held until 07:00 in Africa/Johannesburg: quiet hours');
    expect(result.deferredCount).toBe(1);
  });

  it('defers nothing outside the window', () => {
    const result = evaluateAlerts(input({ ...facts, quietHours: NIGHT }));
    expect(result.alerts.every((a) => a.deliverAt === DAYTIME && !a.deferred)).toBe(true);
    expect(result.deferredCount).toBe(0);
  });
});

describe('privacy-safe external wording', () => {
  const secrets = ['Example Insurance Ltd', 'Sample Software Co', 'Everyday account', 'Example Holdings Ltd', BILL, ACCOUNT, CONNECTION, ENTITY, TRANSACTION, '1250', '4000'];
  const full = evaluateAlerts(
    input({
      upcomingBills: [{ id: BILL, label: 'Example Insurance Ltd premium', dueOn: '2026-03-13', amount: zar('1250') }],
      runway: [{ scopeId: 'personal', scopeLabel: 'Personal', status: 'finite', months: '2.4', thresholdMonths: '3' }],
      priceChanges: [
        {
          seriesKey: 'sample software co|out|ZAR',
          name: 'Sample Software Co',
          counterparty: 'Sample Software Co',
          previousTypical: zar('100'),
          latest: zar('120'),
          changeShare: '0.2',
          direction: 'increase',
          changedOn: '2026-03-09',
          detail: 'Sample Software Co changed price.',
          links: [],
        },
      ],
      coverageGaps: [{ accountId: ACCOUNT, accountName: 'Everyday account', from: '2026-01-01', to: '2026-01-31', reason: 'No statement imported.' }],
      connections: [{ id: CONNECTION, name: 'Sample Bank connection', status: 'stale', lastSuccessAt: null, accountsWithUnknownBalance: 1 }],
      reviews: [
        { kind: 'weekly', dueOn: '2026-03-09', lastCompletedPeriodEnd: null },
        { kind: 'monthly', dueOn: '2026-03-01', lastCompletedPeriodEnd: null },
      ],
      businessWarnings: [{ entityId: ENTITY, entityName: 'Example Holdings Ltd', severity: 'warning', message: 'Payroll is due.', href: '/business' }],
    }),
  );

  it('covers every rule in this fixture', () => {
    expect(new Set(full.alerts.map((a) => a.kind)).size).toBe(8);
  });

  it('leaks no amount, name, account identifier or figure of any kind', () => {
    for (const alert of full.alerts) {
      expect(alert.shortBody).toBe(PRIVACY_SAFE_BODY[alert.kind]);
      expect(alert.shortBody).not.toMatch(/\d/);
      for (const secret of secrets) expect(alert.shortBody).not.toContain(secret);
    }
  });

  it('still records a full reason for every alert', () => {
    for (const alert of full.alerts) {
      expect(alert.why.length).toBeGreaterThan(20);
      expect(alert.body.length).toBeGreaterThan(10);
      expect(alert.href).not.toBeNull();
    }
  });

  it('sorts critical first, then warning, then info', () => {
    const order = full.alerts.map((a) => a.severity);
    expect(order).toEqual([...order].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
  });

  it('maps onto the contract notification record', () => {
    const notification = toNotification(full.alerts[0]!, { id: uid(90), createdAt: '2026-03-10T10:00:00Z' });
    expect(() => Notification.parse(notification)).not.toThrow();
    expect(notification.kind).toBe(full.alerts[0]!.kind);
    expect(notification.why).toBe(full.alerts[0]!.why);
    expect(notification.readAt).toBeNull();
  });
});
