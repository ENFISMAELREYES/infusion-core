// Protocolos de investigación clínica dados de alta -- cada uno se
// identifica por su código real (el que usa el patrocinador/CRO), nunca
// por un nombre interno. Se comparte entre Protocolos.jsx (captura de
// muestras/IM) e Insumos.jsx (sesiones de infusión/hidratación que
// correspondan a un protocolo, detectadas por su "Régimen de atención"),
// para que ambas pantallas usen siempre los mismos códigos y el mismo
// almacén de Inventario por protocolo. Para agregar el siguiente (ej. el
// de infusión que viene en camino) basta con sumar una línea aquí.
export const PROTOCOLOS = [
  { code: "WO46063", label: "WO46063" },
];

// Si el "Régimen de atención" de una sesión contiene el código de un
// protocolo dado de alta, el material/medicamento de esa sesión se
// descuenta del almacén de ese protocolo en vez del almacén normal del
// centro -- sin necesitar un campo nuevo en NuevaSession.
export function protocoloWarehouseFor(regimen) {
  const up = (regimen || "").toUpperCase();
  const match = PROTOCOLOS.find(p => up.includes(p.code));
  return match ? `PROTOCOLO_${match.code}` : null;
}
