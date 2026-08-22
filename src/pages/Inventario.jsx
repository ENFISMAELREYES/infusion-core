 import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { PROJECT_ID, FIRESTORE_BASE_URL, IS_TEST_ENV } from "../config";
import { MASTER_CATALOG } from "../data/materialCatalog";

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

async function fetchCollection(token, collectionId, limit = 1000) {
  const res = await fetch(`${FIRESTORE_BASE_URL}:runQuery`, {
    method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit } }),
  });
  const data = await res.json();
  if (!Array.isArray(data)) {
    console.error(`Error al leer "${collectionId}":`, data);
    return [];
  }
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

// El almacén ahora se identifica por centro real: CITIO, CIPI_PED, CIPI_PRO
// (CIPI se dividió en dos almacenes separados por variante).
const WAREHOUSES = [
  { key: "CITIO", label: "CITIO" },
  { key: "CIPI_PRO", label: "CIPI PRO" },
  { key: "CIPI_PED", label: "CIPI PED" },
];
// Inventario general de la farmacia (QualMedical) -- todo el medicamento
// pertenece a esta farmacia antes de asignarse a un centro. Solo el jefe lo
// ve; para enfermería el flujo se ve exactamente igual que hasta ahora.
const QUAL_WAREHOUSES = [
  { key: "QUAL_CITIO", label: "Qual · CITIO" },
  { key: "QUAL_CIPI", label: "Qual · CIPI" },
];
// A qué almacén de Qual corresponde cada almacén de centro (CIPI PRO y PED
// comparten el mismo fondo de Qual, aunque en el centro estén separados).
const QUAL_FOR_WAREHOUSE = { CITIO: "QUAL_CITIO", CIPI_PRO: "QUAL_CIPI", CIPI_PED: "QUAL_CIPI" };
// Categorías de MASTER_CATALOG que se consideran "medicamento" para efectos
// del descuento automático de Inventario Qual (insumos/soluciones no aplican).
const MED_CATEGORIES = ["Medicamentos", "Oncológicos", "Inmunoterapia"];

function inventoryDocId(warehouse, item) {
  return `${warehouse}_${item}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 200);
}

function warehouseLabel(key) {
  return [...WAREHOUSES, ...QUAL_WAREHOUSES].find(w => w.key === key)?.label || key;
}

// Regla de reorden: mínimo y máximo se capturan directo en piezas (no por
// paquete). En cuanto la existencia baja de "mínimo", se sugiere comprar el
// lote fijo (máximo - mínimo) -- SALVO que la existencia haya caído tanto
// (ej. llegó a 0) que ese lote fijo ni siquiera alcance a cubrir el mínimo;
// en ese caso se sugiere al menos lo necesario para llegar al mínimo.
function reorderInfo(item) {
  const min = item.minStock ?? 0;
  const max = item.maxStock ?? 0;
  if (!max || max <= min) return { min, suggestQty: 0 };
  if (item.currentStock >= min) return { min, suggestQty: 0 };
  const suggestQty = Math.max(max - min, min - item.currentStock);
  return { min, suggestQty };
}

export default function Inventario() {
  const { user, profile } = useAuth();
  const isJefe = profile?.role === "jefe";
  // Solo Paola Vargas puede ver ambos centros siendo enfermera (incluyendo
  // Qual); el resto solo ve el inventario de su propio centro asignado.
  const canSeeAllCenters = isJefe || profile?.name === "Paola Vargas";
  // Firma a distancia en solicitudes de compra: a diferencia del material
  // por paciente (que solo pasa por el checkup de Paola), una solicitud de
  // compra siempre lleva la cadena completa Paola (VALIDA) -> jefe
  // (AUTORIZA), sea de medicamento o de insumo -- es dinero/reabasto, no
  // solo dispensar lo que ya hay.
  const canValidate = isJefe || profile?.name === "Paola Vargas";
  const canAuthorize = isJefe;
  const allowedWarehouses = canSeeAllCenters ? null : (profile?.center === "CIPI" ? ["CIPI_PRO","CIPI_PED"] : ["CITIO"]);
  const [tab, setTab] = useState("existencias"); // "existencias" | "movimientos"
  const [warehouse, setWarehouse] = useState(() => canSeeAllCenters ? "CITIO" : (allowedWarehouses?.[0] || "CITIO"));
  useEffect(() => {
    if (allowedWarehouses && !allowedWarehouses.includes(warehouse)) {
      setWarehouse(allowedWarehouses[0]);
    }
  }, [profile]);
  const [token, setToken] = useState("");
  const [inventory, setInventory] = useState([]);
  const [events, setEvents] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedEvent, setExpandedEvent] = useState(null);
  const [expandedPO, setExpandedPO] = useState(null);
  const [savingPOAction, setSavingPOAction] = useState(null); // id de la solicitud que se está guardando, o null

  const [showMoveModal, setShowMoveModal] = useState(null); // "entrada" | "salida" | null
  const [moveList, setMoveList] = useState([]); // [{item, qty}] -- varios artículos por movimiento
  const [moveSearch, setMoveSearch] = useState("");
  const [moveQty, setMoveQty] = useState("1");
  const [moveReason, setMoveReason] = useState("");
  const [invoiceFolio, setInvoiceFolio] = useState(""); // folio fiscal opcional, para relacionar con una factura
  const [transferTo, setTransferTo] = useState(""); // almacén destino, solo para transferencias
  const [purchaseConcept, setPurchaseConcept] = useState(""); // concepto manual para solicitud de compra
  const [saving, setSaving] = useState(false);
  const [xmlReview, setXmlReview] = useState(null); // [{descripcion, cantidad, matchedItem}] mientras se revisa antes de agregar
  const [xmlReceptor, setXmlReceptor] = useState(""); // nombre del receptor en la factura, para confirmar que corresponde al almacén

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [inv, ev, po] = await Promise.all([
        fetchCollection(t, "inventory"),
        fetchCollection(t, "inventory_events"),
        fetchCollection(t, "purchase_orders"),
      ]);
      setInventory(inv);
      setEvents(ev.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
      setPurchaseOrders(po.sort((a, b) => (b.requestedAt || "").localeCompare(a.requestedAt || "")));
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  };

  useEffect(() => { load(); }, [user]);
  useEffect(() => { if (!canSeeAllCenters && warehouse.startsWith("QUAL")) setWarehouse("CITIO"); }, [canSeeAllCenters, warehouse]);

  const warehouseInventory = inventory.filter(i => i.warehouse === warehouse);
  const filteredInventory = search.trim()
    ? warehouseInventory.filter(i => i.item.toUpperCase().includes(search.toUpperCase()))
    : warehouseInventory;
  const lowStock = warehouseInventory.filter(i => i.currentStock < (i.minStock ?? 0));
  const suggestedReorders = warehouseInventory.filter(i => reorderInfo(i).suggestQty > 0);

  const addToMoveList = (item, cost) => {
    const qty = parseInt(moveQty) || 1;
    setMoveList(prev => {
      const existing = prev.find(x => x.item === item);
      if (existing) return prev.map(x => x.item === item ? { ...x, qty: x.qty + qty } : x);
      return [...prev, { item, qty, cost: cost || undefined }];
    });
    setMoveSearch(""); setMoveQty("1");
  };
  const removeFromMoveList = (item) => setMoveList(prev => prev.filter(x => x.item !== item));
  const setMoveListQty = (item, qty) => setMoveList(prev => prev.map(x => x.item === item ? { ...x, qty: Math.max(0, qty) } : x));

  // Busca en el catálogo el artículo que mejor coincida con la descripción
  // que trae la factura (nunca son idénticas letra por letra).
  const suggestCatalogMatch = (descripcion) => {
    const up = (descripcion || "").toUpperCase().trim();
    if (!up) return "";
    const exact = MASTER_CATALOG.find(c => c.item.toUpperCase() === up);
    if (exact) return exact.item;
    const contains = MASTER_CATALOG.find(c => up.includes(c.item.toUpperCase()) || c.item.toUpperCase().includes(up));
    if (contains) return contains.item;
    // Coincidencia por palabras compartidas (al menos 2 palabras en común)
    const upWords = new Set(up.split(/\s+/).filter(w => w.length > 2));
    let best = null, bestScore = 0;
    MASTER_CATALOG.forEach(c => {
      const cWords = c.item.toUpperCase().split(/\s+/);
      const score = cWords.filter(w => upWords.has(w)).length;
      if (score > bestScore) { bestScore = score; best = c.item; }
    });
    return bestScore >= 2 ? best : "";
  };

  const handleXmlFile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(text, "text/xml");
      if (xmlDoc.querySelector("parsererror")) throw new Error("El archivo no es un XML válido.");

      let conceptos = xmlDoc.getElementsByTagName("cfdi:Concepto");
      if (conceptos.length === 0) conceptos = xmlDoc.getElementsByTagName("Concepto");
      if (conceptos.length === 0) throw new Error("No se encontraron conceptos en la factura -- ¿es un CFDI válido?");

      const review = Array.from(conceptos).map(c => {
        const descripcion = c.getAttribute("Descripcion") || "";
        const cantidad = Math.round(parseFloat(c.getAttribute("Cantidad")) || 1);
        const valorUnitario = parseFloat(c.getAttribute("ValorUnitario")) || 0;
        const subtotal = parseFloat(c.getAttribute("Importe")) || (valorUnitario * cantidad);

        // Sumar los impuestos trasladados (IVA, etc.) de ESTE concepto en
        // particular, para que el costo capturado sea el real (con impuesto
        // incluido), no solo el valor unitario antes de impuestos.
        let traslados = c.getElementsByTagName("cfdi:Traslado");
        if (traslados.length === 0) traslados = c.getElementsByTagName("Traslado");
        const impuesto = Array.from(traslados).reduce((acc, t) => acc + (parseFloat(t.getAttribute("Importe")) || 0), 0);
        const totalConImpuesto = subtotal + impuesto;
        const valorUnitarioConImpuesto = cantidad > 0 ? totalConImpuesto / cantidad : valorUnitario;

        return { descripcion, cantidad, valorUnitario: valorUnitarioConImpuesto, matchedItem: suggestCatalogMatch(descripcion) };
      });
      setXmlReview(review);

      let receptorNode = xmlDoc.getElementsByTagName("cfdi:Receptor")[0] || xmlDoc.getElementsByTagName("Receptor")[0];
      setXmlReceptor(receptorNode?.getAttribute("Nombre") || "");

      let uuidNode = xmlDoc.getElementsByTagName("tfd:TimbreFiscalDigital")[0] || xmlDoc.getElementsByTagName("TimbreFiscalDigital")[0];
      const uuid = uuidNode?.getAttribute("UUID") || "";
      if (uuid) {
        setInvoiceFolio(uuid);
        const yaCargada = events.some(ev => ev.invoiceFolio && ev.invoiceFolio.toUpperCase() === uuid.toUpperCase());
        if (yaCargada) {
          alert(`⚠️ Esta factura (folio ${uuid}) ya se había cargado antes. Revisa en "Movimientos" antes de continuar para no duplicarla.`);
        }
      }
    } catch (e) {
      alert("Error al leer la factura: " + e.message);
    }
  };

  // Carga pdf.js bajo demanda (por CDN, sin agregar dependencia nueva al
  // proyecto) para poder leer el texto de las cotizaciones en PDF.
  const loadPdfJs = () => new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    script.onerror = () => reject(new Error("No se pudo cargar el lector de PDF."));
    document.head.appendChild(script);
  });

  // Lee una cotización de QualMedical en PDF: extrae folio y cada renglón de
  // artículo (los que terminan en "cantidad $unitario $iva $total"), y
  // reutiliza la misma pantalla de revisión que usa el XML de facturas.
  const handlePdfFile = async (file) => {
    if (!file) return;
    try {
      const pdfjsLib = await loadPdfJs();
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

      // Todo el texto seguido, sin intentar reconstruir "renglones" por
      // posición -- el PDF puede desalinear celdas (ej. una columna que
      // envuelve a 2 líneas), lo que rompía la lectura por línea y perdía el
      // nombre del producto. En vez de eso, se usa el patrón de precios al
      // final de cada renglón como ancla, y todo lo que hay ENTRE dos anclas
      // es la descripción de ese artículo -- funciona sin importar cómo
      // quedó posicionado el texto.
      let fullText = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(" ") + " ";
      }

      const folioMatch = fullText.match(/FOLIO:\s*(\S+)/i);
      const folio = folioMatch ? folioMatch[1] : "";

      const MESES = "ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic";
      const cleanDescription = (desc) => {
        let d = desc;
        // Encabezados de columna y de sección que pueden quedar pegados
        // antes de la descripción real (ej. "INSUMOS CLORURO DE SODIO...").
        d = d.replace(/\b(DESCRIPCION|UNIDAD|LOTE|CAD\.?|CANT\.?|PRECIO\s+UNITARIO|IVA|PRECIO|INSUMOS|MEDICAMENTOS|SOLUCIONES)\b/gi, " ");
        // Lote (cualquier token) + mes-año de caducidad, ej. "M2510429 nov-27"
        d = d.replace(new RegExp(`\\s+\\S+\\s+(${MESES})-\\d{2}\\s*$`, "i"), "");
        d = d.replace(/\s+-\s*$/, "");
        d = d.replace(/^[\s.]+/, ""); // puntos/espacios sueltos al inicio, residuo de encabezados removidos
        return d.replace(/\s+/g, " ").trim();
      };

      // Ancla: cantidad seguida de 3 importes con $ (unitario, IVA, precio).
      const anchorRegex = /(\d+)\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})/g;
      const review = [];
      let lastEnd = 0;
      let m;
      while ((m = anchorRegex.exec(fullText)) !== null) {
        const descRaw = cleanDescription(fullText.slice(lastEnd, m.index));
        lastEnd = anchorRegex.lastIndex;
        const cantidad = parseInt(m[1]) || 1;
        const precioTotal = parseFloat(m[4].replace(/,/g, ""));
        const valorUnitario = cantidad > 0 ? precioTotal / cantidad : parseFloat(m[2].replace(/,/g, ""));
        if (!descRaw || /^(SUB\s?TOTAL|IMPUESTOS|TOTAL)$/i.test(descRaw)) continue;
        review.push({ descripcion: descRaw, cantidad, valorUnitario, matchedItem: suggestCatalogMatch(descRaw) });
      }
      if (review.length === 0) throw new Error("No se encontraron artículos reconocibles en el PDF.");
      setXmlReview(review);

      if (folio) {
        setInvoiceFolio(folio);
        const yaCargada = events.some(ev => ev.invoiceFolio && ev.invoiceFolio.toUpperCase() === folio.toUpperCase());
        if (yaCargada) {
          alert(`⚠️ Esta cotización (folio ${folio}) ya se había cargado antes. Revisa en "Movimientos" antes de continuar para no duplicarla.`);
        }
      }
    } catch (e) {
      alert("Error al leer el PDF: " + e.message);
    }
  };

  const confirmXmlReview = () => {
    const unmatched = xmlReview.filter(r => !r.matchedItem);
    if (unmatched.length > 0) {
      if (!confirm(`${unmatched.length} artículo(s) de la factura no tienen un emparejamiento elegido y NO se agregarán. ¿Continuar de todas formas?`)) return;
    }
    setMoveList(prev => {
      const map = new Map(prev.map(x => [x.item, { qty: x.qty, cost: x.cost }]));
      xmlReview.filter(r => r.matchedItem).forEach(r => {
        const existing = map.get(r.matchedItem);
        map.set(r.matchedItem, { qty: (existing?.qty || 0) + r.cantidad, cost: r.valorUnitario || existing?.cost });
      });
      return Array.from(map, ([item, v]) => ({ item, qty: v.qty, cost: v.cost }));
    });
    setXmlReview(null);
  };

  // Anula un movimiento: nunca se borra el registro original (por trazabilidad),
  // en vez de eso se crea un movimiento contrario que revierte exactamente la
  // misma cantidad de cada artículo, y se ajustan las existencias reales.
  // Pide el motivo de la anulación, obligatorio.
  const voidEvent = async (ev) => {
    const reason = prompt(`Motivo de la eliminación de este movimiento (${ev.type === "entrada" ? "entrada" : "salida"} de ${(ev.items||[]).length} artículo(s)):`);
    if (reason === null) return; // canceló
    if (!reason.trim()) { alert("El motivo es obligatorio."); return; }
    setSaving(true);
    try {
      const checkOk = async (res, label) => {
        if (!res.ok) { let msg=`Error ${res.status}`; try{const b=await res.json(); msg=b?.error?.message||msg;}catch{} throw new Error(`${label}: ${msg}`); }
      };
      const reversedType = ev.type === "entrada" ? "salida" : "entrada";
      const evItems = Array.isArray(ev.items) ? ev.items : [];

      for (const { item, qty } of evItems) {
        const docId = inventoryDocId(ev.warehouse, item);
        const existing = inventory.find(i => i.id === docId);
        const currentStock = existing?.currentStock ?? 0;
        // Revertir: si el movimiento original fue entrada, se resta; si fue salida, se suma de vuelta.
        const newStock = ev.type === "entrada" ? currentStock - qty : currentStock + qty;
        const invRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: item }, warehouse: { stringValue: ev.warehouse },
            category: { stringValue: existing?.category || "" }, unit: { stringValue: existing?.unit || "PIEZA" },
            currentStock: toFV(newStock), minStock: toFV(existing?.minStock ?? 0),
            lastCost: toFV(existing?.lastCost ?? 0), avgCost: toFV(existing?.avgCost ?? 0), totalReceived: toFV(existing?.totalReceived ?? 0),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
        await checkOk(invRes, `Existencias de "${item}"`);
      }

      const evRes = await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          type: { stringValue: reversedType }, warehouse: { stringValue: ev.warehouse },
          items: toFV(evItems),
          reversalOf: { stringValue: ev.id },
          reason: { stringValue: `Anulación: ${reason.trim()}` },
          userEmail: { stringValue: profile?.email || user?.email || "" },
          createdAt: { stringValue: new Date().toISOString() },
        }}),
      });
      await checkOk(evRes, "Registro de la anulación");

      // Si este movimiento venía de "Dar de baja inventario" de una sesión
      // (tiene sessionId), esa sesión debe volver a quedar disponible para
      // dar de baja -- si no, se queda marcada como "ya dada de baja" sin
      // que el inventario realmente la refleje.
      if (ev.sessionId && ev.type === "salida") {
        const sessRes = await fetch(`${FIRESTORE_BASE_URL}/sessions/${ev.sessionId}?updateMask.fieldPaths=inventorySalidaDone&updateMask.fieldPaths=inventorySalidaAt`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            inventorySalidaDone: { booleanValue: false },
            inventorySalidaAt: { nullValue: null },
          }}),
        });
        // No detenemos todo el flujo si esto falla (la anulación del
        // inventario ya se hizo bien) -- solo avisamos aparte.
        if (!sessRes.ok) console.error("No se pudo reabrir la sesión ligada a este movimiento.");
      }

      load();
    } catch (e) {
      alert("Error al anular el movimiento: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  // Mueve artículos de un almacén a otro -- resta del origen, suma al
  // destino (llevándose también su costo), y deja un registro cruzado (una
  // salida en el origen, una entrada en el destino) para que se vea en las
  // dos pestañas de Movimientos correspondientes.
  const registerTransfer = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    if (!transferTo) { alert("Elige el almacén destino."); return; }
    if (transferTo === warehouse) { alert("El destino debe ser distinto al almacén actual."); return; }
    setSaving(true);
    try {
      const checkOk = async (res, label) => {
        if (!res.ok) { let msg=`Error ${res.status}`; try{const b=await res.json(); msg=b?.error?.message||msg;}catch{} throw new Error(`${label}: ${msg}`); }
      };

      for (const { item, qty } of moveList) {
        const catalogEntry = MASTER_CATALOG.find(c => c.item === item);

        // Restar del almacén origen
        const fromDocId = inventoryDocId(warehouse, item);
        const fromExisting = inventory.find(i => i.id === fromDocId);
        const fromStock = fromExisting?.currentStock ?? 0;
        const fromRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${fromDocId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: item }, warehouse: { stringValue: warehouse },
            category: { stringValue: catalogEntry?.category || fromExisting?.category || "" },
            unit: { stringValue: catalogEntry?.unit || fromExisting?.unit || "PIEZA" },
            currentStock: toFV(fromStock - qty), minStock: toFV(fromExisting?.minStock ?? 0),
            lastCost: toFV(fromExisting?.lastCost ?? 0), avgCost: toFV(fromExisting?.avgCost ?? 0), totalReceived: toFV(fromExisting?.totalReceived ?? 0),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
        await checkOk(fromRes, `Salida de "${item}" en ${warehouseLabel(warehouse)}`);

        // Sumar al almacén destino, llevándose el costo consigo (se pondera
        // igual que una entrada normal, usando el costo del origen).
        const toDocId = inventoryDocId(transferTo, item);
        const toExisting = inventory.find(i => i.id === toDocId);
        const toStock = toExisting?.currentStock ?? 0;
        const sourceCost = fromExisting?.lastCost || fromExisting?.avgCost || 0;
        const toTotalReceived = toExisting?.totalReceived ?? 0;
        const toAvgCost = toExisting?.avgCost ?? 0;
        const newTotalReceived = toTotalReceived + qty;
        const newAvgCost = sourceCost > 0
          ? ((toAvgCost * toTotalReceived) + (sourceCost * qty)) / (newTotalReceived || 1)
          : toAvgCost;
        const toRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${toDocId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: item }, warehouse: { stringValue: transferTo },
            category: { stringValue: catalogEntry?.category || toExisting?.category || "" },
            unit: { stringValue: catalogEntry?.unit || toExisting?.unit || "PIEZA" },
            currentStock: toFV(toStock + qty), minStock: toFV(toExisting?.minStock ?? 0),
            lastCost: toFV(sourceCost || toExisting?.lastCost || 0), avgCost: toFV(newAvgCost), totalReceived: toFV(newTotalReceived),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
        await checkOk(toRes, `Entrada de "${item}" en ${warehouseLabel(transferTo)}`);
      }

      const salidaRes = await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          type: { stringValue: "salida" }, warehouse: { stringValue: warehouse },
          items: toFV(moveList), reason: { stringValue: `Transferencia a ${warehouseLabel(transferTo)}` },
          userEmail: { stringValue: profile?.email || user?.email || "" },
          createdAt: { stringValue: new Date().toISOString() },
        }}),
      });
      await checkOk(salidaRes, "Registro de la salida por transferencia");

      const entradaRes = await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          type: { stringValue: "entrada" }, warehouse: { stringValue: transferTo },
          items: toFV(moveList), reason: { stringValue: `Transferencia desde ${warehouseLabel(warehouse)}` },
          userEmail: { stringValue: profile?.email || user?.email || "" },
          createdAt: { stringValue: new Date().toISOString() },
        }}),
      });
      await checkOk(entradaRes, "Registro de la entrada por transferencia");

      setShowMoveModal(null); setMoveList([]); setTransferTo("");
      load();
    } catch (e) {
      alert("Error al transferir: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  // Genera el PDF de solicitud de compra (no registra ningún movimiento de
  // inventario -- solo el documento para pedir a QualMedical; la entrada real
  // se registra aparte cuando llega la mercancía, igual que siempre) y deja
  // la solicitud guardada en purchase_orders para su seguimiento (pendiente
  // -> validada por Paola -> autorizada por el jefe -> recibida). Igual que
  // medicamentos, siempre lleva la cadena completa -- aquí no aplica la
  // excepción de "solo checkup de Paola" que sí tiene el material por
  // paciente, porque una compra siempre compromete dinero/reabasto.
  const generatePurchaseOrder = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    if (!purchaseConcept.trim()) { alert("Escribe el concepto de la solicitud."); return; }
    setSaving(true);
    try {
      const groups = { MEDICAMENTOS: [], SOLUCIONES: [], INSUMOS: [] };
      moveList.forEach(({ item, qty }) => {
        const cat = MASTER_CATALOG.find(c => c.item === item)?.category;
        if (MED_CATEGORIES.includes(cat)) groups.MEDICAMENTOS.push({ item, qty });
        else if (/CLORURO DE SODIO|GLUCOSA|HARTMANN/i.test(item)) groups.SOLUCIONES.push({ item, qty });
        else groups.INSUMOS.push({ item, qty });
      });
      const centerForPdf = warehouse.includes("CIPI") ? "CIPI" : "CITIO";
      const cipiVariantForPdf = warehouse === "QUAL_CIPI" || warehouse === "CIPI_PED" ? "PED" : "PRO";
      // Recién creada, nunca pudo haberse validado/autorizado antes -- igual
      // que un anexo nuevo, ambas firmas salen pendientes en este primer PDF.
      const signatures = [
        { label: "SOLICITA", name: profile?.name || "" },
        { label: "VALIDA", pending: true, pendingLabel: "PENDIENTE VALIDACIÓN" },
        { label: "AUTORIZA", pending: true, pendingLabel: "PENDIENTE AUTORIZACIÓN" },
        { label: "RECIBE" },
      ];
      const res = await fetch("/api/generate-material-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ center: centerForPdf, cipiVariant: cipiVariantForPdf, concepto: purchaseConcept, groups, signatures }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Error ${res.status}`); }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);

      const poRes = await fetch(`${FIRESTORE_BASE_URL}/purchase_orders`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: {
          warehouse: { stringValue: warehouse }, concepto: { stringValue: purchaseConcept },
          items: toFV(moveList.map(({ item, qty }) => ({ item, qty }))),
          status: { stringValue: "pendiente" },
          requestedBy: { stringValue: user?.uid || "" }, requestedByName: { stringValue: profile?.name || "" },
          requestedAt: { stringValue: new Date().toISOString() },
          validatedBy: { nullValue: null }, validatedByName: { nullValue: null }, validatedAt: { nullValue: null }, validationSignatureUrl: { nullValue: null },
          authorizedBy: { nullValue: null }, authorizedByName: { nullValue: null }, authorizedAt: { nullValue: null }, authorizationSignatureUrl: { nullValue: null },
        }}),
      });
      if (poRes.ok) {
        const doc = await poRes.json();
        setPurchaseOrders(prev => [parseDoc(doc), ...prev]);
      }
      // Si falla el guardado del rastreo, no se revierte el PDF ya generado
      // (ya se entregó/imprimió) -- solo se pierde el seguimiento en la
      // pestaña de solicitudes, que la persona puede volver a intentar.

      setShowMoveModal(null); setMoveList([]); setPurchaseConcept("");
    } catch (e) {
      alert("Error al generar la solicitud de compra: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const patchPurchaseOrder = async (id, changes, fieldPaths) => {
    setSavingPOAction(id);
    try {
      const mask = fieldPaths.map(k => `updateMask.fieldPaths=${k}`).join("&");
      const fields = Object.fromEntries(Object.entries(changes).map(([k,v]) => [k, toFV(v)]));
      const res = await fetch(`${FIRESTORE_BASE_URL}/purchase_orders/${id}?${mask}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      setPurchaseOrders(prev => prev.map(p => p.id === id ? { ...p, ...changes } : p));
    } catch (e) {
      alert("Error al guardar: " + e.message);
    } finally {
      setSavingPOAction(null);
    }
  };
  const validatePurchaseOrder = (id) => patchPurchaseOrder(id, {
    validatedBy: user?.uid || "", validatedByName: profile?.name || "",
    validatedAt: new Date().toISOString(), validationSignatureUrl: profile?.signatureUrl || null,
  }, ["validatedBy","validatedByName","validatedAt","validationSignatureUrl"]);
  const authorizePurchaseOrder = (id) => patchPurchaseOrder(id, {
    authorizedBy: user?.uid || "", authorizedByName: profile?.name || "",
    authorizedAt: new Date().toISOString(), authorizationSignatureUrl: profile?.signatureUrl || null,
  }, ["authorizedBy","authorizedByName","authorizedAt","authorizationSignatureUrl"]);
  const markPurchaseOrderReceived = (id) => patchPurchaseOrder(id, {
    status: "recibida", receivedAt: new Date().toISOString(),
  }, ["status","receivedAt"]);

  const registerMovement = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    setSaving(true);
    try {
      const type = showMoveModal; // "entrada" | "salida"
      const checkOk = async (res, label) => {
        if (!res.ok) {
          let msg = `Error ${res.status}`;
          try { const body = await res.json(); msg = body?.error?.message || msg; } catch {}
          throw new Error(`${label}: ${msg}`);
        }
      };

      // Actualizar existencias de cada artículo -- ahora se PERMITE negativo,
      // para reflejar que ya se usó algo que aún no se ha registrado como
      // recibido (ej. hay un ingreso pendiente de factura).
      for (const { item, qty, cost } of moveList) {
        const docId = inventoryDocId(warehouse, item);
        const existing = inventory.find(i => i.id === docId);
        const currentStock = existing?.currentStock ?? 0;
        const minStock = existing?.minStock ?? 0;
        const catalogEntry = MASTER_CATALOG.find(c => c.item === item);
        const newStock = type === "entrada" ? currentStock + qty : currentStock - qty;

        // Costo: solo se actualiza en entradas y solo si se capturó un costo.
        // El promedio es ponderado por cantidad recibida a lo largo del tiempo.
        let lastCost = existing?.lastCost ?? 0;
        let avgCost = existing?.avgCost ?? 0;
        let totalReceived = existing?.totalReceived ?? 0;
        if (type === "entrada" && cost > 0) {
          const newTotalReceived = totalReceived + qty;
          avgCost = newTotalReceived > 0 ? ((avgCost * totalReceived) + (cost * qty)) / newTotalReceived : cost;
          totalReceived = newTotalReceived;
          lastCost = cost;
        }

        const invRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: item }, warehouse: { stringValue: warehouse },
            category: { stringValue: catalogEntry?.category || existing?.category || "" },
            unit: { stringValue: catalogEntry?.unit || existing?.unit || "PIEZA" },
            currentStock: toFV(newStock), minStock: toFV(minStock),
            lastCost: toFV(lastCost), avgCost: toFV(avgCost), totalReceived: toFV(totalReceived),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
        await checkOk(invRes, `Existencias de "${item}"`);
      }

      // Un solo evento con todos los artículos juntos (no un renglón por
      // artículo), para poder resumir por movimiento en vez de por producto.
      const eventFields = {
        type: { stringValue: type },
        warehouse: { stringValue: warehouse },
        items: toFV(moveList),
        reason: { stringValue: moveReason || "" },
        invoiceFolio: { stringValue: invoiceFolio || "" },
        userEmail: { stringValue: profile?.email || user?.email || "" },
        createdAt: { stringValue: new Date().toISOString() },
      };
      const evRes = await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: eventFields }),
      });
      await checkOk(evRes, "Registro del evento de movimiento");

      // Si es una entrada de MEDICAMENTO a un almacén de centro (no a Qual
      // mismo), es en realidad un traslado desde la farmacia -- se descuenta
      // solo del Qual correspondiente (CITIO o CIPI, este último combinado
      // entre PRO y PED), sin que enfermería tenga que hacer nada aparte.
      // Insumos/soluciones generales no vienen de Qual, no aplica.
      const qualWarehouse = QUAL_FOR_WAREHOUSE[warehouse];
      if (type === "entrada" && qualWarehouse) {
        const medItems = moveList.filter(({ item }) => {
          const cat = MASTER_CATALOG.find(c => c.item === item)?.category;
          return MED_CATEGORIES.includes(cat);
        });
        if (medItems.length > 0) {
          for (const { item, qty } of medItems) {
            const qualDocId = inventoryDocId(qualWarehouse, item);
            const qualExisting = inventory.find(i => i.id === qualDocId);
            const qualCurrentStock = qualExisting?.currentStock ?? 0;
            const catalogEntry = MASTER_CATALOG.find(c => c.item === item);
            const qualRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${qualDocId}`, {
              method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
              body: JSON.stringify({ fields: {
                item: { stringValue: item }, warehouse: { stringValue: qualWarehouse },
                category: { stringValue: catalogEntry?.category || qualExisting?.category || "" },
                unit: { stringValue: catalogEntry?.unit || qualExisting?.unit || "PIEZA" },
                currentStock: toFV(qualCurrentStock - qty), minStock: toFV(qualExisting?.minStock ?? 0),
                lastCost: toFV(qualExisting?.lastCost ?? 0), avgCost: toFV(qualExisting?.avgCost ?? 0), totalReceived: toFV(qualExisting?.totalReceived ?? 0),
                lastUpdated: { stringValue: new Date().toISOString() },
              }}),
            });
            await checkOk(qualRes, `Traslado desde ${warehouseLabel(qualWarehouse)} de "${item}"`);
          }
          await fetch(`${FIRESTORE_BASE_URL}/inventory_events`, {
            method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
            body: JSON.stringify({ fields: {
              type: { stringValue: "salida" }, warehouse: { stringValue: qualWarehouse },
              items: toFV(medItems),
              reason: { stringValue: `Traslado automático a ${warehouseLabel(warehouse)}` },
              userEmail: { stringValue: profile?.email || user?.email || "" },
              createdAt: { stringValue: new Date().toISOString() },
            }}),
          });
        }
      }

      setShowMoveModal(null); setMoveList([]); setMoveReason(""); setInvoiceFolio("");
      load();
    } catch (e) {
      alert("Error al registrar el movimiento: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const setMinStock = async (docId, newMin) => {
    try {
      await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}?updateMask.fieldPaths=minStock`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: { minStock: toFV(parseInt(newMin) || 0) } }),
      });
      setInventory(prev => prev.map(i => i.id === docId ? { ...i, minStock: parseInt(newMin) || 0 } : i));
    } catch (e) { console.error(e); }
  };

  // Tamaño del paquete de compra (ej. 100 piezas por caja de agujas). A
  // partir de esto se calculan solos el mínimo y la cantidad sugerida --
  // ya no hay que capturar el mínimo a mano para cada artículo.
  const setMaxStock = async (docId, newMax) => {
    try {
      const val = parseInt(newMax) || 0;
      await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}?updateMask.fieldPaths=maxStock`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ fields: { maxStock: toFV(val) } }),
      });
      setInventory(prev => prev.map(i => i.id === docId ? { ...i, maxStock: val } : i));
    } catch (e) { console.error(e); }
  };

  const inputStyle = { background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:9, padding:"8px 12px", color:"#f0f0f0", fontSize:13, outline:"none" };

  if (loading && !hasLoadedOnce) return <div style={{ padding:40, color:"#666", textAlign:"center" }}>Cargando…</div>;

  return (
    <div style={{ padding:"24px 28px", maxWidth:900, margin:"0 auto" }}>
      {IS_TEST_ENV && (
        <div style={{ marginBottom:16, padding:"8px 14px", borderRadius:9, background:"rgba(255,179,71,0.12)", border:"1px solid rgba(255,179,71,0.3)", color:"#ffb347", fontSize:12, fontWeight:600, textAlign:"center" }}>
          ⚠️ Estás en el entorno de PRUEBAS ({PROJECT_ID}) — estos datos no son reales
        </div>
      )}

      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontFamily:"'DM Serif Display', serif", fontSize:24, color:"#fff", marginBottom:4 }}>Inventario</h1>
        <p style={{ fontSize:13, color:"#555" }}>Existencias y movimientos de entrada/salida de material</p>
        {warehouse.startsWith("QUAL") && (
          <p style={{ fontSize:12, color:"#ffb347", marginTop:6 }}>
            📦 Stock general recibido de la farmacia QualMedical para {warehouse === "QUAL_CITIO" ? "CITIO" : "CIPI (PRO y PED juntos)"}, antes de asignarse al centro. Se descuenta solo cuando enfermería registra la entrada del medicamento en el centro correspondiente — no requiere ninguna acción aparte de ellas.
          </p>
        )}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        {[...WAREHOUSES.filter(w => !allowedWarehouses || allowedWarehouses.includes(w.key)), ...(canSeeAllCenters ? QUAL_WAREHOUSES : [])].map(w => (
          <button key={w.key} onClick={() => setWarehouse(w.key)} style={{
            padding:"6px 14px", borderRadius:99, fontSize:12, fontWeight:600, cursor:"pointer",
            background: warehouse===w.key ? (w.key.startsWith("QUAL") ? "rgba(255,179,71,0.12)" : "rgba(79,195,247,0.12)") : "rgba(255,255,255,0.04)",
            border: `1px solid ${warehouse===w.key ? (w.key.startsWith("QUAL") ? "rgba(255,179,71,0.3)" : "rgba(79,195,247,0.3)") : "rgba(255,255,255,0.08)"}`,
            color: warehouse===w.key ? (w.key.startsWith("QUAL") ? "#ffb347" : "#4fc3f7") : "#666",
          }}>{w.label}</button>
        ))}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:20, borderBottom:"1px solid rgba(255,255,255,0.07)" }}>
        {[["existencias","Existencias"],["movimientos","Movimientos"],["compras","🧾 Solicitudes de compra"],...(isJefe ? [["general","Vista general"]] : [])].map(([val,label]) => (
          <button key={val} onClick={() => setTab(val)} style={{
            padding:"10px 16px", fontSize:13, fontWeight:600, cursor:"pointer", background:"none", border:"none",
            borderBottom: tab===val ? "2px solid #00d4aa" : "2px solid transparent",
            color: tab===val ? "#00d4aa" : "#666",
          }}>{label}</button>
        ))}
      </div>

      {tab === "existencias" && (
        <div>
          <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            <input placeholder="Buscar artículo..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, flex:1, minWidth:200 }} />
            <button onClick={() => { setShowMoveModal("entrada"); setMoveList([]); setXmlReview(null); setXmlReceptor(""); setInvoiceFolio(""); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
              ↓ Registrar entrada
            </button>
            <button onClick={() => { setShowMoveModal("salida"); setMoveList([]); setXmlReview(null); setXmlReceptor(""); setInvoiceFolio(""); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
              ↑ Registrar salida
            </button>
            {warehouse.startsWith("QUAL") && (
              <button onClick={() => { setShowMoveModal("transferencia"); setMoveList([]); setTransferTo(warehouse === "QUAL_CITIO" ? "QUAL_CIPI" : "QUAL_CITIO"); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC" }}>
                🔄 Transferir a {warehouse === "QUAL_CITIO" ? "Qual CIPI" : "Qual CITIO"}
              </button>
            )}
            <button onClick={() => { setShowMoveModal("compra"); setMoveList([]); setPurchaseConcept(""); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.3)", color:"#ffb347" }}>
              🧾 Solicitud de compra
            </button>
            {suggestedReorders.length > 0 && (
              <button onClick={() => {
                  setShowMoveModal("compra");
                  setMoveList(suggestedReorders.map(i => ({ item: i.item, qty: reorderInfo(i).suggestQty })));
                  setPurchaseConcept(`Reabastecimiento sugerido ${new Date().toLocaleDateString("es-MX")}`);
                }}
                style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.3)", color:"#ff6b6b" }}>
                🛒 Solicitar sugeridos ({suggestedReorders.length})
              </button>
            )}
          </div>

          {lowStock.length > 0 && (
            <div style={{ marginBottom:16, padding:"10px 14px", borderRadius:10, background:"rgba(255,107,107,0.08)", border:"1px solid rgba(255,107,107,0.25)" }}>
              <div style={{ fontSize:12, color:"#ff6b6b", fontWeight:600, marginBottom:4 }}>⚠️ {lowStock.length} artículo{lowStock.length!==1?"s":""} en o bajo el mínimo</div>
              <div style={{ fontSize:11, color:"#ffb0b0" }}>{lowStock.map(i => i.item).join(", ")}</div>
            </div>
          )}

          {filteredInventory.length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin existencias registradas todavía en este almacén. Usa "Registrar entrada" para empezar a cargar inventario.
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
              {filteredInventory.sort((a,b) => a.item.localeCompare(b.item)).map(i => {
                const { min, suggestQty } = reorderInfo(i);
                const low = i.currentStock < min;
                const negative = i.currentStock < 0;
                return (
                  <div key={i.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 14px", borderRadius:10, background: negative ? "rgba(255,107,107,0.06)" : "rgba(255,255,255,0.03)", border:`1px solid ${negative ? "rgba(255,107,107,0.4)" : low ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.07)"}` }}>
                    <span style={{ flex:1, fontSize:13, color:"#f0f0f0" }}>{i.item}</span>
                    <span style={{ fontSize:10, color:"#555" }}>{i.category}</span>
                    {negative && (
                      <span title="Existencia negativa: ya se usó más de lo registrado como recibido -- probablemente hay un ingreso pendiente de capturar"
                        style={{ fontSize:10, color:"#ff6b6b", background:"rgba(255,107,107,0.12)", padding:"2px 8px", borderRadius:99, fontWeight:600 }}>
                        ⚠ ingreso pendiente
                      </span>
                    )}
                    {suggestQty > 0 && (
                      <span title={`Existencia en o bajo el mínimo (${min}) -- se sugiere comprar 1 paquete más`}
                        style={{ fontSize:10, color:"#ffb347", background:"rgba(255,179,71,0.12)", padding:"2px 8px", borderRadius:99, fontWeight:600, whiteSpace:"nowrap" }}>
                        🛒 comprar {suggestQty}
                      </span>
                    )}
                    <span style={{ fontSize:14, fontWeight:700, color: negative ? "#ff6b6b" : low ? "#ffb347" : "#00d4aa", fontFamily:"'IBM Plex Mono', monospace", minWidth:60, textAlign:"right", whiteSpace:"nowrap" }}>
                      {i.currentStock} {i.unit}{min > 0 && <span style={{ color:"#666", fontWeight:400 }}> (mín. {min})</span>}
                    </span>
                    {(i.lastCost > 0 || i.avgCost > 0) && (
                      <span style={{ fontSize:10, color:"#888", fontFamily:"'IBM Plex Mono', monospace", whiteSpace:"nowrap" }} title="Último costo / Costo promedio">
                        últ. ${(i.lastCost||0).toFixed(2)} · prom. ${(i.avgCost||0).toFixed(2)}
                      </span>
                    )}
                    {isJefe && (
                      <>
                        <input type="number" defaultValue={i.minStock ?? 0} placeholder="mín" title="Mínimo -- en cuanto la existencia baje de este número, se sugiere comprar"
                          onBlur={e => setMinStock(i.id, e.target.value)}
                          style={{ width:46, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"3px 6px", color:"#888", fontSize:11, outline:"none", textAlign:"center" }} />
                        <span style={{ color:"#444", fontSize:11 }}>/</span>
                        <input type="number" defaultValue={i.maxStock ?? ""} placeholder="máx" title="Máximo -- la sugerencia de compra es la diferencia entre máximo y mínimo"
                          onBlur={e => setMaxStock(i.id, e.target.value)}
                          style={{ width:46, background:"rgba(175,169,236,0.06)", border:"1px solid rgba(175,169,236,0.2)", borderRadius:6, padding:"3px 6px", color:"#AFA9EC", fontSize:11, outline:"none", textAlign:"center" }} />
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "movimientos" && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {events.filter(e => e.warehouse === warehouse).length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin movimientos registrados todavía en este almacén.
            </div>
          ) : events.filter(e => e.warehouse === warehouse).map(ev => {
            const isOpen = expandedEvent === ev.id;
            const evItems = Array.isArray(ev.items) ? ev.items : [];
            const itemCount = evItems.length;
            const isReversal = !!ev.reversalOf;
            const wasVoided = events.some(other => other.reversalOf === ev.id);
            return (
              <div key={ev.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden", opacity: wasVoided ? 0.5 : 1 }}>
                <div onClick={() => setExpandedEvent(isOpen ? null : ev.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99, background: ev.type==="entrada" ? "rgba(0,212,170,0.12)" : "rgba(255,107,107,0.1)", color: ev.type==="entrada" ? "#00d4aa" : "#ff6b6b" }}>
                    {ev.type==="entrada" ? "↓ Entrada" : "↑ Salida"}
                  </span>
                  <span style={{ fontSize:13, color:"#f0f0f0", textDecoration: wasVoided ? "line-through" : "none" }}>{itemCount} artículo{itemCount!==1?"s":""}</span>
                  {wasVoided && <span style={{ fontSize:10, color:"#ff6b6b", background:"rgba(255,107,107,0.1)", padding:"2px 8px", borderRadius:99, fontWeight:600 }}>ANULADO</span>}
                  {isReversal && <span style={{ fontSize:10, color:"#ffb347", background:"rgba(255,179,71,0.1)", padding:"2px 8px", borderRadius:99 }}>corrección</span>}
                  {ev.sessionPatientName && <span style={{ fontSize:12, color:"#4fc3f7" }}>👤 {ev.sessionPatientName}</span>}
                  {ev.invoiceFolio && <span style={{ fontSize:11, color:"#AFA9EC" }}>📄 {ev.invoiceFolio}</span>}
                  {ev.reason && <span style={{ fontSize:11, color:"#888" }}>{ev.reason}</span>}
                  <span style={{ marginLeft:"auto", fontSize:11, color:"#555" }}>{ev.createdAt ? new Date(ev.createdAt).toLocaleString("es-MX") : ""}</span>
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {evItems.map((it, i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:"#ccc", padding:"3px 0" }}>
                        <span>{it.item}</span><span style={{ color: ev.type==="entrada" ? "#00d4aa" : "#ff6b6b" }}>{it.qty}</span>
                      </div>
                    ))}
                    {/* Quién lo hizo: solo visible para el jefe */}
                    {isJefe && (
                      <div style={{ marginTop:8, paddingTop:8, borderTop:"1px solid rgba(255,255,255,0.06)", fontSize:11, color:"#666" }}>
                        Registrado por: {ev.userEmail || "—"}
                      </div>
                    )}
                    {!wasVoided && !isReversal && (
                      <button onClick={e => { e.stopPropagation(); voidEvent(ev); }} disabled={saving}
                        style={{ marginTop:8, alignSelf:"flex-start", padding:"5px 12px", borderRadius:7, fontSize:11, fontWeight:600, cursor: saving ? "wait" : "pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
                        🗑 Eliminar (revertir existencias)
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "compras" && (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {purchaseOrders.filter(po => po.warehouse === warehouse).length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin solicitudes de compra en este almacén.
            </div>
          ) : purchaseOrders.filter(po => po.warehouse === warehouse).map(po => {
            const isOpen = expandedPO === po.id;
            const poItems = Array.isArray(po.items) ? po.items : [];
            const received = po.status === "recibida";
            return (
              <div key={po.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden" }}>
                <div onClick={() => setExpandedPO(isOpen ? null : po.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ flex:1, fontSize:13, color:"#f0f0f0", fontWeight:600, minWidth:160 }}>{po.concepto}</span>
                  <span style={{ fontSize:11, color:"#666" }}>{poItems.length} artículo{poItems.length!==1?"s":""}</span>
                  <span style={{ fontSize:11, color:"#555" }}>{po.requestedByName || ""}{po.requestedAt ? " · " + new Date(po.requestedAt).toLocaleDateString("es-MX") : ""}</span>
                  <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99, background: received ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.05)", color: received ? "#00d4aa" : "#888" }}>
                    {received ? "✓ Recibida" : "⏳ Pendiente"}
                  </span>
                  <span title={po.authorizedBy ? `Autorizado por ${po.authorizedByName || ""}` : po.validatedBy ? `Validado por ${po.validatedByName || ""} — falta autorización del jefe` : "Pendiente del checkup de Paola"}
                    style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99,
                    background: po.authorizedBy ? "rgba(0,212,170,0.12)" : "rgba(255,179,71,0.1)",
                    color: po.authorizedBy ? "#00d4aa" : "#ffb347" }}>
                    {po.authorizedBy ? "✓ Autorizada" : po.validatedBy ? "◐ Validada" : "⏳ Sin validar"}
                  </span>
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {poItems.map((t,ti) => (
                      <div key={ti} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"3px 0" }}>
                        <span>{t.item}</span><span style={{ color:"#00d4aa" }}>{t.qty}</span>
                      </div>
                    ))}
                    <div style={{ display:"flex", gap:8, marginTop:8, flexWrap:"wrap" }}>
                      {canValidate && !po.validatedBy && (
                        <button onClick={e => { e.stopPropagation(); validatePurchaseOrder(po.id); }} disabled={savingPOAction === po.id}
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
                          {savingPOAction===po.id ? "Guardando…" : "✓ Validar (checkup)"}
                        </button>
                      )}
                      {canAuthorize && po.validatedBy && !po.authorizedBy && (
                        <button onClick={e => { e.stopPropagation(); authorizePurchaseOrder(po.id); }} disabled={savingPOAction === po.id}
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC" }}>
                          {savingPOAction===po.id ? "Guardando…" : "✓ Autorizar"}
                        </button>
                      )}
                      {!received && canValidate && (
                        <button onClick={e => { e.stopPropagation(); markPurchaseOrderReceived(po.id); }} disabled={savingPOAction === po.id}
                          title="Marcar que la mercancía ya llegó -- esto no registra la entrada al inventario, solo cierra el seguimiento de la solicitud (usa 'Registrar entrada' aparte para eso)"
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(0,212,170,0.1)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>
                          {savingPOAction===po.id ? "Guardando…" : "✓ Marcar recibida"}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "general" && isJefe && (() => {
        const centerKeys = ["CITIO","CIPI_PRO","CIPI_PED"];
        const byItem = {};
        inventory.filter(i => centerKeys.includes(i.warehouse) || i.warehouse === "QUAL_CITIO" || i.warehouse === "QUAL_CIPI").forEach(i => {
          if (!byItem[i.item]) byItem[i.item] = { item: i.item, unit: i.unit, category: i.category, CITIO:0, CIPI_PRO:0, CIPI_PED:0, QUAL_CITIO:0, QUAL_CIPI:0 };
          byItem[i.item][i.warehouse] = i.currentStock;
        });
        const allRows = Object.values(byItem).sort((a,b) => a.item.localeCompare(b.item));
        // Cloruro, glucosa y Hartmann están catalogados como "Medicamentos"
        // en el catálogo, pero funcionalmente son soluciones -- van con
        // material e insumos, igual que en el resto de la app (PDF, consolidado).
        const isSolution = (name) => /CLORURO DE SODIO|GLUCOSA|HARTMANN/i.test(name);
        // La categoría GUARDADA en el documento de inventario puede haber
        // quedado desactualizada (si el catálogo cambió después); se
        // reconsulta el catálogo actual por nombre para clasificar bien.
        const catalogByNameGeneral = {};
        MASTER_CATALOG.forEach(c => { catalogByNameGeneral[c.item.toUpperCase()] = c.category; });
        const currentCategory = (r) => catalogByNameGeneral[r.item.toUpperCase()] || r.category;
        const materialRows = allRows.filter(r => !MED_CATEGORIES.includes(currentCategory(r)) || isSolution(r.item));
        const medRows = allRows.filter(r => MED_CATEGORIES.includes(currentCategory(r)) && !isSolution(r.item));

        const Section = ({ title, rows }) => (
          <div style={{ marginBottom:24 }}>
            <div style={{ fontSize:12, color:"#00d4aa", fontWeight:600, marginBottom:8, textTransform:"uppercase", letterSpacing:1 }}>{title} ({rows.length})</div>
            {rows.length === 0 ? (
              <div style={{ color:"#444", fontSize:13, padding:20, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:12 }}>
                Sin artículos en esta categoría.
              </div>
            ) : (
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                  <thead>
                    <tr style={{ borderBottom:"1px solid rgba(255,255,255,0.1)" }}>
                      <th style={{ textAlign:"left", padding:"8px 10px", color:"#666", fontWeight:600 }}>Artículo</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#4fc3f7", fontWeight:600 }}>CITIO</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#AFA9EC", fontWeight:600 }}>CIPI PRO</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#ffb347", fontWeight:600 }}>CIPI PED</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#00d4aa", fontWeight:600, borderRight:"1px solid rgba(255,255,255,0.1)" }}>Total</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#4fc3f7", fontWeight:600 }}>Qual CITIO</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#AFA9EC", fontWeight:600 }}>Qual CIPI</th>
                      <th style={{ textAlign:"right", padding:"8px 10px", color:"#00d4aa", fontWeight:600 }}>Total Qual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r,i) => {
                      const total = r.CITIO + r.CIPI_PRO + r.CIPI_PED;
                      const totalQual = r.QUAL_CITIO + r.QUAL_CIPI;
                      return (
                        <tr key={i} style={{ borderBottom:"1px solid rgba(255,255,255,0.05)" }}>
                          <td style={{ padding:"7px 10px", color:"#f0f0f0" }}>{r.item}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color: r.CITIO<0 ? "#ff6b6b" : "#ccc", fontFamily:"'IBM Plex Mono', monospace" }}>{r.CITIO}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color: r.CIPI_PRO<0 ? "#ff6b6b" : "#ccc", fontFamily:"'IBM Plex Mono', monospace" }}>{r.CIPI_PRO}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color: r.CIPI_PED<0 ? "#ff6b6b" : "#ccc", fontFamily:"'IBM Plex Mono', monospace" }}>{r.CIPI_PED}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color:"#00d4aa", fontWeight:700, fontFamily:"'IBM Plex Mono', monospace", borderRight:"1px solid rgba(255,255,255,0.06)" }}>{total} {r.unit}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color: r.QUAL_CITIO<0 ? "#ff6b6b" : "#999", fontFamily:"'IBM Plex Mono', monospace" }}>{r.QUAL_CITIO}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color: r.QUAL_CIPI<0 ? "#ff6b6b" : "#999", fontFamily:"'IBM Plex Mono', monospace" }}>{r.QUAL_CIPI}</td>
                          <td style={{ padding:"7px 10px", textAlign:"right", color:"#00d4aa", fontWeight:700, fontFamily:"'IBM Plex Mono', monospace" }}>{totalQual} {r.unit}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );

        return (
          <div>
            <div style={{ fontSize:12, color:"#555", marginBottom:16 }}>{allRows.length} artículo{allRows.length!==1?"s":""} en total · almacenes de centro (izquierda) y Qual, stock de farmacia (derecha)</div>
            <Section title="📦 Material e insumos" rows={materialRows} />
            <Section title="💊 Medicamentos" rows={medRows} />
          </div>
        );
      })()}

      {showMoveModal && (
        <div onClick={() => !saving && (setShowMoveModal(null), setXmlReview(null), setXmlReceptor(""))}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:460, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>
              {showMoveModal === "entrada" ? "↓ Registrar entrada" : showMoveModal === "salida" ? "↑ Registrar salida" : showMoveModal === "compra" ? "🧾 Solicitud de compra" : "🔄 Transferir"} — {warehouseLabel(warehouse)}
            </div>

            {showMoveModal === "compra" && (
              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Concepto de la solicitud</label>
                <input placeholder="Ej. Reabastecimiento de insumos generales" value={purchaseConcept} onChange={e => setPurchaseConcept(e.target.value)} style={inputStyle} />
                <div style={{ fontSize:10, color:"#666", marginTop:4 }}>Este documento solo genera el PDF para pedirlo a QualMedical -- no descuenta ni suma nada al inventario. La entrada real se registra aparte cuando llegue la mercancía.</div>
              </div>
            )}

            {showMoveModal === "transferencia" && (
              <div style={{ padding:"8px 12px", borderRadius:9, background:"rgba(175,169,236,0.08)", border:"1px solid rgba(175,169,236,0.25)", fontSize:12, color:"#AFA9EC" }}>
                Destino: <strong>{warehouseLabel(transferTo)}</strong>
              </div>
            )}

            {showMoveModal === "entrada" && !xmlReview && (
              <div style={{ display:"flex", gap:8 }}>
                <label style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px dashed rgba(175,169,236,0.35)", color:"#AFA9EC" }}>
                  📄 Factura (XML)
                  <input type="file" accept=".xml" style={{ display:"none" }} onChange={e => handleXmlFile(e.target.files?.[0])} />
                </label>
                <label style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px dashed rgba(255,179,71,0.35)", color:"#ffb347" }}>
                  📑 Cotización (PDF)
                  <input type="file" accept=".pdf" style={{ display:"none" }} onChange={e => handlePdfFile(e.target.files?.[0])} />
                </label>
              </div>
            )}

            {xmlReview && (
              <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
                <div style={{ padding:"10px 12px", borderRadius:9, background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.35)" }}>
                  <div style={{ fontSize:11, color:"#ffb347", fontWeight:600, marginBottom:2 }}>⚠️ Confirma que coincide antes de continuar:</div>
                  <div style={{ fontSize:12, color:"#ccc" }}>
                    Receptor en la factura: <strong style={{ color:"#fff" }}>{xmlReceptor || "(no se encontró el nombre)"}</strong>
                  </div>
                  <div style={{ fontSize:12, color:"#ccc", marginTop:2 }}>
                    Almacén seleccionado: <strong style={{ color:"#ffb347" }}>{warehouseLabel(warehouse)}</strong>
                  </div>
                  <div style={{ fontSize:10, color:"#888", marginTop:4 }}>Si no corresponde, cierra este cuadro y cambia de pestaña de almacén arriba antes de volver a intentar.</div>
                </div>
                <div style={{ fontSize:12, color:"#AFA9EC", fontWeight:600 }}>Revisa el emparejamiento antes de agregar ({xmlReview.length} conceptos)</div>
                <div style={{ display:"flex", flexDirection:"column", gap:6, maxHeight:280, overflowY:"auto" }}>
                  {xmlReview.map((r, i) => (
                    <div key={i} style={{ padding:"8px 10px", borderRadius:8, background: r.matchedItem ? "rgba(255,255,255,0.03)" : "rgba(255,107,107,0.06)", border:`1px solid ${r.matchedItem ? "rgba(255,255,255,0.07)" : "rgba(255,107,107,0.25)"}` }}>
                      <div style={{ fontSize:11, color:"#666", marginBottom:4 }}>Factura: "{r.descripcion}" · cant. {r.cantidad}{r.valorUnitario ? ` · $${r.valorUnitario.toFixed(2)} c/u (con IVA)` : ""}</div>
                      <select value={r.matchedItem} onChange={e => setXmlReview(prev => prev.map((x,xi) => xi===i ? { ...x, matchedItem: e.target.value } : x))}
                        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"6px 8px", color: r.matchedItem ? "#f0f0f0" : "#ff6b6b", fontSize:12, outline:"none", cursor:"pointer" }}>
                        <option value="">— Sin emparejar (no se agregará) —</option>
                        {MASTER_CATALOG.map((c,ci) => <option key={ci} value={c.item}>{c.item}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => setXmlReview(null)} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                    Cancelar
                  </button>
                  <button onClick={confirmXmlReview} style={{ flex:2, padding:"9px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.15)", border:"1px solid rgba(175,169,236,0.4)", color:"#AFA9EC" }}>
                    ✓ Agregar {xmlReview.filter(r=>r.matchedItem).length} artículo{xmlReview.filter(r=>r.matchedItem).length!==1?"s":""} a {warehouseLabel(warehouse)}
                  </button>
                </div>
              </div>
            )}

            {!xmlReview && (
            <div>
              <input placeholder="Buscar artículo del catálogo..." value={moveSearch} onChange={e => setMoveSearch(e.target.value)} style={inputStyle} autoFocus />
              {moveSearch.trim().length >= 2 && (
                <div style={{ marginTop:8, display:"flex", flexDirection:"column", gap:3, maxHeight:160, overflowY:"auto" }}>
                  {MASTER_CATALOG.filter(c => c.item.toUpperCase().includes(moveSearch.toUpperCase())).slice(0, 10).map((c, i) => (
                    <button key={i} onClick={() => addToMoveList(c.item)}
                      style={{ textAlign:"left", padding:"7px 10px", borderRadius:6, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.07)", color:"#ccc" }}>
                      + {c.item}
                    </button>
                  ))}
                </div>
              )}
            </div>
            )}

            {/* Lista de artículos ya agregados a este movimiento -- pueden ser varios */}
            {moveList.length > 0 && (
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:200, overflowY:"auto" }}>
                {moveList.map((it, i) => (
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 8px", borderRadius:8, background:"rgba(255,255,255,0.03)" }}>
                    <span style={{ flex:1, fontSize:12, color:"#f0f0f0" }}>{it.item}</span>
                    <input type="number" min="0" value={it.qty} onChange={e => setMoveListQty(it.item, parseInt(e.target.value) || 0)}
                      title="Cantidad"
                      style={{ width:56, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:12, outline:"none", textAlign:"center" }} />
                    {showMoveModal === "entrada" && (
                      <input type="number" min="0" step="0.01" placeholder="$ costo c/u" value={it.cost ?? ""}
                        onChange={e => setMoveList(prev => prev.map(x => x.item===it.item ? { ...x, cost: e.target.value === "" ? undefined : parseFloat(e.target.value) } : x))}
                        title="Costo unitario (opcional)"
                        style={{ width:76, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#00d4aa", fontSize:12, outline:"none", textAlign:"center" }} />
                    )}
                    <button onClick={() => removeFromMoveList(it.item)} style={{ padding:"3px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                  </div>
                ))}
              </div>
            )}

            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Folio de factura (opcional)</label>
              <input placeholder="Ej. folio fiscal / UUID del CFDI" value={invoiceFolio} onChange={e => setInvoiceFolio(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Motivo (opcional)</label>
              <input placeholder={showMoveModal === "entrada" ? "Ej. compra a proveedor" : "Ej. consumo, merma"} value={moveReason} onChange={e => setMoveReason(e.target.value)} style={inputStyle} />
            </div>

            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setShowMoveModal(null)} disabled={saving} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={showMoveModal === "transferencia" ? registerTransfer : showMoveModal === "compra" ? generatePurchaseOrder : registerMovement}
                disabled={saving || moveList.length===0 || (showMoveModal === "transferencia" && !transferTo) || (showMoveModal === "compra" && !purchaseConcept.trim())}
                style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (saving || moveList.length===0) ? "not-allowed" : "pointer",
                background: showMoveModal === "entrada" ? "linear-gradient(135deg,#00d4aa,#0F6E56)" : showMoveModal === "transferencia" ? "linear-gradient(135deg,#AFA9EC,#8B7FD8)" : showMoveModal === "compra" ? "linear-gradient(135deg,#ffb347,#e08e2a)" : "linear-gradient(135deg,#ff6b6b,#c94848)", border:"none", color: showMoveModal === "compra" ? "#000" : "#fff", opacity: (saving || moveList.length===0) ? 0.5 : 1 }}>
                {saving ? (showMoveModal === "compra" ? "Generando…" : "Guardando…") : `✓ ${showMoveModal === "transferencia" ? "Transferir" : showMoveModal === "compra" ? "Generar PDF" : "Guardar"} (${moveList.length} artículo${moveList.length!==1?"s":""})`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
