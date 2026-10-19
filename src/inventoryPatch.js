import { FIRESTORE_BASE_URL } from "./config";

function toFV(val) {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (val === null || val === undefined) return { nullValue: null };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFV) } };
  if (typeof val === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(val).map(([k, v]) => [k, toFV(v)])) } };
  return { stringValue: String(val) };
}

// Escribe un documento de inventory/{docId} sin arriesgar los campos que la
// acción que llama no tiene por qué tocar (minStock, maxStock, category,
// unit...). El bug recurrente de este proyecto era "leer todo el documento,
// cambiar un campo, reescribir todo el documento": si otra pestaña/usuario
// cambió el mínimo o máximo DESPUÉS de que esta pantalla cargó sus datos,
// un PATCH sin updateMask pisa ese cambio con el valor viejo que traía
// cargado, aunque la acción (una entrada, una salida...) no tuviera nada
// que ver con mínimos y máximos. Con updateMask, solo se envían -- y por lo
// tanto solo se pueden pisar -- los campos que de verdad cambiaron.
//
// `existing`: el documento ya cargado en memoria (o null/undefined si es la
//   primera vez que se toca este artículo en este almacén).
// `changedFields`: los campos que esta acción en verdad modifica, ej.
//   { currentStock: 10, lastUpdated: "..." }.
// `createExtras`: campos adicionales SOLO para cuando el documento no existe
//   todavía (item, warehouse, category, unit) -- en ese caso no hay nada
//   que pisar, así que sí se manda completo, con minStock/maxStock en 0.
export async function patchInventoryDoc(token, docId, existing, changedFields, createExtras = {}) {
  if (existing) {
    const mask = Object.keys(changedFields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
    return fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}?${mask}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ fields: Object.fromEntries(Object.entries(changedFields).map(([k, v]) => [k, toFV(v)])) }),
    });
  }
  const full = { minStock: 0, maxStock: 0, lastCost: 0, avgCost: 0, totalReceived: 0, ...createExtras, ...changedFields };
  return fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(full).map(([k, v]) => [k, toFV(v)])) }),
  });
}
