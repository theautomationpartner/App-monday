# Cómo agregarle las capturas al PDF

El PDF ya está hecho: **`Guia-Tecnica-Factura-ARCA.pdf`**. Tiene lugares reservados para
capturas, que hoy se ven como recuadros punteados con el nombre del archivo que va ahí.

**Sacá la captura, guardala en `capturas/` con ese nombre exacto, y regenerá el PDF.**

**No hace falta ponerlas todas.** Las que falten siguen mostrando el recuadro y el documento
se entiende igual.

---

## Las capturas

### Las alertas de Slack — ✅ ya están, generadas

Estas cuatro **no se sacan con una captura**: la alerta de `[RECOVERY_MISMATCH]` aparece
cada varios meses y la de `[ABANDONED]` tarda 8 horas en salir. Esperarlas no era viable,
provocarlas significaba romper una emisión real, y mandarlas al canal de prod tampoco: un
webhook no puede borrar lo que manda, así que quedarían alertas rojas falsas para siempre
en el canal del que depende el equipo.

Están **reconstruidas** con `hacer-capturas-slack.js`: el texto sale literal de las
plantillas de `server.js` y los datos son inventados. El PDF lo aclara.

| Archivo | Qué es |
|---|---|
| `slack-todo-bien.png` | El resumen nocturno con todo OK — la señal de vida diaria |
| `error-a-recovery-mismatch.png` | La alerta de `[RECOVERY_MISMATCH]` |
| `error-b-abandoned.png` | La alerta de `[ABANDONED]` |
| `error-c-discrepancia.png` | `DISCREPANCIA AFIP` de la auditoría nocturna |
| `error-g-conciliacion.png` | `🟡 Conciliación AFIP` — comprobantes sin registrar |

Para rehacerlas o agregar una alerta nueva:

```bash
cd documentacion
node hacer-capturas-slack.js && powershell -File recortar-slack.ps1
```

### Las que faltan — estas sí hay que sacarlas

| Archivo | Qué mostrar |
|---|---|
| `error-d-afip-caido.png` | El comentario en el ítem cuando AFIP no responde |
| `error-e-processing.png` | Un ítem con el estado en "Creando Comprobante" |
| `error-f-dato-mal.png` | El comentario cuando el cliente cargó un dato mal |
| `slack-canal.png` | El canal `#make-errores-` con varias alertas seguidas |
| `github-actions.png` | La pestaña **Actions** de GitHub con los pasos del deploy |
| `tablero-pruebas.png` | El tablero de pruebas con los 12 ítems de error |

> **D, E y F** los tenés servidos en el
> [tablero de pruebas](https://the-automation-partner.monday.com/boards/18425062980):
> los 12 ítems ya están cargados con sus errores y sus comentarios. Son 3 capturas de la
> pantalla, sin emitir nada.

### Cómo pasar a staging — ✅ ya están

Las 7 están hechas, recortadas y con el círculo rojo puesto. Los originales sin recortar
quedaron en `capturas/originales/`.

| Archivo | Dónde está el círculo |
|---|---|
| `staging-1-centro-desarrollo.png` | La fila **"Factura ARCA"** en Mis apps |
| `staging-2-version-nueva.png` | El botón **"+ Versión nueva"** |
| `staging-3-version-creada.png` | La versión nueva en estado **Borrador** |
| `staging-4-funciones.png` | Las **dos funciones** que hay que tocar |
| `staging-5-url-receta.png` | El campo **"URL de ejecución"** y el botón **Guardar cambios** |
| `staging-6-url-vista.png` | El campo **"Establecer la URL que se va a mostrar"** |
| `staging-7-eliminar-version.png` | La opción **"Eliminar versión"** del menú "…" |

> Si alguna hay que rehacerla, el script que las recorta y les dibuja el círculo está en
> `hacer-circulos.ps1`: se editan las coordenadas ahí y se corre de nuevo.

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
