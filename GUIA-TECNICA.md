# Guía técnica — Factura ARCA

Este documento es el traspaso. Explica **qué es el sistema, quién lo usa, qué puede fallar
y cómo se hace un cambio sin romper nada.**

Está pensado para leerse entero una vez, de arriba abajo. Son 15 minutos.

> **Si YA hay un problema y un cliente esperando**, no leas esto: andá directo a
> **[RUNBOOK.md](RUNBOOK.md)**, que se entra por el síntoma.

---

# 1. Qué es y quién lo usa

Una app del marketplace de **monday.com** que emite **facturas electrónicas de AFIP**.

El cliente carga una venta en un tablero de monday, cambia una columna de estado a
"Crear Comprobante", y la app le habla a AFIP, consigue el **CAE**, genera el PDF y lo deja
adjunto en el ítem. Tarda unos 8 segundos.

## Los clientes, y cuánto pesa cada uno

Medido sobre las emisiones exitosas de los **últimos 30 días** (al 06/08/2026):

| Cliente | CUIT | Últimos 30 días | Ritmo |
|---|---|---|---|
| **Polifroni Puertas** | `30637662755` | **134 · 63%** | 5,4 por día, **25 de 30 días** |
| **eGrowers** (Sofía Alewarts) | `27333439692` | **49 · 23%** | 6,1 por día, pero solo **8 días** |
| The Automation Partner SA | `30719434505` | 29 · 14% | 4,1 por día, 7 días |
| Martin Meliendrez (dev) | `20327446348` | 2 · 1% | casi no se usa |
| Pamela Martinez | `23329811484` | 0 | último uso: 05/07 |

> **Polifroni y eGrowers son el 85% del uso real.** Si algo falla, son los que van a
> escribir.

**Y los dos usan la app de forma distinta — esto sirve para saber si algo anda mal:**

- **Polifroni factura casi todos los días** (25 de los últimos 30). Si pasa **un día hábil
  sin emitir nada**, algo está pasando. Es la señal más temprana que tenemos.
- **eGrowers factura en tandas**: 49 comprobantes concentrados en 8 días. Que estén 3 días
  sin facturar es **normal**, no es un síntoma.

Casi todo lo que emiten son facturas. En los últimos 60 días también hubo **22 notas de
crédito** (12 de Polifroni, 10 de TAP SA) y **6 comprobantes de exportación** (TAP SA y el
CUIT de dev).

## Detalles de cada uno que conviene saber antes de un incidente

- **Polifroni está en OTRA cuenta de monday** (`30446835`). No la ven desde la cuenta de
  ustedes. Y tiene **dos tableros** que facturan contra la misma numeración de AFIP —
  `18414569460` (Fact Local) y `18411065225` (Facturación obra). Que un número "falte" en
  un tablero no significa nada: puede estar en el otro.
- **eGrowers** usa un solo tablero, `18411071561`, punto de venta 2.
- **La Batea no existe** en el sistema. Nunca se dio de alta.
- **Las plantillas ES/EN del Marketplace no son clientes**: son los tableros que se copian
  cuando alguien instala la app.

---

# 2. La arquitectura

## Dónde corre cada cosa

```
                        monday.com
                   (el cliente aprieta)
                            │
                            ▼
                       Cloudflare                    ← DNS + TLS + caché
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
  arca.theautomation...              staging.theautomation...
        │                                       │
        ▼                                       ▼
┌──────────────────────── DROPLET 134.122.5.114 ─────────────────────────┐
│                                                                        │
│  /opt/apps/App-monday              /opt/apps/App-monday-staging        │
│  pm2 "tap-monday"  · :3000         pm2 "tap-monday-staging" · :3001    │
│  branch main                       branch develop                      │
│                                                                        │
└────────┬──────────────────────────────────────┬────────────────────────┘
         │                                      │
         ▼                                      ▼
    defaultdb                              stagingdb          ← mismo cluster PostgreSQL
    AFIP PRODUCCIÓN                        AFIP HOMOLOGACIÓN
    (CAE de verdad)                        pero SOLO para los tableros de Martín;
                                           todo lo demás lo reenvía a producción
```

**Un solo servidor, dos copias de la app.** Cada una con su base y su entorno de AFIP.

> ⚠️ **Cuidado con "staging es de prueba" — no siempre.**
> Staging apunta al AFIP de homologación, **pero solo procesa los tableros de unos pocos
> workspaces de desarrollo, todos del CUIT de Martín.** Cualquier otro tablero que llegue
> ahí **NO va a homologación: se reenvía a producción y emite un CAE real.** Es a propósito:
> así, si un cliente cae ahí por error, su factura sale igual y no se pierde.
>
> Consecuencia práctica: **no alcanza con "estar en staging" para probar tranquilo.** Lo
> que hace seguro al tablero de pruebas es que tiene **certificado de homologación**, no el
> entorno.

Se deploya solo: **push a `develop` → staging**, **push a `main` → producción**. Tarda unos
2 minutos.

## Qué pasa cuando alguien emite una factura

```
1. monday dispara la receta          → POST /api/invoices/emit
2. la app lee el ítem y sus subítems  (concepto, cantidad, precio, IVA)
3. valida los datos                   ← acá falla el 80% de los errores
4. consulta el padrón de AFIP         (¿quién es este CUIT? ¿qué IVA tiene?)
5. decide la letra: A, B o C          (según emisor y receptor)
6. RESERVA el número en la base       ← ANTES de hablar con AFIP. Clave.
7. le pide el CAE a AFIP
8. verifica que el CAE que volvió sea el correcto
9. genera el PDF y lo sube al ítem
10. escribe en el tablero de auditoría
```

**El paso 6 es el que hace que el sistema sea recuperable.** Si AFIP responde y se corta la
red justo después, el número quedó anotado y el sistema puede preguntar más tarde "¿esto se
emitió?". Sin eso, el comprobante quedaría huérfano: existiría en AFIP y no lo sabríamos.

## Las 4 capas que arreglan solas

Es lo que hace que la mayoría de los problemas **no requieran que nadie haga nada**:

| Capa | Cuándo actúa | Qué hace |
|---|---|---|
| **1. Reserva** | Antes de cada emisión | Anota el número antes de hablar con AFIP |
| **2. Verificación** | Justo después del CAE | Vuelve a preguntarle a AFIP si coincide |
| **3. Reconciliación** | **Cada 5 minutos** | Rescata las emisiones que quedaron colgadas |
| **4. Auditoría** | **3 AM, todos los días** | Compara todo contra AFIP y avisa a Slack |

Hay una quinta, al revés: el **detector de huérfanos** corre pegado a la de las 3 AM y
busca comprobantes que **AFIP tiene y nosotros no**.

> Por eso la regla es "esperá 15 minutos antes de tocar". La capa 3 ya está trabajando.

## Lo único irreversible

Cuando AFIP autoriza una factura devuelve un **CAE**, y desde ese momento el comprobante
**existe para el Estado**. No se borra: se anula con una nota de crédito, que es un acto
contable.

**Todo lo demás se arregla**: el servidor, un deploy malo, una fila trabada, un tablero
roto.

De ahí salen las dos reglas que ordenan todo lo que sigue:

1. **Ante la duda, no toques.** La reacción apurada hace más daño que el problema.
2. **Todo lo que sea plata o un cliente lo decide Pamela** (contadora). Los devs no
   escriben a clientes: eso lo hacen Pamela y Martín.

---

# 3. Qué puede fallar esta semana

Las alertas llegan al canal de Slack **`#make-errores-`**, donde están todos los devs.

## Traducción rápida de lo que llega

| Lo que ves | Qué es | ¿Hacés algo? |
|---|---|---|
| ✅ `Auditoria nocturna AFIP` | La **señal de vida diaria**. Llega todas las noches a las 3 AM, incluso si no hubo nada que auditar | No. **Que NO llegue sí es un problema** |
| 🚨 `Error sistema en facturación` | ⚠️ Un mismo título tapa **6 cosas distintas** | Leé la línea `Error:` ↓ |
| 🚨 `DISCREPANCIA AFIP` | Lo que registramos no coincide con AFIP | Sí, el mismo día |
| 🟡 `Conciliación AFIP — sin registrar` | AFIP tiene comprobantes que nosotros no | Preguntar, no arreglar |
| ⚠️ `Condición de IVA no reconocida` | La factura **salió bien**. Es una nota para después | No |

## Los 6 errores más probables, y qué significan

### 🔴 `[RECOVERY_MISMATCH]` — el más grave

El número que un ítem tenía reservado ya existe en AFIP, **pero es de otro comprobante**.
Significa que **esa factura no se emitió**. Y peor: el sistema la sacó de la cola de
reintentos **para siempre**, así que si nadie actúa, la venta queda sin facturar y nadie se
entera.

**Qué hacer:** nada técnico. Documentarlo y avisarle a Pamela y a Martín el mismo día.
**Nunca** re-emitir ni adoptar el CAE que aparece en el mensaje.
→ [RUNBOOK, ficha 1](RUNBOOK.md)

### 🔴 `[ABANDONED]` — reservó número y AFIP dice que no existe

Durante 8 horas el sistema le preguntó a AFIP 100 veces y siempre dijo que no. Conclusión:
**la factura realmente no se emitió** — esa es la buena noticia.

Ojo con el reloj: la alerta llega 8 horas después, así que **el cliente ya se quejó antes**
por otro lado. Son el mismo caso.

**Qué hacer:** re-emitir es técnicamente seguro, pero **lo autoriza Pamela** (puede haber
cambiado la fecha, o el cliente puede haber facturado a mano mientras tanto).
→ [RUNBOOK, ficha 2](RUNBOOK.md)

### 🔴 `DISCREPANCIA AFIP` — la auditoría encontró algo

Lo que registramos no coincide con AFIP: importe, número o CAE. O tenemos un CAE que AFIP
no reconoce.

⚠️ **Trampa:** si el **mismo** mismatch aparece 3 noches seguidas, **el sistema deja de
avisar**. No se arregló: se calló. Por eso el chequeo diario mira el acumulado.

**Nunca** editar la fila para que "coincida" con AFIP: eso destruye la evidencia, y nuestro
registro es lo que respalda el PDF que el cliente ya mandó.
→ [RUNBOOK, ficha 3](RUNBOOK.md)

### 🟡 AFIP caído — lo más probable de todo

Varios ítems de **clientes distintos** fallan a la vez, con `503`, `ETIMEDOUT` o
`ECONNRESET`. **El error es de ellos.**

Se confirma en 5 segundos con el `FEDummy`, que no pide autenticación. Si `AppServer`,
`DbServer` o `AuthServer` no dicen `OK`, es AFIP.

**Qué hacer:** avisar y esperar. **No** reiniciar, **no** revertir el deploy, **no** tocar
certificados.
→ [RUNBOOK, ficha 5](RUNBOOK.md)

### 🟡 Una emisión colgada en "processing"

El cliente dice *"quedó en Creando y no pasa nada"*.

**El problema es benigno. El peligro es la reacción.** La capa 3 lo revisa cada 5 minutos.

⛔ **Lo más importante de toda esta guía:** no re-dispares la receta, no cambies el estado a
mano, no hagas un `UPDATE`. **Cualquiera de esas cosas puede generar dos CAE para una sola
venta**, y eso solo se corrige con nota de crédito.
→ [RUNBOOK, ficha 7](RUNBOOK.md)

### ⚪ El cliente cargó algo mal — el más frecuente

Falta o está mal un dato del ítem. **La app ya se lo explicó al cliente** en un comentario,
con la causa y cómo arreglarlo, en su idioma. Hay 232 mensajes distintos y todos dicen qué
hacer.

**Qué hacer:** copiarle al cliente lo que dice el comentario. Nada más.
→ [RUNBOOK, ficha 6](RUNBOOK.md)

---

# 4. Cómo se hace un cambio: un caso completo

Ejemplo real: **un cliente reporta que un mensaje de error dice algo confuso y hay que
mejorarlo.**

## Paso 1 — Trabajar en `develop`, nunca en `main`

```bash
git checkout develop
git pull origin develop
```

⚠️ **Nunca pushees directo a `main`.** Ahí están los 3 clientes reales.

## Paso 2 — Hacer el cambio y probarlo local

```bash
cd backend-repo
npm test          # 5 bancos de prueba, menos de un segundo
```

No necesita AFIP, ni monday, ni base de datos. Si tocaste un mensaje **a propósito**,
refrescá el corpus: `node test/mensajes.test.js --actualizar`

## Paso 3 — Subir a staging

```bash
git add .
git commit -m "fix: descripción del cambio"
git push origin develop
```

GitHub Actions corre los tests y deploya a staging solo. **Si un test falla, el deploy se
frena** y no llega a ningún lado.

## Paso 4 — Probarlo de verdad, en el tablero de pruebas

👉 **[Facturación con errores de test](https://the-automation-partner.monday.com/boards/18425062980)**

Tiene 12 ítems cargados con datos mal a propósito, uno por cada error. Y tiene
**certificado de homologación**, o sea que **no puede emitir un comprobante real**. Podés
romper tranquilo.

Cambiá la columna de estado a **"Crear Comprobante"** en el ítem que corresponda, y leé el
comentario que deja la app.

⚠️ **Ojo:** ese tablero apunta a **producción** (la versión Live). Lo que lo hace seguro no
es el entorno, es el **certificado de homologación**. Si querés probar contra staging tenés
que crear una versión Draft en monday — y esta semana **eso está prohibido**, porque una
Draft activa rutea clientes reales a la instancia de pruebas.

## Paso 5 — Verificar que quedó bien

```bash
ssh root@134.122.5.114
cd /opt/apps/App-monday-staging && git log --oneline -1     # ¿llegó tu commit?
pm2 logs tap-monday-staging --lines 50
```

## Paso 6 — Pasar a producción

```bash
git checkout main
git merge develop --ff-only
git push origin main
```

En ~2 minutos está arriba y los clientes lo ven.

## Paso 7 — Confirmar que llegó DE VERDAD

⚠️ **Que GitHub Actions esté en verde no alcanza.** Ya pasó dos veces que el workflow
terminó bien y el código nunca llegó al servidor.

```bash
ssh root@134.122.5.114 "cd /opt/apps/App-monday && git log --oneline -1"
```

Ese commit tiene que ser el tuyo. Si no coincide, el deploy falló aunque diga OK. La causa
más común: **alguien dejó un archivo suelto en el droplet** y el `git pull` se niega a
pisarlo.

## Si algo salió mal

```bash
git checkout main && git revert HEAD && git push origin main
```

**Revertir nunca necesita permiso de nadie.** No hace falta entender el bug para revertir.

⚠️ **Nunca** `git reset --hard` con `--force`, y **nunca** edites archivos directo en el
droplet: el próximo deploy falla y rompe todos los siguientes.

---

# 5. Reglas de esta semana

Mientras el creador no está, estas tres eliminan la mitad de los incidentes posibles:

1. **A `main` solo van reverts y arreglos urgentes.** Ninguna feature.
2. **Nadie crea versiones Draft en monday.** Una Draft activa rutea clientes reales a la
   instancia de pruebas.
3. **Ninguna migración de base de datos.**

---

# 6. A dónde ir después

| Documento | Para qué |
|---|---|
| **[RUNBOOK.md](RUNBOOK.md)** | **Se rompió algo ahora.** 12 fichas, se entra por el síntoma. Tiene también el chequeo diario de 5 minutos y los procedimientos (leer logs, reiniciar, backup) |
| [EMPEZA-ACA.md](EMPEZA-ACA.md) | Es tu primer día. Incluye **cómo conseguir acceso al servidor** |
| [CLAUDE.md](CLAUDE.md) | El detalle fino: reglas del código, cómo se arman los mensajes, notas de crédito, exportación |

**El código está muy comentado, y no es adorno.** Los comentarios largos cuentan qué
incidente real los originó, con importes y números de comprobante. Cuando algo parezca
retorcido, leé el comentario de arriba: casi siempre explica por qué.

Los mejores para entender el sistema: `src/modules/recoveryGuard.js` y
`src/modules/errorMessages.js`.
