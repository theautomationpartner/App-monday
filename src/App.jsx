import React, { useState, useEffect } from "react";
import mondaySdk from "monday-sdk-js";
import axios from "axios";
import "monday-ui-react-core/tokens";
import "monday-ui-react-core/dist/main.css";
import "./App.css";

const monday = mondaySdk();
// Si estamos en localhost usamos el puerto 3001, si no, usamos la ruta relativa /api
const API_URL = window.location.hostname === "localhost" 
  ? "http://localhost:3001/api" 
  : "/api";

/* ─── Iconos SVG inline ─── */
const IconCert = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
);
const IconBuilding = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M16 6h.01M12 6h.01M8 10h.01M16 10h.01M12 10h.01M8 14h.01M16 14h.01M12 14h.01"/></svg>
);
const IconUpload = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0073ea" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
);
const IconCheck = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#00ca72" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
);

const MENU_ITEMS = [
  { id: "certificados", label: "Certificados AFIP", icon: <IconCert /> },
  { id: "datos", label: "Datos Fiscales", icon: <IconBuilding /> },
];

const IVA_OPTIONS = [
  "Responsable Inscripto",
  "Monotributista",
  "Exento",
];

const App = () => {
  const [context, setContext] = useState(null);
  const [activeSection, setActiveSection] = useState("certificados");
  const [isLoading, setIsLoading] = useState(false);

  // Certificados
  const [crtFile, setCrtFile] = useState(null);
  const [keyFile, setKeyFile] = useState(null);

  // Datos fiscales
  const [fiscal, setFiscal] = useState({
    puntoVenta: "",
    cuit: "",
    fechaInicio: "",
    razonSocial: "",
    domicilio: "",
    condicionIva: "",
  });

  useEffect(() => {
    monday.listen("context", (res) => {
      console.log("Contexto recibido:", res.data);
      setContext(res.data);
    });
  }, []);

  const handleFiscalChange = (field, value) => {
    setFiscal((prev) => ({ ...prev, [field]: value }));
  };

  const handleFileChange = (e, type) => {
    const file = e.target.files[0];
    if (!file) return;
    if (type === "crt") setCrtFile(file);
    if (type === "key") setKeyFile(file);
  };

  const handleSaveFiscal = async () => {
    if (!context || !context.account) {
        monday.execute("notice", { message: "Error: No se detectó la cuenta de Monday", type: "error" });
        return;
    }

    setIsLoading(true);
    try {
        const payload = {
            monday_account_id: context.account.id.toString(),
            business_name: fiscal.razonSocial,
            cuit: fiscal.cuit.replace(/-/g, ""), // Limpiamos guiones
            iva_condition: fiscal.condicionIva,
            default_point_of_sale: parseInt(fiscal.puntoVenta) || 0,
            domicilio: fiscal.domicilio,
            fecha_inicio: fiscal.fechaInicio
        };

        await axios.post(`${API_URL}/companies`, payload);
        
        monday.execute("notice", {
            message: "Datos fiscales guardados con éxito en la base de datos",
            type: "success",
            duration: 5000
        });
    } catch (err) {
        console.error("Error al guardar:", err);
        monday.execute("notice", {
            message: "Error al guardar los datos. Verificá la conexión con el backend.",
            type: "error"
        });
    } finally {
        setIsLoading(false);
    }
  };

  const handleUploadCertificates = async () => {
    if (!crtFile || !keyFile) {
        monday.execute("notice", { message: "Por favor, seleccioná ambos archivos (.crt y .key)", type: "error" });
        return;
    }

    if (!context || !context.account) {
        monday.execute("notice", { message: "Error: No se detectó la cuenta de Monday", type: "error" });
        return;
    }

    setIsLoading(true);
    try {
        const formData = new FormData();
        formData.append("monday_account_id", context.account.id.toString());
        formData.append("crt", crtFile);
        formData.append("key", keyFile);

        await axios.post(`${API_URL}/certificates`, formData, {
            headers: { "Content-Type": "multipart/form-data" }
        });

        monday.execute("notice", {
            message: "Certificados subidos y encriptados correctamente",
            type: "success",
            duration: 5000
        });
    } catch (err) {
        console.error("Error al subir certificados:", err);
        monday.execute("notice", {
            message: "Error al subir certificados. Verificá el servidor backend.",
            type: "error"
        });
    } finally {
        setIsLoading(false);
    }
  };

  /* ─── RENDER ─── */
  return (
    <div className="app-container">
      {/* ─── SIDEBAR ─── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-logo">FE</div>
          <span className="sidebar-title">Facturación<br/>Electrónica</span>
        </div>

        <nav className="sidebar-nav">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`sidebar-item ${activeSection === item.id ? "active" : ""}`}
              onClick={() => setActiveSection(item.id)}
            >
              <span className="sidebar-item-icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-status">
            <span className={`status-dot ${context ? "online" : ""}`} />
            <span className="status-text">
              {context ? "Conectado" : "Sin contexto"}
            </span>
          </div>
        </div>
      </aside>

      {/* ─── CONTENIDO PRINCIPAL ─── */}
      <main className="main-content">
        {isLoading && (
            <div className="loading-overlay">
                <div className="loader"></div>
                <p>Procesando datos de forma segura...</p>
            </div>
        )}

        {/* ═══ SECCIÓN: CERTIFICADOS ═══ */}
        {activeSection === "certificados" && (
          <section className="section">
            <div className="section-header">
              <h1 className="section-title">Certificados AFIP</h1>
              <p className="section-subtitle">
                Subí tus archivos de certificado y clave privada. Los archivos se encriptarán automáticamente antes de guardarse.
              </p>
            </div>

            <div className="cards-row">
              {/* Card CRT */}
              <div className="upload-card">
                <div className="upload-card-header">
                  <h3>Certificado (.crt)</h3>
                  <p>Archivo de certificado público</p>
                </div>
                {crtFile ? (
                  <div className="upload-success">
                    <IconCheck />
                    <span>{crtFile.name}</span>
                    <button className="btn-text" onClick={() => setCrtFile(null)}>Cambiar</button>
                  </div>
                ) : (
                  <label className="upload-zone" htmlFor="crt-upload">
                    <IconUpload />
                    <span className="upload-zone-text">Arrastrá o hacé clic para subir</span>
                    <span className="upload-zone-hint">.crt</span>
                    <input
                      id="crt-upload"
                      type="file"
                      accept=".crt"
                      onChange={(e) => handleFileChange(e, "crt")}
                      hidden
                    />
                  </label>
                )}
              </div>

              {/* Card KEY */}
              <div className="upload-card">
                <div className="upload-card-header">
                  <h3>Clave Privada (.key)</h3>
                  <p>Archivo de clave privada</p>
                </div>
                {keyFile ? (
                  <div className="upload-success">
                    <IconCheck />
                    <span>{keyFile.name}</span>
                    <button className="btn-text" onClick={() => setKeyFile(null)}>Cambiar</button>
                  </div>
                ) : (
                  <label className="upload-zone" htmlFor="key-upload">
                    <IconUpload />
                    <span className="upload-zone-text">Arrastrá o hacé clic para subir</span>
                    <span className="upload-zone-hint">.key</span>
                    <input
                      id="key-upload"
                      type="file"
                      accept=".key"
                      onChange={(e) => handleFileChange(e, "key")}
                      hidden
                    />
                  </label>
                )}
              </div>
            </div>

            <div className="form-actions">
                <button className="btn-primary" onClick={handleUploadCertificates} disabled={isLoading}>
                    {isLoading ? "Subiendo..." : "Guardar Certificados"}
                </button>
            </div>

            <div className="info-box" style={{marginTop: "24px"}}>
              <span className="info-box-icon">🔒</span>
              <span>
                <strong>Seguridad:</strong> Tu clave privada se encripta con algoritmos bancarios antes de salir de tu computadora y nunca se guarda en texto plano.
              </span>
            </div>
          </section>
        )}

        {/* ═══ SECCIÓN: DATOS FISCALES ═══ */}
        {activeSection === "datos" && (
          <section className="section">
            <div className="section-header">
              <h1 className="section-title">Datos Fiscales</h1>
              <p className="section-subtitle">
                Completá la información de tu empresa para la facturación electrónica.
              </p>
            </div>

            <div className="form-grid">
              <div className="form-group">
                <label className="form-label">Razón Social</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Ej: Mi Empresa S.A."
                  value={fiscal.razonSocial}
                  onChange={(e) => handleFiscalChange("razonSocial", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">CUIT</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="20-12345678-9"
                  value={fiscal.cuit}
                  onChange={(e) => handleFiscalChange("cuit", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Punto de Venta</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="0001"
                  value={fiscal.puntoVenta}
                  onChange={(e) => handleFiscalChange("puntoVenta", e.target.value)}
                />
              </div>

              <div className="form-group">
                <label className="form-label">Fecha de Inicio de Actividades</label>
                <input
                  className="form-input"
                  type="date"
                  value={fiscal.fechaInicio}
                  onChange={(e) => handleFiscalChange("fechaInicio", e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label className="form-label">Domicilio Comercial</label>
                <input
                  className="form-input"
                  type="text"
                  placeholder="Av. Corrientes 1234, CABA"
                  value={fiscal.domicilio}
                  onChange={(e) => handleFiscalChange("domicilio", e.target.value)}
                />
              </div>

              <div className="form-group full-width">
                <label className="form-label">Condición frente al IVA</label>
                <div className="radio-group">
                  {IVA_OPTIONS.map((option) => (
                    <label key={option} className={`radio-card ${fiscal.condicionIva === option ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="condicionIva"
                        value={option}
                        checked={fiscal.condicionIva === option}
                        onChange={(e) => handleFiscalChange("condicionIva", e.target.value)}
                        hidden
                      />
                      <span className="radio-dot" />
                      <span className="radio-label">{option}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="form-actions">
              <button className="btn-primary" onClick={handleSaveFiscal} disabled={isLoading}>
                {isLoading ? "Guardando..." : "Guardar Datos Fiscales"}
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
};

export default App;
