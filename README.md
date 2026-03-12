# 🇦🇷 Facturación Electrónica AFIP - Monday.com App

Este proyecto es una aplicación nativa para **Monday.com** que permite a empresas argentinas gestionar su facturación electrónica de AFIP directamente desde sus tableros.

## 🚀 Estado Actual del Proyecto

Actualmente hemos completado la **Etapa 1: Infraestructura y UI Base**.

### ✅ Lo que ya funciona:
1.  **Frontend (React + Vite)**:
    *   Arquitectura "DocuGen Style": Sidebar lateral con navegación fluida.
    *   **Sección Certificados**: Interfaz de carga para archivos `.crt` y `.key`.
    *   **Sección Datos Fiscales**: Formulario completo (CUIT, Razón Social, Punto de Venta, Condición IVA, etc.).
    *   Integración con **Monday SDK** para recibir contexto del tablero.
    *   Estilos nativos usando **Monday Vibe Design System** y CSS personalizado.
2.  **Deploy**:
    *   Configurado y funcionando en **Netlify** con headers de seguridad (`_headers`) para permitir su uso dentro de iframes de Monday.
3.  **Backend (Node.js + Express)**:
    *   Estructura de servidor lista en `/backend`.
    *   Manejo de archivos con **Multer** para recibir certificados.
    *   **Seguridad**: Encriptación de clave privada AFIP usando **AES (CryptoJS)** antes de guardar en DB.
4.  **Base de Datos (PostgreSQL en Neon.tech)**:
    *   Conexión configurada y tablas creadas siguiendo un modelo **Multi-tenant**.

---

## 🛠️ Arquitectura Técnica

### Frontend
- **Framework**: React 18 + Vite.
- **UI**: Monday UI React Core (Vibe).
- **Hosting**: Netlify (`https://incomparable-tapioca-b0e76b.netlify.app/`).

### Backend
- **Runtime**: Node.js.
- **Framework**: Express.
- **Seguridad**: CryptoJS para encriptación de datos sensibles.
- **Base de Datos**: PostgreSQL (Neon.tech).

---

## 📅 Hoja de Ruta (Roadmap) - Próximos Pasos

### 1. Conexión Frontend-Backend (Inmediato)
*   Integrar **Axios** en el Frontend para que el botón "Guardar" envíe los datos reales a la API de Node.js.
*   Implementar carga de archivos real al backend.

### 2. Integración AFIP (Servicios Web)
*   Integrar la librería `afip.js` para comunicarse con los servidores de AFIP (WSAA para tokens y WSFE para facturas).
*   Manejar el flujo de autenticación mediante los certificados subidos.

### 3. Automatización en Monday
*   Crear la lógica para que, al cambiar un estado en Monday (ej: "Generar Factura"), el backend dispare la solicitud a AFIP.
*   Devolver el número de factura y el link al PDF directamente a las columnas de Monday.

### 4. Generación de PDF
*   Implementar un motor de plantillas HTML a PDF para generar el comprobante oficial con el logo de la empresa y los datos de AFIP.

---

## 📁 Estructura del Repositorio
- `/`: Frontend en React.
- `/dist`: Build de producción para Netlify.
- `/backend`: Servidor Node.js.
- `/backend/src`: Lógica del servidor y conexión a base de datos.
- `/backend/uploads`: Almacenamiento temporal de certificados (encriptados).

---
*Desarrollado con ❤️ para empresas argentinas que buscan simplificar su gestión en Monday.com.*
