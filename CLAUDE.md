# Guía rápida — ARCA Facturación

App de facturación electrónica AFIP para clientes en el marketplace de monday.com.

> **⚠️ Si vas a hacer un cambio (feature nuevo o fix), LEÉ EL WORKFLOW DE CAMBIOS abajo antes de tocar código.** No es opcional. Si pusheás directo a `main` impactás 3 clientes reales en producción.

---

## Stack y dónde corre cada cosa

```
TU PC (dev local)
  └── git push develop / main → GitHub Actions

GITHUB
  ├── branch main      → deploya a PRODUCCIÓN
  └── branch develop   → deploya a STAGING

DROPLET DigitalOcean (1 servidor: 134.122.5.114)
  ├── /opt/apps/App-monday/             → branch main, pm2 "tap-monday",         puerto 3000
  └── /opt/apps/App-monday-staging/     → branch develop, pm2 "tap-monday-staging", puerto 3001
      Cada clon tiene su .env propio.

CLUSTER PostgreSQL DigitalOcean Managed (1 cluster, 2 DBs adentro)
  ├── defaultdb   → datos REALES de producción (clientes A, B, C)
  └── stagingdb   → datos de prueba (TAP copiada para tests)

CLOUDFLARE (DNS + TLS + CDN)
  ├── arca.theautomationpartner.com    → puerto 3000 del droplet
  └── staging.theautomationpartner.com → puerto 3001 del droplet
```

---

## URLs importantes

| Entorno | URL | Backend en droplet | DB | Quién la ve |
|---|---|---|---|---|
| **Producción** | `https://arca.theautomationpartner.com` | pm2 `tap-monday` (3000) | `defaultdb` | TODOS los clientes (V13 Live en monday) |
| **Staging** | `https://staging.theautomationpartner.com` | pm2 `tap-monday-staging` (3001) | `stagingdb` | Solo TAP (V14 Draft en monday) |

---

## ⭐ Workflow para hacer un cambio (regla de oro)

**NUNCA pushees directo a `main`. Siempre pasá por staging primero.**

### Paso 1 — Codear localmente en branch `develop`

```bash
git checkout develop
# editás los archivos que necesites
git add .
git commit -m "feat/fix: descripción del cambio"
git push origin develop
```

GitHub Actions automáticamente:
- Detecta el push a `develop`
- Hace `git pull` en `/opt/apps/App-monday-staging/`
- Reload de `pm2 tap-monday-staging`
- Smoke test contra `https://staging.theautomationpartner.com/api/health`

### Paso 2 — Crear V14 (Draft) en monday (solo si no existe ya)

Esto se hace UNA VEZ. Si ya existe V14 apuntando a staging, saltá al paso 3.

1. Abrí monday Centro de Desarrollo → app **Factura ARCA**
2. Click en **"+ Versión nueva"** → queda como Borrador
3. Cambiar URLs en V14 a staging:
   - **Crea → Funciones → Vista del tablero → Deployment**:
     `https://staging.theautomationpartner.com`
   - **Crea → Funciones → Generar Factura AFIP → URL de ejecución**:
     `https://staging.theautomationpartner.com/api/invoices/emit`
4. Guardar (NO promover a Live)

### Paso 3 — Probar el cambio en V14

- TAP es **owner** de la app en monday → al abrir la app en cualquier board de tu cuenta, monday auto-aplica V14 (la draft más reciente).
- Polifroni y Sofia siguen viendo V13 (Live) — no se enteran.
- Si stagingdb no tiene los datos para probar, podés copiarlos de `defaultdb` (solo de TAP) con SQL — pedile al asistente que lo haga.
- ⚠️ **Cuidado al emitir**: el `.env` de staging tiene `AFIP_ENV=PRODUCTION`, así que cualquier emisión va a AFIP real. Para test sin riesgo, solo navegá la UI / probá validaciones / no dispares la receta.

### Paso 4 — Si funciona, mergear a main y deployar a producción

```bash
git checkout main
git merge develop --ff-only
git push origin main
```

GitHub Actions deploya automático a producción (mismo flujo, pero al clon `/opt/apps/App-monday/` y al pm2 `tap-monday`). En ~2 min Polifroni y Sofia ven el cambio.

### Paso 5 — Eliminar V14 en monday

Una vez que el código está en producción, V13 (Live) ya sirve el código nuevo (porque su URL `arca...` es donde se acaba de deployar). V14 ya no aporta nada → se elimina:

- Centro de Desarrollo → Factura ARCA → V14 → menú "..." → Eliminar

(Para el próximo cambio, creás otra V14 nueva en el paso 2. Es de un solo uso por feature.)

---

## Si algo sale mal en producción → rollback

```bash
git checkout main
git revert HEAD          # deshace el último commit creando uno nuevo
git push origin main     # deploya el revert en ~2 min
```

Para un commit específico no reciente: `git revert <hash>`. Nunca uses `git reset --hard` + `--force` push a menos que estés 100% seguro.

---

## Reglas de oro (no rompas nada)

1. **Defaults TRUE en flags nuevos.** Si agregás un toggle / columna booleana al schema, ponele `DEFAULT TRUE` para que clientes existentes mantengan el comportamiento de siempre.

2. **Datos en `defaultdb` son sagrados.** `stagingdb` es para tests. **NUNCA** hagas `DELETE` o `UPDATE` en `defaultdb` sin estar 100% seguro y haber chequeado el `WHERE`.

3. **`APP_ENV=staging` en el `.env` de staging clone.** Controla el skip del audit board (`logEmissionToAuditBoard`). Si lo borrás, las pruebas en staging contaminan el board "Comp Emitidos" de producción.

4. **Migrations idempotentes en `runStartupMigrations()`** (en `server.js`). Toda migración de schema va ahí, con `IF NOT EXISTS` o `try/catch`. Corren al arrancar `pm2` → cada DB (defaultdb y stagingdb) se migra sola.

5. **Defense AFIP — 4 capas, no las desactives a la ligera:**
   - **Fase 1 (idempotency):** reserva cbteNro en DB antes del SOAP, recovery via `FECompConsultar` en retry.
   - **Fase 2 (verificación post-emisión):** valida CAE/nro/importe contra AFIP tras cada CAE recibido.
   - **Fase 3 (reconciliation cron):** cada 5 min recupera facturas stuck.
   - **Fase 4 (auditoría nocturna):** 3 AM AR audita todas las facturas exitosas contra AFIP, alerta a Slack si hay mismatch.

   Si tu cambio toca el flujo de emisión (`/api/invoices/emit`), el callback de AFIP, o la generación de PDF, **probá MUY bien en staging primero**.

6. **El frontend tiene UN solo bundle servido por el backend** (`backend-repo/public/`). Vite genera assets con hash (`index-XXX.js`); esos cachean forever en Cloudflare. El `index.html` siempre es `no-cache` (los headers están en `server.js` `express.static`).

7. **`/etc/nginx/sites-enabled/tap-monday` ES UN SYMLINK** a `/etc/nginx/sites-available/tap-monday`. Si alguien lo rompe, los cambios al config de nginx no se cargan. Siempre verificá con `nginx -T | grep server_name`.

---

## Estructura del repo

```
backend-repo/
  src/
    server.js                    # ÚNICO archivo grande — endpoints + crons + lifecycle + audit
    db.js                        # pool PostgreSQL (SSL verify-full con CA cert de DO)
    validation.js                # Zod schemas (BoardConfigSchema, MappingSchema, etc.)
    onboarding.html              # página de bienvenida iframe-friendly (/onboarding)
    modules/
      invoicePdf.js              # generación PDF (pdfkit)
      invoiceRules.js            # condiciones IVA, helper toTitleCase
      afipAuth.js                # WSAA (token+sign per company, cacheado)
      afipPadron.js              # consulta padrón AFIP (cuit→razón social)
  scripts/
    test-pdf.js                  # genera PDF de muestra sin emitir
    check-account-data.js        # diagnóstico de uninstall
  ecosystem.config.js            # pm2 prod (puerto 3000)
  ecosystem.staging.config.js    # pm2 staging (puerto 3001, cwd App-monday-staging)
  package.json

frontend-repo/
  src/
    App.jsx                      # UI multi-step (Datos Fiscales, Certs, Mapeo Visual)
    WelcomePage.jsx              # bienvenida post-install
    main.jsx, App.css, etc.
  vite.config.js, package.json

.github/workflows/
  deploy.yml                     # CI/CD: detecta branch, deploya al clon correcto

CLAUDE.md                        # ESTE archivo
README.md                        # info pública
```

---

## Env vars críticas (sin valores — los reales viven en `.env` del droplet)

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres connection string (verify-full SSL con CA cert) |
| `AFIP_ENV` | `production` o `homologation` (testing real vs sandbox) |
| `ENCRYPTION_KEY` | AES key para cifrar private key del cert AFIP en DB |
| `MONDAY_CLIENT_SECRET` | valida tokens de sesión que monday firma |
| `MONDAY_CLIENT_ID` | client ID del app en monday (sincronizado por GitHub Actions desde Secrets) |
| `MONDAY_AUDIT_BOARD_ID` | board "Comp Emitidos" donde se loggean emisiones (PROD only) |
| `DEV_MONDAY_TOKEN` | API token del developer (para escribir al audit board) |
| `SLACK_WEBHOOK_URL` | alertas de errores sistema y auditoría nocturna |
| `APP_ENV` | `staging` o no seteado (prod). Skipea audit board cuando `staging`. |
| `PORT` | 3000 prod, 3001 staging |

---

## Comandos útiles para debugging

```bash
# SSH al droplet
ssh root@134.122.5.114

# Logs en vivo
pm2 logs tap-monday --lines 100              # prod
pm2 logs tap-monday-staging --lines 100      # staging

# Reload manual (si hace falta — el deploy lo hace solo)
pm2 reload tap-monday --update-env

# Conectarse a la DB
DATABASE_URL=$(grep ^DATABASE_URL= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
psql "$DATABASE_URL"

# Ver estado de migraciones
psql "$DATABASE_URL" -c "\d board_automation_configs"

# Disparar la auditoría nocturna manualmente (prod)
TOKEN=$(grep ^DEV_MONDAY_TOKEN= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
curl -X POST http://localhost:3000/api/admin/run-nightly-audit \
  -H "x-admin-token: $TOKEN"
```

---

## Cosas que ya pasaron (lecciones aprendidas)

- **`/etc/nginx/sites-enabled/tap-monday` no era un symlink al `sites-available/`** → editar uno no afectaba al otro. Lo arreglé el 2026-05-06 (ahora SÍ es symlink).
- **Cloudflare cachea HTML por defecto.** El backend manda `Cache-Control: no-cache` para `index.html` y Cloudflare lo respeta (`cf-cache-status: DYNAMIC`). Pero browsers cachean también — si no ves un cambio, hacé Ctrl+Shift+R.
- **Mirror columns y Board Relations en monday no traen valor en `text`** del GraphQL — hay que pedir `display_value` con inline fragments (`... on MirrorValue { display_value }`). Está en `fetchMondayItem` y en `getColumnTextById`.
- **`board_automation_configs.status_column_id` es nullable** desde que agregamos los toggles. Antes era NOT NULL. Si activás `auto_update_status=false`, esa columna no se exige.
- **Title Case en datos fiscales:** la función `toTitleCase` en `invoiceRules.js` preserva `IVA` siempre en mayúsculas y siglas multi-punto (`S.A.`, `S.R.L.`). El `nombre de fantasía` (trade_name) se respeta tal cual lo cargó el usuario.

---

## Estado actual de las versiones en monday

- **V13 (Live)** — la usan TAP, Polifroni, Sofia. URL: `arca.theautomationpartner.com`
- **V14 (Draft)** — solo TAP la ve. URL: `staging.theautomationpartner.com`. Se elimina y recrea por feature.

---

## Si tenés dudas

Releé este doc. Después preguntale al asistente. **Y antes de pushear a main, asegurate de haber probado en staging.**
