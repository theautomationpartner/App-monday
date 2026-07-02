import DOMPurify from "dompurify";

// Sanitiza HTML antes de inyectarlo con dangerouslySetInnerHTML.
//
// Hoy SOLO se usa con strings de i18n (constantes de la app definidas en
// i18n.jsx, nunca input del usuario ni datos de columnas de monday), así que
// no hay riesgo real de XSS. Aun así pasamos todo por DOMPurify como defensa
// en profundidad: si alguna cadena de traducción llegara a incluir contenido
// no confiable, DOMPurify remueve <script> y cualquier tag/atributo peligroso
// (onerror, javascript:, etc.) antes de que React lo renderice.
//
// Uso:  <span dangerouslySetInnerHTML={safeHtml(t("clave"))} />
export function safeHtml(dirty) {
  return { __html: DOMPurify.sanitize(dirty ?? "") };
}