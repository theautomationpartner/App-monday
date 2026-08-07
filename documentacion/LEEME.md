# Cómo agregarle las capturas al PDF

El PDF ya está hecho: **`Guia-Tecnica-Factura-ARCA.pdf`**. Tiene 5 lugares reservados para
capturas, que hoy se ven como recuadros punteados.

## Los 5 lugares

Sacá cada captura, guardala en la carpeta `capturas/` **con ese nombre exacto**, y listo.

| Archivo | Qué mostrar |
|---|---|
| `capturas/01-slack-canal.png` | El canal `#make-errores-` con alertas reales |
| `capturas/02-recovery-mismatch.png` | Una alerta de `[RECOVERY_MISMATCH]` en Slack |
| `capturas/03-error-en-item.png` | Un ítem de monday con el comentario de error que deja la app |
| `capturas/04-github-actions.png` | La pestaña **Actions** de GitHub con los pasos del deploy |
| `capturas/05-tablero-pruebas.png` | El tablero de pruebas con los 12 ítems de error |

**No hace falta poner las cinco.** Las que falten siguen mostrando el recuadro punteado y
el documento se entiende igual.

> Para la 03 y la 05, el tablero de pruebas ya tiene los 12 ítems cargados:
> [Facturación con errores de test](https://the-automation-partner.monday.com/boards/18425062980)

## Regenerar el PDF

Doble click en **`generar-pdf.bat`**.

Si no anda, la alternativa manual: abrí `guia-tecnica.html` en Chrome, `Ctrl+P`,
destino **"Guardar como PDF"**, y guardalo encima del anterior.

## Si querés cambiarle el texto

Editá `guia-tecnica.html` —es texto plano, se entiende— y volvé a generar el PDF.

---

## Los otros documentos

Este PDF es **el panorama**: se lee entero una vez, en 15 minutos.

Cuando ya hay un problema concreto, el documento es **`RUNBOOK.md`** (en la raíz del
repositorio): 12 fichas de incidentes, se entra por el síntoma, con los comandos para
copiar y pegar.
