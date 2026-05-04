// Diagnóstico: cuenta cuántas rows hay para un monday_account_id en todas las
// tablas que toca deleteAccountData(). Útil para verificar antes/después del
// flow de uninstall.
//
// Uso:
//   node scripts/check-account-data.js <monday_account_id>

require('dotenv').config();
const db = require('../src/db');

const accountId = process.argv[2];
if (!accountId) {
    console.error('Usage: node scripts/check-account-data.js <monday_account_id>');
    process.exit(1);
}

const queries = [
    { label: 'companies',                  sql: `SELECT COUNT(*)::int AS n FROM companies WHERE monday_account_id::text = $1` },
    { label: 'afip_credentials',           sql: `SELECT COUNT(*)::int AS n FROM afip_credentials WHERE company_id IN (SELECT id FROM companies WHERE monday_account_id::text = $1)` },
    { label: 'invoice_emissions',          sql: `SELECT COUNT(*)::int AS n FROM invoice_emissions WHERE company_id IN (SELECT id FROM companies WHERE monday_account_id::text = $1)` },
    { label: 'board_automation_configs',   sql: `SELECT COUNT(*)::int AS n FROM board_automation_configs WHERE company_id IN (SELECT id FROM companies WHERE monday_account_id::text = $1)` },
    { label: 'visual_mappings',            sql: `SELECT COUNT(*)::int AS n FROM visual_mappings WHERE company_id IN (SELECT id FROM companies WHERE monday_account_id::text = $1)` },
    { label: 'audit_log_items',            sql: `SELECT COUNT(*)::int AS n FROM audit_log_items WHERE monday_account_id = $1` },
    { label: 'user_api_tokens',            sql: `SELECT COUNT(*)::int AS n FROM user_api_tokens WHERE monday_account_id = $1` },
    { label: 'trigger_subscriptions',      sql: `SELECT COUNT(*)::int AS n FROM trigger_subscriptions WHERE monday_account_id = $1` },
    { label: 'installation_leads',         sql: `SELECT COUNT(*)::int AS n FROM installation_leads WHERE monday_account_id = $1` },
];

(async () => {
    console.log(`\nDatos para account_id = ${accountId}\n`);
    let totalOperativo = 0;
    let leadsCount = 0;
    for (const q of queries) {
        try {
            const r = await db.query(q.sql, [accountId]);
            const n = r.rows[0].n;
            if (q.label === 'installation_leads') leadsCount = n;
            else totalOperativo += n;
            const tag = q.label === 'installation_leads' ? '[meta]' : (n === 0 ? '[ok] ' : '[!!!] ');
            console.log(`  ${tag} ${q.label.padEnd(28)} ${n}`);
        } catch (err) {
            console.log(`  [err]  ${q.label.padEnd(28)} ${err.message}`);
        }
    }
    console.log(`\n  Rows operativas (excl. installation_leads): ${totalOperativo}`);
    console.log(`  installation_leads (metadata, debe sobrevivir): ${leadsCount}\n`);
    if (totalOperativo === 0) {
        console.log('  RESULTADO: limpio. Datos operativos borrados correctamente.\n');
    } else {
        console.log('  RESULTADO: aún quedan datos operativos para esta cuenta.\n');
    }
    process.exit(0);
})();
