import 'dotenv/config';

import { hash } from 'argon2';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Crea o actualiza la cuenta interna de la plataforma.
 *
 * Uso:
 *   PLATFORM_ADMIN_EMAIL=dalvarez@mishef.co \
 *   PLATFORM_ADMIN_PASSWORD='...' \
 *   npx ts-node scripts/create-platform-admin.ts
 *
 * La contraseña solo se usa en memoria; no se guarda en el repositorio.
 */
async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME?.trim() || 'Plataforma Mishef';

  if (!email) {
    throw new Error('Falta PLATFORM_ADMIN_EMAIL');
  }

  if (password !== undefined && password.length < 8) {
    throw new Error('PLATFORM_ADMIN_PASSWORD debe tener al menos 8 caracteres');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL ?? '',
    }),
  });

  try {
    const organization = await prisma.organization.upsert({
      where: { slug: 'mishef-platform' },
      create: {
        name: 'Mishef',
        slug: 'mishef-platform',
        isActive: true,
        billingEmail: email,
      },
      update: {
        name: 'Mishef',
        isActive: true,
        billingEmail: email,
      },
    });

    const existing = await prisma.user.findUnique({ where: { email } });
    const passwordHash = password ? await hash(password) : undefined;

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            isPlatformAdmin: true,
            isActive: true,
            emailVerified: true,
            twoFactorEnabled: true,
            onboardedAt: existing.onboardedAt ?? new Date(),
            ...(passwordHash ? { passwordHash } : {}),
          },
        })
      : await prisma.user.create({
          data: {
            email,
            name,
            ...(passwordHash ? { passwordHash } : {}),
            isActive: true,
            emailVerified: true,
            twoFactorEnabled: true,
            onboardedAt: new Date(),
            isPlatformAdmin: true,
          },
        });

    await prisma.membership.upsert({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: organization.id,
        },
      },
      create: {
        userId: user.id,
        organizationId: organization.id,
        roles: ['ADMIN'],
        isActive: true,
      },
      update: {
        roles: ['ADMIN'],
        isActive: true,
      },
    });

    const legacy = await prisma.plan.findUnique({
      where: { code: 'legacy' },
    });

    if (legacy) {
      await prisma.organizationSubscription.upsert({
        where: { organizationId: organization.id },
        create: {
          organizationId: organization.id,
          planId: legacy.id,
          status: 'ACTIVE',
          provider: 'MANUAL',
          interval: 'MONTH',
          quantity: 1,
          unitAmount: 0,
          currency: 'MXN',
          payerEmail: email,
        },
        update: {
          planId: legacy.id,
          status: 'ACTIVE',
          provider: 'MANUAL',
          payerEmail: email,
        },
      });
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          email: user.email,
          userId: user.id,
          organizationId: organization.id,
          organizationSlug: organization.slug,
          isPlatformAdmin: user.isPlatformAdmin,
          twoFactorEnabled: user.twoFactorEnabled,
          emailVerified: user.emailVerified,
          passwordUpdated: Boolean(passwordHash),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
