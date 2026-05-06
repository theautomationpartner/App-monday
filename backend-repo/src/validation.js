// Validacion de inputs de los endpoints publicos con Zod.
// Cada endpoint que recibe JSON del usuario tiene un schema asociado. El helper
// validateBody() lo aplica como middleware antes del handler real:
//   - Si la validacion falla, responde 400 con un error claro.
//   - Si pasa, sobreescribe req.body con la version "limpia" (solo los campos
//     definidos en el schema) — esto previene mass-assignment porque cualquier
//     campo extra del request se descarta antes de llegar al handler.

const { z } = require('zod');

function validateBody(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const issues = result.error.issues || result.error.errors || [];
            const details = issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
            return res.status(400).json({ error: 'Datos invalidos', details });
        }
        req.body = result.data;
        next();
    };
}

// ─── Schemas ────────────────────────────────────────────────────────────────

// Datos fiscales del emisor (POST /api/companies)
const CompanySchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    business_name: z.string().max(255).optional().nullable(),
    nombre_fantasia: z.string().min(1, 'El nombre de fantasia es obligatorio').max(255),
    cuit: z.string().min(1, 'El CUIT es obligatorio').max(20),
    default_point_of_sale: z.union([z.number(), z.string()]).optional().nullable(),
    domicilio: z.string().max(500).optional().nullable(),
    fecha_inicio: z.string().optional().nullable(),
    phone: z.string().max(50).optional().nullable(),
    email: z.string().max(255).optional().nullable(),
    website: z.string().max(500).optional().nullable(),
});

// Configuracion de board para automatizaciones (POST /api/board-config)
//
// auto_rename_item    -> si TRUE, despues de emitir la app renombra el
//                        item con el formato "Factura X N° 0000-00000000"
// auto_update_status  -> si TRUE, la app cambia el estado del item entre
//                        "Procesando" / "Comprobante Creado" / "Error".
//                        Solo en este caso status_column_id es obligatorio.
//
// Defaults TRUE para no afectar a clientes existentes.
const BoardConfigSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    board_id: z.union([z.string(), z.number()]),
    view_id: z.union([z.string(), z.number()]).optional().nullable(),
    app_feature_id: z.union([z.string(), z.number()]).optional().nullable(),
    status_column_id: z.string().optional().nullable(),
    required_columns: z.array(z.any()),
    invoice_pdf_column_id: z.string().optional().nullable(),
    trigger_label: z.string().optional().nullable(),
    processing_label: z.string().optional().nullable(),
    success_label: z.string().optional().nullable(),
    error_label: z.string().optional().nullable(),
    auto_rename_item: z.boolean().optional(),
    auto_update_status: z.boolean().optional(),
}).refine(
    // Si el cliente activa auto_update_status, status_column_id es obligatorio
    (data) => {
        if (data.auto_update_status === false) return true;
        // si auto_update_status es true o undefined (default true), exigir status
        return Boolean(data.status_column_id && data.status_column_id.length > 0);
    },
    {
        message: 'status_column_id es obligatorio cuando auto_update_status está activado',
        path: ['status_column_id'],
    }
);

// Mapeo visual de columnas a campos de factura (POST /api/mappings)
//
// Si is_complete=true, exigimos los 12 campos obligatorios del mapeo.
// Si is_complete=false (o no viene), aceptamos cualquier mapping (caso de
// borrador o autosave futuro). Por defecto el frontend siempre manda true.
const REQUIRED_MAPPING_FIELDS = [
    'fecha_emision',
    'receptor_cuit',
    'condicion_venta',
    'fecha_servicio_desde',
    'fecha_servicio_hasta',
    'fecha_vto_pago',
    'concepto',
    'cantidad',
    'precio_unitario',
    'prod_serv',
    'unidad_medida',
    'alicuota_iva',
];

const MappingSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    board_id: z.union([z.string(), z.number()]),
    view_id: z.union([z.string(), z.number()]).optional().nullable(),
    app_feature_id: z.union([z.string(), z.number()]).optional().nullable(),
    mapping: z.record(z.string(), z.any()).optional(),
    is_locked: z.boolean().optional(),
    is_complete: z.boolean().optional(),
}).superRefine((data, ctx) => {
    // Si is_complete=false (caso de borrador/autosave), aceptamos cualquier mapping
    if (data.is_complete === false) return;
    // Default: is_complete asumido true → exigir los 12 campos obligatorios
    const m = data.mapping || {};
    const missing = REQUIRED_MAPPING_FIELDS.filter((field) => !m[field]);
    if (missing.length > 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Faltan mapear campos obligatorios: ${missing.join(', ')}`,
            path: ['mapping'],
        });
    }
});

// Token de API de monday del usuario (POST /api/user-api-token)
const UserApiTokenSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    api_token: z.string().min(1, 'El API token es obligatorio'),
});

// Generar CSR para certificado AFIP (POST /api/certificates/csr/generate)
const CSRGenerateSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    alias: z.string().max(100).optional().nullable(),
});

module.exports = {
    validateBody,
    CompanySchema,
    BoardConfigSchema,
    MappingSchema,
    UserApiTokenSchema,
    CSRGenerateSchema,
};
