// Configuracion de PM2 para correr el backend en STAGING.
// Vive en el mismo droplet que prod pero en otro puerto + DB + .env.
//
// Uso:
//   pm2 start ecosystem.staging.config.js
//   pm2 save
//
// Logs:
//   /var/log/pm2/tap-monday-staging-out.log
//   /var/log/pm2/tap-monday-staging-error.log

module.exports = {
  apps: [{
    name: "tap-monday-staging",
    script: "./src/server.js",
    cwd: "/opt/apps/App-monday/backend-repo",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    // Memory budget mas chico para staging (rara vez se usa con carga real).
    // Margen pensado para que prod siempre tenga prioridad de RAM.
    max_memory_restart: "200M",
    node_args: "--max-old-space-size=200",
    kill_timeout: 5000,
    listen_timeout: 10000,
    // CRITICO: cargar variables de .env.staging en vez de .env.
    // server.js usa dotenv.config() que lee .env por defecto, asi que
    // hacemos que pm2 le inyecte las vars del .env.staging directamente
    // via cwd + node_args sumando la flag de dotenv-config.
    // Alternativa simple: usar el campo env de pm2 con las vars criticas.
    env_file: ".env.staging",
    env: {
      NODE_ENV: "production",
      APP_ENV: "staging"
    },
    error_file: "/var/log/pm2/tap-monday-staging-error.log",
    out_file: "/var/log/pm2/tap-monday-staging-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    merge_logs: true,
    max_restarts: 10,
    min_uptime: "30s"
  }]
};
