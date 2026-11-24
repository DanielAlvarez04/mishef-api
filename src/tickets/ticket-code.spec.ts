import {
  formatTicketNumber,
  formatTicketUid,
  ticketDay,
  ticketDayKey,
} from './ticket-code';

describe('ticket-code', () => {
  it('formatea el consecutivo a tres dígitos', () => {
    expect(formatTicketNumber(1)).toBe('001');
    expect(formatTicketNumber(42)).toBe('042');
    expect(formatTicketNumber(1234)).toBe('1234');
  });

  it('usa la fecha del negocio para el folio', () => {
    // 25 nov 03:30 UTC = 24 nov 21:30 en CDMX.
    const lateUtc = new Date('2026-11-25T03:30:00.000Z');

    expect(ticketDayKey(lateUtc)).toBe('20261124');
    expect(formatTicketUid(lateUtc, 7)).toBe('20261124007');
  });

  it('construye la fecha de corte a medianoche UTC', () => {
    const day = ticketDay(new Date('2026-11-25T03:30:00.000Z'));

    expect(day.toISOString()).toBe('2026-11-24T00:00:00.000Z');
  });
});
