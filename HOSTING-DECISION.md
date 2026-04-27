# Decisión de hosting — Backend de Facturación AFIP

**Autor**: Dev1
**Fecha**: 2026-04-24
**Contexto**: La app de facturación electrónica AFIP está en producción con clientes. Hoy el backend corre en Monday Code. Los tiempos de emisión son irregulares y a veces llegan a 2-3 minutos. Queremos evaluar si conviene migrar el hosting.

---

## 1. Qué es hosting y dónde está el código hoy

El **backend** es el servidor que hace todo el trabajo técnico: hablar con AFIP, generar el PDF, subir el archivo a Monday, guardar en base de datos. Para que esté disponible 24/7, tiene que "vivir" en un servidor.

Hoy vive en **Monday Code**, que es el servicio de hosting que ofrece Monday específicamente para apps integradas a su plataforma. Funciona así:

- Subimos el código con un comando (`mapps code:push`)
- Monday Code lo pone en un container (máquina virtual aislada)
- Monday le da un dominio, SSL, y lo conecta con la app
- Los secrets (token de AFIP de Martín, etc.) se manejan desde Monday
- El log queda visible en el Developer Center de Monday

Es **lo oficialmente recomendado** por Monday para apps integradas.

---

## 2. Problema actual

Durante el proceso de optimización (últimas semanas) hicimos varios caches y mejoras que redujeron el tiempo de emisión de **~3 minutos a ~60-100 segundos**. Pero el tiempo **varía mucho**: a veces una factura tarda 1 minuto, la siguiente 3 minutos.

Identificamos que la variabilidad viene del container de Monday Code. Al ser **CPU compartida** (el container comparte procesador con otras apps de otros desarrolladores), cuando hay picos de uso general:

- Generar el PDF pasa de 1 s a 50 s
- Subir archivos a Monday pasa de 3 s a 20 s
- Todo lo que depende de CPU/red se vuelve lento

Esto **no es culpa del código**. Es una limitación del modelo de hosting compartido de Monday Code.

### Ejemplo real medido

| Etapa | Medida rápida | Medida lenta | Normal |
|---|---|---|---|
| Generar PDF | 1 s | 50 s | 1-2 s |
| Subir PDF a Monday | 3 s | 19 s | 2-3 s |
| Cambiar estado en tablero | 1 s | 10 s | 1-2 s |
| **Total factura** | **~60 s** | **~200 s** | **~60-80 s** |

---

## 3. Opciones

### Opción A — Quedarse en Monday Code (status quo)

**Ventajas**
- Cero migración, cero riesgo
- Integración nativa con secrets y auth de Monday
- Costo $0
- Es lo oficialmente recomendado por Monday

**Desventajas**
- Tiempos irregulares (1 a 3 minutos por factura)
- Sin control sobre CPU
- La primera impresión del cliente que recién instaló puede ser mala
- Si Monday Code empeora, no podemos hacer nada

**Esfuerzo**: nulo
**Costo**: $0

---

### Opción B — Migrar todo a hosting con CPU dedicada

**Proveedores evaluados**

| Proveedor | Costo mensual | Pros | Contras |
|---|---|---|---|
| **Render** | $7 (Starter) | Simple, dashboard claro, SSL y DNS incluidos, deploy desde Git | Tier gratuito duerme el container (no sirve) |
| **Railway** | ~$5 + uso | Muy fácil, bueno para crecer | Facturación variable puede sorprender |
| **Fly.io** | Desde $0 pay-as-you-go | Muy rápido, escala global | Más técnico de configurar |
| **DigitalOcean** | $6/mes (App Platform) | Proveedor clásico, confiable | Config inicial más manual |

**Recomendado: Render** para empezar — balance entre simplicidad y performance.

**Ventajas**
- CPU dedicada → tiempos estables y predecibles
- PDF pasa de 50 s → 1-2 s garantizados
- Total factura estimado: **30-40 segundos** consistentes
- Log y métricas más detalladas
- Escalabilidad: podemos crecer sin cambiar hosting

**Desventajas**
- Hay que migrar el código (trabajo técnico)
- Configurar DNS/SSL externo para que Monday llame a nuestro servidor
- Re-configurar los secrets de AFIP en el nuevo hosting
- Costo mensual de $5-7

**Esfuerzo**: ~1 a 2 días de trabajo técnico + testing
**Costo**: $5-7/mes

**Detalles técnicos de la migración**
1. Crear cuenta en Render
2. Conectar el repo de GitHub
3. Configurar variables de entorno y secrets (AFIP cert, DB connection, Monday tokens)
4. Deploy inicial
5. Apuntar la app de Monday a la nueva URL
6. Testear en paralelo con clientes existentes
7. Cortar Monday Code cuando esté validado

Es reversible: si no funciona, volvemos a Monday Code en minutos.

---

### Opción C — Híbrido: dejar Monday Code + delegar PDF a serverless

La parte más costosa en CPU es **generar el PDF**. Podríamos dejar todo lo demás en Monday Code y solo mover esa tarea específica a un servicio serverless (Vercel Functions, Cloudflare Workers).

**Ventajas**
- Solución quirúrgica al cuello de botella específico
- Resto de la app no cambia
- Vercel/Cloudflare tienen tier gratuito generoso
- Costo $0 si el volumen es bajo

**Desventajas**
- Dos sistemas separados (más complejo de mantener)
- Latencia entre Monday Code y el servicio del PDF (pero bajita, ~100 ms)
- El resto de las operaciones lentas (upload Monday, status changes) siguen en Monday Code
- Ahorro parcial: solo el PDF, no todo el flujo

**Esfuerzo**: ~1 día
**Costo**: $0 (tier gratuito)

---

## 3.bis. Consolidación de proveedores

Hoy usamos **dos servicios distintos**:
- **Monday Code** para el backend
- **Neon** para la base de datos (Postgres)

Si migramos, conviene consolidar en un proveedor que ofrezca ambos para simplificar gestión y facturación.

### Proveedores con backend + DB integrados

| Proveedor | Backend | DB Postgres | Total mensual | Simplicidad |
|---|---|---|---|---|
| **Render** | $7 (Starter) | $7 (Basic) | **$14/mes** | ⭐⭐⭐⭐⭐ |
| **Railway** | $5 + uso | Incluido en uso | ~$10-15/mes | ⭐⭐⭐⭐⭐ |
| **Fly.io** | Pay-as-you-go | Pay-as-you-go | ~$10-15/mes | ⭐⭐⭐ |
| **DigitalOcean App Platform** | $5-10 | $15 | ~$20-25/mes | ⭐⭐⭐⭐ |
| **AWS** (EC2 + RDS) | ~$8 | ~$15 | ~$25-40/mes + config | ⭐⭐ |
| **Supabase** (Postgres + Edge Functions) | Incluido en plan | Incluido | $0-25/mes | ⭐⭐⭐⭐ |

### Niveles de Render — qué plan elegir

Render tiene varios tiers. **Empezamos con el mínimo viable y escalamos si hace falta**:

| Nivel | Plan backend | Plan DB | Total | Cuándo usarlo |
|---|---|---|---|---|
| **Mínimo** | Starter ($7) | Basic ($7) | **$14/mes** | ✅ **Hoy**: 3-50 clientes, facturas esporádicas |
| **Creciendo** | Standard ($25) | Basic ($7) | $32/mes | 50-100 clientes, picos de concurrencia |
| **Media** | Standard ($25) | Standard ($20) | $45/mes | 100-300 clientes, datos creciendo |
| **Grande** | Pro ($85) | Standard ($20) | $105/mes | 500+ clientes, operación crítica |

**Render permite cambiar de plan sin downtime**. Si el Starter se queda chico, subís a Standard con un click, sin migrar nada.

Recomendación: arrancar con el plan **Mínimo ($14/mes)**. Monitorear uso real. Escalar solo si las métricas lo piden.

### Por qué recomendamos Render

1. **Una sola factura, un solo dashboard** — simplifica operaciones
2. **Backups automáticos de DB** incluidos (Neon también tiene pero queda en otro lado)
3. **Costo fijo y predecible** ($14/mes) — no hay sorpresas
4. **Migración de DB simple**: `pg_dump` desde Neon → `pg_restore` en Render
5. **Soporte y docs muy buenos**, ideal si no se tiene equipo DevOps

### Qué pasa con el frontend

Hoy el frontend (React + Vite compilado) se sirve desde el backend: el comando `npm run copy-frontend` copia los archivos estáticos a `backend-repo/public/` y Express los sirve cuando el cliente entra a la app.

Hay dos formas de manejarlo al migrar:

**A. Mantenerlo junto al backend (recomendado al inicio)**
- Mismo flujo que hoy, solo cambia el hosting
- Un solo servicio en Render, una sola URL
- Cero cambios de arquitectura
- Ideal durante la migración para minimizar riesgo

**B. Separarlo como Static Site en Render (optimización posterior)**
- Render ofrece "Static Sites" gratis aparte del backend
- Se sirve desde CDN global → más rápido de cargar
- Frontend y backend deployan independientes
- Costo adicional: $0 (Static Sites son gratis)
- Cambio técnico: configurar CORS entre frontend y backend
- Sugerencia: pasar a esto **después** de que la migración esté estable

**Plan**: migrar con opción A (como está hoy). Evaluar B cuando el sistema esté consolidado.

### Por qué NO Vercel

Vercel es popular pero tiene un modelo distinto a Render:

- Vercel es **serverless**: cada request es una función que vive solo lo que dura la request
- Render es un **servidor tradicional**: el proceso está prendido 24/7

Para nuestro backend, el modelo serverless no funciona bien porque:

1. **Timeout de 10-60 s por request**: nuestras emisiones a veces tardan 60-180 s (se cortarían a la mitad)
2. **Sin memoria persistente**: perderíamos la capa rápida del cache (queda solo DB)
3. **Sin timers internos**: nuestro cron cada 8 h usa `setTimeout` — requiere proceso vivo
4. **Cold start por request**: los 5 s de carga de pdfkit los pagaríamos **cada** factura

Vercel es excelente para **frontends** (si migráramos la UI de configuración algún día, Vercel es la opción natural). Para el backend: Render.

### Por qué NO AWS

AWS es el estándar de la industria, pero para esta escala es **sobredimensionar**:

- Complejidad de setup (VPC, Security Groups, IAM, networking)
- Curva de aprendizaje empinada
- Más puntos de configuración = más puntos de falla
- Facturación granular confusa (decenas de cargos por servicios distintos)
- Ahorro real vs Render: nulo o negativo para esta escala
- Sentido cuando tenemos 500+ clientes, no hoy

**AWS sería una migración posterior** si el negocio crece mucho. Hoy: Render.

---

## 4. Comparación resumida

| Criterio | A. Monday Code | B. Migrar a Render | C. Híbrido |
|---|---|---|---|
| **Tiempo típico factura** | 60-100 s (variable) | 30-40 s (estable) | 50-70 s |
| **Tiempo peor caso** | 3 min | 45 s | 2 min |
| **Costo mensual** | $0 | $5-7 | $0 |
| **Esfuerzo migración** | 0 | 1-2 días | 1 día |
| **Riesgo ruptura** | 0 | Bajo (reversible) | Bajo |
| **Escalabilidad futura** | Mala | Buena | Regular |
| **Recomendada por Monday** | Sí | No (pero permitida) | No (pero permitida) |
| **Primera impresión cliente** | Mala a veces | Consistentemente buena | Mejor que A |

---

## 5. Recomendación

**Opción B (migrar a Render)** cuando tengamos tiempo para hacer la migración con cuidado. Razones:

1. La primera factura es crítica para la impresión del cliente que acaba de instalar la app — no podemos permitirnos 3 minutos
2. El tiempo estable (30-40 s) es defendible comercialmente
3. El costo ($7/mes) es despreciable comparado con el valor de la experiencia
4. Es reversible si algo sale mal
5. Nos saca la dependencia de que "Monday Code esté de buen humor ese día"

**Mientras tanto, Opción A** con lo que ya optimizamos. El sistema funciona — solo es más lento de lo deseable en momentos de pico.

---

## 6. Preguntas que tu jefe puede hacer

### "¿Si Monday lo recomienda, por qué no lo usamos?"
Lo recomienda para apps típicas que no tienen operaciones pesadas. Nuestra app hace generación de PDFs, autenticación criptográfica con AFIP, firma de certificados — es más intensiva que el caso promedio. Monday Code cumple en lo funcional, pero su performance de CPU compartida no está a la altura de nuestras necesidades cuando el sistema está cargado.

### "¿Qué pasa si migramos y mañana Monday Code mejora?"
Render y Monday Code no son excluyentes — podemos volver a Monday Code con un `mapps code:push` si mejora. La migración es reversible en minutos.

### "¿Podría romperse algo en producción?"
La migración se puede hacer en paralelo: mantener Monday Code corriendo + levantar Render + apuntar la app a Render **solo cuando estemos seguros**. Si Render falla, volvemos a Monday Code sin tiempo de inactividad.

### "¿Cuánto tiempo realmente toma migrar?"
Estimado: 1-2 días efectivos:
- Medio día: configurar Render + migrar variables/secrets
- Medio día: testing con cliente de staging
- Medio día: deploy y validación con clientes reales

### "¿Tenemos clientes activos ahora?"
Sí, al menos uno instalado y emitiendo. La migración tiene que ser cuidadosa para no interrumpir. Por eso el plan en paralelo (punto anterior).

### "¿Podemos medir el impacto antes de migrar?"
Sí. Ya tenemos logs de tiempos en producción. Podemos comparar las mismas facturas antes y después de la migración.

### "¿Qué hacemos si Render sube el precio?"
Render, Railway, Fly.io son intercambiables entre sí. Si uno sube precio, migramos a otro con cambios menores (es el mismo Node.js, solo cambian variables de deploy).

### "¿Qué cambia a futuro?"
Con hosting dedicado:
- Podemos agregar features que requieran más CPU sin preocuparnos (más clientes, PDFs más complejos, consultas de padrón en batch)
- Métricas reales (uso CPU, memoria, latencia por endpoint)
- Posibilidad de escalar horizontalmente si crecemos mucho

Con Monday Code:
- Estamos limitados a lo que Monday permita
- Si crecemos mucho, podemos chocar con límites de ellos sin aviso

### "¿El usuario final nota la diferencia?"
Sí. La primera emisión de una factura después de instalar es la experiencia crítica — "¿este sistema funciona o es una cosa lenta?". Con Monday Code a veces es 45 s, a veces 3 min. Con Render: siempre 30-40 s.

### "¿Cuáles son los riesgos reales?"
- **Config de secrets mal hecha**: riesgo bajo, los logs nos avisan al toque
- **URL cambiada en Monday**: ya tenemos ese flujo documentado
- **Costo mensual recurrente**: $5-7/mes (insignificante)
- **Proveedor cierra o tiene caída**: tenemos alternativas (Railway, Fly.io) y podemos volver a Monday Code

---

## 7. Plan propuesto si se aprueba

**Fase 1 — Preparación (1 día)**
- Crear cuenta Render
- Configurar repo para deploy automático desde GitHub
- Replicar variables y secrets
- Dejar Render levantado en paralelo con Monday Code

**Fase 2 — Testing (1 día)**
- Apuntar un cliente de prueba a Render
- Emitir 20-30 facturas de prueba
- Comparar tiempos
- Detectar cualquier issue

**Fase 3 — Cutover (medio día)**
- Cambiar la URL en la config de la app de Monday (del cliente productivo)
- Monitorear las primeras emisiones reales
- Mantener Monday Code como backup por una semana

**Fase 4 — Limpieza (medio día)**
- Desactivar Monday Code
- Actualizar documentación
- Setear métricas y alertas en Render

**Total**: 3 días efectivos, con rollback posible en cualquier momento.

---

## 8. Resumen ejecutivo

- **Hoy**: facturas entre 60 s y 3 min según suerte del día (Monday Code) + DB en Neon (proveedor separado)
- **Después de migrar a Render**: facturas consistentemente en 30-40 s + backend y DB consolidados en un proveedor
- **Costo extra**: $14/mes total ($7 backend + $7 DB, reemplaza Monday Code + Neon)
- **Esfuerzo**: 3 días técnicos
- **Riesgo**: bajo, reversible

**Recomendación**: migrar cuando haya una ventana de 3-4 días de desarrollo disponibles.

### Ahorro operativo adicional (no monetario)

- **Un solo dashboard** para ver backend + DB + logs
- **Un solo login** para administrar
- **Una sola factura** mensual
- **Un solo proveedor** con quien resolver problemas si hay caídas
