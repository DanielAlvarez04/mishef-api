import { BillingInterval } from '@prisma/client';
import { addInterval, daysUntil, planAmountCents, quoteUpgrade } from './billing.calculator';

const day = 24 * 60 * 60 * 1000;

describe('billing.calculator', () => {
  it('cobra la diferencia al subir de Esencial a Expansión', () => {
    const now = new Date('2026-11-17T12:00:00.000Z');
    const quote = quoteUpgrade({
      current: {
        interval: BillingInterval.MONTH,
        quantity: 1,
        unitAmount: 499,
        currentPeriodStart: new Date(now.getTime() - 15 * day),
        currentPeriodEnd: new Date(now.getTime() + 15 * day),
      },
      targetPlan: { priceMonthly: 799, priceYearly: 7990, perBranch: false },
      targetInterval: BillingInterval.MONTH,
      activeBranches: 1,
      now,
    });

    expect(quote.targetAmountCents).toBe(79900);
    expect(quote.creditCents).toBe(24950);
    expect(quote.amountDueCents).toBe(54950);
    expect(quote.daysRemaining).toBe(15);
  });

  it('multiplica el precio por sucursal en Expansión', () => {
    const quote = quoteUpgrade({
      current: {
        interval: BillingInterval.MONTH,
        quantity: 1,
        unitAmount: 499,
        currentPeriodStart: null,
        currentPeriodEnd: null,
      },
      targetPlan: { priceMonthly: 799, priceYearly: 7990, perBranch: true },
      targetInterval: BillingInterval.MONTH,
      activeBranches: 3,
      now: new Date('2026-11-17T12:00:00.000Z'),
    });

    expect(quote.quantity).toBe(3);
    expect(quote.targetAmountCents).toBe(79900 * 3);
  });

  it('usa el periodo real para el crédito de un plan anual', () => {
    const now = new Date('2026-11-17T12:00:00.000Z');
    const quote = quoteUpgrade({
      current: {
        interval: BillingInterval.YEAR,
        quantity: 1,
        unitAmount: 4990,
        currentPeriodStart: new Date(now.getTime() - 182 * day),
        currentPeriodEnd: new Date(now.getTime() + 183 * day),
      },
      targetPlan: { priceMonthly: 799, priceYearly: 7990, perBranch: false },
      targetInterval: BillingInterval.YEAR,
      activeBranches: 1,
      now,
    });

    expect(quote.targetAmountCents).toBe(799000);
    expect(quote.creditCents).toBeGreaterThan(0);
    expect(quote.amountDueCents).toBe(799000 - quote.creditCents);
  });

  it('calcula importes y periodos', () => {
    expect(
      planAmountCents(
        { priceMonthly: 799, priceYearly: 7990, perBranch: true },
        BillingInterval.MONTH,
        2,
      ),
    ).toBe(159800);

    expect(
      addInterval(new Date('2026-01-31T12:00:00.000Z'), BillingInterval.MONTH).getMonth(),
    ).toBeGreaterThanOrEqual(1);

    expect(daysUntil(new Date('2026-11-20T12:00:00.000Z'), new Date('2026-11-17T12:00:00.000Z'))).toBe(3);
  });
});
