/**
 * Grupos de opciones sugeridos por la app.
 *
 * Son plantillas, no filas compartidas: al usarlas se crea un grupo propio de
 * la organización, de modo que cada negocio pueda renombrarlo, ampliarlo o
 * borrarlo sin afectar a nadie más.
 */
export interface OptionGroupPreset {
  name: string;
  description: string;
  values: Array<{ name: string; kitchenLabel?: string }>;
}

/**
 * Los grupos de exclusión ("Sin cebolla", "Sin queso"...) no cambian el precio
 * del artículo: la opción solo quita un ingrediente.
 */
export function isNoPriceOptionGroup(name: string): boolean {
  return /^sin\b/i.test(name.trim());
}

export const OPTION_GROUP_PRESETS: OptionGroupPreset[] = [
  {
    name: 'Salsas',
    description: 'Salsa o aderezo con el que se prepara el platillo.',
    values: [
      { name: 'Verde' },
      { name: 'Roja' },
      { name: 'BBQ' },
      { name: 'Buffalo' },
    ],
  },
  {
    name: 'Proteínas',
    description: 'Proteína principal del platillo.',
    values: [
      { name: 'Pollo' },
      { name: 'Bistec' },
      { name: 'Cerdo' },
      { name: 'Pescado' },
    ],
  },
  {
    name: 'Leches',
    description: 'Tipo de leche para bebidas y preparaciones.',
    values: [
      { name: 'Entera' },
      { name: 'Deslactosada' },
      { name: 'Almendra' },
      { name: 'Coco' },
      { name: 'Avena' },
    ],
  },
  {
    name: 'Término',
    description: 'Punto de cocción de carnes.',
    values: [
      { name: 'Término medio' },
      { name: 'Tres cuartos' },
      { name: 'Bien cocido' },
    ],
  },
  {
    name: 'Extras',
    description: 'Añadidos que el cliente puede sumar al platillo.',
    values: [
      { name: 'Queso' },
      { name: 'Tocino' },
      { name: 'Aguacate' },
      { name: 'Huevo' },
    ],
  },
  {
    name: 'Sin',
    description: 'Ingredientes que el cliente puede pedir sin incluir.',
    values: [
      { name: 'Cebolla' },
      { name: 'Jitomate' },
      { name: 'Lechuga' },
      { name: 'Crema' },
      { name: 'Queso' },
      { name: 'Chile' },
    ],
  },
];
