// Configuracion de PM2 para correr el backend en STAGING.
//
// Vive en un clon SEPARADO del repo (/opt/apps/App-monday-staging/) que
// checkea la branch "develop". El clon de prod vive en /opt/apps/App-monday/
// con la branch "main".
//
// Aislamiento total entre ambos:
//   - Working directory distinto
//   - Branch distinto (develop vs main)
//   - Archivo .env distinto (cada clon tiene el suyo)
//   - PM2 process name distinto
//   - Puerto distinto (el puerto lo define el .env, default 3001 para staging)
//
// Uso (primera vez, manual):
//   cd /opt/apps/App-monday-staging/backend-repo
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
    cwd: "/opt/apps/App-monday-staging/backend-repo",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    watch: false,
    // Memory budget mas chico que prod para que prod siempre tenga prioridad
    // si el droplet esta presionado.
    max_memory_restart: "200M",
    node_args: "--max-old-space-size=200",
    kill_timeout: 5000,
    listen_timeout: 10000,
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
