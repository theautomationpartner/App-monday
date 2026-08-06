# Empezá acá

Si es tu primer día en este proyecto, leé esta página entera. Son 5 minutos y te ahorran
una semana.

---

## Qué es esto

Una app del marketplace de **monday.com** que emite **facturas electrónicas de AFIP**.

El cliente carga una venta en un tablero de monday, cambia una columna de estado a "Crear
Comprobante", y la app le habla a AFIP, obtiene el **CAE**, genera el PDF y lo deja
adjunto en el ítem. Todo eso pasa en unos 8 segundos.

**Hoy la usan 3 clientes reales que facturan todos los días.** No es un proyecto interno
ni una demo.

---

## Lo único que tenés que entender el primer día

Cuando AFIP autoriza una factura, devuelve un **CAE**. Desde ese momento el comprobante
**existe para el Estado y no se borra**. Si salió uno de más, se anula con una nota de
crédito — que es un acto contable, no un botón.

Todo lo demás de este sistema se arregla: el servidor, un deploy malo, una fila trabada,
un tablero roto. **Eso no.**

De ahí sale la única regla que importa: **ante la duda, no toques nada y preguntá.**

---

## Dónde corre cada cosa

Un servidor, dos copias de la app:

```
DROPLET  134.122.5.114
├── /opt/apps/App-monday          → PRODUCCIÓN · branch main    · puerto 3000
│                                   base defaultdb · AFIP de verdad
└── /opt/apps/App-monday-staging  → PRUEBAS    · branch develop · puerto 3001
                                    base stagingdb · AFIP de mentira
```

Se deploya solo: **push a `develop` → staging**, **push a `main` → producción**. Tarda
unos 2 minutos.

⚠️ **Producción y staging comparten un mismo tablero de auditoría en monday**, así que ahí
vas a ver mezcladas las emisiones reales con las de prueba. Se distinguen por el CAE.

---

## Cómo probar sin romper nada

Hay un tablero hecho para esto:

**[Facturación con errores de test](https://the-automation-partner.monday.com/boards/18425062980)** — 12 ítems cargados con datos mal a propósito, uno por cada error posible.

Tiene **certificado de homologación**, o sea que **no puede emitir un comprobante real**.
Aunque quieras. Podés disparar lo que quieras ahí.

Y para los mensajes de error, sin tocar nada:

```bash
cd backend-repo && npm test     # 5 bancos, menos de un segundo
```
No necesita AFIP, ni monday, ni base de datos. Corren solos en cada deploy y frenan el
deploy si algo se rompió.

---

## Los documentos, y cuándo leer cada uno

| Documento | Cuándo |
|---|---|
| **[RUNBOOK.md](RUNBOOK.md)** | **Se rompió algo y hay un cliente esperando.** Entrás por el síntoma. |
| [CLAUDE.md](CLAUDE.md) | Vas a hacer un cambio. Explica cómo funciona y el workflow para no romper producción. |
| Este archivo | Es tu primer día. |
| `README.md` | Nada. Está viejo, no menciona staging. |

**El código está bien comentado, y no es adorno.** Los comentarios largos cuentan qué
incidente real los originó, con importes y números de comprobante. Cuando algo te parezca
raro o retorcido, leé el comentario de arriba: casi siempre está explicado por qué.

Los mejores para entender el sistema: `src/modules/recoveryGuard.js` y
`src/modules/errorMessages.js`.

---

## Los 4 comandos que más vas a usar

```bash
ssh root@134.122.5.114              # entrar al servidor

pm2 list                            # ¿está vivo?
pm2 logs tap-monday --lines 100     # ¿qué está pasando?

curl -s https://arca.theautomationpartner.com/api/health
```

---

## Antes de tocar producción

1. **Nunca pushees directo a `main`.** Va a `develop` primero, se prueba en staging.
2. **Si rompiste algo, revertí.** No hace falta entender el bug:
   `git checkout main && git revert HEAD && git push origin main`
   Revertir nunca necesita permiso de nadie.
3. **Nunca edites archivos directo en el droplet.** El próximo deploy falla y rompe todos
   los siguientes. Ya pasó.
4. **Cualquier cosa que toque plata, un CAE o un cliente: preguntá antes.**

---

## Quién decide qué

- **Pamela** (contadora, jefa): todo lo fiscal. Notas de crédito, hablar con un cliente,
  cualquier cosa que cambie un importe o un número de comprobante.
- **El líder técnico**: lo demás.
- **Martín**: solo si se está perdiendo plata y ninguna ficha del runbook lo cubre.

---

## Los clientes

?? *Completar antes del lunes: quién es cada uno, su CUIT, su tablero, y quién le habla.*

Por ahora, lo único que necesitás saber: **son tres, son reales, y facturan todos los
días.**
