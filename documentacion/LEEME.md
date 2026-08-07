# Cómo agregarle las capturas al PDF

El PDF ya está hecho: **`Guia-Tecnica-Factura-ARCA.pdf`**. Tiene lugares reservados para
capturas, que hoy se ven como recuadros punteados con el nombre del archivo que va ahí.

**Sacá la captura, guardala en `capturas/` con ese nombre exacto, y regenerá el PDF.**

**No hace falta ponerlas todas.** Las que falten siguen mostrando el recuadro y el documento
se entiende igual.

---

## Las capturas

### Lo normal y el canal

| Archivo | Qué mostrar |
|---|---|
| `exito-comprobante.png` | Un ítem con una **factura emitida bien**: el comentario con el CAE y el PDF adjunto |
| `slack-canal.png` | El canal `#make-errores-` con alertas reales |

### Un error por tipo

| Archivo | Qué mostrar |
|---|---|
| `error-a-recovery-mismatch.png` | La alerta de `[RECOVERY_MISMATCH]` en Slack |
| `error-b-abandoned.png` | La alerta de `[ABANDONED]` en Slack |
| `error-c-discrepancia.png` | La alerta `DISCREPANCIA AFIP` de la auditoría nocturna |
| `error-d-afip-caido.png` | El comentario en el ítem cuando AFIP no responde |
| `error-e-processing.png` | Un ítem con el estado en "Creando Comprobante" |
| `error-f-dato-mal.png` | El comentario cuando el cliente cargó un dato mal |

> Para los errores **D, E y F** tenés todo servido en el
> [tablero de pruebas](https://the-automation-partner.monday.com/boards/18425062980):
> los 12 ítems ya están cargados con sus errores y sus comentarios.
>
> Para **A, B y C** hay que buscar la alerta en el historial de Slack — son las que no se
> pueden forzar a voluntad.

### Cómo pasar a staging

| Archivo | Qué mostrar |
|---|---|
| `staging-1-centro-desarrollo.png` | El Centro de Desarrollo con la app Factura ARCA |
| `staging-2-version-nueva.png` | El botón "+ Versión nueva" y la Draft creada |
| `staging-3-url-vista.png` | La pantalla de la **Vista del tablero** con el campo "URL externa" |
| `staging-4-url-receta.png` | La receta **Crear Comprobante** con el campo "URL de ejecución" |

### El deploy

| Archivo | Qué mostrar |
|---|---|
| `github-actions.png` | La pestaña **Actions** de GitHub con los pasos del deploy |
| `tablero-pruebas.png` | El tablero de pruebas con los 12 ítems de error |

---

## Regenerar el PDF

Doble click en **`generar-pdf.bat`**.

Si no anda: abrí `guia-tecnica.html` en Chrome, `Ctrl+P`, destino **"Guardar como PDF"**.

## Cambiar el texto

Editá `guia-tecnica.html` —es texto plano— y volvé a generar el PDF.

---

## Los otros documentos

Este PDF es **el panorama**. Cuando ya hay un problema concreto, el documento es
**`RUNBOOK.md`** (en la raíz del repositorio): 12 fichas de incidentes, se entra por el
síntoma, con los comandos para copiar y pegar.
