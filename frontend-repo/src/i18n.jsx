import { createContext, useContext, useState, useCallback } from "react";

/**
 * Sistema de idiomas (i18n) — liviano, sin librerías externas.
 *
 * CÓMO FUNCIONA (en criollo):
 *  - `translations` es el "diccionario": cada texto tiene su versión en
 *    español (es) y en inglés (en).
 *  - `es` es el set COMPLETO y de referencia (lo que ya existía).
 *  - `en` se va completando de a poco. Si falta una clave en el idioma actual,
 *    la función `t()` cae a español → la app NUNCA se rompe ni muestra una clave
 *    cruda durante el rollout. (regla: "sin romper nada").
 *  - El idioma elegido se guarda en localStorage para recordarlo la próxima vez.
 *  - Arranca en INGLÉS por defecto (requisito de monday para aprobar la app).
 */

export const translations = {
  es: {
    // ── Sidebar / navegación ──
    "sidebar.config": "Configuración",
    "sidebar.connected": "Backend conectado",
    "sidebar.noContext": "Sin contexto Monday",
    "menu.datos": "Datos Fiscales",
    "menu.certificados": "Certificados ARCA",
    "menu.mapping": "Mapeo Visual",
    "status.complete": "Listo",
    "status.pending": "En progreso",
    "status.incomplete": "Pendiente",
    // ── General ──
    "common.edit": "Editar",
    "header.stepsComplete": "pasos completos",
    // ── Datos Fiscales (encabezado) ──
    "fiscal.title": "Datos Fiscales",
    "fiscal.subSaved": "Esto es lo que AFIP va a ver en tus comprobantes.",
    "fiscal.subSetup":
      "Completá la información de tu empresa para la facturación electrónica.",
    // ── Datos Fiscales (formulario) ──
    "fiscal.razonSocial": "Razón Social",
    "fiscal.razonSocialPh": "Ej: Mi Empresa S.A.",
    "fiscal.nombreFantasia": "Nombre de Fantasía",
    "fiscal.nombreFantasiaPh": "Ej: Kiosco El Sol",
    "fiscal.nombreFantasiaHint":
      "Es el nombre comercial que aparece en negrita arriba del PDF. Si no tenés, poné tu razón social.",
    "fiscal.cuit": "CUIT",
    "fiscal.puntoVenta": "Punto de Venta",
    "fiscal.fechaInicio": "Fecha de Inicio de Actividades",
    "fiscal.domicilio": "Domicilio Comercial",
    "fiscal.domicilioPh": "Av. Corrientes 1234, CABA",
    "fiscal.contactTitle": "Datos de contacto y marca",
    "fiscal.contactSub":
      "Estos datos son opcionales. Más adelante los vamos a usar para personalizar el PDF de tus facturas con la información de tu empresa.",
    "fiscal.phone": "Teléfono",
    "fiscal.email": "Email",
    "fiscal.emailPh": "contacto@miempresa.com",
    "fiscal.website": "Sitio web",
    "fiscal.websitePh": "https://miempresa.com",
    "fiscal.logo": "Logo de la empresa",
    "fiscal.logoNone": "Sin logo",
    "fiscal.logoChange": "Cambiar imagen",
    "fiscal.logoUpload": "Subir imagen",
    "fiscal.logoRemove": "Quitar",
    "fiscal.logoHint": "PNG, JPG, SVG o WebP. Hasta 1 MB.",
    // ── Datos Fiscales (vista solo-lectura + botones) ──
    "fiscal.identityTitle": "Identidad fiscal",
    "fiscal.startDateShort": "Inicio de actividades",
    "fiscal.brandContact": "Marca & contacto · opcional",
    "fiscal.printedOnPdf": "Se imprime en el PDF",
    "fiscal.noContactYet":
      "Aún no configuraste datos de contacto ni logo. Apretá Editar para agregarlos.",
    "fiscal.saving": "Guardando...",
    "fiscal.saveInitial": "Guardar Datos Fiscales",
    "fiscal.saveChanges": "Guardar cambios",
    "fiscal.loadingSaved": "Cargando datos guardados...",
    "common.optional": "opcional",
    "common.required": "Obligatorio",
    "common.cancel": "Cancelar",
    // ── Certificados ARCA ──
    "cert.titleGuided": "Obtené tu certificado ARCA",
    "cert.titleManual": "Subir certificado manualmente",
    "cert.title": "Certificados ARCA",
    "cert.subGuided": "Asistente paso a paso. No necesitás usar terminal ni OpenSSL.",
    "cert.subManual": "Si ya generaste tu .crt y .key por fuera, subilos directamente.",
    "cert.subActive": "Certificado digital de AFIP que firma tus comprobantes.",
    "cert.subSetup":
      "Para facturar necesitás un certificado digital de ARCA. Te guiamos paso a paso.",
    "cert.renew": "Renovar",
    "cert.watchTutorial": "Ver tutorial",
    "cert.watchTutorialTitle": "Abrir tutorial en video",
    "cert.activeTitle": "Certificado activo",
    "cert.activeSub": "Tu app está lista para emitir facturas en ARCA.",
    "cert.expiresOn": "Vence en",
    "cert.alias": "Alias",
    "cert.expiration": "Vencimiento",
    "cert.lastUpdate": "Última actualización",
    "cert.uploadManualLink": "También podés subir nuevos archivos .crt y .key manualmente",
    "cert.pendingTitle": "Solicitud pendiente",
    "cert.recommended": "✨ Recomendado",
    "cert.uploadCrtTitle": "Subir certificado .crt de ARCA",
    "cert.uploadCrtDesc":
      "Terminá el trámite que empezaste — solo te queda adjuntar el archivo que te dio ARCA.",
    "cert.continue": "Continuar →",
    "cert.uploadManualTitle": "Subir archivos manualmente",
    "cert.uploadFiles": "Subir archivos →",
    "cert.resetTitle": "¿Empezar una nueva solicitud?",
    "cert.resetBody":
      "La solicitud actual se reemplaza y vas a tener que hacer todo el trámite de nuevo en ARCA.",
    "cert.resetConfirm": "Sí, empezar de nuevo",
    // ── Certificados: asistente guiado (inicio + stepper + paso 1) ──
    "cert.redownloadCsr": "Re-descargar la solicitud (.csr)",
    "cert.startNewRequest": "Empezar una nueva solicitud",
    "cert.heroTitle": "Obtené tu certificado ARCA con nuestro asistente",
    "cert.heroDesc":
      "La forma más rápida y segura. Sin tener que usar comandos técnicos — generamos la solicitud por vos, la subís al portal de ARCA y listo.",
    "cert.feature1": "Guía paso a paso dentro de la app",
    "cert.feature2": "Sólo subís un archivo al final",
    "cert.feature3": "Tu clave privada queda cifrada automáticamente",
    "cert.startNow": "Empezar ahora →",
    "cert.altQ": "¿Ya generaste tu .crt y .key por fuera?",
    "cert.uploadThemManually": "Subirlos manualmente →",
    "cert.step1Title": "Confirmar datos",
    "cert.step1Desc": "Revisamos tu razón social y CUIT",
    "cert.step2Title": "Descargar solicitud",
    "cert.step2Desc": "Generamos un .csr con tu clave privada cifrada",
    "cert.step3Title": "Subir a ARCA",
    "cert.step3Desc": "Pegás el alias y el .csr en AFIP",
    "cert.step4Title": "Subir certificado",
    "cert.step4Desc": "Adjuntás el .crt que te devuelve AFIP",
    "cert.s1Title": "Confirmá los datos",
    "cert.s1Desc":
      "Estos datos se firman en la solicitud. Si hay algo mal, corregilo en Datos Fiscales antes.",
    "cert.s1RenewTitle": "Estás renovando tu certificado",
    "cert.s1RenewBody":
      "Al generar la nueva solicitud, el actual queda reemplazado y no vas a poder facturar hasta completar el paso 4. Usá un alias distinto al anterior — ARCA no permite repetirlos.",
    "cert.s1MissingTitle": "Faltan datos fiscales",
    "cert.s1MissingBody":
      "Completá razón social y CUIT en la sección \"Datos Fiscales\" antes de generar la solicitud.",
    "cert.aliasLabel": "Alias del certificado",
    "cert.aliasHint": "Tiene que ser único en ARCA. Prepoblado con el mes actual.",
    "cert.keyEncTitle": "Tu clave privada queda cifrada",
    "cert.keyEncBody": "Se genera y guarda con AES-256. No vas a tener que manejarla nunca.",
    "cert.generating": "Generando...",
    "cert.generateRequest": "Generar solicitud",
    // ── Certificados: asistente pasos 2/3/4 ──
    "cert.s2ReadyToUpload": "listo para subir a ARCA",
    "cert.downloadAgain": "Descargar otra vez",
    "cert.gotIt": "Ya lo tengo",
    "cert.s3Title": "Subí el .csr a ARCA",
    "cert.s3Desc": "Seguí estos pasos en el portal de AFIP.",
    "cert.openArca": "Abrir ARCA",
    "cert.gotCrt": "Ya tengo el .crt",
    "cert.s4Title": "Subí el certificado",
    "cert.s4Desc": "Adjuntá el .crt que descargaste de ARCA.",
    "cert.fileSelected": "Archivo seleccionado",
    "cert.changeFile": "Cambiar archivo",
    "cert.dropOrClick": "Arrastrá el archivo o hacé clic",
    "cert.crtUpTo200": ".crt · hasta 200 KB",
    "cert.validating": "Validando...",
    "cert.activateCert": "Activar certificado",
    "common.back": "Volver",
    // ── Certificados: flujo manual ──
    "cert.manualTitle": "Subí tus archivos .crt y .key",
    "cert.backToAssistant": "Volver al asistente",
    "cert.manualDesc":
      "Si ya tenés ambos archivos generados, adjuntalos. Validamos que sean pareja antes de guardarlos.",
    "cert.crtTitle": "Certificado (.crt)",
    "cert.crtDesc": "Archivo de certificado público",
    "cert.keyTitle": "Clave Privada (.key)",
    "cert.keyDesc": "Archivo de clave privada",
    "cert.change": "Cambiar",
    "cert.dropToUpload": "Arrastrá o hacé clic para subir",
    "cert.uploading": "Subiendo...",
    "cert.saveCerts": "Guardar certificados",
    "cert.securityLabel": "Seguridad:",
    "cert.securityBody":
      "tu clave privada se cifra con AES-256 antes de guardarse y nunca se expone en texto plano.",
    // ── Mapeo Visual ──
    "map.title": "Mapeo Visual de Factura",
    "map.sub": "Asociá cada campo de la factura con una columna del tablero de Monday.",
    "map.f.fechaEmision": "Fecha de Emisión",
    "map.f.receptorCuit": "CUIT / DNI Receptor",
    "map.f.condicionVenta": "Condición de Venta",
    "map.f.fechaServDesde": "Fecha Servicio Desde",
    "map.f.fechaServHasta": "Fecha Servicio Hasta",
    "map.f.fechaVtoPago": "Fecha Vto. Pago",
    "map.f.concepto": "Concepto / Detalle",
    "map.f.cantidad": "Cantidad",
    "map.f.precioUnitario": "Precio Unitario",
    "map.f.prodServ": "Prod / Serv",
    "map.f.unidadMedida": "Unidad de Medida",
    "map.f.alicuotaIva": "Alícuota IVA %",
    "map.autoActions": "Acciones automáticas en el item",
    "map.optionals": "Opcionales",
    "map.autoActionsDesc":
      "Decidí qué cambios automáticos hace la app sobre el item de monday cuando se emite la factura.",
    "map.renameItem": "Renombrar el item con el N° de factura",
    "map.changeStatus": "Cambiar el estado del item automáticamente",
    "map.statusColumn": "Columna de estado del item",
    "map.chooseStatus": "— Elegir columna Status —",
    "map.notConfigured": "Sin configurar",
    "map.pdfColumnTitle": "Columna del PDF emitido",
    "map.pdfColumnLabel": "Columna Comprobante PDF",
    "map.chooseFile": "— Elegir columna Archivo —",
    "map.pdfHint": "La columna (tipo Archivo) donde se va a adjuntar el PDF emitido por AFIP.",
    "map.noFileColTitle": "Tu tablero no tiene columna de Archivo",
    "map.noFileColBody":
      "Necesitás agregar una columna tipo \"Archivo\" al tablero para que la app pueda adjuntar el PDF de la factura.",
    "map.optionalConfig": "Configuración opcional",
    "map.optionalConfigDesc":
      "Configuraciones avanzadas que extienden el comportamiento de la app. Si no las usás, la app funciona en su modo por defecto.",
    "map.currency": "Moneda",
    "map.defaultPesos": "— Default: pesos —",
    "map.defaultPesosShort": "Default: pesos",
    "map.exchangeRate": "Tipo de cambio",
    "map.requiredIfCurrency": "Obligatorio si mapeás Moneda",
    "map.defaultAfip": "Default: AFIP",
    "map.needsMapping": "Falta mapear",
    "map.defaultAfipQuote": "Default: cotización AFIP",
    "map.exchangeHint":
      "Celda vacía → la app pide cotización a AFIP y la escribe acá como registro. Con valor → se respeta como override.",
    "map.unitPriceUsd": "Precio Unitario USD",
    "map.subitemTag": "(subitem)",
    "map.onlyIfUsd": "Solo si emitís en USD",
    "map.notMapped": "No mapeado",
    "map.usdHint":
      "Columna numérica del subitem con el precio en dólares. Solo se usa para items con moneda Dólares.",
    "map.currencyWarn":
      "Mapeás Moneda → mapeá también Tipo de Cambio y Precio Unitario USD. Los 3 van juntos.",
    "map.observations": "Observaciones",
    "map.obsHint":
      "Columna texto del item. Si tiene contenido, aparece en el PDF entre la tabla y los totales (máx 255 chars; si excede, se trunca).",
    "map.invoiceModel": "Factura modelo",
    "map.frameEdit": "Hacé click en cada campo para mapear una columna",
    "map.frameView": "Vista del mapeo configurado — apretá Editar para cambiar",
    "map.mapped": "Mapeado",
    "map.unmapped": "Sin mapear",
    "map.issueDate": "Fecha de emisión",
    "map.pointOfSale": "Punto de venta",
    "map.clientLabel": "Cliente — CUIT/DNI",
    "map.paymentTermsLabel": "Condición de venta",
    "map.serviceFrom": "Servicio desde",
    "map.serviceTo": "Servicio hasta",
    "map.paymentDue": "Vencimiento de pago",
    "map.thConcept": "Concepto",
    "map.thQty": "Cant",
    "map.thUnit": "Unidad",
    "map.thProdServ": "Prod/Serv",
    "map.thUnitPrice": "Precio unit.",
    "map.thVat": "IVA %",
    "map.sampleConcept": "Consultoría abril 2026",
    "map.sampleUnit": "Hora",
    "map.sampleServ": "Servicio",
    "map.ghostRow": "Los subítems del tablero van a aparecer como líneas acá.",
    "map.subtotal": "Subtotal",
    "map.vat21": "IVA 21%",
    "map.total": "Total",
    "map.requiredCols": "Columnas obligatorias",
    "map.requiredColsDesc":
      "Datos del comprobante que la app registra en el item. Algunas las completa sola al emitir (CAE, N° de comprobante, letra, razón social y condición IVA del receptor — estas dos las saca del padrón de AFIP); otras son la base para emitir Notas de Crédito/Débito (Tipo de Comprobante y el CAE de la factura a anular). Mapealas todas para dejar el tablero completo.",
    "map.caeLabel": "CAE del Comprobante",
    "map.receptorName": "Razón Social del Receptor",
    "map.receptorIvaCond": "Condición IVA del Receptor",
    "map.optional": "Opcional",
    "map.colDate": "Columna fecha",
    "map.colCuitReceptor": "Columna CUIT receptor",
    "map.colConcepto": "Concepto",
    "map.colQty": "Cantidad",
    "map.colProdServ": "Prod/Serv",
    "map.colPrice": "Precio",
    "map.colCae": "Columna CAE del comprobante",
    "map.colText": "Columna texto",
    "map.colDropdown": "Columna dropdown",
    "map.voucherType": "Tipo de Comprobante",
    "map.caeToCancel": "CAE de la factura a anular",
    "map.colNumeric": "Columna numérica",
    "map.factRefHint": "Para una factura va vacía; para una NC/ND pegás acá el CAE de la factura que ajusta.",
    "map.letterLabel": "Letra del Comprobante",
    "map.invoiceNum": "N° Factura (Pto-Nro)",
    "map.voucherNum": "N° Comprobante",
    "map.optionalCols": "Columnas opcionales",
    "map.optionalColsDesc": "Mapealas solo si las usás. La app las completa o las lee al emitir.",
    "map.saveInitial": "Guardar Mapeo Visual",
    "common.close": "Cerrar",
    // ── WelcomePage ──
    "welcome.title": "¡Bienvenido a Factura ARCA!",
    "welcome.subtitle":
      "Vas a poder facturar electrónicamente desde tus boards de monday en 3 pasos. Configurá una vez y olvidate de la carga manual en la web de AFIP.",
    "welcome.step1Desc":
      "Cargá los datos de tu empresa (CUIT, razón social, punto de venta). Es la información que va a aparecer en cada factura que emitas.",
    "welcome.step2Desc":
      "Conectá tu certificado digital de ARCA. Si ya tenés uno, lo subís. Si no, te guiamos paso a paso para generarlo sin salir de la app.",
    "welcome.step3Desc":
      "Decile a la app qué columna del board representa el cliente, qué columna el monto, etc. Es como armar la plantilla de la factura una sola vez.",
    "welcome.zoomAria": "Ampliar captura del paso",
    "welcome.stepWord": "Paso",
    "welcome.clickToZoom": "Click para ampliar",
    "welcome.footer":
      "Después, cada cambio de estado en el board dispara una factura AFIP automática con CAE, número y PDF adjunto al item.",
    "welcome.startBtn": "Empezar configuración",
    "welcome.lightboxAria": "Imagen ampliada",
  },
  en: {
    // ── Sidebar / navigation ──
    "sidebar.config": "Setup",
    "sidebar.connected": "Backend connected",
    "sidebar.noContext": "No monday context",
    "menu.datos": "Tax Details",
    "menu.certificados": "ARCA Certificates",
    "menu.mapping": "Visual Mapping",
    "status.complete": "Done",
    "status.pending": "In progress",
    "status.incomplete": "Pending",
    // ── General ──
    "common.edit": "Edit",
    "header.stepsComplete": "steps complete",
    // ── Tax Details (header) ──
    "fiscal.title": "Tax Details",
    "fiscal.subSaved": "This is what AFIP will see on your invoices.",
    "fiscal.subSetup":
      "Complete your company information for electronic invoicing.",
    // ── Tax Details (form) ──
    "fiscal.razonSocial": "Legal Name",
    "fiscal.razonSocialPh": "e.g. Acme Inc.",
    "fiscal.nombreFantasia": "Trade Name",
    "fiscal.nombreFantasiaPh": "e.g. Sunny Store",
    "fiscal.nombreFantasiaHint":
      "It's the commercial name shown in bold at the top of the PDF. If you don't have one, use your legal name.",
    "fiscal.cuit": "Tax ID (CUIT)",
    "fiscal.puntoVenta": "Point of Sale",
    "fiscal.fechaInicio": "Business Start Date",
    "fiscal.domicilio": "Business Address",
    "fiscal.domicilioPh": "e.g. 123 Main St, City",
    "fiscal.contactTitle": "Contact & branding",
    "fiscal.contactSub":
      "These details are optional. We'll use them later to personalize your invoice PDF with your company information.",
    "fiscal.phone": "Phone",
    "fiscal.email": "Email",
    "fiscal.emailPh": "contact@mycompany.com",
    "fiscal.website": "Website",
    "fiscal.websitePh": "https://mycompany.com",
    "fiscal.logo": "Company logo",
    "fiscal.logoNone": "No logo",
    "fiscal.logoChange": "Change image",
    "fiscal.logoUpload": "Upload image",
    "fiscal.logoRemove": "Remove",
    "fiscal.logoHint": "PNG, JPG, SVG or WebP. Up to 1 MB.",
    // ── Tax Details (read-only view + buttons) ──
    "fiscal.identityTitle": "Tax identity",
    "fiscal.startDateShort": "Start date",
    "fiscal.brandContact": "Brand & contact · optional",
    "fiscal.printedOnPdf": "Printed on the PDF",
    "fiscal.noContactYet":
      "You haven't set up contact details or a logo yet. Click Edit to add them.",
    "fiscal.saving": "Saving...",
    "fiscal.saveInitial": "Save Tax Details",
    "fiscal.saveChanges": "Save changes",
    "fiscal.loadingSaved": "Loading saved data...",
    "common.optional": "optional",
    "common.required": "Required",
    "common.cancel": "Cancel",
    // ── ARCA Certificates ──
    "cert.titleGuided": "Get your ARCA certificate",
    "cert.titleManual": "Upload certificate manually",
    "cert.title": "ARCA Certificates",
    "cert.subGuided": "Step-by-step assistant. No terminal or OpenSSL needed.",
    "cert.subManual": "If you already generated your .crt and .key elsewhere, upload them directly.",
    "cert.subActive": "AFIP digital certificate that signs your invoices.",
    "cert.subSetup":
      "To invoice you need an ARCA digital certificate. We guide you step by step.",
    "cert.renew": "Renew",
    "cert.watchTutorial": "Watch tutorial",
    "cert.watchTutorialTitle": "Open video tutorial",
    "cert.activeTitle": "Active certificate",
    "cert.activeSub": "Your app is ready to issue invoices in ARCA.",
    "cert.expiresOn": "Expires on",
    "cert.alias": "Alias",
    "cert.expiration": "Expiration",
    "cert.lastUpdate": "Last update",
    "cert.uploadManualLink": "You can also upload new .crt and .key files manually",
    "cert.pendingTitle": "Pending request",
    "cert.recommended": "✨ Recommended",
    "cert.uploadCrtTitle": "Upload ARCA .crt certificate",
    "cert.uploadCrtDesc":
      "Finish the process you started — you just need to attach the file ARCA gave you.",
    "cert.continue": "Continue →",
    "cert.uploadManualTitle": "Upload files manually",
    "cert.uploadFiles": "Upload files →",
    "cert.resetTitle": "Start a new request?",
    "cert.resetBody":
      "The current request will be replaced and you'll have to do the whole process again in ARCA.",
    "cert.resetConfirm": "Yes, start over",
    // ── Certificates: guided assistant (start + stepper + step 1) ──
    "cert.redownloadCsr": "Re-download the request (.csr)",
    "cert.startNewRequest": "Start a new request",
    "cert.heroTitle": "Get your ARCA certificate with our assistant",
    "cert.heroDesc":
      "The fastest, safest way. No technical commands needed — we generate the request for you, you upload it to the ARCA portal, and you're done.",
    "cert.feature1": "Step-by-step guide inside the app",
    "cert.feature2": "You only upload one file at the end",
    "cert.feature3": "Your private key is encrypted automatically",
    "cert.startNow": "Start now →",
    "cert.altQ": "Already generated your .crt and .key elsewhere?",
    "cert.uploadThemManually": "Upload them manually →",
    "cert.step1Title": "Confirm details",
    "cert.step1Desc": "We review your legal name and CUIT",
    "cert.step2Title": "Download request",
    "cert.step2Desc": "We generate a .csr with your encrypted private key",
    "cert.step3Title": "Upload to ARCA",
    "cert.step3Desc": "Paste the alias and the .csr into AFIP",
    "cert.step4Title": "Upload certificate",
    "cert.step4Desc": "Attach the .crt that AFIP returns",
    "cert.s1Title": "Confirm the details",
    "cert.s1Desc":
      "These details are signed in the request. If something is wrong, fix it in Tax Details first.",
    "cert.s1RenewTitle": "You're renewing your certificate",
    "cert.s1RenewBody":
      "When you generate the new request, the current one is replaced and you won't be able to invoice until you complete step 4. Use a different alias than before — ARCA doesn't allow repeats.",
    "cert.s1MissingTitle": "Missing tax details",
    "cert.s1MissingBody":
      "Complete legal name and CUIT in the \"Tax Details\" section before generating the request.",
    "cert.aliasLabel": "Certificate alias",
    "cert.aliasHint": "It must be unique in ARCA. Pre-filled with the current month.",
    "cert.keyEncTitle": "Your private key is encrypted",
    "cert.keyEncBody": "It's generated and stored with AES-256. You'll never have to handle it.",
    "cert.generating": "Generating...",
    "cert.generateRequest": "Generate request",
    // ── Certificates: assistant steps 2/3/4 ──
    "cert.s2ReadyToUpload": "ready to upload to ARCA",
    "cert.downloadAgain": "Download again",
    "cert.gotIt": "I have it",
    "cert.s3Title": "Upload the .csr to ARCA",
    "cert.s3Desc": "Follow these steps in the AFIP portal.",
    "cert.openArca": "Open ARCA",
    "cert.gotCrt": "I have the .crt",
    "cert.s4Title": "Upload the certificate",
    "cert.s4Desc": "Attach the .crt you downloaded from ARCA.",
    "cert.fileSelected": "File selected",
    "cert.changeFile": "Change file",
    "cert.dropOrClick": "Drag the file or click",
    "cert.crtUpTo200": ".crt · up to 200 KB",
    "cert.validating": "Validating...",
    "cert.activateCert": "Activate certificate",
    "common.back": "Back",
    // ── Certificates: manual flow ──
    "cert.manualTitle": "Upload your .crt and .key files",
    "cert.backToAssistant": "Back to assistant",
    "cert.manualDesc":
      "If you already have both files generated, attach them. We check they match before saving.",
    "cert.crtTitle": "Certificate (.crt)",
    "cert.crtDesc": "Public certificate file",
    "cert.keyTitle": "Private Key (.key)",
    "cert.keyDesc": "Private key file",
    "cert.change": "Change",
    "cert.dropToUpload": "Drag or click to upload",
    "cert.uploading": "Uploading...",
    "cert.saveCerts": "Save certificates",
    "cert.securityLabel": "Security:",
    "cert.securityBody":
      "your private key is encrypted with AES-256 before being saved and is never exposed in plain text.",
    // ── Visual Mapping ──
    "map.title": "Visual Invoice Mapping",
    "map.sub": "Match each invoice field with a column from your Monday board.",
    "map.f.fechaEmision": "Issue Date",
    "map.f.receptorCuit": "Recipient CUIT / DNI",
    "map.f.condicionVenta": "Payment Terms",
    "map.f.fechaServDesde": "Service Date From",
    "map.f.fechaServHasta": "Service Date To",
    "map.f.fechaVtoPago": "Payment Due Date",
    "map.f.concepto": "Description / Detail",
    "map.f.cantidad": "Quantity",
    "map.f.precioUnitario": "Unit Price",
    "map.f.prodServ": "Product / Service",
    "map.f.unidadMedida": "Unit of Measure",
    "map.f.alicuotaIva": "VAT Rate %",
    "map.autoActions": "Automatic actions on the item",
    "map.optionals": "Optional",
    "map.autoActionsDesc":
      "Decide which automatic changes the app makes to the monday item when the invoice is issued.",
    "map.renameItem": "Rename the item with the invoice number",
    "map.changeStatus": "Change the item status automatically",
    "map.statusColumn": "Item status column",
    "map.chooseStatus": "— Choose Status column —",
    "map.notConfigured": "Not configured",
    "map.pdfColumnTitle": "Issued PDF column",
    "map.pdfColumnLabel": "Invoice PDF column",
    "map.chooseFile": "— Choose File column —",
    "map.pdfHint": "The (File-type) column where the PDF issued by AFIP will be attached.",
    "map.noFileColTitle": "Your board has no File column",
    "map.noFileColBody":
      "You need to add a \"File\" column to the board so the app can attach the invoice PDF.",
    "map.optionalConfig": "Optional settings",
    "map.optionalConfigDesc":
      "Advanced settings that extend the app's behavior. If you don't use them, the app works in its default mode.",
    "map.currency": "Currency",
    "map.defaultPesos": "— Default: pesos —",
    "map.defaultPesosShort": "Default: pesos",
    "map.exchangeRate": "Exchange rate",
    "map.requiredIfCurrency": "Required if you map Currency",
    "map.defaultAfip": "Default: AFIP",
    "map.needsMapping": "Needs mapping",
    "map.defaultAfipQuote": "Default: AFIP rate",
    "map.exchangeHint":
      "Empty cell → the app requests the rate from AFIP and writes it here as a record. With a value → it's respected as an override.",
    "map.unitPriceUsd": "Unit Price USD",
    "map.subitemTag": "(subitem)",
    "map.onlyIfUsd": "Only if you invoice in USD",
    "map.notMapped": "Not mapped",
    "map.usdHint":
      "Subitem numeric column with the price in dollars. Only used for items with currency Dollars.",
    "map.currencyWarn":
      "You map Currency → also map Exchange Rate and Unit Price USD. The 3 go together.",
    "map.observations": "Notes",
    "map.obsHint":
      "Item text column. If it has content, it appears in the PDF between the table and the totals (max 255 chars; truncated if longer).",
    "map.invoiceModel": "Model invoice",
    "map.frameEdit": "Click each field to map a column",
    "map.frameView": "View of the configured mapping — click Edit to change",
    "map.mapped": "Mapped",
    "map.unmapped": "Unmapped",
    "map.issueDate": "Issue date",
    "map.pointOfSale": "Point of sale",
    "map.clientLabel": "Client — CUIT/DNI",
    "map.paymentTermsLabel": "Payment terms",
    "map.serviceFrom": "Service from",
    "map.serviceTo": "Service to",
    "map.paymentDue": "Payment due",
    "map.thConcept": "Description",
    "map.thQty": "Qty",
    "map.thUnit": "Unit",
    "map.thProdServ": "Prod/Serv",
    "map.thUnitPrice": "Unit price",
    "map.thVat": "VAT %",
    "map.sampleConcept": "Consulting April 2026",
    "map.sampleUnit": "Hour",
    "map.sampleServ": "Service",
    "map.ghostRow": "Your board subitems will appear as lines here.",
    "map.subtotal": "Subtotal",
    "map.vat21": "VAT 21%",
    "map.total": "Total",
    "map.requiredCols": "Required columns",
    "map.requiredColsDesc":
      "Invoice data the app records on the item. Some it fills in automatically when issuing (CAE, invoice number, letter, recipient's legal name and VAT condition — these two are pulled from the AFIP registry); others are the basis for issuing Credit/Debit Notes (Voucher Type and the CAE of the invoice to cancel). Map them all to keep the board complete.",
    "map.caeLabel": "Voucher CAE",
    "map.receptorName": "Recipient Legal Name",
    "map.receptorIvaCond": "Recipient VAT Condition",
    "map.optional": "Optional",
    "map.colDate": "Date column",
    "map.colCuitReceptor": "Recipient CUIT column",
    "map.colConcepto": "Concept",
    "map.colQty": "Quantity",
    "map.colProdServ": "Prod/Serv",
    "map.colPrice": "Price",
    "map.colCae": "Voucher CAE column",
    "map.colText": "Text column",
    "map.colDropdown": "Dropdown column",
    "map.voucherType": "Voucher Type",
    "map.caeToCancel": "CAE of the invoice to cancel",
    "map.colNumeric": "Numeric column",
    "map.factRefHint": "For an invoice it's empty; for a Credit/Debit Note paste here the CAE of the invoice it adjusts.",
    "map.letterLabel": "Voucher Letter",
    "map.invoiceNum": "Invoice No. (PoS-No.)",
    "map.voucherNum": "Voucher No.",
    "map.optionalCols": "Optional columns",
    "map.optionalColsDesc": "Map them only if you use them. The app fills or reads them when issuing.",
    "map.saveInitial": "Save Visual Mapping",
    "common.close": "Close",
    // ── WelcomePage ──
    "welcome.title": "Welcome to Factura ARCA!",
    "welcome.subtitle":
      "You'll be able to issue electronic invoices from your monday boards in 3 steps. Set it up once and forget about manual entry on the AFIP website.",
    "welcome.step1Desc":
      "Enter your company details (CUIT, legal name, point of sale). This is the information that will appear on every invoice you issue.",
    "welcome.step2Desc":
      "Connect your ARCA digital certificate. If you already have one, upload it. If not, we guide you step by step to generate it without leaving the app.",
    "welcome.step3Desc":
      "Tell the app which board column represents the client, which one the amount, etc. It's like building the invoice template once.",
    "welcome.zoomAria": "Zoom screenshot of step",
    "welcome.stepWord": "Step",
    "welcome.clickToZoom": "Click to zoom",
    "welcome.footer":
      "After that, each status change on the board triggers an automatic AFIP invoice with CAE, number, and PDF attached to the item.",
    "welcome.startBtn": "Start setup",
    "welcome.lightboxAria": "Zoomed image",
  },
};

const STORAGE_KEY = "arca_lang";
const DEFAULT_LANG = "en"; // monday exige inglés por defecto

const LangContext = createContext({
  lang: DEFAULT_LANG,
  setLang: () => {},
  t: (key) => key,
});

function readInitialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "es" || saved === "en") return saved;
  } catch {
    /* iframe sin acceso a localStorage → usamos el default */
  }
  return DEFAULT_LANG;
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(readInitialLang);

  const setLang = useCallback((next) => {
    if (next !== "es" && next !== "en") return;
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* sin localStorage: igual cambia en memoria para esta sesión */
    }
  }, []);

  // t(key): devuelve el texto en el idioma actual; si no existe, cae a español;
  // si tampoco existe en español, devuelve la clave (señal visible para el dev).
  const t = useCallback(
    (key) =>
      translations[lang]?.[key] ?? translations.es?.[key] ?? key,
    [lang]
  );

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </LangContext.Provider>
  );
}

export function useT() {
  return useContext(LangContext);
}

// Selector de idioma (EN / ES). Pill chiquito, marca la opción activa.
export function LanguageSwitcher() {
  const { lang, setLang } = useT();
  return (
    <div className="lang-switcher" role="group" aria-label="Idioma / Language">
      <button
        type="button"
        className={`lang-opt ${lang === "en" ? "active" : ""}`}
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
      >
        EN
      </button>
      <button
        type="button"
        className={`lang-opt ${lang === "es" ? "active" : ""}`}
        onClick={() => setLang("es")}
        aria-pressed={lang === "es"}
      >
        ES
      </button>
    </div>
  );
}