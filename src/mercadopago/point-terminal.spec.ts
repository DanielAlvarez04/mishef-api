import {
  isPointPdvTerminal,
  supportsPointTips,
} from './point-terminal';

describe('compatibilidad de terminales Point', () => {
  it('acepta Smart 1 y Smart 2 en modo PDV', () => {
    expect(isPointPdvTerminal('PDV', 'SMART_1')).toBe(true);
    expect(isPointPdvTerminal('PDV', 'SMART_2')).toBe(true);
  });

  it('rechaza terminales fuera de PDV', () => {
    expect(isPointPdvTerminal('STANDALONE', 'SMART_2')).toBe(false);
    expect(isPointPdvTerminal('SELF_SERVICE', 'SMART_2')).toBe(false);
    expect(isPointPdvTerminal(null, 'SMART_1')).toBe(false);
  });

  it('rechaza Air 2 aunque esté marcada como PDV', () => {
    expect(isPointPdvTerminal('PDV', 'AIR_2')).toBe(false);
  });

  it('solo Smart 2 captura propina', () => {
    expect(supportsPointTips('SMART_2')).toBe(true);
    expect(supportsPointTips('SMART_1')).toBe(false);
    expect(supportsPointTips('AIR_2')).toBe(false);
    expect(supportsPointTips(null)).toBeNull();
    expect(supportsPointTips(undefined)).toBeNull();
  });
});
