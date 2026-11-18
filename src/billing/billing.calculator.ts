import { BillingInterval, Plan } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Acepta number, string o Decimal de Prisma. */
type Numeric = number | string | { toString(): string };

type PlanPrices = {
  priceMonthly: Numeric;
  priceYearly: Numeric;
  perBranch: boolean;
};

/** Suma un mes o un año conservando el día cuando es posible. */
export function addInterval(date: Date, interval: BillingInterval): Date {
  const result = new Date(date);
  const day = result.getUTCDate();

  result.setUTCDate(1);

  if (interval === BillingInterval.YEAR) {
    result.setUTCFullYear(result.getUTCFullYear() + 1);
  } else {
    result.setUTCMonth(result.getUTCMonth() + 1);
  }

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));

  return result;
}

/** Días que faltan para una fecha, redondeados hacia arriba. */
export function daysUntil(date: Date | null, now = new Date()): number {
  if (!date) return 0;
  return Math.max(0, Math.ceil((date.getTime() - now.getTime()) / DAY_MS));
}

/** Importe total del plan en centavos, considerando precio por sucursal. */
export function planAmountCents(
  plan: PlanPrices,
  interval: BillingInterval,
  quantity = 1,
): number {
  const unit =
    interval === BillingInterval.YEAR
      ? Number(plan.priceYearly)
      : Number(plan.priceMonthly);
  const units = plan.perBranch ? Math.max(1, quantity) : 1;

  return Math.round(unit * 100) * units;
}

export interface UpgradeQuote {
  /** Valor de los días que le quedan al plan actual. */
  creditCents: number;
  /** Diferencia a cobrar en el primer cargo del nuevo plan. */
  amountDueCents: number;
  /** Si el crédito supera el nuevo plan, queda a favor. */
  carryOverCents: number;
  /** Precio completo del nuevo plan para el periodo. */
  targetAmountCents: number;
  quantity: number;
  daysRemaining: number;
  newPeriodStart: Date;
  newPeriodEnd: Date;
}

/**
 * Calcula el cambio a un plan superior.
 *
 * El crédito se basa en el valor real del periodo pagado (no en un mes fijo):
 * así funciona igual con meses de 28, 30 o 31 días y con planes anuales.
 */
export function quoteUpgrade(params: {
  current: {
    interval: BillingInterval;
    quantity: number;
    unitAmount: Numeric;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
  };
  targetPlan: PlanPrices;
  targetInterval: BillingInterval;
  activeBranches: number;
  now?: Date;
}): UpgradeQuote {
  const now = params.now ?? new Date();
  const quantity = params.targetPlan.perBranch
    ? Math.max(1, params.activeBranches)
    : 1;
  const targetAmountCents = planAmountCents(
    params.targetPlan,
    params.targetInterval,
    quantity,
  );

  let creditCents = 0;
  let daysRemaining = 0;

  const start = params.current.currentPeriodStart;
  const end = params.current.currentPeriodEnd;

  if (start && end && end > now && end > start) {
    const totalCents =
      Math.round(Number(params.current.unitAmount) * 100) *
      Math.max(1, params.current.quantity);
    const totalMs = end.getTime() - start.getTime();
    const remainingMs = end.getTime() - now.getTime();

    creditCents = Math.round(totalCents * (remainingMs / totalMs));
    daysRemaining = daysUntil(end, now);
  }

  creditCents = Math.max(0, Math.min(creditCents, targetAmountCents));
  const amountDueCents = Math.max(0, targetAmountCents - creditCents);
  const carryOverCents = Math.max(0, creditCents - targetAmountCents);

  return {
    creditCents,
    amountDueCents,
    carryOverCents,
    targetAmountCents,
    quantity,
    daysRemaining,
    newPeriodStart: now,
    newPeriodEnd: addInterval(now, params.targetInterval),
  };
}

/** Convierte centavos a número con dos decimales para Mercado Pago. */
export function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}
