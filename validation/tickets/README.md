# Dataset de tickets reales (accuracy)

Este directorio es para fotos locales de tickets. **No se commitean**: el
`.gitignore` deja pasar solo este README y el ejemplo de manifiesto.

## Formato

```
validation/tickets/
  expected.json
  ticket-001.jpg
  ticket-002.png
  ...
```

`expected.json`:

```json
[
  {
    "file": "ticket-001.jpg",
    "supplier": "Walmart Supercenter",
    "date": "2026-11-01",
    "total": 350.5,
    "lines": [
      {
        "description": "SALSA VERDE 1 L",
        "quantity": 1,
        "lineTotal": 35
      }
    ]
  }
]
```

- `supplier`: nombre o alias como aparece en el ticket.
- `date`: `YYYY-MM-DD`.
- `total`: total con IVA.
- `lines`: las líneas que la revisión humana considera correctas. `quantity`
  y `lineTotal` son opcionales, pero recomendados.

## Ejecución

```powershell
cd api
npm run intel:worker:dev   # en otra terminal, si no está corriendo
node scripts/validate-ticket-accuracy.mjs
```

El arnés sube cada foto por el flujo real (presign → R2 → `createTicket` →
worker pg-boss), espera la extracción y compara contra `expected.json`. No
aprueba compras ni mueve inventario. Por defecto borra la compra y el objeto de
R2 al terminar; usa `--keep` para conservarlos.

Opciones:

- `--limit=10` para una muestra.
- `--self-test` genera un ticket sintético y valida el propio arnés (no cuenta
  como los 50 reales).

## Criterios

- Proveedor / fecha / total: **≥95%**.
- Líneas (recall): **≥85%** (con revisión humana).
- Muestra: **50 tickets reales** de al menos 3 proveedores.
- p95 de procesamiento: **<60 s**.

Si la muestra es menor a 50, el arnés lo reporta y no declara cumplido el
criterio.
