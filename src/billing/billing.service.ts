import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BillingInterval,
  OrganizationSubscription,
  Plan,
  PlanChange,
  PlanChangeStatus,
  Prisma,
  Role,
  SubscriptionProvider,
  SubscriptionStatus,
} from '@prisma/client';

import { verifyMercadoPagoSignature } from '../common/webhook-signature';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingClient,
  BillingProviderError,
  MpAuthorizedPayment,
  MpPreapproval,
  isTransientBillingError,
} from './billing.client';
import {
  addInterval,
  centsToAmount,
  daysUntil,
  planAmountCents,
  quoteUpgrade,
  UpgradeQuote,
} from './billing.calculator';
import {
  ChangePlanDto,
  CreatePlanDto,
  ManualSubscriptionDto,
  PlatformOrganizationsQueryDto,
  SubscribeDto,
  UpdatePlanDto,
} from './dto/billing.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 5;

export interface PlanView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceMonthly: number;
  priceYearly: number;
  currency: string;
  perBranch: boolean;
  trialDays: number;
  maxBranches: number | null;
  maxUsersPerBranch: number | null;
  maxImagesPerItem: number;
  maxVideosPerItem: number;
  maxStorageBytes: number | null;
  maxInventoryItems: number | null;
  customDomain: boolean;
  isActive: boolean;
  isPublic: boolean;
  sortOrder: number;
  features: unknown;
}

export interface BillingUsage {
  branches: number;
  users: number;
  storageBytes: number;
}

export interface SubscriptionView {
  id: string;
  status: SubscriptionStatus;
  provider: SubscriptionProvider;
  interval: BillingInterval;
  quantity: number;
  unitAmount: number;
  currency: string;
  providerPreapprovalId: string | null;
  payerEmail: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  canceledAt: string | null;
  pausedAt: string | null;
  creditBalanceCents: number;
  plan: PlanView;
  usage: BillingUsage;
  daysLeft: number;
  canWrite: boolean;
  isLegacy: boolean;
  nextChargeAt: string | null;
}

export interface UpgradeQuoteView extends UpgradeQuote {
  currentPlan: PlanView;
  targetPlan: PlanView;
  currentTotalCents: number;
}

export interface PlatformOrganizationRow {
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  isActive: boolean;
  createdAt: Date;
  plan: PlanView | null;
  status: SubscriptionStatus | null;
  provider: SubscriptionProvider | null;
  interval: BillingInterval | null;
  quantity: number;
  currentPeriodEnd: Date | null;
  trialEndsAt: Date | null;
  graceEndsAt: Date | null;
  branches: number;
  users: number;
  storageBytes: number;
}

interface WebhookRequest {
  body: unknown;
  headers: {
    signature?: string | string[];
    requestId?: string | string[];
  };
  query: {
    dataId?: string | string[];
    dataIdAlt?: string | string[];
    type?: string | string[];
  };
}

interface WebhookBody {
  action?: string;
  type?: string;
  user_id?: string | number;
  data?: { id?: string | number };
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: BillingClient,
    private readonly config: ConfigService,
  ) {}

  // --------------------------------------------------------------------------
  // Planes
  // --------------------------------------------------------------------------

  async listPlans(includeHidden = false): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      where: includeHidden ? {} : { isActive: true, isPublic: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });

    return plans.map(toPlanView);
  }

  async createPlan(dto: CreatePlanDto, actorUserId: string): Promise<PlanView> {
    const existing = await this.prisma.plan.findUnique({
      where: { code: dto.code },
      select: { id: true },
    });

    if (existing) {
      throw new BadRequestException('Ya existe un plan con ese código');
    }

    const plan = await this.prisma.plan.create({
      data: {
        code: dto.code,
        name: dto.name.trim(),
        description: dto.description?.trim() || null,
        priceMonthly: new Prisma.Decimal(dto.priceMonthly),
        priceYearly: new Prisma.Decimal(dto.priceYearly),
        currency: dto.currency?.toUpperCase() || 'MXN',
        perBranch: dto.perBranch ?? false,
        trialDays: dto.trialDays ?? 14,
        maxBranches: dto.maxBranches ?? null,
        maxUsersPerBranch: dto.maxUsersPerBranch ?? null,
        maxImagesPerItem: dto.maxImagesPerItem ?? 1,
        maxVideosPerItem: dto.maxVideosPerItem ?? 0,
        maxStorageBytes:
          dto.maxStorageBytes === undefined || dto.maxStorageBytes === null
            ? null
            : BigInt(dto.maxStorageBytes),
        maxInventoryItems: dto.maxInventoryItems ?? null,
        customDomain: dto.customDomain ?? false,
        isActive: dto.isActive ?? true,
        isPublic: dto.isPublic ?? true,
        sortOrder: dto.sortOrder ?? 0,
        features:
          dto.features === undefined
            ? undefined
            : dto.features === null
              ? Prisma.JsonNull
              : (dto.features as Prisma.InputJsonValue),
      },
    });

    await this.audit(actorUserId, 'billing.plan_created', plan.id, null, plan);
    return toPlanView(plan);
  }

  async updatePlan(
    planId: string,
    dto: UpdatePlanDto,
    actorUserId: string,
  ): Promise<PlanView> {
    const current = await this.prisma.plan.findUnique({ where: { id: planId } });

    if (!current) throw new NotFoundException('Plan no encontrado');

    if (dto.code && dto.code !== current.code) {
      const taken = await this.prisma.plan.findUnique({
        where: { code: dto.code },
        select: { id: true },
      });
      if (taken) throw new BadRequestException('Ese código de plan ya existe');
    }

    const data: Prisma.PlanUpdateInput = {};

    if (dto.code !== undefined && dto.code !== current.code) data.code = dto.code;
    if (dto.name !== undefined && dto.name.trim() !== current.name) data.name = dto.name.trim();
    if (dto.description !== undefined) {
      const description = dto.description?.trim() || null;
      if (description !== current.description) data.description = description;
    }
    if (dto.priceMonthly !== undefined && Number(current.priceMonthly) !== dto.priceMonthly) {
      data.priceMonthly = new Prisma.Decimal(dto.priceMonthly);
    }
    if (dto.priceYearly !== undefined && Number(current.priceYearly) !== dto.priceYearly) {
      data.priceYearly = new Prisma.Decimal(dto.priceYearly);
    }
    if (dto.currency !== undefined && dto.currency.toUpperCase() !== current.currency) {
      data.currency = dto.currency.toUpperCase();
    }
    if (dto.perBranch !== undefined && dto.perBranch !== current.perBranch) data.perBranch = dto.perBranch;
    if (dto.trialDays !== undefined && dto.trialDays !== current.trialDays) data.trialDays = dto.trialDays;
    if (dto.maxBranches !== undefined && dto.maxBranches !== current.maxBranches) data.maxBranches = dto.maxBranches;
    if (dto.maxUsersPerBranch !== undefined && dto.maxUsersPerBranch !== current.maxUsersPerBranch) {
      data.maxUsersPerBranch = dto.maxUsersPerBranch;
    }
    if (dto.maxImagesPerItem !== undefined && dto.maxImagesPerItem !== current.maxImagesPerItem) {
      data.maxImagesPerItem = dto.maxImagesPerItem;
    }
    if (dto.maxVideosPerItem !== undefined && dto.maxVideosPerItem !== current.maxVideosPerItem) {
      data.maxVideosPerItem = dto.maxVideosPerItem;
    }
    if (dto.maxStorageBytes !== undefined) {
      const next =
        dto.maxStorageBytes === null ? null : BigInt(dto.maxStorageBytes);
      if (next !== current.maxStorageBytes) data.maxStorageBytes = next;
    }
    if (dto.maxInventoryItems !== undefined && dto.maxInventoryItems !== current.maxInventoryItems) {
      data.maxInventoryItems = dto.maxInventoryItems;
    }
    if (dto.customDomain !== undefined && dto.customDomain !== current.customDomain) data.customDomain = dto.customDomain;
    if (dto.isActive !== undefined && dto.isActive !== current.isActive) data.isActive = dto.isActive;
    if (dto.isPublic !== undefined && dto.isPublic !== current.isPublic) data.isPublic = dto.isPublic;
    if (dto.sortOrder !== undefined && dto.sortOrder !== current.sortOrder) data.sortOrder = dto.sortOrder;
    if (dto.features !== undefined) {
      data.features =
        dto.features === null
          ? Prisma.JsonNull
          : (dto.features as Prisma.InputJsonValue);
    }

    if (Object.keys(data).length === 0) return toPlanView(current);

    const updated = await this.prisma.plan.update({
      where: { id: planId },
      data,
    });

    await this.audit(actorUserId, 'billing.plan_updated', planId, current, updated);
    return toPlanView(updated);
  }

  // --------------------------------------------------------------------------
  // Suscripción del negocio
  // --------------------------------------------------------------------------

  async ensureSubscription(organizationId: string): Promise<OrganizationSubscription> {
    const existing = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
    });

    if (existing) return existing;

    const plan =
      (await this.prisma.plan.findUnique({ where: { code: 'esencial' } })) ??
      (await this.prisma.plan.findFirst({
        where: { isActive: true, isPublic: true },
        orderBy: { sortOrder: 'asc' },
      }));

    if (!plan) {
      throw new ServiceUnavailableException(
        'No hay planes configurados para iniciar la prueba',
      );
    }

    const now = new Date();
    return this.prisma.organizationSubscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: SubscriptionStatus.TRIALING,
        provider: SubscriptionProvider.MANUAL,
        interval: BillingInterval.MONTH,
        quantity: 1,
        unitAmount: plan.priceMonthly,
        currency: plan.currency,
        trialEndsAt: new Date(now.getTime() + plan.trialDays * DAY_MS),
      },
    });
  }

  async startTrial(organizationId: string, planCode = 'esencial') {
    const existing = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
    });

    if (existing) return this.getSubscription(organizationId);

    const plan = await this.prisma.plan.findUnique({ where: { code: planCode } });

    if (!plan) throw new NotFoundException('Plan no encontrado');

    const now = new Date();

    await this.prisma.organizationSubscription.create({
      data: {
        organizationId,
        planId: plan.id,
        status: SubscriptionStatus.TRIALING,
        provider: SubscriptionProvider.MANUAL,
        interval: BillingInterval.MONTH,
        quantity: 1,
        unitAmount: plan.priceMonthly,
        currency: plan.currency,
        trialEndsAt: new Date(now.getTime() + plan.trialDays * DAY_MS),
      },
    });

    return this.getSubscription(organizationId);
  }

  async getSubscription(organizationId: string): Promise<SubscriptionView> {
    await this.ensureSubscription(organizationId);

    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });

    if (
      subscription.status === SubscriptionStatus.TRIALING &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt <= new Date()
    ) {
      const hasPreapproval = Boolean(subscription.providerPreapprovalId);
      const updated = await this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: hasPreapproval
          ? {
              status: SubscriptionStatus.PAST_DUE,
              graceEndsAt:
                subscription.graceEndsAt ??
                new Date(Date.now() + GRACE_DAYS * DAY_MS),
            }
          : { status: SubscriptionStatus.EXPIRED },
        include: { plan: true },
      });

      const [branches, users, organization] = await Promise.all([
        this.prisma.branch.count({ where: { organizationId, isActive: true } }),
        this.prisma.membership.count({
          where: { organizationId, isActive: true, user: { isActive: true } },
        }),
        this.prisma.organization.findUniqueOrThrow({
          where: { id: organizationId },
          select: { storageBytes: true },
        }),
      ]);

      return this.toSubscriptionView(updated, {
        branches,
        users,
        storageBytes: Number(organization.storageBytes ?? 0n),
      });
    }

    const [branches, users, organization] = await Promise.all([
      this.prisma.branch.count({ where: { organizationId, isActive: true } }),
      this.prisma.membership.count({
        where: { organizationId, isActive: true, user: { isActive: true } },
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { storageBytes: true },
      }),
    ]);

    return this.toSubscriptionView(subscription, {
      branches,
      users,
      storageBytes: Number(organization.storageBytes ?? 0n),
    });
  }

  async getUpgradeQuote(
    organizationId: string,
    planCode: string,
    interval: BillingInterval,
  ): Promise<UpgradeQuoteView> {
    const { subscription, targetPlan, activeBranches } =
      await this.loadChangeContext(organizationId, planCode);

    const currentTotalCents = planAmountCents(
      subscription.plan,
      subscription.interval,
      subscription.quantity,
    );
    const quote = quoteUpgrade({
      current: {
        interval: subscription.interval,
        quantity: subscription.quantity,
        unitAmount: subscription.unitAmount,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      targetPlan,
      targetInterval: interval,
      activeBranches,
    });

    if (quote.targetAmountCents <= currentTotalCents) {
      throw new BadRequestException(
        'Para cambiar a un plan menor, espera al final del periodo actual.',
      );
    }

    return {
      ...quote,
      currentPlan: toPlanView(subscription.plan),
      targetPlan: toPlanView(targetPlan),
      currentTotalCents,
    };
  }

  async subscribe(
    organizationId: string,
    dto: SubscribeDto,
  ): Promise<{ initPoint: string; preapprovalId: string; quote: UpgradeQuoteView }> {
    await this.ensureSubscription(organizationId);

    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });
    const targetPlan = await this.prisma.plan.findUnique({
      where: { code: dto.planCode },
    });

    if (!targetPlan || !targetPlan.isActive) {
      throw new NotFoundException('Plan no encontrado o inactivo');
    }

    if (
      subscription.providerPreapprovalId &&
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.PAST_DUE)
    ) {
      throw new BadRequestException(
        'Ya tienes una suscripción activa. Usa el cambio de plan.',
      );
    }

    // Doble clic o reintento: se reutiliza el checkout pendiente en lugar de
    // crear otra preapproval (que cobraría dos veces).
    const reusable = await this.findReusableChange(
      subscription.id,
      targetPlan.id,
      dto.interval,
    );

    if (reusable) {
      const initPoint = await this.resumeChangeCheckout(reusable);

      if (initPoint) {
        const startAt = reusable.effectiveAt ?? new Date();

        return {
          initPoint,
          preapprovalId: reusable.providerPreapprovalId!,
          quote: {
            creditCents: reusable.creditCents,
            amountDueCents: reusable.amountDueCents,
            carryOverCents: 0,
            targetAmountCents: reusable.amountDueCents,
            quantity: reusable.quantity,
            daysRemaining: 0,
            newPeriodStart: startAt,
            newPeriodEnd: addInterval(startAt, reusable.interval),
            currentPlan: toPlanView(subscription.plan),
            targetPlan: toPlanView(targetPlan),
            currentTotalCents: planAmountCents(
              subscription.plan,
              subscription.interval,
              subscription.quantity,
            ),
          },
        };
      }
    }

    // Si había un cambio pendiente hacia otro plan, se cancela antes de crear
    // el nuevo: no deben quedar dos preapprovals vivas.
    await this.cancelPendingChanges(subscription.id);

    const activeBranches = await this.prisma.branch.count({
      where: { organizationId, isActive: true },
    });

    const quantity = targetPlan.perBranch ? Math.max(1, activeBranches) : 1;
    const amountCents = planAmountCents(targetPlan, dto.interval, quantity);
    const currentTotalCents = planAmountCents(
      subscription.plan,
      subscription.interval,
      subscription.quantity,
    );
    const now = new Date();
    const startAt =
      subscription.status === SubscriptionStatus.TRIALING &&
      subscription.trialEndsAt &&
      subscription.trialEndsAt > now
        ? subscription.trialEndsAt
        : now;

    const change = await this.prisma.planChange.create({
      data: {
        subscriptionId: subscription.id,
        fromPlanId: subscription.planId,
        toPlanId: targetPlan.id,
        interval: dto.interval,
        quantity,
        creditCents: 0,
        amountDueCents: amountCents,
        status: PlanChangeStatus.PENDING,
        effectiveAt: startAt,
      },
    });

    const preapproval = await this.createPreapproval({
      organizationId,
      plan: targetPlan,
      interval: dto.interval,
      amountCents,
      payerEmail: dto.payerEmail,
      startAt,
      metadata: { kind: 'subscribe', planChangeId: change.id },
      idempotencyKey: change.id,
    });

    await this.prisma.$transaction([
      this.prisma.planChange.update({
        where: { id: change.id },
        data: { providerPreapprovalId: preapproval.id },
      }),
      this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          payerEmail: dto.payerEmail,
          provider: SubscriptionProvider.MERCADO_PAGO,
        },
      }),
      this.prisma.organization.update({
        where: { id: organizationId },
        data: { billingEmail: dto.payerEmail },
      }),
    ]);

    return {
      initPoint: this.initPoint(preapproval),
      preapprovalId: preapproval.id,
      quote: {
        creditCents: 0,
        amountDueCents: amountCents,
        carryOverCents: 0,
        targetAmountCents: amountCents,
        quantity,
        daysRemaining: 0,
        newPeriodStart: startAt,
        newPeriodEnd: addInterval(startAt, dto.interval),
        currentPlan: toPlanView(subscription.plan),
        targetPlan: toPlanView(targetPlan),
        currentTotalCents,
      },
    };
  }

  async changePlan(
    organizationId: string,
    dto: ChangePlanDto,
  ): Promise<{
    initPoint: string | null;
    preapprovalId: string | null;
    quote: UpgradeQuoteView;
    applied: boolean;
  }> {
    const quote = await this.getUpgradeQuote(
      organizationId,
      dto.planCode,
      dto.interval,
    );
    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });
    const targetPlan = await this.prisma.plan.findUniqueOrThrow({
      where: { code: dto.planCode },
    });

    if (quote.amountDueCents <= 0) {
      throw new BadRequestException(
        'El crédito cubre el cambio; contacta a soporte para aplicarlo.',
      );
    }

    const reusable = await this.findReusableChange(
      subscription.id,
      targetPlan.id,
      dto.interval,
    );

    if (reusable) {
      const initPoint = await this.resumeChangeCheckout(reusable);

      if (initPoint) {
        return {
          initPoint,
          preapprovalId: reusable.providerPreapprovalId,
          quote,
          applied: false,
        };
      }
    }

    const payerEmail =
      subscription.payerEmail ?? (await this.billingEmail(organizationId));

    if (!payerEmail) {
      throw new BadRequestException(
        'Agrega un correo de facturación antes de cambiar de plan.',
      );
    }

    await this.cancelPendingChanges(subscription.id);

    const change = await this.prisma.planChange.create({
      data: {
        subscriptionId: subscription.id,
        fromPlanId: subscription.planId,
        toPlanId: targetPlan.id,
        interval: dto.interval,
        quantity: quote.quantity,
        creditCents: quote.creditCents,
        amountDueCents: quote.amountDueCents,
        previousPreapprovalId: subscription.providerPreapprovalId,
        status: PlanChangeStatus.PENDING,
        effectiveAt: quote.newPeriodStart,
      },
    });

    const preapproval = await this.createPreapproval({
      organizationId,
      plan: targetPlan,
      interval: dto.interval,
      amountCents: quote.amountDueCents,
      payerEmail,
      startAt: quote.newPeriodStart,
      metadata: { kind: 'change_plan', planChangeId: change.id },
      idempotencyKey: change.id,
    });

    await this.prisma.planChange.update({
      where: { id: change.id },
      data: { providerPreapprovalId: preapproval.id },
    });

    return {
      initPoint: this.initPoint(preapproval),
      preapprovalId: preapproval.id,
      quote,
      applied: false,
    };
  }

  async cancel(organizationId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
      include: { plan: true },
    });

    if (subscription.providerPreapprovalId) {
      try {
        await this.client.cancelPreapproval(
          subscription.providerPreapprovalId,
        );
      } catch (error) {
        // 400/404: Mercado Pago ya no tiene una preapproval viva; se puede
        // cerrar localmente. Un timeout o 5xx significa que podría seguir
        // cobrando: se aborta para no dejarla activa "invisible".
        if (
          error instanceof BillingProviderError &&
          (error.status === 400 || error.status === 404)
        ) {
          this.logger.warn(
            `Mercado Pago ya no tenía la preapproval ${subscription.providerPreapprovalId}: ${error.message}`,
          );
        } else {
          throw new ServiceUnavailableException(
            'No se pudo cancelar el cobro automático en Mercado Pago. La suscripción no cambió; vuelve a intentarlo.',
          );
        }
      }
    }

    await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.CANCELED, canceledAt: new Date() },
    });

    return this.getSubscription(organizationId);
  }

  async pause(organizationId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
    });

    if (!subscription.providerPreapprovalId) {
      throw new BadRequestException('La suscripción no tiene cobro automático');
    }

    await this.client.pausePreapproval(subscription.providerPreapprovalId);
    await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.PAUSED, pausedAt: new Date() },
    });

    return this.getSubscription(organizationId);
  }

  async resume(organizationId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.organizationSubscription.findUniqueOrThrow({
      where: { organizationId },
    });

    if (!subscription.providerPreapprovalId) {
      throw new BadRequestException('La suscripción no tiene cobro automático');
    }

    await this.client.resumePreapproval(subscription.providerPreapprovalId);
    await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { status: SubscriptionStatus.ACTIVE, pausedAt: null },
    });

    return this.getSubscription(organizationId);
  }

  async sync(organizationId: string): Promise<SubscriptionView> {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) throw new NotFoundException('Suscripción no encontrada');

    const pendingChange = await this.prisma.planChange.findFirst({
      where: {
        subscriptionId: subscription.id,
        status: PlanChangeStatus.PENDING,
        providerPreapprovalId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    const preapprovalId =
      pendingChange?.providerPreapprovalId ??
      subscription.providerPreapprovalId;

    if (!preapprovalId) return this.getSubscription(organizationId);

    const preapproval = await this.client.getPreapproval(preapprovalId);
    await this.applyPreapproval(organizationId, preapproval);

    return this.getSubscription(organizationId);
  }

  async listPayments(organizationId: string) {
    return this.prisma.subscriptionPayment.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Ajusta la cantidad de sucursales de un plan por sucursal.
   *
   * Se llama al crear/desactivar una sucursal. Si la suscripción ya tiene
   * cobro automático, el siguiente cargo usará el nuevo total.
   */
  async refreshQuantity(organizationId: string): Promise<void> {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription || !subscription.plan.perBranch) return;

    const branches = await this.prisma.branch.count({
      where: { organizationId, isActive: true },
    });
    const quantity = Math.max(1, branches);

    if (quantity === subscription.quantity) return;

    await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data: { quantity },
    });

    if (
      subscription.providerPreapprovalId &&
      (subscription.status === SubscriptionStatus.ACTIVE ||
        subscription.status === SubscriptionStatus.PAST_DUE)
    ) {
      const amount = planAmountCents(
        subscription.plan,
        subscription.interval,
        quantity,
      );

      await this.client
        .updatePreapproval(subscription.providerPreapprovalId, {
          auto_recurring: {
            transaction_amount: centsToAmount(amount),
            currency_id: subscription.plan.currency,
          },
        })
        .catch((error) =>
          this.logger.warn(
            `No se pudo ajustar el cobro por sucursal: ${
              (error as Error).message
            }`,
          ),
        );
    }
  }

  async getEntitlements(organizationId: string) {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) return null;

    return {
      plan: toPlanView(subscription.plan),
      status: subscription.status,
      canWrite: canWrite(subscription),
      currentPeriodEnd: subscription.currentPeriodEnd,
      trialEndsAt: subscription.trialEndsAt,
      graceEndsAt: subscription.graceEndsAt,
      isLegacy: subscription.plan.code === 'legacy',
    };
  }

  async canWrite(organizationId: string): Promise<boolean> {
    const entitlements = await this.getEntitlements(organizationId);
    return entitlements?.canWrite ?? true;
  }

  // --------------------------------------------------------------------------
  // Webhook de suscripciones
  // --------------------------------------------------------------------------

  async handleWebhook(request: WebhookRequest) {
    const secret = this.client.webhookSecret;

    if (!secret) {
      throw new ServiceUnavailableException(
        'El webhook de suscripciones no está configurado',
      );
    }

    const body = (request.body ?? {}) as WebhookBody;
    const dataId =
      first(request.query.dataId) ??
      first(request.query.dataIdAlt) ??
      (body.data?.id !== undefined ? String(body.data.id) : undefined);
    const topic = first(request.query.type) ?? body.type ?? 'unknown';

    if (!dataId) return { ok: true, ignored: 'missing_data_id' };

    const signature = verifyMercadoPagoSignature({
      secret,
      signature: first(request.headers.signature),
      requestId: first(request.headers.requestId),
      dataId,
      maxSkewSeconds: this.client.webhookMaxSkewSeconds,
    });

    if (!signature.valid) {
      this.logger.warn(
        `Firma de webhook de suscripción inválida (${signature.reason}) para ${topic} ${dataId}`,
      );
      throw new UnauthorizedException(
        'Firma de notificación de suscripción inválida',
      );
    }

    if (
      ![
        'subscription_preapproval',
        'subscription_authorized_payment',
        'subscription_preapproval_plan',
      ].includes(topic)
    ) {
      return { ok: true, ignored: `topic_${topic}` };
    }

    const registered = await this.registerEvent({
      requestId: first(request.headers.requestId),
      topic,
      providerId: dataId,
      payload: body,
    });

    if (registered.duplicate) return { ok: true, duplicated: true };

    const event = registered.event;

    try {
      if (topic === 'subscription_preapproval') {
        const preapproval = await this.client.getPreapproval(dataId);
        await this.applyPreapproval(
          preapproval.external_reference ?? '',
          preapproval,
        );
      } else if (topic === 'subscription_authorized_payment') {
        const payment = await this.client.getAuthorizedPayment(dataId);
        await this.applyAuthorizedPayment(payment);
      }

      await this.markEvent(event.id, null);
      return { ok: true };
    } catch (error) {
      if (isTransientBillingError(error)) {
        // Se deja `processedAt` vacío para que el reintento de Mercado Pago
        // vuelva a procesar el evento; el 5xx es lo que dispara el reintento.
        await this.markEvent(event.id, (error as Error).message, false);

        this.logger.warn(
          `Webhook de suscripción transitorio (${dataId}), se reintentará: ${
            (error as Error).message
          }`,
        );

        throw new ServiceUnavailableException(
          'Mercado Pago no pudo procesar la notificación en este momento',
        );
      }

      await this.markEvent(event.id, (error as Error).message, true);

      this.logger.warn(
        `Webhook de suscripción procesado con error (${dataId}): ${
          (error as Error).message
        }`,
      );

      return { ok: false };
    }
  }

  // --------------------------------------------------------------------------
  // Panel de plataforma
  // --------------------------------------------------------------------------

  async listPlatformOrganizations(
    query: PlatformOrganizationsQueryDto,
  ): Promise<PlatformOrganizationRow[]> {
    const search = query.search?.trim();
    const where: Prisma.OrganizationWhereInput = {
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
              { domain: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.status
        ? { subscription: { is: { status: query.status } } }
        : {}),
      ...(query.planCode
        ? { subscription: { is: { plan: { is: { code: query.planCode } } } } }
        : {}),
    };

    const organizations = await this.prisma.organization.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        subscription: { include: { plan: true } },
        _count: {
          select: {
            branches: true,
            memberships: true,
          },
        },
      },
      take: 500,
    });

    return organizations.map((organization) => ({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      domain: organization.domain,
      isActive: organization.isActive,
      createdAt: organization.createdAt,
      plan: organization.subscription
        ? toPlanView(organization.subscription.plan)
        : null,
      status: organization.subscription?.status ?? null,
      provider: organization.subscription?.provider ?? null,
      interval: organization.subscription?.interval ?? null,
      quantity: organization.subscription?.quantity ?? 1,
      currentPeriodEnd: organization.subscription?.currentPeriodEnd ?? null,
      trialEndsAt: organization.subscription?.trialEndsAt ?? null,
      graceEndsAt: organization.subscription?.graceEndsAt ?? null,
      branches: organization._count.branches,
      users: organization._count.memberships,
      storageBytes: Number(organization.storageBytes ?? 0n),
    }));
  }

  async updateOrganizationSubscription(
    organizationId: string,
    dto: ManualSubscriptionDto,
    actorUserId: string,
  ) {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) throw new NotFoundException('Suscripción no encontrada');

    const data: Prisma.OrganizationSubscriptionUpdateInput = {};
    let providerChanged = false;

    if (dto.planCode !== undefined) {
      const plan = await this.prisma.plan.findUnique({
        where: { code: dto.planCode },
      });
      if (!plan) throw new NotFoundException('Plan no encontrado');

      const interval = dto.interval ?? subscription.interval;
      const quantity = plan.perBranch
        ? Math.max(
            1,
            await this.prisma.branch.count({
              where: { organizationId, isActive: true },
            }),
          )
        : 1;
      const planChanged = plan.id !== subscription.planId;
      const intervalChanged = interval !== subscription.interval;
      const quantityChanged =
        (dto.quantity ?? quantity) !== subscription.quantity;

      if (planChanged) {
        data.plan = { connect: { id: plan.id } };
        data.currency = plan.currency;
        providerChanged = true;
      }

      if (planChanged || intervalChanged) {
        data.interval = interval;
        data.unitAmount =
          interval === BillingInterval.YEAR
            ? plan.priceYearly
            : plan.priceMonthly;
        providerChanged = true;
      }

      if (planChanged || quantityChanged) {
        data.quantity = dto.quantity ?? quantity;
        providerChanged = true;
      }
    }

    if (dto.status !== undefined && dto.status !== subscription.status) {
      data.status = dto.status;
      providerChanged = true;
    }

    if (
      dto.interval !== undefined &&
      dto.interval !== subscription.interval &&
      dto.planCode === undefined
    ) {
      data.interval = dto.interval;
      data.unitAmount =
        dto.interval === BillingInterval.YEAR
          ? subscription.plan.priceYearly
          : subscription.plan.priceMonthly;
      providerChanged = true;
    }

    if (
      dto.quantity !== undefined &&
      dto.quantity !== subscription.quantity &&
      dto.planCode === undefined
    ) {
      data.quantity = dto.quantity;
      providerChanged = true;
    }
    if (dto.payerEmail !== undefined) data.payerEmail = dto.payerEmail;
    if (dto.currentPeriodEnd !== undefined) {
      data.currentPeriodEnd = dto.currentPeriodEnd
        ? new Date(dto.currentPeriodEnd)
        : null;
    }
    if (dto.trialEndsAt !== undefined) {
      data.trialEndsAt = dto.trialEndsAt ? new Date(dto.trialEndsAt) : null;
    }
    if (dto.graceEndsAt !== undefined) {
      data.graceEndsAt = dto.graceEndsAt ? new Date(dto.graceEndsAt) : null;
    }

    if (providerChanged && subscription.providerPreapprovalId) {
      try {
        await this.client.cancelPreapproval(
          subscription.providerPreapprovalId,
        );
      } catch (error) {
        if (
          error instanceof BillingProviderError &&
          (error.status === 400 || error.status === 404)
        ) {
          this.logger.warn(
            `Mercado Pago ya no tenía la preapproval ${subscription.providerPreapprovalId}: ${error.message}`,
          );
        } else {
          throw new ServiceUnavailableException(
            'No se pudo cancelar el cobro anterior en Mercado Pago. La suscripción no cambió; vuelve a intentarlo.',
          );
        }
      }

      data.providerPreapprovalId = null;
      data.provider = SubscriptionProvider.MANUAL;
    }

    const updated = await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data,
      include: { plan: true },
    });

    await this.audit(
      actorUserId,
      'billing.subscription_overridden',
      subscription.id,
      subscription,
      updated,
      organizationId,
    );

    return this.getSubscription(organizationId);
  }

  async listPlatformPayments() {
    return this.prisma.subscriptionPayment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        subscription: {
          include: {
            organization: { select: { id: true, name: true, slug: true } },
            plan: { select: { name: true, code: true } },
          },
        },
      },
    });
  }

  // --------------------------------------------------------------------------
  // Internos
  // --------------------------------------------------------------------------

  private async loadChangeContext(organizationId: string, planCode: string) {
    const subscription = await this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });

    if (!subscription) throw new NotFoundException('Suscripción no encontrada');

    const targetPlan = await this.prisma.plan.findUnique({
      where: { code: planCode },
    });

    if (!targetPlan || !targetPlan.isActive) {
      throw new NotFoundException('Plan no encontrado o inactivo');
    }

    if (targetPlan.id === subscription.planId) {
      throw new BadRequestException('Ya tienes ese plan');
    }

    const activeBranches = await this.prisma.branch.count({
      where: { organizationId, isActive: true },
    });

    return { subscription, targetPlan, activeBranches };
  }

  private async createPreapproval(params: {
    organizationId: string;
    plan: Plan;
    interval: BillingInterval;
    amountCents: number;
    payerEmail: string;
    startAt: Date;
    metadata: Record<string, unknown>;
    idempotencyKey: string;
  }) {
    if (!this.client.isConfigured) {
      throw new ServiceUnavailableException(
        'La facturación con Mercado Pago no está configurada',
      );
    }

    const webOrigin = (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
    const backUrl =
      this.config.get<string>('MP_BILLING_BACK_URL') ?? `${webOrigin}/billing`;
    const startAt =
      params.startAt.getTime() > Date.now() + 60_000
        ? params.startAt
        : new Date(Date.now() + 60_000);

    return this.client.createPreapproval(
      {
        reason: `Mishef ${params.plan.name}`,
        external_reference: params.organizationId,
        payer_email: params.payerEmail,
        back_url: backUrl,
        status: 'pending',
        metadata: params.metadata,
        auto_recurring: {
          frequency: params.interval === BillingInterval.YEAR ? 12 : 1,
          frequency_type: 'months',
          transaction_amount: centsToAmount(params.amountCents),
          currency_id: params.plan.currency,
          start_date: startAt.toISOString(),
        },
      },
      params.idempotencyKey,
    );
  }

  /**
   * Un cambio pendiente con el mismo plan e intervalo se reutiliza: el
   * usuario vuelve al mismo checkout en lugar de generar otra preapproval.
   */
  private findReusableChange(
    subscriptionId: string,
    toPlanId: string,
    interval: BillingInterval,
  ): Promise<PlanChange | null> {
    return this.prisma.planChange.findFirst({
      where: {
        subscriptionId,
        toPlanId,
        interval,
        status: PlanChangeStatus.PENDING,
        providerPreapprovalId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Devuelve el link de pago del cambio pendiente, o `null` si Mercado Pago ya
   * lo canceló/rechazó (en ese caso el cambio local se marca como cancelado).
   */
  private async resumeChangeCheckout(
    change: PlanChange,
  ): Promise<string | null> {
    if (!change.providerPreapprovalId) return null;

    let preapproval: MpPreapproval;

    try {
      preapproval = await this.client.getPreapproval(
        change.providerPreapprovalId,
      );
    } catch (error) {
      if (error instanceof BillingProviderError && error.status === 404) {
        await this.prisma.planChange.update({
          where: { id: change.id },
          data: { status: PlanChangeStatus.CANCELED },
        });
        return null;
      }

      throw error;
    }

    if (
      preapproval.status === 'pending' ||
      preapproval.status === 'authorized'
    ) {
      return this.initPoint(preapproval);
    }

    if (
      preapproval.status === 'canceled' ||
      preapproval.status === 'cancelled' ||
      preapproval.status === 'rejected'
    ) {
      await this.prisma.planChange.update({
        where: { id: change.id },
        data: { status: PlanChangeStatus.CANCELED },
      });
      return null;
    }

    return null;
  }

  /**
   * Cancela en Mercado Pago los cambios pendientes que quedaron huérfanos
   * antes de crear uno nuevo. Best-effort: si MP falla, se registra y se
   * continúa para no bloquear al usuario.
   */
  private async cancelPendingChanges(subscriptionId: string): Promise<void> {
    const pending = await this.prisma.planChange.findMany({
      where: {
        subscriptionId,
        status: PlanChangeStatus.PENDING,
      },
      select: { id: true, providerPreapprovalId: true },
    });

    for (const change of pending) {
      if (change.providerPreapprovalId) {
        try {
          await this.client.cancelPreapproval(change.providerPreapprovalId);
        } catch (error) {
          if (
            error instanceof BillingProviderError &&
            (error.status === 400 || error.status === 404)
          ) {
            this.logger.warn(
              `Mercado Pago ya no tenía la preapproval ${change.providerPreapprovalId}: ${error.message}`,
            );
          } else {
            // No se crea otro intento si el anterior podría seguir cobrando.
            throw new ServiceUnavailableException(
              'No se pudo cancelar un intento de pago anterior en Mercado Pago. Vuelve a intentarlo en unos segundos.',
            );
          }
        }
      }
    }

    if (pending.length > 0) {
      await this.prisma.planChange.updateMany({
        where: {
          id: { in: pending.map((change) => change.id) },
          status: PlanChangeStatus.PENDING,
        },
        data: { status: PlanChangeStatus.CANCELED },
      });
    }
  }

  private initPoint(preapproval: MpPreapproval): string {
    const point = this.client.isTestMode
      ? preapproval.sandbox_init_point ?? preapproval.init_point
      : preapproval.init_point;

    if (!point) {
      throw new ServiceUnavailableException(
        'Mercado Pago no devolvió un link de pago para la suscripción',
      );
    }

    return point;
  }

  private async applyPreapproval(
    organizationId: string,
    preapproval: MpPreapproval,
  ) {
    const orgId =
      preapproval.external_reference?.trim() || organizationId.trim();

    if (!orgId) return;

    const pendingChange = await this.prisma.planChange.findFirst({
      where: {
        providerPreapprovalId: preapproval.id,
        status: PlanChangeStatus.PENDING,
      },
      include: { subscription: true, toPlan: true },
      orderBy: { createdAt: 'desc' },
    });

    if (preapproval.status === 'authorized' && pendingChange) {
      // El plan se aplica cuando el primer pago de la suscripción queda
      // aprobado, no solo cuando se autoriza la tarjeta.
      return;
    }

    if (
      (preapproval.status === 'canceled' ||
        preapproval.status === 'cancelled') &&
      pendingChange
    ) {
      await this.prisma.planChange.update({
        where: { id: pendingChange.id },
        data: { status: PlanChangeStatus.CANCELED },
      });
      return;
    }

    const subscription = await this.prisma.organizationSubscription.findFirst({
      where: {
        OR: [
          { providerPreapprovalId: preapproval.id },
          { organizationId: orgId },
        ],
      },
    });

    if (!subscription) return;

    const status = mapPreapprovalStatus(preapproval.status);

    if (!status) return;

    const data: Prisma.OrganizationSubscriptionUpdateInput = {
      status,
      lastSyncedAt: new Date(),
    };

    if (status === SubscriptionStatus.ACTIVE) {
      if (!subscription.currentPeriodStart || !subscription.currentPeriodEnd) {
        const start = preapproval.auto_recurring?.start_date
          ? new Date(preapproval.auto_recurring.start_date)
          : new Date();
        data.currentPeriodStart = start;
        data.currentPeriodEnd = addInterval(start, subscription.interval);
      }
      data.graceEndsAt = null;
      data.canceledAt = null;
      data.pausedAt = null;
    }

    if (status === SubscriptionStatus.PAUSED) {
      data.pausedAt = new Date();
    }

    if (status === SubscriptionStatus.CANCELED) {
      data.canceledAt = new Date();
    }

    await this.prisma.organizationSubscription.update({
      where: { id: subscription.id },
      data,
    });
  }

  private async applyPlanChange(change: PlanChange & { toPlan: Plan }) {
    const now = new Date();
    const interval = change.interval;
    const periodEnd = addInterval(now, interval);

    await this.prisma.$transaction(async (tx) => {
      const subscription = await tx.organizationSubscription.findUniqueOrThrow({
        where: { id: change.subscriptionId },
      });

      await tx.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          planId: change.toPlanId,
          interval,
          quantity: change.quantity,
          unitAmount:
            interval === BillingInterval.YEAR
              ? change.toPlan.priceYearly
              : change.toPlan.priceMonthly,
          currency: change.toPlan.currency,
          status: SubscriptionStatus.ACTIVE,
          provider: SubscriptionProvider.MERCADO_PAGO,
          providerPreapprovalId: change.providerPreapprovalId,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          trialEndsAt: null,
          graceEndsAt: null,
          canceledAt: null,
          pausedAt: null,
          lastSyncedAt: now,
        },
      });

      await tx.planChange.update({
        where: { id: change.id },
        data: {
          status: PlanChangeStatus.PAID,
          appliedAt: now,
          effectiveAt: now,
        },
      });
    });

    if (
      change.previousPreapprovalId &&
      change.previousPreapprovalId !== change.providerPreapprovalId
    ) {
      await this.client
        .cancelPreapproval(change.previousPreapprovalId)
        .catch((error) =>
          this.logger.warn(
            `No se pudo cancelar el cobro anterior: ${
              (error as Error).message
            }`,
          ),
        );
    }
  }

  private async applyAuthorizedPayment(payment: MpAuthorizedPayment) {
    const preapprovalId = payment.preapproval_id;
    if (!preapprovalId) return;

    const pendingChange = await this.prisma.planChange.findFirst({
      where: {
        providerPreapprovalId: preapprovalId,
        status: PlanChangeStatus.PENDING,
      },
      include: { toPlan: true },
      orderBy: { createdAt: 'desc' },
    });

    const subscription = await this.prisma.organizationSubscription.findFirst({
      where: {
        OR: [
          { providerPreapprovalId: preapprovalId },
          ...(pendingChange
            ? [{ id: pendingChange.subscriptionId }]
            : []),
        ],
      },
      include: { plan: true },
    });

    if (!subscription) return;

    const rejected =
      payment.payment?.status === 'rejected' ||
      payment.status === 'rejected' ||
      payment.status === 'recycling';
    const approved =
      !rejected &&
      (payment.payment?.status === 'approved' ||
        payment.status === 'processed' ||
        payment.status === 'approved');

    const now = new Date();
    const interval = pendingChange?.interval ?? subscription.interval;
    const periodStart = payment.debit_date
      ? new Date(payment.debit_date)
      : payment.date_created
        ? new Date(payment.date_created)
        : now;
    const periodEnd = addInterval(periodStart, interval);
    const amountCents = Math.round(Number(payment.transaction_amount ?? 0) * 100);

    if (approved && pendingChange) {
      await this.applyPlanChange(pendingChange);
    }

    if (approved) {
      await this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          graceEndsAt: null,
          canceledAt: null,
          pausedAt: null,
          lastSyncedAt: now,
        },
      });
    }

    if (rejected) {
      await this.prisma.organizationSubscription.update({
        where: { id: subscription.id },
        data: {
          status: SubscriptionStatus.PAST_DUE,
          graceEndsAt: new Date(now.getTime() + GRACE_DAYS * DAY_MS),
          lastSyncedAt: now,
        },
      });
    }

    if (payment.id !== undefined) {
      await this.prisma.subscriptionPayment.upsert({
        where: { providerPaymentId: String(payment.id) },
        create: {
          subscriptionId: subscription.id,
          organizationId: subscription.organizationId,
          kind: pendingChange ? 'PLAN_CHANGE' : 'SUBSCRIPTION',
          status:
            payment.payment?.status ??
            payment.status ??
            (approved ? 'approved' : 'unknown'),
          amountCents,
          currency: payment.currency_id ?? subscription.currency,
          providerPaymentId: String(payment.id),
          periodStart,
          periodEnd,
          paidAt: approved ? now : null,
          raw: payment as unknown as Prisma.InputJsonValue,
        },
        update: {
          status:
            payment.payment?.status ??
            payment.status ??
            (approved ? 'approved' : 'unknown'),
          amountCents,
          paidAt: approved ? now : null,
          raw: payment as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // El primer cargo de un cambio puede ser la diferencia prorrateada.
    // Después de cobrarlo, el cobro recurrente vuelve al precio completo.
    if (approved && pendingChange?.providerPreapprovalId) {
      const targetTotal = planAmountCents(
        pendingChange.toPlan,
        pendingChange.interval,
        pendingChange.quantity,
      );

      await this.client
        .updatePreapproval(pendingChange.providerPreapprovalId, {
          auto_recurring: {
            transaction_amount: centsToAmount(targetTotal),
            currency_id: pendingChange.toPlan.currency,
          },
        })
        .catch((error) =>
          this.logger.warn(
            `No se pudo restaurar el importe recurrente: ${
              (error as Error).message
            }`,
          ),
        );
    }
  }

  private toSubscriptionView(
    subscription: OrganizationSubscription & { plan: Plan },
    usage: BillingUsage,
  ): SubscriptionView {
    const daysLeft =
      subscription.status === SubscriptionStatus.TRIALING
        ? daysUntil(subscription.trialEndsAt)
        : subscription.status === SubscriptionStatus.PAST_DUE
          ? daysUntil(subscription.graceEndsAt)
          : daysUntil(subscription.currentPeriodEnd);

    return {
      id: subscription.id,
      status: subscription.status,
      provider: subscription.provider,
      interval: subscription.interval,
      quantity: subscription.quantity,
      unitAmount: Number(subscription.unitAmount),
      currency: subscription.currency,
      providerPreapprovalId: subscription.providerPreapprovalId,
      payerEmail: subscription.payerEmail,
      currentPeriodStart: subscription.currentPeriodStart?.toISOString() ?? null,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
      trialEndsAt: subscription.trialEndsAt?.toISOString() ?? null,
      graceEndsAt: subscription.graceEndsAt?.toISOString() ?? null,
      canceledAt: subscription.canceledAt?.toISOString() ?? null,
      pausedAt: subscription.pausedAt?.toISOString() ?? null,
      creditBalanceCents: subscription.creditBalanceCents,
      plan: toPlanView(subscription.plan),
      usage,
      daysLeft,
      canWrite: canWrite(subscription),
      isLegacy: subscription.plan.code === 'legacy',
      nextChargeAt:
        subscription.status === SubscriptionStatus.TRIALING
          ? subscription.trialEndsAt?.toISOString() ?? null
          : subscription.currentPeriodEnd?.toISOString() ?? null,
    };
  }

  private async billingEmail(organizationId: string): Promise<string | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { billingEmail: true, memberships: {
        where: { roles: { has: Role.ADMIN }, isActive: true },
        select: { user: { select: { email: true } } },
        take: 1,
      } },
    });

    return (
      organization?.billingEmail ??
      organization?.memberships[0]?.user.email ??
      null
    );
  }

  private async registerEvent(params: {
    requestId: string | undefined;
    topic: string;
    providerId: string;
    payload: WebhookBody;
  }): Promise<{
    event: { id: string; processedAt: Date | null };
    duplicate: boolean;
  }> {
    if (params.requestId) {
      const existing = await this.prisma.billingWebhookEvent.findUnique({
        where: { requestId: params.requestId },
        select: { id: true, processedAt: true },
      });

      if (existing) {
        // Sin `processedAt` el intento anterior fue transitorio: se reprocesa.
        return { event: existing, duplicate: existing.processedAt !== null };
      }
    }

    try {
      const created = await this.prisma.billingWebhookEvent.create({
        data: {
          requestId: params.requestId ?? null,
          topic: params.topic,
          providerId: params.providerId,
          payload: params.payload as Prisma.InputJsonValue,
        },
        select: { id: true, processedAt: true },
      });

      return { event: created, duplicate: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        params.requestId
      ) {
        const existing = await this.prisma.billingWebhookEvent.findUnique({
          where: { requestId: params.requestId },
          select: { id: true, processedAt: true },
        });

        if (existing) {
          return {
            event: existing,
            duplicate: existing.processedAt !== null,
          };
        }
      }

      throw error;
    }
  }

  private async markEvent(
    id: string,
    error: string | null,
    processed = true,
  ): Promise<void> {
    await this.prisma.billingWebhookEvent.update({
      where: { id },
      data: {
        processedAt: processed ? new Date() : null,
        error: error?.slice(0, 500) ?? null,
      },
    });
  }

  private async audit(
    userId: string | null,
    action: string,
    entityId: string,
    oldValues: unknown,
    newValues: unknown,
    organizationId: string | null = null,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId,
        userId,
        action,
        entity: 'Plan',
        entityId,
        oldValues: jsonSafe(oldValues),
        newValues: jsonSafe(newValues),
      },
    });
  }
}

function toPlanView(plan: Plan): PlanView {
  return {
    id: plan.id,
    code: plan.code,
    name: plan.name,
    description: plan.description,
    priceMonthly: Number(plan.priceMonthly),
    priceYearly: Number(plan.priceYearly),
    currency: plan.currency,
    perBranch: plan.perBranch,
    trialDays: plan.trialDays,
    maxBranches: plan.maxBranches,
    maxUsersPerBranch: plan.maxUsersPerBranch,
    maxImagesPerItem: plan.maxImagesPerItem,
    maxVideosPerItem: plan.maxVideosPerItem,
    maxStorageBytes:
      plan.maxStorageBytes === null ? null : Number(plan.maxStorageBytes),
    maxInventoryItems: plan.maxInventoryItems,
    customDomain: plan.customDomain,
    isActive: plan.isActive,
    isPublic: plan.isPublic,
    sortOrder: plan.sortOrder,
    features: plan.features,
  };
}

function canWrite(
  subscription: OrganizationSubscription,
  now = new Date(),
): boolean {
  if (subscription.status === SubscriptionStatus.ACTIVE) {
    return (
      !subscription.currentPeriodEnd ||
      subscription.currentPeriodEnd > now ||
      (subscription.graceEndsAt !== null && subscription.graceEndsAt > now)
    );
  }

  if (subscription.status === SubscriptionStatus.TRIALING) {
    if (!subscription.trialEndsAt || subscription.trialEndsAt > now) {
      return true;
    }

    if (
      subscription.providerPreapprovalId &&
      subscription.trialEndsAt.getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000 >
        now.getTime()
    ) {
      return true;
    }

    return subscription.graceEndsAt !== null && subscription.graceEndsAt > now;
  }

  if (subscription.status === SubscriptionStatus.PAST_DUE) {
    return subscription.graceEndsAt !== null && subscription.graceEndsAt > now;
  }

  if (subscription.status === SubscriptionStatus.CANCELED) {
    return (
      subscription.currentPeriodEnd !== null &&
      subscription.currentPeriodEnd > now
    );
  }

  return false;
}

function mapPreapprovalStatus(
  status: string | undefined,
): SubscriptionStatus | null {
  switch (status) {
    case 'authorized':
      return SubscriptionStatus.ACTIVE;
    case 'paused':
      return SubscriptionStatus.PAUSED;
    case 'canceled':
    case 'cancelled':
      return SubscriptionStatus.CANCELED;
    case 'pending':
      return null;
    default:
      return null;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Convierte BigInt/Date/Decimal a algo aceptado por un campo JSON. */
function jsonSafe(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  ) as Prisma.InputJsonValue;
}
