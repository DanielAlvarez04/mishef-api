# Scripts de la imagen Docker

Esta carpeta contiene **solo** los scripts que deben existir dentro de la
imagen de producción. El `Dockerfile` la copia a `/app/scripts`:

```dockerfile
COPY docker-scripts ./scripts
```

Por eso los comandos dentro del contenedor siguen siendo:

```bash
node scripts/seed-plans.mjs
node scripts/seed-demo-org.mjs
node scripts/storage-recount.mjs
```

Los scripts de desarrollo (migraciones de datos, optimización de imágenes,
pruebas, etc.) se quedan en `scripts/` y `.dockerignore` los excluye.

## Regla

Si un script debe ejecutarse en producción:

1. Muévelo aquí.
2. Actualiza su ruta en `package.json`.
3. Si usa imports relativos a `src/`, mantén la profundidad (`../src`) porque
   en el contenedor esta carpeta se monta como `/app/scripts`.

No agregues aquí scripts que necesiten `ts-node` sin revisar
`seed-demo-org.mjs`: ese seed prepara el contenedor (enlace `src -> dist/src` e
instala `ts-node` temporalmente) antes de ejecutar el seed de catálogo.
