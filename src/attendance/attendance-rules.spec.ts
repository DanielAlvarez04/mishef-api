import {
  addDays,
  effectiveBreakMinutes,
  effectiveEnd,
  effectiveStart,
  startOfWeek,
} from './attendance-rules';

const rules = {
  applyTolerance: true,
  lateGraceMinutes: 10,
  lunchGraceMinutes: 5,
  earlyLeaveGraceMinutes: 15,
  defaultBreakMinutes: 60,
};

const at = (hour: number, minute = 0) =>
  new Date(2026, 10, 17, hour, minute, 0, 0);

describe('attendance-rules', () => {
  it('la semana empieza en lunes', () => {
    const wednesday = new Date(2026, 10, 18, 12, 0, 0);
    const monday = startOfWeek(wednesday);

    expect(monday.getDay()).toBe(1);
    expect(monday.getDate()).toBe(16);
    expect(monday.getHours()).toBe(0);
  });

  it('una entrada dentro de la tolerancia se registra a la hora programada', () => {
    expect(effectiveStart(at(9, 5), at(9), rules)).toEqual(at(9));
  });

  it('una entrada después de la tolerancia conserva la hora real', () => {
    expect(effectiveStart(at(9, 12), at(9), rules)).toEqual(at(9, 12));
  });

  it('llegar antes cuenta la hora real', () => {
    expect(effectiveStart(at(8, 55), at(9), rules)).toEqual(at(8, 55));
  });

  it('una salida dentro de la tolerancia se registra a la hora programada', () => {
    expect(effectiveEnd(at(17, 50), at(18), rules)).toEqual(at(18));
  });

  it('una salida antes de la tolerancia conserva la hora real', () => {
    expect(effectiveEnd(at(17, 40), at(18), rules)).toEqual(at(17, 40));
  });

  it('salir después cuenta como hora real', () => {
    expect(effectiveEnd(at(18, 5), at(18), rules)).toEqual(at(18, 5));
  });

  it('la comida descuenta lo planeado si está dentro de la tolerancia', () => {
    expect(effectiveBreakMinutes(64, 60, rules)).toBe(60);
  });

  it('la comida descuenta lo real si supera la tolerancia', () => {
    expect(effectiveBreakMinutes(70, 60, rules)).toBe(70);
  });

  it('si las tolerancias están apagadas se usa la hora exacta', () => {
    const exact = { ...rules, applyTolerance: false };

    expect(effectiveStart(at(9, 5), at(9), exact)).toEqual(at(9, 5));
    expect(effectiveEnd(at(17, 50), at(18), exact)).toEqual(at(17, 50));
    expect(effectiveBreakMinutes(64, 60, exact)).toBe(64);
  });
});
