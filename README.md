# Facturacion Electronica AFIP - Monday.com App

Aplicacion nativa para Monday.com enfocada en configuracion fiscal y preparacion de facturacion electronica AFIP para empresas argentinas.

## Estado actual (abril 2026)

Estamos en una etapa intermedia entre infraestructura y operacion real:

- Frontend y backend ya estan conectados.
- Los datos fiscales se guardan y se recuperan desde PostgreSQL.
- La carga de certificados esta operativa con cifrado de clave privada.
- Falta la emision AFIP productiva (WSAA/WSFE) en este monorepo principal.

## Lo que ya funciona

1. Frontend React + Vite
- Navegacion lateral por secciones (Certificados y Datos Fiscales).
- Integracion con Monday SDK para obtener contexto de cuenta/tablero.
- Formulario fiscal completo con persistencia real.
- Estado visual de avance por seccion (Pendiente/Completo).

2. Integracion Frontend-Backend
- Llamadas HTTP con Axios a la API.
- Precarga de setup guardado al abrir la app.
- Guardado de datos fiscales via endpoint dedicado.
- Subida de archivos .crt y .key con multipart/form-data.

3. Backend Node.js + Express (serverless-ready)
- API montada en backend con soporte local y Netlify Functions.
- Multer en memoria para procesar certificados en entornos serverless.
- Cifrado AES (CryptoJS) para clave privada AFIP antes de persistir.
- Conexion a Neon/PostgreSQL con SSL.

4. Deploy
- Deploy principal en Netlify.
- Redirect /api/* hacia function serverless.
- Headers compatibles con uso embebido en iframe de Monday.

## Endpoints disponibles

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | /api/health | Verifica estado del backend y conexion DB |
| GET | /api/setup/:mondayAccountId | Trae datos fiscales/certificados guardados |
| POST | /api/companies | Crea o actualiza datos fiscales por monday_account_id |
| POST | /api/certificates | Sube .crt/.key, cifra la clave y guarda credenciales |

## Arquitectura tecnica

Frontend
- React 18 + Vite
- Monday UI React Core (Vibe)
- Monday SDK + Axios

Backend
- Node.js + Express
- Multer (memory storage)
- CryptoJS (AES)
- PostgreSQL (pg) en Neon
- serverless-http para Netlify Functions

## Estructura del repo

- / : Frontend principal (Vite).
- /backend : API principal de este flujo.
- /netlify.toml : Build, redirects y functions del deploy principal.
- /frontend-repo y /backend-repo : Variante desacoplada en evolucion (flujo alternativo).

## Variables de entorno

Frontend (raiz)
- No requiere variables obligatorias para el flujo base actual.

Backend (/backend)
- DATABASE_URL: string de conexion PostgreSQL (Neon).
- ENCRYPTION_KEY: clave usada para cifrar la private key.
- PORT: opcional para desarrollo local (default 3001).

## Como levantar en local

1. Instalar dependencias del frontend (raiz)

```bash
npm install
```

2. Instalar dependencias del backend

```bash
cd backend
npm install
```

3. Crear archivo .env en backend con al menos:

```env
DATABASE_URL=postgresql://...
ENCRYPTION_KEY=tu_clave_segura
PORT=3001
```

4. Iniciar backend (terminal 1)

```bash
cd backend
npm run dev
```

5. Iniciar frontend (terminal 2)

```bash
npm run dev
```

En local, el frontend usa automaticamente http://localhost:3001/api cuando detecta hostname localhost.

## Deploy en Netlify (monorepo principal)

Configuracion esperada (ya incluida en netlify.toml):

- Build command: npm run build
- Publish directory: dist
- Functions directory: backend/netlify/functions

Variables de entorno minimas en Netlify:

- DATABASE_URL
- ENCRYPTION_KEY

## Roadmap proximo

1. Integracion AFIP real
- WSAA para obtener token/sign.
- WSFEv1 para autorizacion de comprobantes.

2. Automatizacion con Monday
- Disparar emision por cambio de estado/accion.
- Escribir numero de comprobante y link PDF en columnas.

3. PDF fiscal
- Generar comprobante en PDF con plantilla y datos AFIP.

4. Endurecimiento operativo
- Validaciones de negocio adicionales.
- Auditoria/logs y pruebas E2E.

Desarrollado para equipos argentinos que operan en Monday y AFIP.
