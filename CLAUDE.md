# Guía rápida — ARCA Facturación

App de facturación electrónica AFIP para clientes en el marketplace de monday.com.

> ## 🚨 ¿Se rompió algo? No leas esto: andá a **[RUNBOOK.md](RUNBOOK.md)**
>
> Si hay un cliente esperando, el runbook es el documento: se entra por el síntoma.
>
> **¿Es tu primera semana en el proyecto?** Empezá por
> **[GUIA-TECNICA.md](GUIA-TECNICA.md)** — arquitectura, clientes, qué puede fallar y cómo
> se hace un cambio. 15 minutos, se lee entera una vez.
>
> Este archivo (CLAUDE.md) es el detalle fino: las reglas del código y cómo tocarlo.

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
| **Producción** | `https://arca.theautomationpartner.com` | pm2 `tap-monday` (3000) | `defaultdb` | TODOS los clientes (versión Live actual: **v18**) |
| **Staging** | `https://staging.theautomationpartner.com` | pm2 `tap-monday-staging` (3001) | `stagingdb` | Solo TAP (versión Draft, v19+ según feature) |

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

### Paso 2 — Crear una versión Draft en monday (solo si no existe ya)

Esto se hace UNA VEZ por feature. Si ya existe una versión Draft apuntando a
staging, saltá al paso 3. (La versión Live actual es **v18**; cada feature crea
la siguiente Draft — v19, v20, etc. Los números suben, el flujo es el mismo.)

1. Abrí monday Centro de Desarrollo → app **Factura ARCA**
2. Click en **"+ Versión nueva"** → queda como Borrador
3. Cambiar las URLs de la Draft a staging:
   - **Crea → Funciones → Vista del tablero → URL externa**:
     `https://staging.theautomationpartner.com`
   - **Crea → Funciones → Crear Comprobante (receta unificada) → URL de ejecución**:
     `https://staging.theautomationpartner.com/api/invoices/emit`
     (la receta unificada rutea por la columna `tipo_comprobante` a factura / NC / ND;
      no hace falta receta separada — las URL `/api/credit-notes/emit` y
      `/api/debit-notes/emit` existen como endpoints alternativos pero no son
      necesarias si usás la receta unificada)
4. Guardar (NO promover a Live)

### Paso 3 — Probar el cambio en la versión Draft

- TAP es **owner** de la app en monday → al abrir la app en cualquier board de tu cuenta, monday auto-aplica la Draft más reciente.
- **Polifroni** está en OTRA cuenta de monday (30446835) → la Draft no le llega, sigue en Live.
- ⚠️ **Sofia, Pamela y TAP SA tienen su board en la cuenta de TAP** (28569993) → la Draft **SÍ** les llega y sus recetas apuntan a staging. Esto causó 3 incidentes de fuga (facturas reales emitidas por staging y guardadas en stagingdb, invisibles para prod).
- ✅ **Hoy eso está resuelto por el proxy de ruteo** (`stagingRouteGuard`, ver regla 8): staging solo procesa los workspaces de `STAGING_DEV_WORKSPACES` y **reenvía todo el resto a producción**. Sofia/Pamela facturan normal aunque tengas la Draft activa. Verificá con `pm2 logs tap-monday-staging | grep staging-proxy`.
- Si stagingdb no tiene los datos para probar, podés copiarlos de `defaultdb` (solo de TAP) con SQL — pedile al asistente que lo haga.
- ⚠️ **Cuidado al emitir desde un workspace de dev**: el `.env` de staging tiene `AFIP_ENV=PRODUCTION`, así que emitir desde `STAGING_DEV_WORKSPACES` genera un **CAE real** con el CUIT de testing. Para test sin riesgo, navegá la UI / probá validaciones / no dispares la receta.

### Paso 4 — Si funciona, mergear a main y deployar a producción

```bash
git checkout main
git merge develop --ff-only
git push origin main
```

GitHub Actions deploya automático a producción (mismo flujo, pero al clon `/opt/apps/App-monday/` y al pm2 `tap-monday`). En ~2 min Polifroni y Sofia ven el cambio.

### Paso 5 — Eliminar la versión Draft en monday

Una vez que el código está en producción, la versión Live ya sirve el código nuevo (porque su URL `arca...` es donde se acaba de deployar). La Draft ya no aporta nada → se elimina:

- Centro de Desarrollo → Factura ARCA → versión Draft → menú "..." → Eliminar

(Para el próximo cambio, creás otra Draft nueva en el paso 2. Es de un solo uso por feature.)

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

3. **`APP_ENV=staging` en el `.env` de staging clone.** Controla dos cosas: (a) el skip de las **alertas de Slack** (`notifySlackSystemError` + resumen nocturno de auditoría) — los errores de staging son ruido para el canal de prod; (b) el **proxy de ruteo** hacia prod (regla 8). **NO** skipea el audit board: staging emite con `AFIP_ENV=production`, así que sus comprobantes son reales (CAE real) y SÍ se registran en "Comp Emitidos" (staging y prod comparten `MONDAY_AUDIT_BOARD_ID`; el dedup de `logEmissionToAuditBoard` es por DB local, así que no colisionan items de distintos entornos).

4. **Migrations idempotentes en `runStartupMigrations()`** (en `server.js`). Toda migración de schema va ahí, con `IF NOT EXISTS` o `try/catch`. Corren al arrancar `pm2` → cada DB (defaultdb y stagingdb) se migra sola.

5. **Defense AFIP — 4 capas, no las desactives a la ligera:**
   - **Fase 1 (idempotency):** reserva cbteNro en DB antes del SOAP, recovery via `FECompConsultar` en retry.
   - **Fase 2 (verificación post-emisión):** valida CAE/nro/importe contra AFIP tras cada CAE recibido.
   - **Fase 3 (reconciliation cron):** cada 5 min recupera facturas stuck.
   - **Fase 4 (auditoría nocturna):** 3 AM AR audita todas las facturas exitosas contra AFIP, alerta a Slack si hay mismatch.

   Si tu cambio toca el flujo de emisión (`/api/invoices/emit`), el callback de AFIP, o la generación de PDF, **probá MUY bien en staging primero**.

6. **El frontend tiene UN solo bundle servido por el backend** (`backend-repo/public/`). Vite genera assets con hash (`index-XXX.js`); esos cachean forever en Cloudflare. El `index.html` siempre es `no-cache` (los headers están en `server.js` `express.static`).

7. **`/etc/nginx/sites-enabled/tap-monday` ES UN SYMLINK** a `/etc/nginx/sites-available/tap-monday`. Si alguien lo rompe, los cambios al config de nginx no se cargan. Siempre verificá con `nginx -T | grep server_name`.

8. **Staging solo emite para los workspaces de dev — el resto lo reenvía a prod.** `stagingRouteGuard` (en `server.js`, encadenado en las 4 rutas de emisión después de `requireAutomationBlock`) resuelve el `workspace_id` del board y decide:
   - workspace ∈ `STAGING_DEV_WORKSPACES` → staging procesa local (CAE real con el CUIT de testing, registro en `stagingdb`).
   - cualquier otro → **reenvía a producción** (`PROD_FORWARD_URL`, default `http://127.0.0.1:3000`). El cliente factura normal y no se entera de que existe staging.

   **El ruteo es por WORKSPACE, no por CUIT** — el CUIT de testing del dev (20327446348) tiene boards tanto en workspaces de dev como en uno normal, así que un filtro por CUIT rompería uno de los dos casos.

   **Default fail-safe: ante la duda, prod.** Si no se puede resolver el workspace (board sin config, `boardId` vacío, error de DB) se reenvía. El costo de un falso reenvío es que notás que tu código no corrió; el del error inverso es una fuga fiscal.

   Anti-loop en 3 capas: prod es no-op (`APP_ENV != 'staging'`); un request que llega con el header `x-tap-proxy-hop` responde 502 (nunca re-reenvía ni procesa local); y `getProdForwardUrl()` devuelve null (→ 503) si el destino huele a staging o usa el puerto propio. `assertStagingNotBlocked` (`STAGING_BLOCKED_CUITS`) queda como backstop de último recurso.

---

## Estructura del repo

```
backend-repo/
  src/
    server.js                    # el más grande — endpoints + crons + lifecycle + audit
    config.js                    # endpoints AFIP por entorno (homo vs prod) + constantes (CBTE_TYPE, IVA_CONDITION)
    db.js                        # pool PostgreSQL (SSL verify-full con CA cert de DO)
    validation.js                # Zod schemas (BoardConfigSchema, MappingSchema, etc.)
    onboarding.html              # página de bienvenida iframe-friendly (/onboarding)
    modules/
      errorMessages.js           # TODOS los mensajes de error al usuario (ES + EN)
      invoicePdf.js              # generación PDF (pdfkit)
      invoiceRules.js            # condiciones IVA, helper toTitleCase
      afipAuth.js                # WSAA (token+sign per company, cacheado)
      afipPadron.js              # consulta padrón AFIP (cuit→razón social)
      afipWsfex.js               # comprobantes de exportación (WSFEXv1, otro web service)
      piiCrypto.js               # cifrado de la PII del emisor (tabla companies)
      recoveryGuard.js           # ¿el comprobante que devolvió AFIP es realmente nuestro?
      documentoReceptor.js       # dígito verificador del CUIT + etiqueta del documento
  test/                          # corren solos en cada deploy (ver .github/workflows)
    mensajes.test.js             # los 232 mensajes de error, en los dos idiomas
    errores-corpus.json          # el corpus congelado que usa el anterior
    textos-al-usuario.test.js    # los textos de éxito y aviso (acentos, jerga)
    recovery-ajeno.test.js       # que no adoptemos el CAE de la factura de otro
    cuit-digito.test.js          # que un CUIT mal escrito se detecte sin AFIP
    pdf-doc-receptor.test.js     # que el PDF no le diga CUIT a un DNI
  scripts/
    test-pdf.js                  # genera PDF de muestra sin emitir
    check-account-data.js        # diagnóstico de uninstall
  ecosystem.config.js            # pm2 prod (puerto 3000)
  ecosystem.staging.config.js    # pm2 staging (puerto 3001, cwd App-monday-staging)
  package.json                   # `npm test` corre los 5 bancos de prueba

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
| `MONDAY_AUDIT_BOARD_ID` | board "Comp Emitidos" donde se loggean emisiones (staging y prod comparten el mismo board) |
| `DEV_MONDAY_TOKEN` | API token del developer (para escribir al audit board) |
| `SLACK_WEBHOOK_URL` | alertas de errores sistema y auditoría nocturna |
| `APP_ENV` | `staging` o no seteado (prod). Cuando `staging`: (a) skipea las alertas de Slack (errores sistema + resumen nocturno); (b) activa el proxy de ruteo a prod (regla 8). El audit board SÍ se escribe en staging. |
| `PORT` | 3000 prod, 3001 staging |
| `STAGING_DEV_WORKSPACES` | **solo staging**. CSV de workspace_ids que staging procesa local; todo el resto se reenvía a prod (regla 8). Vacío → todo a prod. |
| `PROD_FORWARD_URL` | **solo staging** (opcional). Destino del reenvío. Default `http://127.0.0.1:3000` (misma droplet, sin pasar por Cloudflare). |
| `STAGING_DEV_BOARDS` | **solo staging** (opcional). CSV de board_ids de dev, para boards nuevos que todavía no tienen config en `stagingdb`. |
| `STAGING_BLOCKED_CUITS` | **solo staging**. Backstop: CUITs para los que staging se niega a emitir si algo esquiva el proxy. |

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

## Mensajes de error al usuario — cómo se arman (leer antes de tocar un `throw`)

> **Actualizado el 06/08/2026.** Lo que decía antes esta sección quedó viejo: la función se
> mudó de archivo y la lista en inglés dejó de existir. Si leíste esto antes, releelo.

Todo error que llega al item de monday pasa por **`buildErrorComment`**, que vive en
**`src/modules/errorMessages.js`** (se mudó de `server.js` el 05/08). Su lógica:

1. Parte el mensaje en líneas. **La primera línea es la "Causa"**.
2. Las líneas que empiezan con `•` son el detalle por subítem.
3. Busca el mensaje en **`KNOWN_ERRORS`**, un array de `{ match: /regex/, title, accion, estado, detalle, solucion }`.
4. Si **matchea**: arma el mensaje con `accion` (qué hacer, primero), `estado` (si se emitió algo) y `detalle`.
5. Si **NO matchea**: cae al fallback genérico.

### Una sola lista, y el inglés arriba

⚠️ **`KNOWN_ERRORS_EN` ya no existe.** Había dos listas paralelas y **derivaron**: la
española llegó a 49 reglas y la inglesa se quedó en 24, así que 30 mensajes se le mostraban
en español a un tablero en inglés.

Hoy hay **una sola lista ordenada** (`KNOWN_ERRORS`, en español) y un mapa **`EN_TEXT`**
indexado **por el `title` en español**, que superpone el texto en inglés. Una regla sin
entrada en `EN_TEXT` hace **fallar el banco de pruebas**, así que no se puede olvidar.

**Al agregar un error nuevo:** agregá la regla a `KNOWN_ERRORS`, su traducción a `EN_TEXT`
con la misma clave, y verificá que ninguna regex anterior se lo robe — **gana la primera
que matchea**.

⚠️ **La trampa vieja:** un `throw` con detalle en varias líneas perdía todo salvo la
primera si no estaba en la lista. Pasó con la bonificación. **Hoy los 232 errores tienen
mensaje propio y ninguno cae al genérico** — y hay un test que lo verifica en cada deploy.

Ejemplos de entradas que usan los bullets: `Item incompleto`, `no hay subitems`,
`importes de bonificación`.

### Antes de tocar un mensaje

```bash
cd backend-repo && npm test        # 5 bancos, menos de un segundo, sin AFIP ni monday
```

Si cambiaste un mensaje **a propósito**, refrescá el corpus:
`node test/mensajes.test.js --actualizar`

Y para ver un error real de punta a punta, el tablero **18425062980** tiene 12 items
cargados con datos mal a propósito. Tiene certificado de **homologación**: no puede emitir
nada real.

---

## Cosas que ya pasaron (lecciones aprendidas)

- **Automatizaciones de monday que pisan columnas al crear un item.** El board "Facturación TAP SA" (18415550350) tiene una que le pone **moneda = Dólares** y le agrega un **subítem vacío** a cada item nuevo. Resultado: 4 notas de crédito salieron emitidas como **facturas** porque la automatización también pisó `Tipo Comprobante`. Si creás items por API en un board con automatizaciones, **releé los campos después de crear** — no alcanza con mandarlos en el `create_item`.
- **AFIP se cae y el error es suyo, no nuestro.** Un `FECompUltimoAutorizado HTTP 503` es AFIP caído. Se confirma en 5 segundos con el `FEDummy`, que no pide autenticación: `POST https://servicios1.afip.gov.ar/wsfev1/service.asmx` con `SOAPAction: http://ar.gov.afip.dif.FEV1/FEDummy` — si `AppServer`/`DbServer`/`AuthServer` no dicen OK, hay que esperar.
- **CUIT de receptor inexistente:** el `30000000007` que traen los items de ejemplo NO existe en el padrón, y la emisión muere ahí con un error de padrón antes de cualquier validación nuestra. Para pruebas conviene **dejar el CUIT vacío** (consumidor final): así ni consulta el padrón.

- **`/etc/nginx/sites-enabled/tap-monday` no era un symlink al `sites-available/`** → editar uno no afectaba al otro. Lo arreglé el 2026-05-06 (ahora SÍ es symlink).
- **Cloudflare cachea HTML por defecto.** El backend manda `Cache-Control: no-cache` para `index.html` y Cloudflare lo respeta (`cf-cache-status: DYNAMIC`). Pero browsers cachean también — si no ves un cambio, hacé Ctrl+Shift+R.
- **Mirror columns y Board Relations en monday no traen valor en `text`** del GraphQL — hay que pedir `display_value` con inline fragments (`... on MirrorValue { display_value }`). Está en `fetchMondayItem` y en `getColumnTextById`.
- **`board_automation_configs.status_column_id` es nullable** desde que agregamos los toggles. Antes era NOT NULL. Si activás `auto_update_status=false`, esa columna no se exige.
- **Title Case en datos fiscales:** la función `toTitleCase` en `invoiceRules.js` preserva `IVA` siempre en mayúsculas y siglas multi-punto (`S.A.`, `S.R.L.`). El `nombre de fantasía` (trade_name) se respeta tal cual lo cargó el usuario.

---

## Notas de Crédito y Notas de Débito — cómo se emiten

- Receta en monday: **"Crear Comprobante"** (unificada) — la columna `tipo_comprobante` rutea a NC / ND / Factura. Endpoints directos opcionales: `POST /api/credit-notes/emit` y `POST /api/debit-notes/emit` (no se usan si se dispara desde la receta unificada).
- La NC vive en su **propio item** de monday y referencia la factura a anular por el **CAE** escrito en la columna mapeada `factura_referencia` (obligatoria — sin ella no se emite). La app busca la factura por `afip_result_json->>'cae'` (índice `idx_invoice_emissions_cae`).
- El importe sale de los **subítems del propio item de NC** (mismo mapeo que la factura). La app los lee, calcula neto/IVA/total y emite la NC parcial por ese monto. El encabezado (receptor, moneda, condición, letra) lo hereda de la factura.
- Controles: la alícuota IVA de la NC debe coincidir con la de la factura; el total acreditado (NCs previas + esta) no puede superar el de la factura (control de saldo). Se permiten **varias NC parciales** sobre una factura mientras no se pasen del total.
- Al emitir una **factura**, la app escribe su CAE en la columna `factura_referencia` del item (write-back) — así se copia fácil al item de la NC.
- Mapeo: `tipo_comprobante` y `factura_referencia` son campos del Mapeo Visual. En la plantilla son `dropdown_mm3hbhc0` y `numeric_mm3h6y35`, auto-mapeados en instalaciones nuevas (`TEMPLATE_NC_MAPPING` en `App.jsx` — el mismo mapeo se reusa para NC y ND).
- La lógica fiscal de subítems→líneas vive en `buildLinesFromSubitems` (server.js); la emisión de factura tiene su propia copia inline — si se tocan, mantenerlas sincronizadas.

### Notas de Débito (espejo de NC)

- **Notas de Débito** están soportadas: son el espejo fiscal de la NC pero con **CbteTipo 2 / 7 / 12** (A/B/C) en lugar de 3/8/13. Endpoint propio: `POST /api/debit-notes/emit`. Misma forma de operar que la NC: item nuevo, columna `factura_referencia` con el CAE de la factura, subítems con las líneas a debitar.
- Diferencias con la NC: la ND **NO tiene tope de saldo** (suma deuda, AFIP no la limita contra el total facturado) y la **alícuota IVA es libre** (AFIP no exige que coincida con la de la factura).
- **Receta unificada:** la receta en monday es una sola, **"Crear Comprobante"**, que recibe el item y rutea por la columna `tipo_comprobante` ("Factura" / "Nota de Crédito" / "Nota de Débito") al handler correspondiente.
- **Handler:** el handler unificado de NC y ND se llama `emitNotaHandler(req, res, clase)` (con `clase = 'NC' | 'ND'`), registrado en ambos endpoints. NO existe `creditNoteHandler` separado.

### Multi-PV (Punto de Venta por ítem)

- Hay una columna **Punto de Venta** mapeable en el board. Si está mapeada, el usuario tiene que seleccionar el PV en CADA ítem (pre-flight, antes de pasar el item al status "Creando").
- Si NO está mapeada, la emisión usa el `default_point_of_sale` de Datos Fiscales (clientes históricos no se ven afectados — el comportamiento por defecto es el de siempre).
- Para NC/ND el PV se hereda de la factura referenciada. Si el usuario eligió en la columna un PV distinto al de la factura → error (la NC/ND se emite desde el mismo PV que la factura para mantener coherencia de numeración). Si la dejó vacía → se completa con write-back después de emitir.

---

## Bonificación (descuento por línea)

- Columna **opcional** del Mapeo Visual, a nivel **subítem**. Sin mapear no pasa nada: no hay descuento y el comportamiento es el de siempre.
- Es un **IMPORTE**, no un porcentaje. Se aplica al **total de la línea** (cantidad × precio), **no por unidad**, y va en la **misma moneda que el precio unitario** (WSFEv1 expresa todos los importes en la moneda del comprobante).
- **Son DOS columnas, igual que el precio**: `bonificacion` (pesos) y `bonificacion_usd`. Si el item va en dólares la app lee la de USD; si no está mapeada, cae a la de pesos. Mismo criterio y mismo lugar que `precio_unitario` / `precio_unitario_usd` — leer la columna en pesos para un comprobante en dólares daría un neto cualquiera y **nada lo detectaría después**.
- Ya están en las dos plantillas del marketplace, con IDs distintos en cada una (`TEMPLATE_BONIF_SUBITEM_MAPPING` en `App.jsx` prueba los dos candidatos, igual que las columnas de exportación):

  | Plantilla | Board de subítems | Pesos | USD |
  |---|---|---|---|
  | ES "Facturación" | 18410634619 | `numeric_mm5xw0w1` | `numeric_mm5xyz60` |
  | EN "Invoicing" | 18419323354 | `numeric_mm5xv3tn` | `numeric_mm5x81` |

- ⚠️ **Las columnas de fórmula del board de subítems** (`Subtotal $`, `Subtotal u$`) calculan `cantidad × precio` y **no restan la bonificación**. Hay que editarlas a mano en monday (la API no permite cambiar la fórmula de una columna existente) o el cliente ve un total en monday y otro en el PDF. `IVA` y `Total` cuelgan de `Subtotal`, así que con corregir los dos Subtotal alcanza.
- Se detrae del **neto**: el IVA se calcula sobre lo que queda. Art. 10 de la Ley de IVA — el precio neto es el de la factura *"neto de descuentos y similares efectuados de acuerdo con las costumbres de plaza"*.
- **SOLO facturas A, B, C y E. Las NC y ND la ignoran** aunque el board tenga la columna mapeada y los subítems de la nota la tengan cargada. El corte está en los *callers*: no le pasan `bonificacionColumnId` a `buildLinesFromSubitems` / `buildExportLinesFromSubitems`. Para habilitarla en NC/ND alcanza con pasar el parámetro.
- **PDF**: las columnas `% Bonif` e `Imp. Bonif.` ya existían y estaban hardcodeadas en `'0,00'`. Ahora se llenan. En **B y C el precio se imprime con IVA adentro**, así que la bonificación se convierte igual (el usuario carga 1.000 → el PDF imprime 1.210) para que `precio − bonificación = subtotal` cierre. Es la regla del RCEL de AFIP: todos los números de la línea en la misma unidad. En A no hay conversión (se imprime todo neto).
- Si ninguna línea tiene bonificación, la tabla sale **exactamente como antes** — en factura A la columna `Imp. Bonif.` ni siquiera aparece. Vale también para regenerar PDFs viejos, cuyo `draft_json` no tiene el campo.
- **En mercado interno AFIP no ve nada de esto**: `FECAESolicitar` manda solo totales, sin detalle de líneas. Lo único que cambia es que el `ImpNeto` sale más chico.
- **En Factura E AFIP SÍ valida** (manual WSFEX v3.1.1, pág. 22): **1811** (≥ 0), **1812** (≤ `Pro_precio_uni × Pro_qty`), **1815** (`Pro_total_item = Pro_precio_uni × Pro_qty − Pro_bonificacion`, tolerancia 0,01), **1817** (12 enteros y 6 decimales). Sigue vigente la **1610**: `Imp_total` = suma exacta de los `Pro_total_item`.
- La lógica está en los **3 lugares de siempre** (`buildLinesFromSubitems`, la copia inline de la emisión de factura y `buildExportLinesFromSubitems`). Si tocás una, tocá las tres.

---

## Estado actual de las versiones en monday

(Snapshot 2026-05-21 — los números de versión suben en cada feature.)

- **v18 (Live)** — la usan TAP, Polifroni, Sofia. URL: `arca.theautomationpartner.com`
- **Draft (v19+)** — solo TAP la ve. URL: `staging.theautomationpartner.com`. Se crea y elimina por feature.

---

## Si tenés dudas

Releé este doc. Después preguntale al asistente. **Y antes de pushear a main, asegurate de haber probado en staging.**
