import { NotFoundException, BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from './organizations.service';

// El DNS se sustituye por mocks: la verificación real se prueba en producción
// con el dominio del negocio, aquí solo la lógica de decisión.
jest.mock('node:dns/promises', () => ({
  resolveTxt: jest.fn(),
  resolveCname: jest.fn(),
}));

const txtMock = jest.requireMock('node:dns/promises').resolveTxt as jest.Mock;
const cnameMock = jest.requireMock('node:dns/promises')
  .resolveCname as jest.Mock;

function createMocks() {
  const prisma: Record<string, any> = {
    organization: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };

  const service = new OrganizationsService(prisma as unknown as PrismaService);

  return { service, prisma };
}

describe('OrganizationsService', () => {
  it('devuelve la organización de la sesión', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Naranja Pimienta',
      slug: 'naranja-pimienta',
      isActive: true,
    });

    const result = await service.current('org-1');

    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { id: 'org-1' },
    });
    expect(result).toMatchObject({ id: 'org-1', name: 'Naranja Pimienta' });
  });

  it('falla si la organización no existe', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue(null);

    await expect(service.current('org-ajena')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('renombra solo la organización indicada y recorta espacios', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Naranja Pimienta',
      slug: 'naranja-pimienta',
      domain: null,
      isActive: true,
    });
    prisma.organization.update.mockResolvedValue({
      id: 'org-1',
      name: 'Café Central',
      slug: 'naranja-pimienta',
      isActive: true,
    });

    const result = await service.update('org-1', { name: '  Café Central  ' });

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { name: 'Café Central' },
    });
    expect(result.name).toBe('Café Central');
  });

  it('conecta un dominio y devuelve las instrucciones de DNS', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique
      .mockResolvedValueOnce({
        id: 'org-1',
        slug: 'cafe-central',
        domain: null,
        domainToken: null,
        domainVerifiedAt: null,
        customDomainEnabled: true,
      })
      .mockResolvedValueOnce(null);
    prisma.organization.update.mockResolvedValue({});

    const result = await service.setDomain('org-1', ' App.MiCafeteria.com ');

    expect(result.domain).toBe('app.micafeteria.com');
    expect(result.status).toBe('pending');
    expect(result.cname).toEqual({
      name: 'app.micafeteria.com',
      value: 'cafe-central.mishef.co',
    });
    expect(result.txt.name).toBe('_mishef.app.micafeteria.com');
    expect(result.txt.value).toMatch(/^mishef-verify=[0-9a-f]{32}$/);

    const data = prisma.organization.update.mock.calls[0][0].data;
    expect(data.domain).toBe('app.micafeteria.com');
    expect(data.domainVerifiedAt).toBeNull();
  });

  it('rechaza un dominio inválido', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      slug: 'cafe-central',
      domain: null,
      domainToken: null,
      domainVerifiedAt: null,
      customDomainEnabled: true,
    });

    await expect(
      service.setDomain('org-1', 'sin punto'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('rechaza conectar un dominio si el plan no lo incluye', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      slug: 'cafe-central',
      domain: null,
      domainToken: null,
      domainVerifiedAt: null,
      customDomainEnabled: false,
    });

    await expect(
      service.setDomain('org-1', 'app.micafeteria.com'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('no permite usar el dominio de otra organización', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique
      .mockResolvedValueOnce({
        id: 'org-1',
        slug: 'cafe-central',
        domain: null,
        domainToken: null,
        domainVerifiedAt: null,
        customDomainEnabled: true,
      })
      .mockResolvedValueOnce({ id: 'org-2' });

    await expect(
      service.setDomain('org-1', 'app.micafeteria.com'),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('verifica el dominio cuando el TXT y el CNAME coinciden', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      slug: 'cafe-central',
      domain: 'app.micafeteria.com',
      domainToken: 'mishef-verify=abc',
      domainVerifiedAt: null,
    });
    prisma.organization.update.mockResolvedValue({});

    txtMock.mockResolvedValue([['mishef-verify=abc']]);
    cnameMock.mockResolvedValue(['cafe-central.mishef.co.']);

    const result = await service.verifyDomain('org-1');

    expect(result.verified).toBe(true);
    expect(result.checks).toEqual({ txt: true, cname: true });
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { domainVerifiedAt: expect.any(Date) },
    });
  });

  it('no verifica si falta el TXT', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      slug: 'cafe-central',
      domain: 'app.micafeteria.com',
      domainToken: 'mishef-verify=abc',
      domainVerifiedAt: null,
    });

    txtMock.mockRejectedValue(new Error('ENOTFOUND'));
    cnameMock.mockResolvedValue(['cafe-central.mishef.co.']);

    const result = await service.verifyDomain('org-1');

    expect(result.verified).toBe(false);
    expect(result.checks).toEqual({ txt: false, cname: true });
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('resuelve el negocio solo si el dominio está verificado', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findFirst.mockResolvedValue({
      name: 'Café Central',
      slug: 'cafe-central',
      brandColor: '#123456',
      logoUrl: null,
      address: null,
      latitude: null,
      longitude: null,
    });

    const tenant = await service.tenantByDomain('App.MiCafeteria.com:443');

    expect(tenant.slug).toBe('cafe-central');
    expect(prisma.organization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          domain: 'app.micafeteria.com',
          domainVerifiedAt: { not: null },
          isActive: true,
        },
      }),
    );
  });

  it('indica la disponibilidad de un dominio', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValueOnce(null);

    await expect(service.domainAvailable(' NaranjaPimienta.Cafe ')).resolves.toEqual({
      domain: 'naranjapimienta.cafe',
      available: true,
    });

    prisma.organization.findUnique.mockResolvedValueOnce({ id: 'org-2' });

    await expect(service.domainAvailable('naranjapimienta.cafe')).resolves.toEqual({
      domain: 'naranjapimienta.cafe',
      available: false,
      reason: 'taken',
    });

    await expect(service.domainAvailable('sin punto')).resolves.toEqual({
      domain: 'sin punto',
      available: false,
      reason: 'invalid',
    });
  });

  it('indica la disponibilidad de una dirección de negocio', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValueOnce(null);

    await expect(service.slugAvailable(' Mi Cafetería ')).resolves.toEqual({
      slug: 'mi-cafeteria',
      available: true,
    });

    prisma.organization.findUnique.mockResolvedValueOnce({ id: 'org-2' });

    await expect(service.slugAvailable('mi-cafeteria')).resolves.toEqual({
      slug: 'mi-cafeteria',
      available: false,
      reason: 'taken',
    });

    await expect(service.slugAvailable('api')).resolves.toEqual({
      slug: 'api',
      available: false,
      reason: 'reserved',
    });
  });

  it('sugiere una dirección libre a partir del nombre', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1' })
      .mockResolvedValueOnce(null);

    await expect(service.slugSuggestion('Café Central')).resolves.toEqual({
      slug: 'cafe-central-2',
      available: true,
    });
  });

  it('guarda color, logo, dirección y coordenadas del negocio', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Café Central',
      slug: 'cafe-central',
      domain: null,
      brandColor: null,
      logoUrl: null,
      address: null,
      latitude: null,
      longitude: null,
    });
    prisma.organization.update.mockResolvedValue({
      id: 'org-1',
      name: 'Café Central',
      slug: 'cafe-central',
      domain: null,
      brandColor: '#123456',
      logoUrl: 'https://img.mishef.co/logo.png',
      address: 'Av. Reforma 123',
      latitude: 19.4326077,
      longitude: -99.133208,
      taxRate: 0.16,
      currency: 'MXN',
      isActive: true,
      businessType: null,
      serviceTypes: [],
      goals: [],
      hasBranches: false,
      useCoreSuggestions: true,
      practiceMode: false,
      practiceUntil: null,
    });

    await service.update('org-1', {
      brandColor: '#123456',
      logoUrl: 'https://img.mishef.co/logo.png',
      address: 'Av. Reforma 123',
      latitude: 19.4326077,
      longitude: -99.133208,
    });

    const data = prisma.organization.update.mock.calls[0][0].data;

    expect(data.brandColor).toBe('#123456');
    expect(data.logoUrl).toBe('https://img.mishef.co/logo.png');
    expect(data.address).toBe('Av. Reforma 123');
    expect(data.latitude.toString()).toBe('19.4326077');
    expect(data.longitude.toString()).toBe('-99.133208');
  });
});
