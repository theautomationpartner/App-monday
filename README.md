# Facturacion Electronica AFIP - Monday.com App

Aplicacion nativa para Monday.com para configuracion fiscal y emision de facturacion electronica AFIP (Argentina). Se despliega sobre **Monday Code**.

## Estructura del workspace

Este directorio es un workspace con dos proyectos independientes (cada uno con su propio `.git`, pensados para subir a repos separados en GitHub):

- [frontend-repo/](frontend-repo/) — React + Vite. Build estatico que sirve el backend.
- [backend-repo/](backend-repo/) — Node.js + Express. Punto de entrada desplegado en Monday Code.
- [legacy/](legacy/) — codigo y archivos viejos archivados (antigua version monorepo con Netlify, blueprints, logs, builds previos). No forma parte del runtime.

## Target de deploy: Monday Code

El backend corre como un proceso Node estandar (`node src/server.js`), no como serverless function. Usa `@mondaycom/apps-sdk` para leer `EnvironmentVariablesManager` y `SecretsManager`, y hace `app.listen(process.env.PORT)`.

El flujo actual es: el backend sirve los archivos estaticos del frontend desde [backend-repo/public/](backend-repo/public/). El build del frontend (`frontend-repo/dist/`) se copia alli antes de desplegar.

## Lo que funciona hoy

### Frontend ([frontend-repo/](frontend-repo/))

- React 18 + Vite, Monday UI Core (Vibe), Monday SDK, Axios.
- Navegacion lateral por secciones (Certificados ARCA y Datos Fiscales).
- Formulario fiscal con persistencia real.
- Precarga de setup guardado por `monday_account_id`.
- Subida de `.crt` y `.key` con `multipart/form-data`.

### Backend ([backend-repo/](backend-repo/))

- Express + Multer en memoria + `pg` (Neon PostgreSQL con SSL).
- Cifrado AES (CryptoJS) para la clave privada AFIP antes de persistir.
- Modulos de emision AFIP reales en [backend-repo/src/modules/](backend-repo/src/modules/):
  - `afipAuth.js` — WSAA (token/sign).
  - `afipPadron.js` — consulta de padron.
  - `invoiceRules.js` — reglas de comprobantes.
- Generacion de PDF con `pdfkit` (inline en [backend-repo/src/server.js](backend-repo/src/server.js), funcion `generateFacturaPdfBuffer`).
- Sirve el frontend estatico desde `public/`.

## Endpoints principales

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | /api/health | Estado del backend y conexion DB |
| GET | /api/setup/:mondayAccountId | Datos fiscales y certificados guardados |
| POST | /api/companies | Alta/actualizacion de datos fiscales |
| POST | /api/certificates | Sube `.crt`/`.key`, cifra la clave y guarda credenciales |

(El backend tiene endpoints adicionales para emision de comprobantes y webhooks de Monday — ver [backend-repo/src/server.js](backend-repo/src/server.js).)

## Variables de entorno

En Monday Code se configuran desde `mapps` o el dashboard. En local, `.env` dentro de cada proyecto.

Backend:
- `DATABASE_URL` — string de conexion PostgreSQL (Neon).
- `ENCRYPTION_KEY` — clave simetrica para cifrar la private key AFIP. Se recomienda cargarla como **secret** (`SecretsManager`).
- `MONDAY_CLIENT_SECRET` — para validar tokens de sesion Monday. Tambien como secret.
- `PORT` — opcional, default 3001.

## Levantar en local

```bash
# Backend
cd backend-repo
npm install
npm run dev

# Frontend (otra terminal)
cd frontend-repo
npm install
npm run dev
```

En local, el frontend apunta al backend en `http://localhost:3001/api` cuando detecta hostname `localhost`.

## Build y deploy a Monday Code

1. Build del frontend:
   ```bash
   cd frontend-repo
   npm run build
   ```
2. Copiar `frontend-repo/dist/*` a `backend-repo/public/`.
3. Desde `backend-repo/`, desplegar con el CLI de Monday Code (`mapps code:push`).

## Roadmap

1. Terminar integracion AFIP productiva (WSAA + WSFEv1) — los modulos ya existen en `backend-repo/src/modules/`, queda endurecerlos.
2. Automatizaciones Monday: disparar emision por cambio de estado, escribir numero de comprobante y link PDF en columnas.
3. Plantilla de PDF fiscal.
4. Logs, auditoria y pruebas E2E.
