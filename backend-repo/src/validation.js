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
const BoardConfigSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    board_id: z.union([z.string(), z.number()]),
    view_id: z.union([z.string(), z.number()]).optional().nullable(),
    app_feature_id: z.union([z.string(), z.number()]).optional().nullable(),
    status_column_id: z.string().min(1),
    required_columns: z.array(z.any()),
    invoice_pdf_column_id: z.string().optional().nullable(),
    trigger_label: z.string().optional().nullable(),
    processing_label: z.string().optional().nullable(),
    success_label: z.string().optional().nullable(),
    error_label: z.string().optional().nullable(),
});

// Mapeo visual de columnas a campos de factura (POST /api/mappings)
const MappingSchema = z.object({
    monday_account_id: z.union([z.string(), z.number()]).optional(),
    workspace_id: z.union([z.string(), z.number()]).optional().nullable(),
    board_id: z.union([z.string(), z.number()]),
    view_id: z.union([z.string(), z.number()]).optional().nullable(),
    app_feature_id: z.union([z.string(), z.number()]).optional().nullable(),
    mapping: z.record(z.string(), z.any()).optional(),
    is_locked: z.boolean().optional(),
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
