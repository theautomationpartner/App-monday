# ARCA Facturación — App marketplace monday.com

App nativa de facturación electrónica AFIP (Argentina) para el marketplace de monday.com.

## Estructura

- [frontend-repo/](frontend-repo/) — React + Vite. El build se copia a [backend-repo/public/](backend-repo/public/) en el deploy.
- [backend-repo/](backend-repo/) — Node + Express. Sirve el frontend estático y expone los endpoints `/api/*`.

## Deploy

`git push main` → GitHub Actions → DigitalOcean droplet (`pm2 reload tap-monday --update-env`).

## Producción

- App: https://arca.theautomationpartner.com
- DB: PostgreSQL DigitalOcean Managed (NYC1)
- Hosting: DigitalOcean droplet (Ubuntu)

## Sistema de defensa contra duplicados / discrepancias AFIP

| Capa | Cuándo | Qué hace |
| --- | --- | --- |
| **Idempotency** | Reintento manual del usuario | Consulta cbteNro reservado en AFIP antes de reemitir |
| **Verificación post-emisión** | Inmediato tras cada emisión OK | Cross-check de CAE/nro/importe vía `FECompConsultar` |
| **Reconciliación** | Cron cada 5 min | Recupera facturas huérfanas (timeout sin retry manual) |
| **Auditoría nocturna** | Cron 3 AM AR | Verifica todas las nuevas contra AFIP, resumen en Slack |

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

## Variables de entorno (droplet)

`/opt/apps/App-monday/backend-repo/.env`. Las críticas:

- `DATABASE_URL` — DigitalOcean Managed PG con `sslmode=verify-full`
- `ENCRYPTION_KEY` — AES key para cifrar la private key AFIP
- `MONDAY_CLIENT_SECRET` — validación de tokens de sesión monday
- `SLACK_WEBHOOK_URL` — para alertas de discrepancias AFIP
- `DEV_MONDAY_TOKEN` — admin token (CRM tracking + endpoint admin)
