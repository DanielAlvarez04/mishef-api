import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from './organizations.service';

function createMocks() {
  const prisma: Record<string, any> = {
    organization: {
      findUnique: jest.fn(),
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

  it('acepta un dominio libre y lo normaliza', async () => {
    const { service, prisma } = createMocks();
    // 1.ª consulta: la organización actual (por id). 2.ª: dominio destino, libre.
    prisma.organization.findUnique
      .mockResolvedValueOnce({
        id: 'org-1',
        name: 'Café Central',
        slug: 'naranja-pimienta',
        domain: null,
        isActive: true,
      })
      .mockResolvedValueOnce(null);
    prisma.organization.update.mockResolvedValue({
      id: 'org-1',
      name: 'Café Central',
      slug: 'naranja-pimienta',
      domain: 'naranjapimienta.cafe',
      isActive: true,
    });

    const result = await service.update('org-1', {
      domain: ' NaranjaPimienta.Cafe ',
    });

    expect(prisma.organization.findUnique).toHaveBeenCalledWith({
      where: { domain: 'naranjapimienta.cafe' },
    });
    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { domain: 'naranjapimienta.cafe' },
    });
    expect(result.domain).toBe('naranjapimienta.cafe');
  });

  it('rechaza un dominio inválido', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique.mockResolvedValue({
      id: 'org-1',
      name: 'Café Central',
      slug: 'naranja-pimienta',
      domain: null,
      isActive: true,
    });

    await expect(
      service.update('org-1', { domain: 'sin punto' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('no permite usar el dominio de otra organización', async () => {
    const { service, prisma } = createMocks();
    prisma.organization.findUnique
      .mockResolvedValueOnce({
        id: 'org-1',
        name: 'Café Central',
        slug: 'naranja-pimienta',
        domain: null,
        isActive: true,
      })
      .mockResolvedValueOnce({ id: 'org-2' });

    await expect(
      service.update('org-1', { domain: 'naranjapimienta.cafe' }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
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
