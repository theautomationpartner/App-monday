# RUNBOOK — Factura ARCA

**Si algo se rompió, este es el documento.** Buscá con `Ctrl+F` el texto de la alerta que
te llegó, o lo que te dijo el cliente.

> **¿Nunca viste este sistema?** Leé primero **[GUIA-TECNICA.md](GUIA-TECNICA.md)** —
> arquitectura, clientes y qué puede fallar, en 15 minutos. Este runbook asume que ya
> sabés qué es un CAE.

> Última revisión: **06/08/2026** · Escrito para la semana del 11 al 15 de agosto.

---

## Qué es esto y qué está en juego

Esta app emite **facturas electrónicas de AFIP** desde monday.com. Hoy la usan
**3 clientes reales que facturan todos los días**. Cuando emitís una factura, AFIP te
devuelve un **CAE** — y desde ese momento el comprobante existe para el Estado.

**Un CAE no se borra.** Si sale uno de más, se anula con una nota de crédito, que es un
acto fiscal. Esa es la única cosa verdaderamente irreversible acá. Todo lo demás —el
servidor caído, un deploy malo, una fila trabada, un tablero roto— se arregla.

---

## Las 3 reglas

**1. Ante la duda, no toques.** El sistema tiene 4 capas que arreglan solas la mayoría de
los problemas, y tardan entre 5 minutos y 8 horas. La reacción apurada hace más daño que
el problema: re-disparar una emisión que "parece trabada" es la forma más común de
generar una factura duplicada.

**2. Si rompió un deploy: revertí primero, investigá después.** No necesitás entender el
bug para revertir. Revertir nunca necesita permiso de nadie.

**3. Todo lo que sea plata, un número de comprobante o un cliente: lo decide Pamela.**
Ella es contadora. Vos podés decir "el sistema está caído, ya lo estamos viendo". No podés
decir "tu factura está bien" ni "emitila de nuevo".

---

## Reglas de esta semana

Mientras Martín no está, estas tres cosas eliminan la mitad de los incidentes posibles:

- **A `main` solo van reverts y arreglos urgentes.** Ninguna feature.
- **Nadie crea versiones Draft en monday.** Una Draft activa rutea clientes reales a la
  instancia de pruebas.
- **Ninguna migración de base de datos.**

---

## ¿Está sano? — chequeo de 2 minutos

> **¿No entrás al servidor?** El acceso se pide una sola vez y son 3 pasos:
> ver **[EMPEZA-ACA.md → Conseguir acceso al servidor](EMPEZA-ACA.md#conseguir-acceso-al-servidor)**.
> Hacelo **antes** de que haya un incidente, no durante.

```bash
ssh root@134.122.5.114

pm2 list                                    # tap-monday y tap-monday-staging: online
curl -s https://arca.theautomationpartner.com/api/health
df -h / | tail -1                           # que no pase de 85%
free -m | grep Mem
```

**Así se veía el 06/08, funcionando bien:**

```
pm2        tap-monday · online · restarts 118
salud      {"status":"ok","message":"Servidor y DB conectados"}
disco      70% usado (2.7 G libres)
RAM        287 MB de 458 MB
base       501 emisiones · 484 exitosas · 0 con discrepancia
```

⚠️ **El health miente a medias.** Solo prueba que la base responde. **No** verifica AFIP ni
si los procesos automáticos siguen vivos. Para eso:

```bash
# Los crons tienen que aparecer seguido. Reconciliación cada 5 min, backfill cada 15.
pm2 logs tap-monday --nostream --lines 3000 | grep -E "\[reconcile-cron\]|\[audit-backfill\]"
```

Si la última línea es de hace horas, **los procesos automáticos están muertos aunque pm2
diga `online`** → ficha 4.

**Anomalía conocida, no la toquen:** hay 1 emisión en `processing` desde el 12/05 (id 50).
Nunca reservó número, así que jamás llegó a AFIP y ningún cron la mira. Está así hace
3 meses y es inofensiva.

⚠️ **Chequeá siempre por el dominio, nunca por la IP.** Desde el 03/09/2026 el servidor
solo acepta tráfico que venga de Cloudflare. Si curleás la IP directo te va a contestar:

```
400 Bad Request — No required SSL certificate was sent
```

**Eso está bien, es la protección funcionando** — no es que el servidor esté caído. Si
necesitás saltear Cloudflare para debuggear, entrá por SSH y curleá adentro:

```bash
ssh root@134.122.5.114
curl -s http://localhost:3000/api/health      # prod
curl -s http://localhost:3001/api/health      # staging
```

---

## Chequeo diario — 5 minutos, una vez por día

El sistema tiene tres puntos ciegos conocidos: **no avisa si un proceso automático se
muere**, **un mismatch repetido se auto-silencia a la tercera noche**, y **un certificado
vencido no tiene alerta propia**. Este chequeo los tapa. Son 7 preguntas.

**1. ¿Llegó el aviso nocturno a Slack?**
Tiene que estar, todas las mañanas. Si no está → ficha 10.

**2. ¿Está vivo el proceso?**
```bash
ssh root@134.122.5.114 "pm2 list"
```
`online`, y que los `restarts` no hayan subido de golpe desde ayer.

**3. ¿Los procesos automáticos siguen corriendo?**
```bash
pm2 logs tap-monday --nostream --lines 2000 | grep -E "\[reconcile-cron\]|\[audit-backfill\]" | tail -3
```
Tienen que ser de hace minutos, no de hace horas. **Esto es lo que el health no verifica.**

**4. ¿Hay algo trabado?**
```sql
SELECT status, COUNT(*) FROM invoice_emissions
WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY 1;
```
Algún `processing` es normal. Muchos, o uno de ayer, no.

**5. ¿Hay discrepancias acumuladas?**
```sql
SELECT audit_status, COUNT(*) FROM invoice_emissions WHERE status='success' GROUP BY 1;
```
`mismatch` y `not_found_in_afip` tienen que dar **0**. Si hay y no llegó alerta, es porque
se auto-silenciaron → ficha 3.

**6. ¿Se vence algún certificado esta semana?**
```sql
SELECT company_id, expiration_date FROM afip_credentials ORDER BY expiration_date LIMIT 3;
```
Si alguno vence en menos de 15 días, avisale a Pamela **antes** de que el cliente no pueda
facturar → ficha 12.


**7. ¿Algún tablero quedó con dos dueños?**
```sql
SELECT board_id, workspace_id, company_id FROM board_automation_configs
WHERE workspace_id IS NULL OR workspace_id = '';
```
Tiene que dar **0 filas**. Cualquier fila acá es una config que la app guardó sin saber de
qué empresa era: el tablero queda con dos empresas anotadas y la emisión puede salir con el
**CUIT equivocado**, sin error y sin que la pantalla lo muestre (la app resuelve por
workspace y la emisión por tablero). Pasó el 24/08/2026 en el board de TAP SA. Se arregló en
el código, pero el chequeo queda: si vuelve a dar algo, es el mismo bug de nuevo.

Para ver quién es el dueño real de un tablero, la misma consulta que usa la emisión:
```sql
SELECT c.cuit FROM companies c JOIN board_automation_configs bac ON bac.company_id = c.id
WHERE c.monday_account_id::text = '<accountId>' AND bac.board_id = '<boardId>'
ORDER BY (bac.workspace_id IS NOT NULL AND bac.workspace_id <> '') DESC, bac.updated_at DESC
LIMIT 1;
```
> Anotá lo raro en algún lado, aunque no hagas nada. Si algo aparece tres días seguidos,
> deja de ser ruido.

---

## Diccionario mínimo

Diez palabras. Sin esto no se entiende el resto.

| Palabra | Qué es |
|---|---|
| **CAE** | El número que AFIP le da a una factura al autorizarla. Con eso el comprobante ya existe para el Estado. **No se borra.** |
| **Punto de venta** | Un número (1, 5, 7…) que agrupa la numeración. Cada uno lleva su propia secuencia. |
| **CbteTipo** | El código de AFIP para el tipo: Factura A=1, B=6, C=11 · NC = 3/8/13 · ND = 2/7/12 |
| **NC / ND** | Nota de crédito (resta) y nota de débito (suma). Es la única forma de anular o corregir algo ya emitido. |
| **Padrón** | El registro de AFIP donde se consulta quién es un CUIT y qué condición de IVA tiene. |
| **WSAA / token** | El login contra AFIP. Dura 12 h y se renueva solo. |
| **Homologación** | El AFIP de mentira, para probar. Los CAE de ahí no valen nada. |
| **Producción** | El AFIP de verdad. Un CAE de acá es un documento fiscal. |
| **Emisión** | Una fila en la tabla `invoice_emissions`. Estados: `processing`, `success`, `error`. |
| **`success`** | Tiene CAE. **Nunca se re-emite una fila en `success`** — ese fue el origen de un bug de facturas duplicadas. |

---

## Índice de incidentes

**Por lo que dice la alerta de Slack:**

| Si dice… | Ficha |
|---|---|
| `Error sistema` + `[RECOVERY_MISMATCH]` | **1** 🔴 |
| `Error sistema` + `[ABANDONED]` | **2** 🔴 |
| `DISCREPANCIA AFIP` (auditoría nocturna) | **3** 🔴 |
| `Error sistema` + `503` / `ETIMEDOUT` / `ECONNRESET` | **5** 🟡 |
| `Error sistema` + `Esta es la instancia de PRUEBA (staging)` | **9** 🔴 |
| `Conciliación AFIP — comprobantes sin registrar` | **8** 🟡 |
| `Condición de IVA no reconocida` | **11** ⚪ |
| `Auditoria nocturna` con ✅ | nada, es la señal de vida |
| **No llegó nada en toda la noche** | **10** 🟡 |

**Por lo que dice el cliente:**

| Si dice… | Ficha |
|---|---|
| "no me deja emitir" / "me tira un error" | **6** ⚪ |
| "quedó en Creando y no pasa nada" | **7** 🟡 |
| "no me anda nada" (y son varios clientes) | **5** o **4** |
| "se venció el certificado" | **12** 🟡 |

**Sin alerta:** deploy que rompió producción → **ficha 4**.

---

# 🔴 Fichas urgentes

## Ficha 1 · `[RECOVERY_MISMATCH]` — el número se lo llevó otro

**Llega así**, en Slack:
```
🚨 Error sistema en facturación
Error: [RECOVERY_MISMATCH] El N° 177 (PV 7) existe en AFIP con CAE=... pero NO es
el de esta emisión: importe: nuestro=259163.85 vs AFIP=1069942.5 ...
```

**Qué significa:** el número que este ítem tenía reservado ya existe en AFIP, **pero es de
otro comprobante**. O sea: **la factura de este cliente no se emitió**.

⚠️ **Y hay una segunda parte, peor:** el sistema sacó esa fila de la cola de reintentos
**para siempre**. Si nadie hace nada, esa venta queda sin facturar y nadie se entera.

**Gravedad: 🔴 hoy mismo.** Es la única alerta que no puede esperar a mañana.

**Diagnóstico:**
```sql
SELECT id, item_id, attempted_pto_vta, attempted_cbte_nro, error_message, updated_at
FROM invoice_emissions
WHERE error_message LIKE '[RECOVERY_MISMATCH]%'
ORDER BY updated_at DESC LIMIT 20;
```

**Qué hacer: nada técnico.** Documentá el caso y escalá.

**NO HAGAS:** re-emitir, adoptar el CAE que aparece en el mensaje, editar
`afip_result_json`, ni borrarle el `error_message` para "destrabarla" (eso la devuelve al
cron y puede duplicar).

**Escalá a: Pamela** (es numeración fiscal) **y al líder técnico**. Es uno de los 3
motivos para llamar a Martín de vacaciones.

*Ya pasó dos veces, con el mismo cliente. Está explicado en `src/modules/recoveryGuard.js`.*

---

## Ficha 2 · `[ABANDONED]` — reservó número y AFIP dice que no existe

**Llega así:**
```
🚨 Error sistema en facturación
Error: [ABANDONED] Reconciliation abandoned after 100 attempts — AFIP confirmed not exists
```

**Qué significa:** durante 8 horas el sistema le preguntó a AFIP si ese comprobante
existía, 100 veces, y siempre dijo que no. Conclusión: **la factura realmente no se
emitió**. Esa es la buena noticia adentro de la mala.

**Ojo con el reloj:** la alerta llega 8 horas después del hecho. **El cliente ya se quejó
por otro lado mucho antes** (ficha 7). Son el mismo caso.

**Gravedad: 🔴 pero sin apuro técnico.**

**Diagnóstico:** igual que la ficha 1, cambiando por `LIKE '[ABANDONED]%'`.

**Qué hacer:** re-emitir es técnicamente seguro —AFIP confirmó que no existe— **pero no es
una decisión técnica**. Puede haber cambiado la fecha, o el cliente puede haber facturado
a mano mientras tanto.

**Escalá a: Pamela.** Ella autoriza y define con qué fecha.

---

## Ficha 3 · `DISCREPANCIA AFIP` — la auditoría nocturna encontró algo

**Llega así**, a las 3 de la mañana:
```
🚨 DISCREPANCIA AFIP — Auditoria nocturna 2026-08-11
REVISAR MANUALMENTE EN AFIP WEB:
1. <Cliente> — Factura A N° 07-00000177
   ⚠️ Mismatch: • imp_total: nuestro=259163.85 vs AFIP=1069942.5
```

**Qué significa:** lo que registramos **no coincide con lo que AFIP tiene**. Dos sabores:
- `⚠️ Mismatch:` → un campo difiere (importe, número o CAE).
- `🚨 NO EXISTE EN AFIP` → tenemos un CAE que AFIP no reconoce. Más grave.

**Gravedad: 🔴 el mismo día.**

⚠️ **Trampa importante:** si el **mismo** mismatch aparece **3 noches seguidas, el sistema
deja de avisar**. No se arregló: se calló. Por eso el chequeo mira el acumulado:

```sql
SELECT audit_status, COUNT(*) FROM invoice_emissions WHERE status='success' GROUP BY 1;

SELECT id, item_id, audit_status, audit_findings, mismatch_persisted_nights, last_audit_at
FROM invoice_emissions
WHERE audit_status IN ('mismatch','not_found_in_afip')
ORDER BY last_audit_at DESC LIMIT 30;
```

`audit_findings` te dice qué campo difiere y los dos valores.

**NO HAGAS, nunca:** editar la fila para que "coincida" con AFIP. Eso destruye la única
evidencia de lo que pasó, y nuestro registro es lo que respalda el PDF que el cliente ya
mandó.

**Escalá a: Pamela.** Ella decide si hay que corregirlo ante AFIP.

---

## Ficha 4 · Un deploy rompió producción

**Se ve así:** funcionaba, alguien mergeó a `main`, y a los 2 minutos empiezan los errores.
**GitHub Actions está en verde.**

⚠️ **Verde no significa que se pueda facturar.** El chequeo automático del deploy son
5 tests de **textos y PDF**. No prueban AFIP, ni monday, ni la base, ni la emisión.

**Gravedad: 🔴. Revertí primero, entendé después.**

**Diagnóstico:** `git log --oneline -5 origin/main` y comparar la hora del deploy con la
del primer error. Que coincidan alcanza.

**Qué hacer:**
```bash
git checkout main && git revert HEAD && git push origin main
```
Deploya solo en ~2 minutos.

**NO HAGAS:** `git reset --hard` con `--force`; editar archivos directo en el droplet (el
próximo `git pull` falla y rompe **todos** los deploys siguientes); "arreglarlo rápido"
con otro push a `main`.

**Escalá al líder técnico** *después* de revertir, no antes.

> **Ya pasó el 06/08:** el deploy quedó verde pero el código nunca llegó al servidor. Había
> un archivo suelto en el droplet que hacía fallar el `git pull`, y el workflow terminaba
> bien igual. **Si revertís y el problema sigue, verificá que el servidor tenga el código
> que creés:** `ssh root@134.122.5.114 "cd /opt/apps/App-monday && git log --oneline -1"`

---

## Ficha 9 · Staging le rebotó una emisión a un cliente real

**Llega así:**
```
🚨 Error sistema en facturación
Error: Esta es la instancia de PRUEBA (staging)...
```
Es **la única alerta que staging tiene permitido mandar**.

**Qué significa:** un cliente real cayó en la instancia de pruebas. El mensaje que leyó el
cliente **le promete que ya avisamos**, así que alguien tiene que contestarle.

**Gravedad: 🔴 — hay un cliente esperando.**

**Diagnóstico:** ¿hay una versión Draft activa en monday? Y:
```bash
pm2 logs tap-monday-staging --nostream --lines 500 | grep staging-proxy
```

**Qué hacer:** eliminar la versión Draft en el Centro de Desarrollo de monday. La versión
Live apunta a producción y funciona bien. Pedirle al cliente que reintente.

**NO HAGAS:** emitir desde staging para "resolverlo".

**Escalá al líder técnico**, y avisale al cliente.

---

# 🟡 Fichas del día

## Ficha 5 · AFIP está caído

**Se ve así:** varios ítems de **clientes distintos** fallan a la vez. En Slack, errores
con `503`, `ETIMEDOUT`, `ECONNRESET` o `FECompUltimoAutorizado`. El cliente lee *"AFIP no
está respondiendo correctamente"*.

**Qué significa:** se cayó AFIP. El error es de ellos, no nuestro.

**Gravedad: 🟡 — no se pierde plata, no se puede facturar.**

**Diagnóstico — 5 segundos, no pide autenticación:**
```bash
curl -s -X POST https://servicios1.afip.gov.ar/wsfev1/service.asmx \
  -H "Content-Type: text/xml" \
  -H "SOAPAction: http://ar.gov.afip.dif.FEV1/FEDummy" \
  -d '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soapenv:Body><ar:FEDummy/></soapenv:Body></soapenv:Envelope>'
```
Si `AppServer`, `DbServer` o `AuthServer` no dicen `OK`, **es AFIP**.

**Qué hacer:** avisarle a los clientes que esperen. Reintentar cuando el FEDummy vuelva.

**NO HAGAS:** reiniciar pm2 (no cambia nada), revertir el deploy, tocar certificados, ni
prometerle un horario al cliente.

**Escalá:** a nadie. Si dura más de 3 horas en horario hábil → Pamela decide si los
clientes facturan a mano. *(Ojo: facturar a mano genera después la ficha 8.)*

---

## Ficha 7 · Emisión colgada en "processing"

**Se ve así:** el cliente dice *"quedó en Creando y no pasa nada"*.

**Qué significa:** la emisión salió y AFIP todavía no confirmó. El número ya está
reservado. **El sistema revisa esto solo, cada 5 minutos**, y le pregunta a AFIP si el
comprobante existe.

**Gravedad: 🟡 — el problema es benigno. El peligro es la reacción.**

### ⛔ Esperá 15 minutos antes de mirar siquiera

**Diagnóstico:**
```sql
SELECT id, item_id, attempted_pto_vta, attempted_cbte_nro,
       reconciliation_attempts, last_reconciliation_at, updated_at
FROM invoice_emissions
WHERE status='processing' ORDER BY created_at DESC LIMIT 20;
```
Si `reconciliation_attempts` **sube** de corrida en corrida, el sistema está trabajando.
Dejalo.

**Qué hacer: nada.**

**NO HAGAS —y esto es lo más importante del runbook:** re-disparar la receta en monday;
cambiar el estado a mano para "reintentar"; hacer un `UPDATE`; emitir la misma factura
desde otro ítem. **Cualquiera de esas cosas puede generar dos CAE para una sola venta**, y
eso solo se corrige con nota de crédito y con Pamela.

**Escalá:** si sigue más de 2 horas **con los intentos subiendo** → líder técnico. Si los
intentos **no** suben → los crons están muertos → ficha 10.

---

## Ficha 8 · AFIP tiene comprobantes que nosotros no

**Llega así:**
```
🟡 Conciliación AFIP — 2 comprobantes sin registrar (2 series)
AFIP emitió comprobantes que no figuran en el sistema.
📋 <Cliente> · CUIT ...
   • Factura B (PV 7) — falta 1 → 0007-00000080
```

**Qué significa:** hay huecos en la numeración de AFIP. **La causa más común es
inofensiva: el cliente facturó a mano desde la web de AFIP.** La causa grave sería un
duplicado nuestro.

**Gravedad: 🟡 — hay que preguntar, no arreglar.**

**Diagnóstico:** ¿los números faltantes son consecutivos y recientes? → probablemente una
tanda manual. ¿Hay emisiones nuestras con el mismo importe esos días? → posible duplicado,
tratalo como 🔴.

**NO HAGAS:** insertar filas en la base para "tapar" el hueco. **Ni llamar a
`/api/admin/ack-afip-gap`** — silenciar un hueco es afirmar que está bien fiscalmente, y
eso lo decide Pamela.

**Escalá a: Pamela**, que le pregunta al cliente si facturó por fuera.

> **Ya pasó, y así se resolvió (06/08):** Polifroni había emitido una Factura B y su nota
> de crédito desde el portal de AFIP. Se verificó comprobante por comprobante contra AFIP,
> se cargaron los dos ítems en su tablero con el PDF, y se silenciaron. Neto: cero.

---

## Ficha 10 · No llegó ninguna alerta en toda la noche

**Se ve así:** son más de las 3:10 AM y en Slack no hay nada.

**Qué significa:** **desde el 06/08, el aviso nocturno llega SIEMPRE**, aunque no haya
nada que auditar. Así que el silencio ya no es ambiguo: **si no llegó, algo está roto.**

**Gravedad: 🟡 — 3 minutos de chequeo.**

**Diagnóstico, en este orden:**
```bash
pm2 list                       # ¿online? ¿el uptime bajó? ¿los restarts subieron?
pm2 logs tap-monday --nostream --lines 3000 | grep "\[nightly-audit\]"
```
- Si hay líneas de `[nightly-audit]` pero no llegó el mensaje → falló el webhook de Slack.
- Si no hay ninguna → el proceso no llegó a las 3 AM → ficha 4 (¿se cayó?).

**NO HAGAS:** reiniciar "por las dudas". Reiniciar reprograma los crons y podés perder la
corrida del día.

**Escalá:** si pasan dos noches seguidas sin explicación → líder técnico.

---

## Ficha 12 · Se venció el certificado de un cliente

**Se ve así:** **un solo cliente** no puede emitir nada. En el ítem: *"Se te venció el
certificado de ARCA"*. En el resumen nocturno aparece 🟡 y el número de "errores técnicos"
salta de golpe.

**Qué significa:** venció el certificado que AFIP le dio a ese cliente. Sin eso no se firma
nada.

**Gravedad: 🟡 — pero avisale hoy, porque no factura hasta renovarlo.**

**Diagnóstico:**
```sql
SELECT company_id, expiration_date, status FROM afip_credentials ORDER BY expiration_date;
```
Miralos **todos** de una: si uno venció, fijate cuándo vencen los demás. Esa consulta de
5 segundos evita el segundo incidente igual.

**Qué hacer:** el cliente genera el certificado nuevo en ARCA y lo sube desde la app.
**Un desarrollador no puede hacerlo por él.**

**NO HAGAS:** tocar `afip_credentials` a mano.

**Escalá a: Pamela**, que habla con el cliente. Es un trámite en AFIP, no software.

*Tranquilos: las facturas ya emitidas de ese cliente no se perdieron. Solo quedan sin poder
auditarse hasta que haya certificado nuevo.*

---

# ⚪ Fichas que pueden esperar

## Ficha 6 · El cliente cargó algo mal

**Se ve así:** el cliente dice *"no me emite"*. **En Slack normalmente no suena nada** —
son errores de datos, no del sistema.

**Qué significa:** falta o está mal un dato del ítem. **La app ya se lo explicó al cliente**
en un comentario del ítem, con la causa y cómo arreglarlo, en su idioma.

**Gravedad: ⚪ — lo arregla el cliente.**

**Diagnóstico:** abrí el ítem en monday y leé el comentario. Hay 232 mensajes distintos, y
todos dicen qué hacer.

**Qué hacer:** copiarle al cliente lo que dice el comentario.

**NO HAGAS:** entrar a la base, cambiarle el mapeo del tablero, ni emitir desde otro lado.

**Escalá:** si el cliente **discute el criterio fiscal** ("¿por qué me pide la condición de
IVA?") → Pamela. Nunca improvises una respuesta fiscal.

---

## Ficha 11 · Ruido conocido — suena y no se hace nada

| Alerta | Qué hacer |
|---|---|
| `⚠️ Condición de IVA no reconocida — se usó X por descarte` | **Nada.** La factura salió bien. Es una nota para agregar un mapeo cuando vuelva Martín. Anotalo. |
| `✅ Auditoria nocturna` con `TODAS CORRECTAS` o con `0 para auditar` | **Nada.** Es la señal de vida diaria. |
| `[FASE2_MISMATCH]` dentro de un error sistema | La factura **sí** tiene CAE. Es informativo → líder técnico, sin urgencia. **Salvo que difiera el importe** → ahí es 🔴 y va a Pamela. |
| El cliente dice "el total en monday no coincide con el PDF" | Conocido: las columnas de fórmula del tablero de subítems **no restan la bonificación**. Se arregla en monday, no es un bug del backend. |

---

# Lo que solo decide Pamela

La línea es simple: **si cambia lo que AFIP o el cliente creen que pasó, es de Pamela. Si
solo cambia el estado del software, es del equipo.**

**Siempre va a Pamela:**

1. Emitir una nota de crédito o de débito. Ni "para probar".
2. Re-emitir una factura que quedó en duda. Aunque sea técnicamente seguro.
3. Llamar a `/api/admin/ack-afip-gap` (silenciar un hueco de numeración es un juicio contable).
4. Dar por cerrada una discrepancia de la auditoría.
5. Escribirle a un cliente **cualquier cosa** sobre números, CAE, plazos o implicancias fiscales.
6. Autorizar que un cliente facture a mano durante una caída.
7. Cambiar datos fiscales de un cliente: punto de venta, condición de IVA, mapeo.
8. Cualquier `UPDATE` o `DELETE` en `defaultdb`. **Doble autorización: Pamela y el líder
   técnico.** El `WHERE` se lee en voz alta antes de ejecutar.

**Lo que SÍ podés hacer solo** (igual de importante — sin esto todo escala y nadie hace nada):

- `pm2 reload`, leer logs, `curl /api/health`, el FEDummy.
- **`git revert` y push a `main`. Revertir nunca necesita permiso.**
- Correr `run-nightly-audit`, `run-orphan-detector` y `run-audit-backfill`. **Los tres son
  seguros**: leen y comparan, no emiten nada ante AFIP.
- Cualquier `SELECT` con `LIMIT`.
- Eliminar una versión Draft de monday.
- Decirle a un cliente que reintente en un rato.

> **De los 4 endpoints de administración, 3 son inofensivos y 1 (`ack-afip-gap`) es una
> decisión contable.** Si te acordás solo de esto, ya evitaste el peor error de la semana.

---

# Los 3 únicos motivos para llamar a Martín de vacaciones

1. Sospecha de **CAE duplicado**, o plata en riesgo que ninguna ficha cubre.
2. **Más de un cliente sin poder facturar por más de 2 horas** y el revert no lo arregló.
3. Un `[RECOVERY_MISMATCH]` que no se entiende (ficha 1).

Todo lo demás espera.

---

# Comandos que vas a usar

```bash
# Entrar
ssh root@134.122.5.114

# Estado
pm2 list
pm2 logs tap-monday --lines 100
pm2 logs tap-monday --nostream --lines 3000 | grep "\[nightly-audit\]"
pm2 reload tap-monday --update-env

# Base de datos (producción)
DATABASE_URL=$(grep ^DATABASE_URL= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
psql "$DATABASE_URL"

# Endpoints de administración (los 3 seguros)
TOKEN=$(grep ^DEV_MONDAY_TOKEN= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
curl -X POST http://localhost:3000/api/admin/run-nightly-audit   -H "x-admin-token: $TOKEN"
curl -X POST http://localhost:3000/api/admin/run-orphan-detector -H "x-admin-token: $TOKEN"
curl -X POST http://localhost:3000/api/admin/run-audit-backfill  -H "x-admin-token: $TOKEN"

# Revertir producción
git checkout main && git revert HEAD && git push origin main
```

**Consultas útiles** (todas de solo lectura):

```sql
-- ¿Cómo viene el día?
SELECT status, COUNT(*) FROM invoice_emissions
WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY 1;

-- ¿Hay algo trabado?
SELECT id, item_id, status, attempted_cbte_nro, reconciliation_attempts, updated_at
FROM invoice_emissions WHERE status <> 'success' AND attempted_cbte_nro IS NOT NULL
ORDER BY updated_at DESC LIMIT 20;

-- ¿Hay discrepancias sin resolver?
SELECT audit_status, COUNT(*) FROM invoice_emissions WHERE status='success' GROUP BY 1;

-- ¿De quién es esta fila?  (business_name está CIFRADO — buscá por cuit)
SELECT id, cuit, monday_account_id, workspace_id FROM companies;
```

⚠️ **`companies.business_name` está cifrado en la base** y vas a ver `U2FsdGVkX1...`. Es
normal. Identificá por `cuit` o `monday_account_id`.

---

# Procedimientos

## Leer los logs sin ahogarse

Todo lo que loguea el sistema lleva un prefijo entre corchetes. **Grepear por el prefijo es
la diferencia entre encontrar algo y leer 3000 líneas.**

| Prefijo | Qué es |
|---|---|
| `[emit]` | Emisión de una factura, paso a paso |
| `[nc]` · `[fe]` | Nota de crédito/débito · Factura de exportación |
| `[wsfe]` · `[wsfex]` | El diálogo crudo con AFIP (mercado interno · exportación) |
| `[wsaa]` | El login contra AFIP. Los tokens duran 12 h |
| `[padron-cron]` · `[padron-rec-cron]` | Refresco del padrón (emisor · receptores) |
| `[reconcile-cron]` | El que rescata emisiones trabadas, **cada 5 min** |
| `[nightly-audit]` | La auditoría de las 3 AM |
| `[orphan-detector]` | Busca comprobantes que AFIP tiene y nosotros no |
| `[audit-backfill]` | Rellena el tablero "Comp Emitidos", cada 15 min |
| `[staging-proxy]` · `[guard-staging]` | El ruteo de staging hacia producción |
| `[migrations]` | Solo al arrancar |

```bash
# Todo lo de un ítem puntual (el más útil cuando un cliente reporta algo)
pm2 logs tap-monday --nostream --lines 3000 | grep "12717334630"

# Qué pasó con una emisión
pm2 logs tap-monday --nostream --lines 3000 | grep -E "\[emit\]|\[wsfe\]" | tail -40

# Errores de verdad, sin el ruido
pm2 logs tap-monday --nostream --lines 2000 | grep -iE "error|falló|rechaz" | tail -30
```

⚠️ **Cada request tiene un `X-Request-ID`** de 12 caracteres. Si lo tenés, grepealo: te
trae toda la cadena de esa operación de una.

---

## Reiniciar sin romper nada

```bash
pm2 reload tap-monday --update-env
```

`reload` es gradual: el proceso viejo sigue atendiendo hasta que el nuevo está listo.

⚠️ **Nunca uses `pm2 delete` + `pm2 start`.** Perdés la configuración de
`ecosystem.config.js` (límites de memoria, rutas de log) y el proceso queda mal levantado.

⚠️ **Reiniciar reprograma todos los procesos automáticos desde cero.** Si reiniciás a las
2 AM, la auditoría de las 3 AM de esa noche no corre. No reinicies "por las dudas".

Y un detalle que ya nos mordió: **el `reload` es gradual, así que un cambio no se ve al
instante.** Si querés confirmar que el código nuevo está corriendo, mirá el `uptime`:

```bash
pm2 describe tap-monday | grep uptime     # tiene que ser de segundos, no de horas
```

---

## Verificar que un deploy llegó de verdad

**No alcanza con que GitHub Actions esté en verde.** Ya pasó dos veces que el workflow
terminó bien y el código nunca llegó al servidor.

```bash
ssh root@134.122.5.114 "cd /opt/apps/App-monday && git log --oneline -1"
```

Ese commit tiene que ser el que pusheaste. Si no coincide, el deploy falló aunque diga OK.
La causa más común: **alguien dejó un archivo suelto en el droplet** y el `git pull` se
niega a pisarlo.

```bash
cd /opt/apps/App-monday && git status --porcelain    # archivos sueltos que van a chocar
```

---

## Backup y restore

**Sacar una copia** (tarda menos de un segundo):

```bash
D=$(grep ^DATABASE_URL= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
pg_dump "$D" > /root/backups/defaultdb-$(date +%F-%H%M).sql
```

**Verificar que sirva** — que el archivo exista no alcanza:

```bash
F=$(ls -t /root/backups/*.sql | head -1)
grep -c "^CREATE TABLE" "$F"                      # tienen que ser 17
awk '/^COPY public.invoice_emissions/,/^\\\.$/' "$F" | wc -l
psql "$D" -t -A -c "SELECT count(*) FROM invoice_emissions;"   # tiene que dar parecido
```

**Restaurar: NO lo hagas solo.** Restaurar pisa datos de clientes reales y es de las pocas
cosas irreversibles del lado nuestro. Requiere Pamela **y** Martín. Si igual llega ese
momento, lo mínimo: sacar un dump del estado actual **antes** de restaurar nada, para poder
volver.

---

# Quién es quién

Sacado de la base de producción el 06/08/2026. **Toda consulta de diagnóstico empieza acá:
"¿de quién es esta fila?"**

⚠️ Recordá que `business_name` está cifrado. **Identificá siempre por `cuit`** — esta tabla
es la traducción.

| Quién | CUIT | Cuenta monday | PV | Tableros | Emitidas |
|---|---|---|---|---|---|
| **Polifroni Puertas Srl** | `30637662755` | **30446835** ← otra cuenta | 7 | `18414569460` Fact Local<br>`18411065225` Facturación obra | **290** |
| **eGrowers** (Sofía Alewarts) | `27333439692` | 28569993 | 2 | `18411071561` | **123** |
| **The Automation Partner SA** | `30719434505` | 28569993 | 1 | `18415550350` | 38 |
| **Martin Meliendrez** (dev) | `20327446348` | 28569993 | 5 | `18410634614` | 37 |
| **Pamela Martinez** | `23329811484` | 28569993 | 4 | `18411959800` | 5 |
| **test** (pruebas de error) | `20327446348` | 28569993 | 1 | `18425062980` | 0 · homologación |

**Los dos que importan son Polifroni y eGrowers:** entre los dos son el 80% de la
facturación real, y son los que van a escribir si algo falla.

Cosas que conviene saber antes de diagnosticar:

- **Polifroni está en OTRA cuenta de monday** (`30446835`). No la ves desde la cuenta de
  ustedes. Y tiene **dos tableros** que facturan contra la misma numeración de AFIP, uno
  local y uno de obra: que un número "falte" en un tablero no significa nada, puede estar
  en el otro.
- **La Batea todavía no existe** en el sistema. Si preguntan, no está dada de alta.
- **Las plantillas ES/EN del Marketplace no son clientes**: son los tableros que se copian
  cuando alguien instala la app.
- Hay empresas repetidas con el mismo CUIT en workspaces distintos (Martín, TAP SA). Es
  conocido y no es un error: cada workspace lleva su propia configuración.

**Contacto de cada cliente:** ?? *(completar: quién le escribe a Polifroni y a eGrowers, y
por qué canal).*

---

# El canal `#make-errores-` — qué llega y qué significa

Es donde están todos los devs. **No todo lo que llega ahí es un problema.**

| Lo que ves | Qué es | Acción |
|---|---|---|
| ✅ `Auditoria nocturna AFIP` | **La señal de vida diaria.** Llega todas las noches a las 3 AM, incluso si no hubo nada que auditar | Ninguna. **Que NO llegue sí es un problema** → ficha 10 |
| 🚨 `Error sistema en facturación` | ⚠️ **Un mismo título rojo tapa 6 cosas distintas** | leé la línea `Error:` ↓ |
| 🚨 `DISCREPANCIA AFIP` | Lo que registramos no coincide con AFIP | ficha 3 🔴 |
| 🟡 `Conciliación AFIP — sin registrar` | AFIP tiene comprobantes que nosotros no | ficha 8 🟡 |
| ⚠️ `Condición de IVA no reconocida` | La factura **salió bien**. Es una nota para después | ninguna ⚪ |

**El `Error sistema` se abre por la línea `Error:`.** Es lo más importante de esta página,
porque el mismo título va desde "esperá" hasta "esto es plata":

| Si `Error:` empieza con… | Qué es | Ficha |
|---|---|---|
| `[RECOVERY_MISMATCH]` | 🔴 **La factura NO se emitió** y el sistema no la va a reintentar nunca | 1 |
| `[ABANDONED]` | 🔴 Reservó número y AFIP dice que no existe | 2 |
| `Esta es la instancia de PRUEBA (staging)` | 🔴 Un cliente real cayó en staging y está esperando respuesta | 9 |
| `503` · `ETIMEDOUT` · `ECONNRESET` | 🟡 Se cayó AFIP. No es nuestro | 5 |
| `[FASE2_MISMATCH]` | ⚪ La factura **sí** tiene CAE. Informativo | 11 |

---

# Accesos — quién tiene qué

| | Quién |
|---|---|
| **SSH al servidor** | Cada dev con su clave → [cómo pedirlo](EMPEZA-ACA.md#conseguir-acceso-al-servidor) |
| **Centro de Desarrollo de monday** | Todos, con la cuenta de dev |
| **Slack `#make-errores-`** | Todos los devs |
| **Panel de DigitalOcean** | ⚠️ **Solo Martín (el jefe)** |
| **Cloudflare** | ⚠️ Solo Martín |
| **Clave fiscal de AFIP** | **Nadie de nosotros.** Cada cliente tiene la suya |

Dos consecuencias prácticas:

**Si el servidor no responde ni por SSH, hay que llamar a Martín.** Es el único que puede
entrar por la consola web de DigitalOcean o reiniciar el droplet.

**Nunca vamos a poder entrar a AFIP por un cliente.** Cuando una ficha dice "verificar en
AFIP web", eso lo hace **el cliente**, o Pamela con él. Nosotros solo consultamos por la
API — que es lo que hacen los endpoints de administración.

---

# Backups

**Estado: ?? — confirmar con Martín**, el único con acceso al panel de DigitalOcean.

Pero **no dependemos de eso**: la base entera pesa 15 MB y podemos sacar nuestra propia
copia con las credenciales que ya tenemos en el servidor.

```bash
ssh root@134.122.5.114
DATABASE_URL=$(grep ^DATABASE_URL= /opt/apps/App-monday/backend-repo/.env | cut -d= -f2-)
pg_dump "$DATABASE_URL" > /root/backup-$(date +%F).sql
ls -lh /root/backup-*.sql
```

Tarda segundos. **Bajate el archivo a tu máquina**: un backup que vive en el mismo servidor
no te salva si el servidor se muere.

---

# Falta completar

- **Contacto de Polifroni y de eGrowers:** ?? — quién les escribe y por dónde
- **Backups automáticos:** ?? — confirmar con Martín si el cluster los tiene
- **Contacto de emergencia del creador:** ?? — cómo se lo ubica
