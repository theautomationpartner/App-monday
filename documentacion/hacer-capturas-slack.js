// Genera las imagenes de los avisos de Slack para la guia tecnica.
//
// POR QUE ESTO EXISTE: la alerta de [RECOVERY_MISMATCH] aparece una vez cada
// varios meses, y la de [ABANDONED] tarda 8 horas en salir. Esperar a que pasen
// para sacarles una foto no es viable, y provocarlas a proposito significaria
// romper una emision real. Tampoco se pueden mandar al canal de prod: un
// incoming webhook no puede borrar lo que manda, y quedarian alertas rojas
// falsas para siempre en el historial del canal del que depende el equipo.
//
// Asi que se arman aca. El TEXTO de cada mensaje esta copiado literal de las
// plantillas de server.js (cada bloque cita su linea) — si alguien cambia el
// formato de una alerta, hay que cambiarlo tambien aca. Lo unico inventado son
// los datos: cuenta, cliente, numeros e importes.
//
// Uso:  node hacer-capturas-slack.js  &&  powershell -File recortar-slack.ps1

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR_CAPTURAS = path.join(__dirname, 'capturas');
const TMP = path.join(__dirname, '.tmp-slack');
const AUDIT_BOARD = '18409500030';        // "Comp Emitidos"
const FONDO = '#ff00ff';                  // centinela: se recorta despues

// ---------------------------------------------------------------------------
// Los mensajes. `texto` es mrkdwn de Slack, igual que el que viaja en el POST.
// ---------------------------------------------------------------------------

// server.js:11186 — notifySlackSystemError()
const errorSistema = ({ cuenta, item, error }) => [
    ':rotating_light: *Error sistema en facturación*',
    '*Cuenta:* ' + cuenta,
    '*Item del cliente:* "' + item + '"',
    '*Error:* `' + error + '`',
    '<https://the-automation-partner.monday.com/boards/' + AUDIT_BOARD
        + '|→ Abrir Comp Emitidos> _(item aún no creado — buscar manualmente)_',
].join('\n');

const MENSAJES = [
    {
        archivo: 'slack-todo-bien.png',
        hora: '03:00',
        reaccion: '✅ 1',
        // server.js:11993 — rama sin problemas
        texto: [
            ':white_check_mark: *Auditoria nocturna AFIP — 2026-08-06*',
            '',
            '*Auditadas esta noche:* 4 → TODAS CORRECTAS',
            '   · Facturas: 4  ·  Notas de crédito: 0  ·  Notas de Débito: 0',
            '*Estado del sistema:* 490/490 OK :white_check_mark:',
            '',
            '_Las facturas, notas de crédito y notas de débito emitidas por la app coinciden 100% con AFIP (CAE, numero e importe)._',
            '_Duracion: 3.2s_',
        ].join('\n'),
    },
    {
        archivo: 'error-a-recovery-mismatch.png',
        hora: '11:42',
        // server.js:12697 — el detalle que arma el cron antes de alertar
        texto: errorSistema({
            cuenta: '30446835',
            item: 'CORRALON SAN JUSTO SRL',
            error: '[RECOVERY_MISMATCH] El N° 212 (PV 7) existe en AFIP con'
                + ' CAE=76298431105522 pero NO es el de esta emisión: importe:'
                + ' nuestro=145200 vs AFIP=98750. Otra emisión se quedó con el número.'
                + ' NO se adopta ese CAE: el comprobante de este ítem no está emitido y'
                + ' hay que emitirlo de nuevo. Item 9184726351, invoice_emissions.id=507',
        }),
    },
    {
        archivo: 'error-b-abandoned.png',
        hora: '19:08',
        // server.js:12595 + 12612
        texto: errorSistema({
            cuenta: '28569993',
            item: 'MARTINEZ SILVINA BEATRIZ',
            error: '[ABANDONED] Reconciliation abandoned after 100 attempts — AFIP'
                + ' confirmed not exists. Item 9184726352, cbteNro 89, tipo 6, ptoVta 5.'
                + ' invoice_emissions.id=508',
        }),
    },
    {
        archivo: 'error-c-discrepancia.png',
        hora: '03:00',
        // server.js:12058 — rama con discrepancias
        texto: [
            ':rotating_light: *DISCREPANCIA AFIP — Auditoria nocturna 2026-08-06*',
            '',
            '*Auditadas esta noche:* 6',
            '   · Facturas: 5  ·  Notas de crédito: 1  ·  Notas de Débito: 0',
            ':white_check_mark: OK: 4',
            ':rotating_light: Discrepancias criticas: 2',
            '',
            '*Estado del sistema:* 488/490 OK · 2 con discrepancia · 0 con error tecnico',
            '',
            '*REVISAR MANUALMENTE EN AFIP WEB:*',
            '',
            '*1.* POLIFRONI PUERTAS SA — Factura A N° 07-00000177',
            '   :warning: Mismatch:',
            '   • *imp_total*: nuestro=`847300` vs AFIP=`874300`',
            '   account=30446835 board=18411959990 item=9184726353',
            '',
            '*2.* MARTINEZ SILVINA BEATRIZ — Factura B N° 05-00000091',
            '   :rotating_light: NO EXISTE EN AFIP',
            '   Nuestro CAE: `76298431105601`',
            '   account=28569993 board=18412887401 item=9184726354',
        ].join('\n'),
    },
    {
        archivo: 'error-g-conciliacion.png',
        hora: '06:15',
        // server.js:12462 — detector de huerfanos
        texto: [
            '🟡 *Conciliación AFIP — 3 comprobantes sin registrar (2 series)*',
            '',
            'AFIP emitió comprobantes que no figuran en el sistema. Revisar si son emisiones manuales o duplicados a anular.',
            '',
            '📋 *POLIFRONI PUERTAS SA* · CUIT 30712345678',
            '   • Factura B (PV 5) — faltan 2 → N° 90, 91',
            '   • Nota de Crédito A (PV 7) — falta 1 → 0007-00000006',
            '',
            'Silenciar un caso revisado: `/api/admin/ack-afip-gap`',
        ].join('\n'),
    },
];

// ---------------------------------------------------------------------------
// mrkdwn de Slack -> HTML
// ---------------------------------------------------------------------------

const EMOJIS = {
    rotating_light: '🚨',
    white_check_mark: '✅',
    warning: '⚠️',
    large_yellow_circle: '🟡',
};

const NUL = String.fromCharCode(0);

const escapar = (s) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function mrkdwn(texto) {
    // Los links se sacan primero: su sintaxis <url|texto> choca con el escapado.
    // El marcador va rodeado de NUL y no de espacios: con espacios, cualquier
    // numero suelto del mensaje ("faltan 2 → N°") se confundiria con el.
    const links = [];
    let t = texto.replace(/<(https?:[^|>]+)\|([^>]+)>/g, function (_, url, label) {
        links.push('<a href="' + url + '">' + escapar(label) + '</a>');
        return NUL + (links.length - 1) + NUL;
    });

    t = escapar(t);
    // Los emojis van ANTES que la cursiva: `:white_check_mark:` tiene guiones
    // bajos adentro y al reves `_check_` se lee como cursiva y parte el nombre.
    t = t.replace(/:([a-z_]+):/g, function (m, name) { return EMOJIS[name] || m; });
    // El codigo tambien se saca de la linea antes de negrita/cursiva, y por lo
    // mismo: adentro de un bloque de codigo Slack NO interpreta el markup, y
    // los mensajes estan llenos de `[RECOVERY_MISMATCH]` e `invoice_emissions`
    // — con los guiones bajos a la vista el texto salia partido en cursiva.
    t = t.replace(/`([^`]+)`/g, function (_, c) {
        links.push('<code>' + c + '</code>');
        return NUL + (links.length - 1) + NUL;
    });
    t = t.replace(/\*([^*\n]+)\*/g, function (_, c) { return '<b>' + c + '</b>'; });
    t = t.replace(/_([^_\n]+)_/g, function (_, c) { return '<i>' + c + '</i>'; });
    t = t.split(NUL).map(function (parte, i) {
        return i % 2 ? links[Number(parte)] : parte;
    }).join('');

    return t.split('\n').map(function (l) {
        return l === '' ? '<div class="v"></div>' : '<div>' + l + '</div>';
    }).join('');
}

// ---------------------------------------------------------------------------

const CSS = [
    '*{box-sizing:border-box;margin:0;padding:0}',
    'body{background:' + FONDO + ';padding:26px;font-family:"Segoe UI",Lato,system-ui,sans-serif}',
    // 780 y no mas: la imagen entra a lo ancho de la pagina del PDF, asi que
    // cuanto mas ancha, mas se achica el texto al imprimir. Con 780 el bloque
    // de codigo del Error queda legible en papel.
    '.msg{background:#1a1d21;width:780px;padding:14px 18px;display:flex;gap:11px;',
    '     color:#d1d2d3;font-size:15px;line-height:1.48}',
    // pre-wrap solo en el cuerpo: Slack respeta los espacios con los que vienen
    // indentadas las lineas de detalle ("   · Facturas: 4"). Si se pone en .msg,
    // los saltos de linea del propio HTML se dibujan como lineas en blanco.
    '.cuerpo{white-space:pre-wrap}',
    '.av{width:36px;height:36px;border-radius:5px;flex:0 0 36px;background:#2d3f6b;',
    '    display:flex;align-items:center;justify-content:center;font-size:19px}',
    '.cab{display:flex;align-items:baseline;gap:7px;margin-bottom:3px}',
    '.nom{color:#fff;font-weight:900;font-size:15px}',
    '.app{background:#35373b;color:#ababad;font-size:10px;font-weight:700;letter-spacing:.4px;',
    '     padding:1px 4px;border-radius:2px;position:relative;top:-1px}',
    '.hora{color:#ababad;font-size:12px}',
    'b{color:#fff;font-weight:700}',
    'i{color:#ababad}',
    'a{color:#1d9bd1;text-decoration:none}',
    'code{background:#232529;border:1px solid #35373b;border-radius:3px;color:#e01e5a;',
    '     font-family:Consolas,Menlo,monospace;font-size:12.5px;padding:1px 4px}',
    '.v{height:9px}',
    '.rx{display:inline-flex;align-items:center;gap:5px;margin-top:9px;background:#232529;',
    '    border:1px solid #1d9bd1;border-radius:11px;padding:2px 9px;font-size:12px;color:#1d9bd1}',
].join('\n');

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(DIR_CAPTURAS, { recursive: true });

MENSAJES.forEach(function (m) {
    const html = '<!doctype html><meta charset="utf-8"><style>' + CSS + '</style>\n'
        + '<div class="msg">\n'
        + '  <div class="av">🧾</div>\n'
        + '  <div>\n'
        + '    <div class="cab"><span class="nom">TAP Facturación Alertas</span>'
        + '<span class="app">APP</span><span class="hora">' + m.hora + '</span></div>\n'
        + '    <div class="cuerpo">' + mrkdwn(m.texto) + '</div>\n'
        + (m.reaccion ? '    <div class="rx">' + m.reaccion + '</div>\n' : '')
        + '  </div>\n</div>';
    fs.writeFileSync(path.join(TMP, m.archivo.replace('.png', '.html')), html, 'utf8');
});

// ---------------------------------------------------------------------------

const CANDIDATOS = [
    process.env['ProgramFiles'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['ProgramFiles(x86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
];
const chrome = CANDIDATOS.find(function (p) { return p && fs.existsSync(p); });
if (!chrome) {
    console.error('  No encontre Chrome ni Edge. Abri a mano los .html de .tmp-slack/');
    process.exit(1);
}

MENSAJES.forEach(function (m) {
    const htmlPath = path.join(TMP, m.archivo.replace('.png', '.html'));
    const pngPath = path.join(TMP, m.archivo);
    execFileSync(chrome, [
        '--headless', '--disable-gpu', '--hide-scrollbars',
        '--force-device-scale-factor=2',      // doble resolucion: se lee en el PDF
        '--window-size=1000,900',
        '--screenshot=' + pngPath,
        'file:///' + htmlPath.replace(/\\/g, '/'),
    ], { stdio: 'ignore' });
    console.log('  ' + m.archivo);
});

console.log('\n  Ahora: powershell -File recortar-slack.ps1');
