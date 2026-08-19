import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { uploadUserSignature } from "../firebase";
import SignaturePad from "./SignaturePad";
import { PROJECT_ID, DATABASE_ID } from "../config";

function parseDoc(doc) {
  const parse = (v) => {
    if (!v) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return parseInt(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue) return (v.arrayValue.values || []).map(parse);
    if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, val]) => [k, parse(val)]));
    return null;
  };
  const id = doc.name.split("/").pop();
  return { id, ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, parse(v)])) };
}

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (val === null || val === undefined) return { nullValue: null };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
  return { stringValue: String(val) };
}

async function fetchUserDoc(token, uid) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/users/${uid}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return parseDoc(await res.json());
}

async function patchUser(token, uid, fields) {
  const mask = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/users/${uid}?${mask}`,
    { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toFV(v)])) }) });
  if (!res.ok) { let msg = `Error ${res.status}`; try { const b = await res.json(); msg = b?.error?.message || msg; } catch {} throw new Error(msg); }
}

async function fetchPendingRequests(token) {
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: "signature_requests" }],
      where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "pending" } } },
    }}),
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// Botón + modal de "Mi firma" -- captura una sola vez, se reutiliza
// automáticamente (imagen incrustada, congelada por documento) en las
// solicitudes de insumos, la bitácora de tratamiento, etc. No dibuja nada
// en vivo cada vez: quien firma solo aparece en pantalla una vez por firma.
export default function MySignatureModal() {
  const { user, profile, refreshProfile } = useAuth();
  const isJefe = profile?.role === "jefe";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const [myPendingRequest, setMyPendingRequest] = useState(null);

  const load = async () => {
    const t = await user.getIdToken(true);
    if (isJefe) {
      setLoadingPending(true);
      try { setPending(await fetchPendingRequests(t)); } finally { setLoadingPending(false); }
    } else {
      setLoadingPending(true);
      try {
        const mine = (await fetchPendingRequests(t)).filter(r => r.uid === user.uid);
        setMyPendingRequest(mine[0] || null);
      } finally { setLoadingPending(false); }
    }
  };

  useEffect(() => { if (open) load(); }, [open]);

  const hasSignature = !!profile?.signatureUrl;

  const saveSignature = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const t = await user.getIdToken(true);
      const newUrl = await uploadUserSignature(user.uid, draft);
      const history = [...(profile?.signatureHistory || [])];
      if (profile?.signatureUrl) history.push({ url: profile.signatureUrl, setAt: profile.signatureSetAt || null, replacedAt: new Date().toISOString() });

      if (isJefe || !hasSignature) {
        // Jefe: auto-aprobado siempre. Cualquier otro usuario: solo la
        // PRIMERA captura es libre, sin pedir autorización.
        await patchUser(t, user.uid, { signatureUrl: newUrl, signatureHistory: history, signatureSetAt: new Date().toISOString() });
        // Registro/auditoría del cambio, aunque haya sido auto-aprobado.
        await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/signature_requests`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
          body: JSON.stringify({ fields: Object.fromEntries(Object.entries({
            uid: user.uid, name: profile?.name || "", newSignatureUrl: newUrl, previousSignatureUrl: profile?.signatureUrl || null,
            status: "approved", requestedAt: new Date().toISOString(), resolvedBy: user.uid, resolvedAt: new Date().toISOString(),
            autoApproved: true,
          }).map(([k, v]) => [k, toFV(v)])) }),
        });
      } else {
        // Cambio de firma (ya tenía una): queda pendiente de autorización
        // del jefe -- no se toca users/{uid} todavía.
        await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/signature_requests`, {
          method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
          body: JSON.stringify({ fields: Object.fromEntries(Object.entries({
            uid: user.uid, name: profile?.name || "", newSignatureUrl: newUrl, previousSignatureUrl: profile?.signatureUrl || null,
            status: "pending", requestedAt: new Date().toISOString(),
          }).map(([k, v]) => [k, toFV(v)])) }),
        });
      }
      setDraft(null);
      await load();
      if (isJefe || !hasSignature) await refreshProfile();
    } catch (e) {
      alert("Error al guardar la firma: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const resolveRequest = async (req, approve) => {
    setSaving(true);
    try {
      const t = await user.getIdToken(true);
      if (approve) {
        const target = await fetchUserDoc(t, req.uid);
        const history = [...(target?.signatureHistory || [])];
        if (target?.signatureUrl) history.push({ url: target.signatureUrl, setAt: target.signatureSetAt || null, replacedAt: new Date().toISOString() });
        await patchUser(t, req.uid, { signatureUrl: req.newSignatureUrl, signatureHistory: history, signatureSetAt: new Date().toISOString() });
      }
      const mask = ["status", "resolvedBy", "resolvedAt"].map(k => `updateMask.fieldPaths=${k}`).join("&");
      await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DATABASE_ID}/documents/signature_requests/${req.id}?${mask}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${t}` },
        body: JSON.stringify({ fields: { status: toFV(approve ? "approved" : "rejected"), resolvedBy: toFV(user.uid), resolvedAt: toFV(new Date().toISOString()) } }),
      });
      await load();
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)}
        style={{ width: "100%", padding: "8px", borderRadius: 9, fontSize: 11, cursor: "pointer", background: "rgba(175,169,236,0.08)", border: "1px solid rgba(175,169,236,0.2)", color: "#AFA9EC", marginTop: 8 }}>
        ✍️ Mi firma
      </button>

      {open && (
        <div onClick={() => !saving && setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#161616", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 20, width: "100%", maxWidth: 460, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#f0f0f0" }}>✍️ Mi firma</div>
              <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>Se captura una sola vez y se reutiliza automáticamente en los documentos que la necesiten.</div>
            </div>

            {hasSignature && (
              <div style={{ padding: "10px 12px", borderRadius: 10, background: "#fff" }}>
                <div style={{ fontSize: 10, color: "#666", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>Firma activa</div>
                <img src={profile.signatureUrl} alt="Firma actual" style={{ height: 44, display: "block" }} />
              </div>
            )}

            {myPendingRequest && !isJefe && (
              <div style={{ padding: "8px 12px", borderRadius: 9, background: "rgba(255,179,71,0.08)", border: "1px solid rgba(255,179,71,0.25)", fontSize: 12, color: "#ffb347" }}>
                ⏳ Ya tienes un cambio de firma pendiente de autorización del jefe.
              </div>
            )}

            <SignaturePad label={hasSignature ? "Capturar nueva firma" : "Captura tu firma"} onChange={setDraft} />

            <button onClick={saveSignature} disabled={!draft || saving}
              style={{ padding: "10px", borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: (!draft || saving) ? "not-allowed" : "pointer",
                background: "linear-gradient(135deg,#1D9E75,#0F6E56)", border: "none", color: "#fff", opacity: (!draft || saving) ? 0.5 : 1 }}>
              {saving ? "Guardando…" : isJefe ? "✓ Guardar firma" : !hasSignature ? "✓ Guardar mi firma" : "✓ Solicitar cambio de firma"}
            </button>
            {!isJefe && hasSignature && (
              <div style={{ fontSize: 11, color: "#666", textAlign: "center", marginTop: -8 }}>
                Como ya tienes firma registrada, este cambio queda pendiente de autorización del jefe.
              </div>
            )}

            {isJefe && (
              <div style={{ marginTop: 4, paddingTop: 14, borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                <div style={{ fontSize: 12, color: "#888", fontWeight: 600, marginBottom: 8 }}>
                  Solicitudes de cambio de firma pendientes {pending.length > 0 && `(${pending.length})`}
                </div>
                {loadingPending ? (
                  <div style={{ fontSize: 12, color: "#555" }}>Cargando…</div>
                ) : pending.length === 0 ? (
                  <div style={{ fontSize: 12, color: "#444" }}>No hay solicitudes pendientes.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {pending.map(req => (
                      <div key={req.id} style={{ padding: "8px 10px", borderRadius: 9, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                        <div style={{ fontSize: 12, color: "#f0f0f0", fontWeight: 600, marginBottom: 6 }}>{req.name}</div>
                        <div style={{ background: "#fff", borderRadius: 6, padding: 6, marginBottom: 6, display: "inline-block" }}>
                          <img src={req.newSignatureUrl} alt="Nueva firma" style={{ height: 36, display: "block" }} />
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => resolveRequest(req, true)} disabled={saving}
                            style={{ flex: 1, padding: "6px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(0,212,170,0.12)", border: "1px solid rgba(0,212,170,0.3)", color: "#00d4aa" }}>
                            ✓ Aprobar
                          </button>
                          <button onClick={() => resolveRequest(req, false)} disabled={saving}
                            style={{ flex: 1, padding: "6px", borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: "pointer", background: "rgba(255,107,107,0.1)", border: "1px solid rgba(255,107,107,0.25)", color: "#ff6b6b" }}>
                            ✕ Rechazar
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button onClick={() => setOpen(false)} disabled={saving}
              style={{ padding: "8px", borderRadius: 9, fontSize: 12, cursor: "pointer", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#666" }}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </>
  );
}
