 import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";
import { PROJECT_ID, FIRESTORE_BASE_URL, IS_TEST_ENV } from "../config";
import { MASTER_CATALOG } from "../data/materialCatalog";
import { openPdfBlob } from "../pdfOpen";

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

// El catálogo maestro (MASTER_CATALOG) es estático, del código -- pero
// Insumos.jsx ya permite dar de alta artículos nuevos ahí mismo, guardados
// en settings/materialCatalog.extraCatalog. Antes Inventario.jsx nunca leía
// esos extras, así que un producto agregado desde Insumos no aparecía aquí
// para buscarlo/registrar movimientos, y viceversa. Se lee el mismo
// documento para que ambas páginas compartan un solo catálogo dinámico.
async function fetchExtraCatalog(token) {
  try {
    const res = await fetch(`${FIRESTORE_BASE_URL}/settings/materialCatalog`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) return [];
    const doc = await res.json();
    return parseDoc(doc).extraCatalog || [];
  } catch (e) {
    return [];
  }
}
async function saveExtraCatalog(token, updated) {
  await fetch(`${FIRESTORE_BASE_URL}/settings/materialCatalog?updateMask.fieldPaths=extraCatalog`, {
    method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ fields: { extraCatalog: toFV(updated) } }),
  });
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

// Mismo criterio que inventoryDocId, pero el lote entra en el ID -- así una
// segunda entrada del mismo lote suma a lo disponible en vez de duplicar.
function inventoryLotDocId(warehouse, item, lote) {
  return `${warehouse}_${item}_${lote}`.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 300);
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
  // Solo Paola puede ver ambos centros siendo enfermera (incluyendo Qual);
  // el resto solo ve el inventario de su propio centro asignado. Se marca
  // con un campo aparte en su documento de usuario (puedeValidarInsumos:
  // true en Firestore, users/{uid}) en vez de comparar su nombre -- un
  // nombre puede cambiar (ej. al ponerse el nombre completo para el
  // consentimiento informado) y comparar el string exacto se rompe en
  // silencio justo cuando eso pasa.
  const canSeeAllCenters = isJefe || profile?.puedeValidarInsumos;
  // Firma a distancia en solicitudes de compra: a diferencia del material
  // por paciente (que solo pasa por el checkup de Paola), una solicitud de
  // compra siempre lleva la cadena completa Paola (VALIDA) -> jefe
  // (AUTORIZA), sea de medicamento o de insumo -- es dinero/reabasto, no
  // solo dispensar lo que ya hay.
  const canValidate = isJefe || profile?.puedeValidarInsumos;
  const canAuthorize = isJefe;
  // Qual·CITIO/Qual·CIPI ya no son un privilegio aparte de "ver ambos
  // centros" -- son parte del propio flujo de medicamentos de cada centro
  // (ahí es donde de verdad se registra la transferencia y se usa el lote
  // el día de la sesión, ver Insumos.jsx), así que cualquier enfermera de
  // CITIO entra a Qual·CITIO igual que a su propio almacén, y lo mismo
  // CIPI con Qual·CIPI.
  const allowedWarehouses = canSeeAllCenters ? null : (profile?.center === "CIPI" ? ["CIPI_PRO","CIPI_PED","QUAL_CIPI"] : ["CITIO","QUAL_CITIO"]);
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
  const [extraCatalog, setExtraCatalog] = useState([]); // artículos dados de alta desde Insumos o desde aquí mismo (settings/materialCatalog)
  const [inventoryLots, setInventoryLots] = useState([]); // lotes de medicamento (Fase 2 de trazabilidad, solo CITIO por ahora)
  // Regularizar cotización (Fase 3): un lote de CITIO en rojo significa que
  // ya se usó en una sesión antes de que CITIO lo comprara formalmente
  // (ver Insumos.jsx, dar de baja). Cuando llega la cotización, esto solo
  // abona a CITIO -- NO vuelve a descontar Qual·CITIO (ya se descontó el
  // día de la sesión, descontarlo otra vez lo dejaría mal contado).
  const [regularizeLot, setRegularizeLot] = useState(null);
  const [regularizeQty, setRegularizeQty] = useState("");
  const [savingRegularize, setSavingRegularize] = useState(false);
  const openRegularizeCotizacion = (lot) => { setRegularizeLot(lot); setRegularizeQty(String(Math.abs(lot.cantidadDisponible ?? 0) || "")); };
  const saveRegularizeCotizacion = async () => {
    const qty = parseFloat(regularizeQty) || 0;
    if (qty <= 0) { alert("Captura una cantidad mayor a 0."); return; }
    setSavingRegularize(true);
    try {
      const lot = regularizeLot;
      const nuevaDisponible = (lot.cantidadDisponible ?? 0) + qty;
      const res = await fetch(`${FIRESTORE_BASE_URL}/inventory_lots/${lot.id}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            warehouse: { stringValue: "CITIO" }, item: { stringValue: lot.item },
            lote: { stringValue: lot.lote }, caducidad: { stringValue: lot.caducidad || "" }, marca: { stringValue: lot.marca || "" },
            cantidadInicial: toFV(Math.max(lot.cantidadInicial ?? 0, nuevaDisponible)),
            cantidadDisponible: toFV(nuevaDisponible),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      setInventoryLots(prev => prev.map(l => l.id === lot.id ? { ...l, cantidadDisponible: nuevaDisponible } : l));
      setRegularizeLot(null); setRegularizeQty("");
    } catch (e) {
      alert("Error al registrar la cotización: " + e.message);
    } finally {
      setSavingRegularize(false);
    }
  };

  // Ajuste directo de cantidad (jefe) -- para corregir un lote que quedó
  // mal (ej. en rojo porque se dio de baja en sesiones desde antes de que
  // existiera el registro de lote, o porque la cuenta física real no
  // coincide). A diferencia de "Registrar entrada" (que SUMA sobre lo que
  // ya hay) y de "Registrar cotización" (que también suma), esto REEMPLAZA
  // la cantidad por la que se capture -- para poner el número real, no para
  // sumarle algo. Al guardar, también se recalcula la existencia agregada
  // (el número grande) de ese artículo en ese almacén como la suma de
  // todos sus lotes, para que quede sincronizada sin corregirla aparte.
  const [adjustLot, setAdjustLot] = useState(null);
  const [adjustQty, setAdjustQty] = useState("");
  const [savingAdjust, setSavingAdjust] = useState(false);
  const openAdjustLot = (lot) => { setAdjustLot(lot); setAdjustQty(String(lot.cantidadDisponible ?? 0)); };
  const saveAdjustLot = async () => {
    const qty = parseFloat(adjustQty);
    if (isNaN(qty)) { alert("Captura un número válido (puede ser 0)."); return; }
    setSavingAdjust(true);
    try {
      const lot = adjustLot;
      const lotRes = await fetch(`${FIRESTORE_BASE_URL}/inventory_lots/${lot.id}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            warehouse: { stringValue: lot.warehouse }, item: { stringValue: lot.item },
            lote: { stringValue: lot.lote }, caducidad: { stringValue: lot.caducidad || "" }, marca: { stringValue: lot.marca || "" },
            cantidadInicial: toFV(Math.max(lot.cantidadInicial ?? 0, qty)),
            cantidadDisponible: toFV(qty),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}) });
      if (!lotRes.ok) { const err = await lotRes.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${lotRes.status}`); }

      const updatedLots = inventoryLots.map(l => l.id === lot.id ? { ...l, cantidadDisponible: qty } : l);
      const sumForItem = updatedLots.filter(l => l.warehouse === lot.warehouse && l.item === lot.item).reduce((acc, l) => acc + (l.cantidadDisponible || 0), 0);
      const docId = inventoryDocId(lot.warehouse, lot.item);
      const existingInv = inventory.find(i => i.id === docId);
      const invRes = await fetch(`${FIRESTORE_BASE_URL}/inventory/${docId}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: lot.item }, warehouse: { stringValue: lot.warehouse },
            category: { stringValue: existingInv?.category || "" }, unit: { stringValue: existingInv?.unit || "PIEZA" },
            currentStock: toFV(sumForItem), minStock: toFV(existingInv?.minStock ?? 0),
            lastCost: toFV(existingInv?.lastCost ?? 0), avgCost: toFV(existingInv?.avgCost ?? 0), totalReceived: toFV(existingInv?.totalReceived ?? 0),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}) });
      if (!invRes.ok) { const err = await invRes.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${invRes.status}`); }

      setInventoryLots(updatedLots);
      setInventory(prev => prev.map(i => i.id === docId ? { ...i, currentStock: sumForItem } : i));
      setAdjustLot(null); setAdjustQty("");
    } catch (e) {
      alert("Error al ajustar la cantidad: " + e.message);
    } finally {
      setSavingAdjust(false);
    }
  };

  // Ajuste directo de la existencia agregada (jefe) -- para artículos sin
  // ningún lote registrado todavía, donde el ajuste por lote no aplica
  // (ver adjustLot arriba). Mismo criterio: reemplaza el número, no lo
  // suma. Si el artículo sí tiene lotes, es mejor corregirlos ahí (eso ya
  // recalcula este número solo) -- este botón es para cuando no hay nada
  // que corregir a nivel de lote.
  const [adjustStock, setAdjustStock] = useState(null);
  const [adjustStockQty, setAdjustStockQty] = useState("");
  const [savingAdjustStock, setSavingAdjustStock] = useState(false);
  const openAdjustStock = (invDoc) => { setAdjustStock(invDoc); setAdjustStockQty(String(invDoc.currentStock ?? 0)); };
  const saveAdjustStock = async () => {
    const qty = parseFloat(adjustStockQty);
    if (isNaN(qty)) { alert("Captura un número válido (puede ser 0)."); return; }
    setSavingAdjustStock(true);
    try {
      const doc = adjustStock;
      const res = await fetch(`${FIRESTORE_BASE_URL}/inventory/${doc.id}`,
        { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
          body: JSON.stringify({ fields: {
            item: { stringValue: doc.item }, warehouse: { stringValue: doc.warehouse },
            category: { stringValue: doc.category || "" }, unit: { stringValue: doc.unit || "PIEZA" },
            currentStock: toFV(qty), minStock: toFV(doc.minStock ?? 0),
            lastCost: toFV(doc.lastCost ?? 0), avgCost: toFV(doc.avgCost ?? 0), totalReceived: toFV(doc.totalReceived ?? 0),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}) });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error?.message || `Error ${res.status}`); }
      setInventory(prev => prev.map(x => x.id === doc.id ? { ...x, currentStock: qty } : x));
      setAdjustStock(null); setAdjustStockQty("");
    } catch (e) {
      alert("Error al ajustar la existencia: " + e.message);
    } finally {
      setSavingAdjustStock(false);
    }
  };

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
  const [purchaseNote, setPurchaseNote] = useState(""); // nota opcional (ej. motivo del pedido, instrucciones para el proveedor)
  const [editingPO, setEditingPO] = useState(null); // solicitud de compra que se está corrigiendo, o null si es una nueva
  const [saving, setSaving] = useState(false);
  const [xmlReview, setXmlReview] = useState(null); // [{descripcion, cantidad, matchedItem}] mientras se revisa antes de agregar
  const [xmlReceptor, setXmlReceptor] = useState(""); // nombre del receptor en la factura, para confirmar que corresponde al almacén
  const [newItemDraft, setNewItemDraft] = useState(null); // { rowIndex, nombre, categoria, unidad } -- alta de producto nuevo desde un renglón sin emparejar
  const [savingNewItem, setSavingNewItem] = useState(false);
  const [linkedPO, setLinkedPO] = useState(null); // solicitud de compra pendiente que esta entrada va a cerrar, o null

  const load = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const t = await user.getIdToken(true);
      setToken(t);
      const [inv, ev, po, extraCat, lots] = await Promise.all([
        fetchCollection(t, "inventory"),
        fetchCollection(t, "inventory_events"),
        fetchCollection(t, "purchase_orders"),
        fetchExtraCatalog(t),
        fetchCollection(t, "inventory_lots"),
      ]);
      setInventory(inv);
      setEvents(ev.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")));
      setPurchaseOrders(po.sort((a, b) => (b.requestedAt || "").localeCompare(a.requestedAt || "")));
      setExtraCatalog(extraCat);
      setInventoryLots(lots);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setHasLoadedOnce(true);
    }
  };

  useEffect(() => { load(); }, [user]);
  // El token se obtiene una sola vez al cargar (arriba, en load()) -- todas
  // las escrituras de esta página lo reusan tal cual, sin pedir uno fresco
  // antes de cada una (a diferencia de MaterialModal.jsx, que sí lo hace).
  // Si la pestaña se queda abierta más de una hora, el token caduca y
  // cualquier guardado falla con ese token viejo -- reportado como "el PDF
  // sí se generó pero la solicitud de compra nunca se guardó" en una
  // sesión larga. Se renueva solo cada 45 min mientras la pestaña siga
  // abierta, para que nunca llegue a caducar.
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(() => {
      user.getIdToken(true).then(setToken).catch(() => {});
    }, 45 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user]);

  // Catálogo maestro + extras dados de alta desde Insumos o desde aquí --
  // usar SIEMPRE este en vez de MASTER_CATALOG a secas en esta página.
  const effectiveCatalog = [...MASTER_CATALOG, ...extraCatalog];
  const isMedItem = (itemName) => MED_CATEGORIES.includes(effectiveCatalog.find(c => c.item === itemName)?.category);

  // Insumos y medicamentos viven en el mismo almacén de centro (CITIO, CIPI
  // PRO/PED) -- este filtro es solo de vista, para poder trabajar uno sin
  // que el otro estorbe. No aplica a Qual (ahí solo hay medicamento).
  const [catFilter, setCatFilter] = useState(""); // "" | "insumos" | "medicamentos"
  const catFilterActive = catFilter && !warehouse.startsWith("QUAL");

  const warehouseInventory = inventory.filter(i => i.warehouse === warehouse
    && (!catFilterActive || (catFilter === "medicamentos" ? isMedItem(i.item) : !isMedItem(i.item))));
  const filteredInventory = search.trim()
    ? warehouseInventory.filter(i => i.item.toUpperCase().includes(search.toUpperCase()))
    : warehouseInventory;
  const lowStock = warehouseInventory.filter(i => i.currentStock < (i.minStock ?? 0));
  const suggestedReorders = warehouseInventory.filter(i => reorderInfo(i).suggestQty > 0);

  const addToMoveList = (item, cost) => {
    const qty = parseInt(moveQty) || 1;
    setMoveList(prev => {
      const existing = prev.find(x => x.item === item);
      // Qual·CITIO (needsLotEntry): el mismo medicamento puede entrar en
      // más de un lote distinto en una sola transferencia (ej. DOCETAXEL
      // con dos lotes de caducidad diferente) -- cada vez que se agrega se
      // suma un renglón de lote nuevo, nunca se mezcla con uno existente.
      if (needsLotEntry(item)) {
        const entries = [...(existing?.lotEntries || []), { lote: "", caducidad: "", marca: "", qty }];
        const total = entries.reduce((acc, e) => acc + e.qty, 0);
        if (existing) return prev.map(x => x.item === item ? { ...x, qty: total, lotEntries: entries } : x);
        return [...prev, { item, qty: total, cost: cost || undefined, lotEntries: entries }];
      }
      if (existing) return prev.map(x => x.item === item ? { ...x, qty: x.qty + qty } : x);
      return [...prev, { item, qty, cost: cost || undefined }];
    });
    setMoveSearch(""); setMoveQty("1");
  };
  const removeFromMoveList = (item) => setMoveList(prev => prev.filter(x => x.item !== item));
  const setMoveListQty = (item, qty) => setMoveList(prev => prev.map(x => x.item === item ? { ...x, qty: Math.max(0, qty) } : x));
  // Lotes de un medicamento que SÍ llega en esta entrada a Qual·CITIO
  // (distinto de lotPicks, que es tomar de un lote YA existente).
  const setLotEntryField = (itemName, idx, field, value) => setMoveList(prev => prev.map(x => {
    if (x.item !== itemName) return x;
    const entries = x.lotEntries.map((e, i) => i === idx ? { ...e, [field]: value } : e);
    return { ...x, lotEntries: entries };
  }));
  const setLotEntryQty = (itemName, idx, qty) => setMoveList(prev => prev.map(x => {
    if (x.item !== itemName) return x;
    const entries = x.lotEntries.map((e, i) => i === idx ? { ...e, qty: Math.max(0, qty) } : e);
    return { ...x, lotEntries: entries, qty: entries.reduce((acc, e) => acc + e.qty, 0) };
  }));
  const addLotEntryRow = (itemName) => setMoveList(prev => prev.map(x => x.item === itemName ? { ...x, lotEntries: [...x.lotEntries, { lote: "", caducidad: "", marca: "", qty: 0 }] } : x));
  const removeLotEntryRow = (itemName, idx) => setMoveList(prev => prev.map(x => {
    if (x.item !== itemName) return x;
    const entries = x.lotEntries.filter((_, i) => i !== idx);
    return { ...x, lotEntries: entries, qty: entries.reduce((acc, e) => acc + e.qty, 0) };
  }));
  // Elegir cuánto tomar de un lote específico de Qual·CITIO (CITIO jala,
  // no vuelve a capturar) -- la cantidad total del renglón se recalcula
  // sola como la suma de lo elegido en cada lote.
  const setLotPickQty = (itemName, lot, qty) => setMoveList(prev => prev.map(x => {
    if (x.item !== itemName) return x;
    const picks = x.lotPicks ? [...x.lotPicks] : [];
    const idx = picks.findIndex(p => p.lotId === lot.id);
    const newQty = Math.max(0, qty);
    if (idx >= 0) picks[idx] = { ...picks[idx], qty: newQty };
    else picks.push({ lotId: lot.id, lote: lot.lote, caducidad: lot.caducidad, marca: lot.marca, qty: newQty });
    return { ...x, lotPicks: picks, qty: picks.reduce((acc, p) => acc + p.qty, 0) };
  }));
  const isMedForLot = (itemName) => MED_CATEGORIES.includes(effectiveCatalog.find(c => c.item === itemName)?.category);
  // Qual·CITIO es donde llega de verdad el medicamento (vía el PDF de
  // transferencia de QualMedical) -- ahí se captura lote/caducidad/marca.
  const needsLotEntry = (itemName) => warehouse === "QUAL_CITIO" && isMedForLot(itemName);
  // No todos los medicamentos de CITIO pasan por Qual -- algunos se compran
  // directo a otro proveedor. Por default se asume que SÍ viene de Qual
  // (jalar un lote ya existente); "directSource" en el renglón del
  // movimiento marca la excepción, elegida a mano por quien registra la
  // entrada (ver botón de alternar en la lista de artículos).
  const isDirectSource = (itemName) => !!moveList.find(x => x.item === itemName)?.directSource;
  // CITIO ya no vuelve a capturar nada: "jala" un lote que ya existe en
  // Qual·CITIO (la "venta oficial" que Qual regresa después) -- se elige
  // de un listado en vez de escribirlo de nuevo. Excepto cuando es compra
  // directa: ahí SÍ se captura lote/caducidad/marca nuevos, igual que
  // Qual·CITIO.
  const needsLotPick = (itemName) => warehouse === "CITIO" && isMedForLot(itemName) && !isDirectSource(itemName);
  const needsDirectEntry = (itemName) => warehouse === "CITIO" && isMedForLot(itemName) && isDirectSource(itemName);
  const setDirectSource = (itemName, value) => setMoveList(prev => prev.map(x => x.item === itemName ? {
    ...x, directSource: value,
    lotPicks: value ? undefined : [],
    lotEntries: value ? [{ lote:"", caducidad:"", marca:"", qty:0 }] : undefined,
    qty: 0,
  } : x));
  const availableQualLots = (itemName) => inventoryLots
    .filter(l => l.warehouse === "QUAL_CITIO" && l.item === itemName && (l.cantidadDisponible ?? 0) > 0)
    .sort((a, b) => (a.caducidad || "").localeCompare(b.caducidad || ""));

  // Busca en el catálogo el artículo que mejor coincida con la descripción
  // que trae la factura (nunca son idénticas letra por letra).
  const suggestCatalogMatch = (descripcion) => {
    const up = (descripcion || "").toUpperCase().trim();
    if (!up) return "";
    const exact = effectiveCatalog.find(c => c.item.toUpperCase() === up);
    if (exact) return exact.item;
    const contains = effectiveCatalog.find(c => up.includes(c.item.toUpperCase()) || c.item.toUpperCase().includes(up));
    if (contains) return contains.item;
    // Coincidencia por palabras compartidas (al menos 2 palabras en común)
    const upWords = new Set(up.split(/\s+/).filter(w => w.length > 2));
    let best = null, bestScore = 0;
    effectiveCatalog.forEach(c => {
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

      // Dos formatos de PDF de QualMedical, con columnas distintas:
      // - "Transferencia entre almacenes" (TR-xxx): es el que de verdad
      //   llega a Qual·CITIO -- trae MARCA, LOTE y CADUCIDAD (fecha
      //   completa DD/MM/AAAA) en columnas limpias, sin precios.
      // - "Cotización" (COT-QUAL-xxx): la venta oficial que Qual regresa
      //   después -- trae LOTE y CAD. (mes-año nomás) pero no marca en
      //   columna aparte, con precios por renglón.
      const isTransferencia = /TRANSFERENCIA\s+ENTRE\s+ALMACENES/i.test(fullText);
      let folio = "";
      const review = [];

      if (isTransferencia) {
        const folioMatch = fullText.match(/\bTR-\d+\b/);
        folio = folioMatch ? folioMatch[0] : "";

        // Se busca desde después del encabezado de la tabla -- si no, la
        // fecha del documento ("TR-074 02/10/2026 02 de octubre...") que
        // sale ANTES de la tabla se puede confundir con un renglón real.
        const headerMatch = fullText.match(/MARCA\s+LOTE\s+CADUCIDAD\s+CANT\.?\s+UNIDAD/i);
        const searchText = headerMatch ? fullText.slice(headerMatch.index + headerMatch[0].length) : fullText;

        // Ancla: MARCA LOTE DD/MM/AAAA CANT UNIDAD (un solo token cada uno
        // de marca/lote/unidad -- si la marca real trae espacio, queda
        // incompleta pero se puede corregir a mano antes de guardar).
        const anchorRegex = /(\S+)\s+(\S+)\s+(\d{2})\/(\d{2})\/(\d{4})\s+(\d+)\s+(\S+)/g;
        let lastEnd = 0;
        let m;
        while ((m = anchorRegex.exec(searchText)) !== null) {
          // El renglón 1 a veces arrastra texto de las cajas de ALMACÉN
          // ORIGEN/DESTINO y de los encabezados DETALLE/NO./DESCRIPCIÓN --
          // el PDF los coloca fuera de orden visual en el flujo de texto.
          const descRaw = searchText.slice(lastEnd, m.index)
            .replace(/\b(ALMAC[ÉE]N\s+(ORIGEN|DESTINO|PRINCIPAL|CITIO|CIPI)|DETALLE\s+DE\s+PRODUCTOS\s+TRANSFERIDOS|NO\.|DESCRIPCI[ÓO]N)(?=\s|$)/gi, " ")
            .replace(/^\s*\d+\s+/, "").replace(/\s+/g, " ").trim();
          lastEnd = anchorRegex.lastIndex;
          if (!descRaw) continue;
          const [, marca, lote, dd, mm, yyyy, cantStr] = m;
          const cantidad = parseInt(cantStr) || 1;
          const caducidad = `${yyyy}-${mm}-${dd}`;
          review.push({ descripcion: descRaw, cantidad, valorUnitario: undefined, matchedItem: suggestCatalogMatch(descRaw), lote, caducidad, marca });
        }
        if (review.length === 0) throw new Error("No se encontraron artículos reconocibles en la transferencia.");
      } else {
        const folioMatch = fullText.match(/FOLIO:\s*(\S+)/i);
        folio = folioMatch ? folioMatch[1] : "";

        const MESES = "ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic";
        const MES_NUM = { ene:1,feb:2,mar:3,abr:4,may:5,jun:6,jul:7,ago:8,sep:9,oct:10,nov:11,dic:12 };
        // El lote y la caducidad SÍ vienen en la cotización de QualMedical
        // (ej. "M2510429 nov-27") -- se extraen para precargarlos en vez de
        // tirarlos; "caducidad" queda como el último día de ese mes, ya que
        // el PDF solo trae mes-año. La marca aquí NO viene en columna
        // aparte (va mezclada en "UNIDAD", sin anclaje confiable) -- se
        // deja siempre para captura a mano.
        const extractLoteCaducidad = (desc) => {
          const mm = desc.match(new RegExp(`\\s+(\\S+)\\s+(${MESES})-(\\d{2})\\s*$`, "i"));
          if (!mm) return { lote: "", caducidad: "", rest: desc };
          const mesNum = MES_NUM[mm[2].toLowerCase()];
          const anio = 2000 + parseInt(mm[3]);
          const lastDay = new Date(anio, mesNum, 0).getDate();
          const caducidad = `${anio}-${String(mesNum).padStart(2,"0")}-${String(lastDay).padStart(2,"0")}`;
          return { lote: mm[1], caducidad, rest: desc.slice(0, mm.index) + desc.slice(mm.index + mm[0].length) };
        };
        const cleanDescription = (desc) => {
          let d = desc;
          // Encabezados de columna y de sección que pueden quedar pegados
          // antes de la descripción real (ej. "INSUMOS CLORURO DE SODIO...").
          d = d.replace(/\b(DESCRIPCION|UNIDAD|LOTE|CAD\.?|CANT\.?|PRECIO\s+UNITARIO|IVA|PRECIO|INSUMOS|MEDICAMENTOS|SOLUCIONES)\b/gi, " ");
          d = d.replace(/\s+-\s*$/, "");
          d = d.replace(/^[\s.]+/, ""); // puntos/espacios sueltos al inicio, residuo de encabezados removidos
          return d.replace(/\s+/g, " ").trim();
        };

        // Ancla: cantidad seguida de 3 importes con $ (unitario, IVA, precio).
        const anchorRegex = /(\d+)\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})\s+\$\s?([\d,]+\.\d{2})/g;
        let lastEnd = 0;
        let m;
        while ((m = anchorRegex.exec(fullText)) !== null) {
          const rawSlice = fullText.slice(lastEnd, m.index);
          const { lote, caducidad, rest } = extractLoteCaducidad(rawSlice);
          const descRaw = cleanDescription(rest);
          lastEnd = anchorRegex.lastIndex;
          const cantidad = parseInt(m[1]) || 1;
          const precioTotal = parseFloat(m[4].replace(/,/g, ""));
          const valorUnitario = cantidad > 0 ? precioTotal / cantidad : parseFloat(m[2].replace(/,/g, ""));
          if (!descRaw || /^(SUB\s?TOTAL|IMPUESTOS|TOTAL)$/i.test(descRaw)) continue;
          review.push({ descripcion: descRaw, cantidad, valorUnitario, matchedItem: suggestCatalogMatch(descRaw), lote, caducidad });
        }
        if (review.length === 0) throw new Error("No se encontraron artículos reconocibles en el PDF.");
      }

      setXmlReview(review);

      if (folio) {
        setInvoiceFolio(folio);
        const yaCargada = events.some(ev => ev.invoiceFolio && ev.invoiceFolio.toUpperCase() === folio.toUpperCase());
        if (yaCargada) {
          alert(`⚠️ Este documento (folio ${folio}) ya se había cargado antes. Revisa en "Movimientos" antes de continuar para no duplicarlo.`);
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
      const map = new Map(prev.map(x => [x.item, { qty: x.qty, cost: x.cost, lotEntries: x.lotEntries }]));
      xmlReview.filter(r => r.matchedItem).forEach(r => {
        const existing = map.get(r.matchedItem);
        // El mismo medicamento puede salir dos veces en la misma
        // transferencia, cada vez con un lote distinto (ej. DOCETAXEL con
        // dos lotes) -- cada renglón del PDF agrega su PROPIO lote, nunca
        // se mezcla con el de otro renglón del mismo artículo.
        if (needsLotEntry(r.matchedItem)) {
          const entries = [...(existing?.lotEntries || []), { lote: r.lote || "", caducidad: r.caducidad || "", marca: r.marca || "", qty: r.cantidad }];
          map.set(r.matchedItem, { qty: entries.reduce((acc, e) => acc + e.qty, 0), cost: r.valorUnitario || existing?.cost, lotEntries: entries });
        } else {
          map.set(r.matchedItem, { qty: (existing?.qty || 0) + r.cantidad, cost: r.valorUnitario || existing?.cost, lotEntries: existing?.lotEntries });
        }
      });
      return Array.from(map, ([item, v]) => ({ item, qty: v.qty, cost: v.cost, ...(v.lotEntries ? { lotEntries: v.lotEntries } : {}) }));
    });
    setXmlReview(null);
    setNewItemDraft(null);
  };

  // Da de alta un artículo nuevo directo desde un renglón de la factura que
  // no encontró emparejamiento -- antes eso solo dejaba "— Sin emparejar —"
  // y el renglón se perdía en silencio. Se guarda en el mismo
  // settings/materialCatalog.extraCatalog que ya usa Insumos.jsx (catálogo
  // compartido), y de una vez se selecciona como el emparejamiento de ese
  // renglón.
  const createExtraCatalogItem = async () => {
    if (!newItemDraft || !newItemDraft.nombre.trim()) return;
    setSavingNewItem(true);
    try {
      const nombre = newItemDraft.nombre.trim().toUpperCase();
      if (effectiveCatalog.some(c => c.item.toUpperCase() === nombre)) {
        alert("Ya existe un artículo con ese nombre en el catálogo -- elígelo de la lista en vez de crear uno nuevo.");
        return;
      }
      const updated = [...extraCatalog, { category: newItemDraft.categoria, item: nombre, unit: (newItemDraft.unidad || "PIEZA").trim().toUpperCase() }];
      await saveExtraCatalog(token, updated);
      setExtraCatalog(updated);
      setXmlReview(prev => prev.map((r, ri) => ri === newItemDraft.rowIndex ? { ...r, matchedItem: nombre } : r));
      setNewItemDraft(null);
    } catch (e) {
      alert("Error al crear el producto: " + e.message);
    } finally {
      setSavingNewItem(false);
    }
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

      // Si este movimiento venía de "Dar de baja medicamentos/material" de
      // una sesión (tiene sessionId), esa mitad de la sesión debe volver a
      // quedar disponible para dar de baja -- si no, se queda marcada como
      // "ya dada de baja" sin que el inventario realmente la refleje. Cada
      // mitad se identifica por el texto del motivo (ver confirmInvSalida
      // en Insumos.jsx); los anexos posteriores al retiro tienen su propio
      // motivo ("Anexo N...") y no deben reabrir nada.
      const bajaMatch = /^Baja de inventario \((medicamentos|material)\)/.exec(ev.reason || "");
      if (ev.sessionId && ev.type === "salida" && bajaMatch) {
        const isMeds = bajaMatch[1] === "medicamentos";
        const field = isMeds ? "inventorySalidaMedsDone" : "inventorySalidaMaterialDone";
        const atField = isMeds ? "inventorySalidaMedsAt" : "inventorySalidaMaterialAt";
        const sessRes = await fetch(`${FIRESTORE_BASE_URL}/sessions/${ev.sessionId}?updateMask.fieldPaths=${field}&updateMask.fieldPaths=${atField}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            [field]: { booleanValue: false },
            [atField]: { nullValue: null },
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
        const catalogEntry = effectiveCatalog.find(c => c.item === item);

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
  //
  // editingPO (null al crear una nueva, o el objeto de la solicitud que se
  // está corrigiendo) decide si esto crea un documento nuevo o actualiza uno
  // existente. Editar invalida la validación/autorización ya hecha -- el
  // contenido cambió, hay que volver a revisarlo -- por lo que el PDF sale
  // de nuevo con VALIDA/AUTORIZA pendientes, igual que la primera vez.
  const generatePurchaseOrder = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    if (!purchaseConcept.trim()) { alert("Escribe el concepto de la solicitud."); return; }
    setSaving(true);
    try {
      const groups = { MEDICAMENTOS: [], SOLUCIONES: [], INSUMOS: [] };
      moveList.forEach(({ item, qty }) => {
        const cat = effectiveCatalog.find(c => c.item === item)?.category;
        if (MED_CATEGORIES.includes(cat)) groups.MEDICAMENTOS.push({ item, qty });
        else if (/CLORURO DE SODIO|GLUCOSA|HARTMANN/i.test(item)) groups.SOLUCIONES.push({ item, qty });
        else groups.INSUMOS.push({ item, qty });
      });
      const centerForPdf = warehouse.includes("CIPI") ? "CIPI" : "CITIO";
      const cipiVariantForPdf = warehouse === "QUAL_CIPI" || warehouse === "CIPI_PED" ? "PED" : "PRO";
      // Recién creada (o recién editada), nunca pudo haberse validado/
      // autorizado antes -- igual que un anexo nuevo, ambas firmas salen
      // pendientes en este PDF.
      const signatures = [
        { label: "SOLICITA", name: profile?.name || "", signatureUrl: profile?.signatureUrl || null },
        { label: "VALIDA", pending: true, pendingLabel: "PENDIENTE VALIDACIÓN" },
        { label: "AUTORIZA", pending: true, pendingLabel: "PENDIENTE AUTORIZACIÓN" },
        { label: "RECIBE" },
      ];
      const res = await fetch("/api/generate-material-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ center: centerForPdf, cipiVariant: cipiVariantForPdf, concepto: purchaseConcept, groups, signatures, note: purchaseNote.trim() }),
      });
      if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `Error ${res.status}`); }
      const blob = await res.blob();
      openPdfBlob(blob, `Solicitud_Compra_${(purchaseConcept || "solicitud").replace(/\s+/g, "_").slice(0, 40)}.pdf`);

      const itemsFv = toFV(moveList.map(({ item, qty }) => ({ item, qty })));
      if (editingPO) {
        const changedFields = {
          concepto: { stringValue: purchaseConcept },
          note: { stringValue: purchaseNote.trim() },
          items: itemsFv,
          validatedBy: { nullValue: null }, validatedByName: { nullValue: null }, validatedAt: { nullValue: null }, validationSignatureUrl: { nullValue: null },
          authorizedBy: { nullValue: null }, authorizedByName: { nullValue: null }, authorizedAt: { nullValue: null }, authorizationSignatureUrl: { nullValue: null },
        };
        const mask = Object.keys(changedFields).map(k => `updateMask.fieldPaths=${k}`).join("&");
        const poRes = await fetch(`${FIRESTORE_BASE_URL}/purchase_orders/${editingPO.id}?${mask}`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body: JSON.stringify({ fields: changedFields }) });
        if (poRes.ok) {
          setPurchaseOrders(prev => prev.map(p => p.id === editingPO.id ? { ...p,
            concepto: purchaseConcept, note: purchaseNote.trim(), items: moveList.map(({ item, qty }) => ({ item, qty })),
            validatedBy: null, validatedByName: null, validatedAt: null, validationSignatureUrl: null,
            authorizedBy: null, authorizedByName: null, authorizedAt: null, authorizationSignatureUrl: null,
          } : p));
        } else {
          const err = await poRes.json().catch(() => ({}));
          alert("⚠️ El PDF se generó, pero NO se pudo guardar el cambio en el seguimiento de la solicitud: " + (err.error?.message || `Error ${poRes.status}`) + "\n\nVuelve a intentar 'Guardar cambios' en un momento.");
        }
      } else {
        const poRes = await fetch(`${FIRESTORE_BASE_URL}/purchase_orders`, {
          method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            warehouse: { stringValue: warehouse }, concepto: { stringValue: purchaseConcept },
            note: { stringValue: purchaseNote.trim() },
            items: itemsFv,
            status: { stringValue: "pendiente" },
            requestedBy: { stringValue: user?.uid || "" }, requestedByName: { stringValue: profile?.name || "" },
            requestedBySignatureUrl: profile?.signatureUrl ? { stringValue: profile.signatureUrl } : { nullValue: null },
            requestedAt: { stringValue: new Date().toISOString() },
            validatedBy: { nullValue: null }, validatedByName: { nullValue: null }, validatedAt: { nullValue: null }, validationSignatureUrl: { nullValue: null },
            authorizedBy: { nullValue: null }, authorizedByName: { nullValue: null }, authorizedAt: { nullValue: null }, authorizationSignatureUrl: { nullValue: null },
          }}),
        });
        if (poRes.ok) {
          const doc = await poRes.json();
          setPurchaseOrders(prev => [parseDoc(doc), ...prev]);
        } else {
          // Antes esto fallaba en silencio -- el PDF se abría igual y nadie
          // se enteraba de que la solicitud nunca quedó guardada en la
          // pestaña de seguimiento, hasta que alguien la buscaba y no
          // aparecía. Ahora se avisa de inmediato con el motivo real (ej.
          // permisos, reglas de Firestore desactualizadas).
          const err = await poRes.json().catch(() => ({}));
          alert("⚠️ El PDF se generó, pero la solicitud NO quedó guardada en el seguimiento (pestaña 'Solicitudes de compra'): " + (err.error?.message || `Error ${poRes.status}`) + "\n\nVuelve a intentar generarla en un momento; si sigue fallando, avísale al jefe.");
        }
      }

      setShowMoveModal(null); setMoveList([]); setPurchaseConcept(""); setPurchaseNote(""); setEditingPO(null);
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
  // "Marcar recibida" manual ya no existe -- el cierre a "recibida" ahora
  // pasa por vincular la solicitud con una entrada real al registrarla
  // (ver registerMovement), que es lo que de verdad prueba que llegó.
  //
  // Cerrar: para cuando una solicitud no se va a concretar por la vía
  // normal (se canceló, se duplicó, se resolvió de otra forma) -- nunca se
  // borra (igual que un movimiento anulado), queda como registro de que se
  // pidió y por qué se cerró. Pide motivo obligatorio, mismo criterio que
  // voidEvent. Una vez cerrada (o recibida vía entrada), ya no se puede
  // editar ni volver a firmar -- es un estado terminal.
  const closePurchaseOrder = (po) => {
    const reason = prompt(`Motivo del cierre de "${po.concepto}":`);
    if (reason === null) return; // canceló el prompt
    if (!reason.trim()) { alert("El motivo es obligatorio."); return; }
    patchPurchaseOrder(po.id, {
      status: "cerrada", closedAt: new Date().toISOString(),
      closedBy: user?.uid || "", closedByName: profile?.name || "",
      closeReason: reason.trim(),
    }, ["status","closedAt","closedBy","closedByName","closeReason"]);
  };

  // Reimprime el PDF con el estado de firma ACTUAL (a diferencia del
  // original, que sale con VALIDA/AUTORIZA pendientes porque se imprime en
  // el mismo instante en que se crea la solicitud). No guarda nada nuevo.
  const [reprintingPO, setReprintingPO] = useState(null);
  const reprintPurchaseOrder = async (po) => {
    setReprintingPO(po.id);
    try {
      const items = po.items || [];
      const groups = { MEDICAMENTOS: [], SOLUCIONES: [], INSUMOS: [] };
      items.forEach(({ item, qty }) => {
        const cat = effectiveCatalog.find(c => c.item === item)?.category;
        if (MED_CATEGORIES.includes(cat)) groups.MEDICAMENTOS.push({ item, qty });
        else if (/CLORURO DE SODIO|GLUCOSA|HARTMANN/i.test(item)) groups.SOLUCIONES.push({ item, qty });
        else groups.INSUMOS.push({ item, qty });
      });
      const centerForPdf = po.warehouse.includes("CIPI") ? "CIPI" : "CITIO";
      const cipiVariantForPdf = po.warehouse === "QUAL_CIPI" || po.warehouse === "CIPI_PED" ? "PED" : "PRO";
      const signatures = [
        { label: "SOLICITA", name: po.requestedByName || "", signatureUrl: po.requestedBySignatureUrl || null },
        { label: "VALIDA", name: po.validatedByName || "", signatureUrl: po.validationSignatureUrl || null, pending: !po.validatedBy, pendingLabel: "PENDIENTE VALIDACIÓN" },
        { label: "AUTORIZA", name: po.authorizedByName || "", signatureUrl: po.authorizationSignatureUrl || null, pending: !po.authorizedBy, pendingLabel: "PENDIENTE AUTORIZACIÓN" },
        { label: "RECIBE" },
      ];
      const res = await fetch("/api/generate-material-order", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ center: centerForPdf, cipiVariant: cipiVariantForPdf, concepto: po.concepto, groups, signatures, note: po.note || "" }),
      });
      if (!res.ok) throw new Error(`Error ${res.status} al reimprimir`);
      const blob = await res.blob();
      openPdfBlob(blob, `Solicitud_Compra_${(po.concepto || "solicitud").replace(/\s+/g, "_").slice(0, 40)}.pdf`);
    } catch (e) {
      alert("Error al reimprimir la solicitud: " + e.message);
    } finally {
      setReprintingPO(null);
    }
  };

  const registerMovement = async () => {
    if (moveList.length === 0) { alert("Agrega al menos un artículo."); return; }
    const type = showMoveModal; // "entrada" | "salida"
    if (type === "entrada") {
      const missingEntry = moveList.filter(it => (needsLotEntry(it.item) || needsDirectEntry(it.item))
        && (it.lotEntries || []).some(e => !e.qty || !e.lote?.trim() || !e.caducidad || !e.marca?.trim()));
      if (missingEntry.length > 0) {
        alert(`Falta lote, caducidad, marca o cantidad en algún renglón de: ${missingEntry.map(m => m.item).join(", ")}. Es donde llega de verdad el medicamento -- se necesitan los cuatro en cada lote.`);
        return;
      }
      for (const it of moveList) {
        if (!needsLotPick(it.item)) continue;
        const picks = (it.lotPicks || []).filter(p => p.qty > 0);
        const pickedTotal = picks.reduce((acc, p) => acc + p.qty, 0);
        if (pickedTotal === 0) { alert(`"${it.item}": elige de qué lote(s) de Qual·CITIO se va a tomar.`); return; }
        if (pickedTotal !== it.qty) { alert(`"${it.item}": lo elegido por lote (${pickedTotal}) no coincide con la cantidad (${it.qty}).`); return; }
        for (const p of picks) {
          const lotNow = inventoryLots.find(l => l.id === p.lotId);
          if ((lotNow?.cantidadDisponible ?? 0) < p.qty) {
            alert(`"${it.item}" lote ${p.lote}: ya no hay ${p.qty} disponibles en Qual·CITIO (quedan ${lotNow?.cantidadDisponible ?? 0}). Actualiza la selección.`);
            return;
          }
        }
      }
    }
    setSaving(true);
    try {
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
        const catalogEntry = effectiveCatalog.find(c => c.item === item);
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

      // Si esta entrada se ligó a una solicitud de compra pendiente, la
      // entrada real es justo lo que la cierra -- ya no depende de que
      // alguien se acuerde de dar clic aparte en "Marcar recibida".
      if (type === "entrada" && linkedPO) {
        const evDoc = await evRes.json().catch(() => null);
        const eventId = evDoc?.name ? evDoc.name.split("/").pop() : null;
        const poFields = {
          status: { stringValue: "recibida" },
          receivedAt: { stringValue: new Date().toISOString() },
          receivedByEventId: eventId ? { stringValue: eventId } : { nullValue: null },
        };
        const poRes = await fetch(`${FIRESTORE_BASE_URL}/purchase_orders/${linkedPO.id}?${Object.keys(poFields).map(k => `updateMask.fieldPaths=${k}`).join("&")}`,
          { method:"PATCH", headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` }, body: JSON.stringify({ fields: poFields }) });
        if (poRes.ok) {
          setPurchaseOrders(prev => prev.map(p => p.id === linkedPO.id ? { ...p, status: "recibida", receivedAt: poFields.receivedAt.stringValue, receivedByEventId: eventId } : p));
        } else {
          const err = await poRes.json().catch(() => ({}));
          alert("⚠️ La entrada se registró bien, pero NO se pudo cerrar la solicitud de compra vinculada: " + (err.error?.message || `Error ${poRes.status}`) + "\n\nCiérrala a mano desde 'Solicitudes de compra' con '✓ Marcar recibida'.");
        }
      }

      // Si es una entrada de MEDICAMENTO a un almacén de centro (no a Qual
      // mismo), es en realidad un traslado desde la farmacia -- se descuenta
      // solo del Qual correspondiente (CITIO o CIPI, este último combinado
      // entre PRO y PED), sin que enfermería tenga que hacer nada aparte.
      // Insumos/soluciones generales no vienen de Qual, no aplica.
      const qualWarehouse = QUAL_FOR_WAREHOUSE[warehouse];
      if (type === "entrada" && qualWarehouse) {
        const medItems = moveList.filter(({ item }) => {
          const cat = effectiveCatalog.find(c => c.item === item)?.category;
          return MED_CATEGORIES.includes(cat);
        });
        if (medItems.length > 0) {
          for (const { item, qty } of medItems) {
            const qualDocId = inventoryDocId(qualWarehouse, item);
            const qualExisting = inventory.find(i => i.id === qualDocId);
            const qualCurrentStock = qualExisting?.currentStock ?? 0;
            const catalogEntry = effectiveCatalog.find(c => c.item === item);
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

      // Lotes de medicamento (Fase 2 de trazabilidad): Qual·CITIO es donde
      // llega de verdad (vía el PDF de transferencia) -- ahí se crea/suma
      // el lote. CITIO solo jala de esos lotes (la "venta oficial" que Qual
      // regresa después): se descuenta del lote en Qual·CITIO y se crea/suma
      // el mismo lote (mismo número) del lado de CITIO.
      const upsertLot = async (lotWarehouse, item, lote, caducidad, marca, deltaQty) => {
        const lotDocId = inventoryLotDocId(lotWarehouse, item, lote);
        const lotExisting = inventoryLots.find(l => l.id === lotDocId);
        const nuevaDisponible = (lotExisting?.cantidadDisponible ?? 0) + deltaQty;
        const res = await fetch(`${FIRESTORE_BASE_URL}/inventory_lots/${lotDocId}`, {
          method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ fields: {
            warehouse: { stringValue: lotWarehouse }, item: { stringValue: item },
            lote: { stringValue: lote }, caducidad: { stringValue: caducidad }, marca: { stringValue: marca || lotExisting?.marca || "" },
            cantidadInicial: toFV((lotExisting?.cantidadInicial ?? 0) + Math.max(deltaQty, 0)),
            cantidadDisponible: toFV(nuevaDisponible),
            lastUpdated: { stringValue: new Date().toISOString() },
          }}),
        });
        await checkOk(res, `Lote "${lote}" de "${item}" en ${warehouseLabel(lotWarehouse)}`);
      };

      if (type === "entrada" && warehouse === "QUAL_CITIO") {
        for (const it of moveList.filter(it => needsLotEntry(it.item))) {
          for (const e of (it.lotEntries || [])) {
            if (e.qty > 0) await upsertLot("QUAL_CITIO", it.item, e.lote, e.caducidad, e.marca, e.qty);
          }
        }
      }
      if (type === "entrada" && warehouse === "CITIO") {
        for (const it of moveList.filter(it => needsLotPick(it.item))) {
          for (const p of (it.lotPicks || []).filter(p => p.qty > 0)) {
            await upsertLot("QUAL_CITIO", it.item, p.lote, p.caducidad, p.marca, -p.qty);
            await upsertLot("CITIO", it.item, p.lote, p.caducidad, p.marca, p.qty);
          }
        }
        // Compra directa a otro proveedor (no pasa por Qual): el lote se
        // captura aquí mismo, igual que en Qual·CITIO, pero se acredita
        // directo a CITIO -- no hay nada que descontar de Qual porque Qual
        // nunca lo tuvo.
        for (const it of moveList.filter(it => needsDirectEntry(it.item))) {
          for (const e of (it.lotEntries || [])) {
            if (e.qty > 0) await upsertLot("CITIO", it.item, e.lote, e.caducidad, e.marca, e.qty);
          }
        }
      }

      setShowMoveModal(null); setMoveList([]); setMoveReason(""); setInvoiceFolio(""); setLinkedPO(null);
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
        {warehouse === "QUAL_CITIO" ? (
          <p style={{ fontSize:12, color:"#ffb347", marginTop:6 }}>
            📦 Aquí llega el medicamento a almacén QUAL/CITIO por transferencia (o carga manual), antes de pasar al centro. El lote se descuenta directo de aquí el mismo día que se usa en una sesión (💊 al dar de baja medicamentos en Insumos) — no espera a que se registre la entrada formal a CITIO. Esa entrada formal solo abona a CITIO cuando llega la factura/cotización oficial, sin volver a descontar de aquí.
          </p>
        ) : warehouse === "QUAL_CIPI" && (
          <p style={{ fontSize:12, color:"#ffb347", marginTop:6 }}>
            📦 Stock general recibido de la farmacia QualMedical para CIPI (PRO y PED juntos), antes de asignarse al centro. Se descuenta solo cuando enfermería registra la entrada del medicamento en el centro correspondiente — no requiere ninguna acción aparte de ellas.
          </p>
        )}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
        {[...WAREHOUSES, ...QUAL_WAREHOUSES].filter(w => !allowedWarehouses || allowedWarehouses.includes(w.key)).map(w => (
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
          {!warehouse.startsWith("QUAL") && (
            <div style={{ display:"flex", gap:6, marginBottom:12 }}>
              {[["", "Todos"], ["insumos", "🧰 Insumos"], ["medicamentos", "💊 Medicamentos"]].map(([val, label]) => (
                <button key={val} onClick={() => setCatFilter(val)} style={{
                  padding:"6px 12px", borderRadius:99, fontSize:11.5, fontWeight:600, cursor:"pointer",
                  background: catFilter === val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${catFilter === val ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                  color: catFilter === val ? "#00d4aa" : "#888",
                }}>{label}</button>
              ))}
            </div>
          )}
          <div style={{ display:"flex", gap:10, marginBottom:16, flexWrap:"wrap", alignItems:"center" }}>
            <input placeholder="Buscar artículo..." value={search} onChange={e => setSearch(e.target.value)} style={{ ...inputStyle, flex:1, minWidth:200 }} />
            <button onClick={() => { setShowMoveModal("entrada"); setMoveList([]); setXmlReview(null); setXmlReceptor(""); setInvoiceFolio(""); setNewItemDraft(null); setLinkedPO(null); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
              ↓ Registrar entrada
            </button>
            <button onClick={() => { setShowMoveModal("salida"); setMoveList([]); setXmlReview(null); setXmlReceptor(""); setInvoiceFolio(""); setNewItemDraft(null); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
              ↑ Registrar salida
            </button>
            {warehouse.startsWith("QUAL") && (
              <button onClick={() => { setShowMoveModal("transferencia"); setMoveList([]); setTransferTo(warehouse === "QUAL_CITIO" ? "QUAL_CIPI" : "QUAL_CITIO"); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC" }}>
                🔄 Transferir a {warehouse === "QUAL_CITIO" ? "Qual CIPI" : "Qual CITIO"}
              </button>
            )}
            <button onClick={() => { setShowMoveModal("compra"); setMoveList([]); setPurchaseConcept(""); setPurchaseNote(""); setEditingPO(null); }} style={{ padding:"8px 16px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.3)", color:"#ffb347" }}>
              🧾 Solicitud de compra
            </button>
            {suggestedReorders.length > 0 && (
              <button onClick={() => {
                  setShowMoveModal("compra");
                  setMoveList(suggestedReorders.map(i => ({ item: i.item, qty: reorderInfo(i).suggestQty })));
                  setPurchaseConcept(`Reabastecimiento sugerido ${new Date().toLocaleDateString("es-MX")}`);
                  setPurchaseNote(""); setEditingPO(null);
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
                // CITIO sí muestra lotes en negativo -- es justo lo "pendiente
                // de compra" (ya se usó en una sesión antes de que CITIO lo
                // comprara formalmente). Qual·CITIO no, ahí un lote en 0 ya
                // no tiene nada que mostrar.
                const itemLots = (warehouse === "CITIO" || warehouse === "QUAL_CITIO") && isMedForLot(i.item)
                  ? inventoryLots.filter(l => l.warehouse === warehouse && l.item === i.item && (warehouse === "CITIO" ? (l.cantidadDisponible ?? 0) !== 0 : (l.cantidadDisponible ?? 0) > 0)).sort((a,b) => (a.caducidad||"").localeCompare(b.caducidad||""))
                  : [];
                return (
                  <div key={i.id} style={{ display:"flex", flexDirection:"column", gap:6, padding:"10px 14px", borderRadius:10, background: negative ? "rgba(255,107,107,0.06)" : "rgba(255,255,255,0.03)", border:`1px solid ${negative ? "rgba(255,107,107,0.4)" : low ? "rgba(255,107,107,0.3)" : "rgba(255,255,255,0.07)"}` }}>
                  <div style={{ display:"flex", alignItems:"center", gap:10 }}>
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
                    {isJefe && (
                      <button onClick={() => openAdjustStock(i)} title="Corregir a mano la existencia real de este artículo (reemplaza el número, no lo suma) -- para cuando no hay ningún lote que corregir"
                        style={{ padding:"2px 7px", borderRadius:6, fontSize:10, fontWeight:700, cursor:"pointer", background:"rgba(79,195,247,0.1)", border:"1px solid rgba(79,195,247,0.3)", color:"#4fc3f7" }}>
                        ✏️
                      </button>
                    )}
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
                  {itemLots.length > 0 && (
                    <div style={{ display:"flex", gap:6, flexWrap:"wrap", paddingLeft:2 }}>
                      {itemLots.map(l => {
                        const isNeg = (l.cantidadDisponible ?? 0) < 0;
                        return (
                          <span key={l.id} title={`Marca: ${l.marca || "—"}${isNeg ? " -- pendiente de compra (ya se usó en una sesión, falta la cotización)" : ""}`}
                            style={{ fontSize:10, padding:"2px 8px", borderRadius:99, display:"inline-flex", alignItems:"center", gap:5,
                              background: isNeg ? "rgba(255,107,107,0.08)" : "rgba(0,212,170,0.08)",
                              border: `1px solid ${isNeg ? "rgba(255,107,107,0.25)" : "rgba(0,212,170,0.2)"}`,
                              color: isNeg ? "#ff6b6b" : "#00d4aa" }}>
                            🏷️ {l.lote} · cad. {l.caducidad} · {l.cantidadDisponible} {i.unit}
                            {isNeg && warehouse === "CITIO" && (
                              <button onClick={() => openRegularizeCotizacion(l)} title="Registrar la cotización oficial de este lote -- abona a CITIO sin volver a tocar Qual·CITIO"
                                style={{ padding:"1px 6px", borderRadius:99, fontSize:9, fontWeight:700, cursor:"pointer", background:"rgba(255,179,71,0.15)", border:"1px solid rgba(255,179,71,0.3)", color:"#ffb347" }}>
                                💰 cotización
                              </button>
                            )}
                            {isJefe && (
                              <button onClick={() => openAdjustLot(l)} title="Corregir a mano la cantidad real de este lote (reemplaza el número, no lo suma) -- también recalcula la existencia agregada"
                                style={{ padding:"1px 6px", borderRadius:99, fontSize:9, fontWeight:700, cursor:"pointer", background:"rgba(79,195,247,0.12)", border:"1px solid rgba(79,195,247,0.3)", color:"#4fc3f7" }}>
                                ✏️ ajustar
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "movimientos" && (() => {
        const warehouseEvents = events.filter(e => e.warehouse === warehouse
          && (!catFilterActive || (Array.isArray(e.items) ? e.items : []).some(it => catFilter === "medicamentos" ? isMedItem(it.item) : !isMedItem(it.item))));
        return (
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {!warehouse.startsWith("QUAL") && (
            <div style={{ display:"flex", gap:6, marginBottom:4 }}>
              {[["", "Todos"], ["insumos", "🧰 Insumos"], ["medicamentos", "💊 Medicamentos"]].map(([val, label]) => (
                <button key={val} onClick={() => setCatFilter(val)} style={{
                  padding:"6px 12px", borderRadius:99, fontSize:11.5, fontWeight:600, cursor:"pointer",
                  background: catFilter === val ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${catFilter === val ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                  color: catFilter === val ? "#00d4aa" : "#888",
                }}>{label}</button>
              ))}
            </div>
          )}
          {warehouseEvents.length === 0 ? (
            <div style={{ color:"#444", fontSize:14, padding:40, textAlign:"center", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:14 }}>
              Sin movimientos registrados todavía en este almacén.
            </div>
          ) : warehouseEvents.map(ev => {
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
        );
      })()}

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
            const closed = po.status === "cerrada";
            const isTerminal = received || closed; // ya no se puede editar ni volver a firmar
            return (
              <div key={po.id} style={{ background:"rgba(255,255,255,0.03)", border:"1px solid rgba(255,255,255,0.07)", borderRadius:12, overflow:"hidden", opacity: closed ? 0.55 : 1 }}>
                <div onClick={() => setExpandedPO(isOpen ? null : po.id)} style={{ padding:"12px 16px", cursor:"pointer", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
                  <span style={{ flex:1, fontSize:13, color:"#f0f0f0", fontWeight:600, minWidth:160, textDecoration: closed ? "line-through" : "none" }}>{po.concepto}</span>
                  <span style={{ fontSize:11, color:"#666" }}>{poItems.length} artículo{poItems.length!==1?"s":""}</span>
                  {po.note && <span title={po.note} style={{ fontSize:11, color:"#4fc3f7" }}>📝</span>}
                  <span style={{ fontSize:11, color:"#555" }}>{po.requestedByName || ""}{po.requestedAt ? " · " + new Date(po.requestedAt).toLocaleDateString("es-MX") : ""}</span>
                  <span style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99,
                    background: received ? "rgba(0,212,170,0.12)" : closed ? "rgba(255,107,107,0.1)" : "rgba(255,255,255,0.05)",
                    color: received ? "#00d4aa" : closed ? "#ff6b6b" : "#888" }}>
                    {received ? "✓ Recibida" : closed ? "✕ Cerrada" : "⏳ Pendiente"}
                  </span>
                  {!closed && (
                    <span title={po.authorizedBy ? `Autorizado por ${po.authorizedByName || ""}` : po.validatedBy ? `Validado por ${po.validatedByName || ""} — falta autorización del jefe` : "Pendiente del checkup de Paola"}
                      style={{ fontSize:11, fontWeight:600, padding:"2px 8px", borderRadius:99,
                      background: po.authorizedBy ? "rgba(0,212,170,0.12)" : "rgba(255,179,71,0.1)",
                      color: po.authorizedBy ? "#00d4aa" : "#ffb347" }}>
                      {po.authorizedBy ? "✓ Autorizada" : po.validatedBy ? "◐ Validada" : "⏳ Sin validar"}
                    </span>
                  )}
                  <span style={{ color:"#555" }}>{isOpen ? "▲" : "▼"}</span>
                </div>
                {isOpen && (
                  <div style={{ padding:"0 16px 14px", display:"flex", flexDirection:"column", gap:4 }}>
                    {po.note && (
                      <div style={{ fontSize:11, color:"#4fc3f7", marginBottom:6, padding:"6px 8px", background:"rgba(79,195,247,0.06)", borderRadius:6 }}>📝 {po.note}</div>
                    )}
                    {closed && (
                      <div style={{ fontSize:11, color:"#ff6b6b", marginBottom:6, padding:"6px 8px", background:"rgba(255,107,107,0.06)", borderRadius:6 }}>
                        ✕ Cerrada por {po.closedByName || ""}{po.closedAt ? " · " + new Date(po.closedAt).toLocaleString("es-MX") : ""} — {po.closeReason}
                      </div>
                    )}
                    {received && po.receivedByEventId && (
                      <div style={{ fontSize:11, color:"#00d4aa", marginBottom:6, padding:"6px 8px", background:"rgba(0,212,170,0.06)", borderRadius:6 }}>
                        ✓ Recibida — ligada a la entrada registrada{po.receivedAt ? " · " + new Date(po.receivedAt).toLocaleString("es-MX") : ""}
                      </div>
                    )}
                    {poItems.map((t,ti) => (
                      <div key={ti} style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#aaa", padding:"3px 0" }}>
                        <span>{t.item}</span><span style={{ color:"#00d4aa" }}>{t.qty}</span>
                      </div>
                    ))}
                    <div style={{ display:"flex", gap:8, marginTop:8, flexWrap:"wrap" }}>
                      {!isTerminal && canValidate && !po.validatedBy && (
                        <button onClick={e => { e.stopPropagation(); validatePurchaseOrder(po.id); }} disabled={savingPOAction === po.id}
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(255,179,71,0.1)", border:"1px solid rgba(255,179,71,0.25)", color:"#ffb347" }}>
                          {savingPOAction===po.id ? "Guardando…" : "✓ Validar (checkup)"}
                        </button>
                      )}
                      {!isTerminal && canAuthorize && po.validatedBy && !po.authorizedBy && (
                        <button onClick={e => { e.stopPropagation(); authorizePurchaseOrder(po.id); }} disabled={savingPOAction === po.id}
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(175,169,236,0.1)", border:"1px solid rgba(175,169,236,0.3)", color:"#AFA9EC" }}>
                          {savingPOAction===po.id ? "Guardando…" : "✓ Autorizar"}
                        </button>
                      )}
                      {!isTerminal && (
                        <button onClick={e => {
                            e.stopPropagation();
                            setEditingPO(po);
                            setMoveList(poItems.map(({ item, qty }) => ({ item, qty })));
                            setPurchaseConcept(po.concepto || "");
                            setPurchaseNote(po.note || "");
                            setShowMoveModal("compra");
                          }}
                          title="Corregir concepto, nota o artículos -- vuelve a generar el PDF y reinicia la validación/autorización"
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#ccc" }}>
                          ✏️ Editar
                        </button>
                      )}
                      {!isTerminal && (
                        <button onClick={e => { e.stopPropagation(); closePurchaseOrder(po); }} disabled={savingPOAction === po.id}
                          title="La solicitud no se va a concretar por la vía normal (se canceló, se duplicó, se resolvió de otra forma) -- pide motivo y queda como registro, nunca se borra. Ya no se podrá editar después."
                          style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: savingPOAction===po.id ? "wait" : "pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>
                          ✕ Cerrar
                        </button>
                      )}
                      <button onClick={e => { e.stopPropagation(); reprintPurchaseOrder(po); }} disabled={reprintingPO === po.id}
                        title="Volver a generar el PDF -- útil para obtener una copia con las firmas ya al día"
                        style={{ padding:"5px 12px", borderRadius:8, fontSize:11, fontWeight:600, cursor: reprintingPO===po.id ? "wait" : "pointer", background:"rgba(255,255,255,0.04)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                        {reprintingPO===po.id ? "…" : "🖨️ Reimprimir"}
                      </button>
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
        // La categoría GUARDADA en el documento de inventario puede haber
        // quedado desactualizada (si el catálogo cambió después); se
        // reconsulta el catálogo actual por nombre para clasificar bien.
        // Cloruro de sodio, glucosa 5%, Hartmann y agua estéril ya están
        // catalogados como "Soluciones" (no "Medicamentos") -- se compran al
        // mayoreo como insumo, no por paciente vía Qual (ver materialCatalog.js).
        const catalogByNameGeneral = {};
        effectiveCatalog.forEach(c => { catalogByNameGeneral[c.item.toUpperCase()] = c.category; });
        const currentCategory = (r) => catalogByNameGeneral[r.item.toUpperCase()] || r.category;
        const materialRows = allRows.filter(r => !MED_CATEGORIES.includes(currentCategory(r)));
        const medRows = allRows.filter(r => MED_CATEGORIES.includes(currentCategory(r)));

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
        <div onClick={() => !saving && (setShowMoveModal(null), setXmlReview(null), setXmlReceptor(""), setEditingPO(null), setNewItemDraft(null), setLinkedPO(null))}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:460, maxHeight:"85vh", overflowY:"auto", display:"flex", flexDirection:"column", gap:12 }}>
            <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>
              {showMoveModal === "entrada" ? "↓ Registrar entrada" : showMoveModal === "salida" ? "↑ Registrar salida" : showMoveModal === "compra" ? (editingPO ? "✏️ Editar solicitud de compra" : "🧾 Solicitud de compra") : "🔄 Transferir"} — {warehouseLabel(warehouse)}
            </div>

            {showMoveModal === "compra" && (
              <div>
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Concepto de la solicitud</label>
                <input placeholder="Ej. Reabastecimiento de insumos generales" value={purchaseConcept} onChange={e => setPurchaseConcept(e.target.value)} style={inputStyle} />
                <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", margin:"10px 0 4px" }}>Nota (opcional)</label>
                <textarea placeholder="Ej. motivo del pedido, instrucciones para el proveedor..." value={purchaseNote} onChange={e => setPurchaseNote(e.target.value)}
                  rows={2} style={{ ...inputStyle, resize:"vertical" }} />
                <div style={{ fontSize:10, color:"#666", marginTop:4 }}>Este documento solo genera el PDF para pedirlo a QualMedical -- no descuenta ni suma nada al inventario. La entrada real se registra aparte cuando llegue la mercancía.</div>
              </div>
            )}

            {showMoveModal === "transferencia" && (
              <div style={{ padding:"8px 12px", borderRadius:9, background:"rgba(175,169,236,0.08)", border:"1px solid rgba(175,169,236,0.25)", fontSize:12, color:"#AFA9EC" }}>
                Destino: <strong>{warehouseLabel(transferTo)}</strong>
              </div>
            )}

            {showMoveModal === "entrada" && (() => {
              const pendingPOs = purchaseOrders.filter(po => po.warehouse === warehouse && po.status === "pendiente");
              if (pendingPOs.length === 0) return null;
              return (
                <div style={{ padding:"10px 12px", borderRadius:9, background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.2)" }}>
                  <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:6 }}>¿Corresponde a una solicitud de compra pendiente?</label>
                  <select value={linkedPO?.id || ""} onChange={e => setLinkedPO(pendingPOs.find(po => po.id === e.target.value) || null)}
                    style={{ ...inputStyle, cursor:"pointer" }}>
                    <option value="">— No, es una entrada independiente —</option>
                    {pendingPOs.map(po => <option key={po.id} value={po.id}>{po.concepto} · {po.requestedByName || ""}</option>)}
                  </select>
                  {linkedPO && (
                    <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, marginTop:8 }}>
                      <div style={{ fontSize:10, color:"#00d4aa" }}>Al registrar, esta solicitud se marcará como recibida.</div>
                      <button onClick={() => setMoveList(prev => {
                          const map = new Map(prev.map(x => [x.item, { qty:x.qty, cost:x.cost }]));
                          (linkedPO.items||[]).forEach(({ item, qty }) => {
                            const existing = map.get(item);
                            map.set(item, { qty:(existing?.qty||0)+qty, cost:existing?.cost });
                          });
                          return Array.from(map, ([item,v]) => ({ item, qty:v.qty, cost:v.cost }));
                        })}
                        style={{ padding:"4px 10px", borderRadius:7, fontSize:10, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap", background:"rgba(0,212,170,0.12)", border:"1px solid rgba(0,212,170,0.3)", color:"#00d4aa" }}>
                        + Precargar sus artículos
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {showMoveModal === "entrada" && !xmlReview && (
              <div style={{ display:"flex", gap:8 }}>
                <label style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(175,169,236,0.1)", border:"1px dashed rgba(175,169,236,0.35)", color:"#AFA9EC" }}>
                  📄 Factura (XML)
                  <input type="file" accept=".xml" style={{ display:"none" }} onChange={e => handleXmlFile(e.target.files?.[0])} />
                </label>
                <label style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"10px", borderRadius:9, fontSize:12, fontWeight:600, cursor:"pointer", background:"rgba(255,179,71,0.1)", border:"1px dashed rgba(255,179,71,0.35)", color:"#ffb347" }}>
                  📑 Transferencia/Cotización (PDF)
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
                      {(r.lote || r.caducidad || r.marca) && (
                        <div style={{ fontSize:10, color:"#00d4aa", marginBottom:4 }}>Detectado en el PDF: {[r.marca && `marca ${r.marca}`, r.lote && `lote ${r.lote}`, r.caducidad && `caduca ${r.caducidad}`].filter(Boolean).join(" · ")} (se puede corregir abajo)</div>
                      )}
                      <select value={r.matchedItem} onChange={e => {
                          if (e.target.value === "__new__") {
                            setNewItemDraft({ rowIndex: i, nombre: r.descripcion, categoria: "Insumos", unidad: "PIEZA" });
                            return;
                          }
                          setXmlReview(prev => prev.map((x,xi) => xi===i ? { ...x, matchedItem: e.target.value } : x));
                        }}
                        style={{ width:"100%", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"6px 8px", color: r.matchedItem ? "#f0f0f0" : "#ff6b6b", fontSize:12, outline:"none", cursor:"pointer" }}>
                        <option value="">— Sin emparejar (no se agregará) —</option>
                        <option value="__new__">+ Crear producto nuevo con este nombre…</option>
                        {effectiveCatalog.map((c,ci) => <option key={ci} value={c.item}>{c.item}</option>)}
                      </select>
                      {newItemDraft?.rowIndex === i && (
                        <div style={{ marginTop:6, padding:"8px", borderRadius:7, background:"rgba(0,212,170,0.05)", border:"1px solid rgba(0,212,170,0.2)", display:"flex", flexDirection:"column", gap:6 }}>
                          <input value={newItemDraft.nombre} onChange={e => setNewItemDraft(d => ({ ...d, nombre: e.target.value }))}
                            placeholder="Nombre del producto" style={{ ...inputStyle, fontSize:12 }} />
                          <div style={{ display:"flex", gap:6 }}>
                            <select value={newItemDraft.categoria} onChange={e => setNewItemDraft(d => ({ ...d, categoria: e.target.value }))} style={{ ...inputStyle, fontSize:12, flex:1 }}>
                              <option>Insumos</option><option>Soluciones</option><option>Medicamentos</option><option>Oncológicos</option><option>Inmunoterapia</option>
                            </select>
                            <input value={newItemDraft.unidad} onChange={e => setNewItemDraft(d => ({ ...d, unidad: e.target.value }))}
                              placeholder="Unidad" style={{ ...inputStyle, fontSize:12, width:80 }} />
                          </div>
                          <div style={{ display:"flex", gap:6 }}>
                            <button onClick={() => setNewItemDraft(null)} style={{ flex:1, padding:"6px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>Cancelar</button>
                            <button onClick={createExtraCatalogItem} disabled={savingNewItem || !newItemDraft.nombre.trim()}
                              style={{ flex:2, padding:"6px", borderRadius:6, fontSize:11, fontWeight:600, cursor: savingNewItem ? "wait" : "pointer", background:"rgba(0,212,170,0.15)", border:"1px solid rgba(0,212,170,0.4)", color:"#00d4aa" }}>
                              {savingNewItem ? "Creando…" : "✓ Crear y usar"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={() => { setXmlReview(null); setNewItemDraft(null); }} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:12, cursor:"pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
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
                  {effectiveCatalog.filter(c => c.item.toUpperCase().includes(moveSearch.toUpperCase())).slice(0, 10).map((c, i) => (
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
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:280, overflowY:"auto" }}>
                {moveList.map((it, i) => {
                  const showLotEntry = showMoveModal === "entrada" && needsLotEntry(it.item);
                  const showDirectEntry = showMoveModal === "entrada" && needsDirectEntry(it.item);
                  const showLotPick = showMoveModal === "entrada" && needsLotPick(it.item);
                  const showSourceToggle = showMoveModal === "entrada" && warehouse === "CITIO" && isMedForLot(it.item);
                  const qualLots = showLotPick ? availableQualLots(it.item) : [];
                  const pickedTotal = (it.lotPicks || []).reduce((acc, p) => acc + p.qty, 0);
                  return (
                  <div key={i} style={{ display:"flex", flexDirection:"column", gap:5, padding:"6px 8px", borderRadius:8, background:"rgba(255,255,255,0.03)" }}>
                    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                      <span style={{ flex:1, fontSize:12, color:"#f0f0f0" }}>{it.item}</span>
                      <input type="number" min="0" value={it.qty} readOnly={showLotPick || showLotEntry || showDirectEntry} disabled={showLotPick || showLotEntry || showDirectEntry}
                        onChange={e => setMoveListQty(it.item, parseInt(e.target.value) || 0)}
                        title={showLotPick ? "Se calcula sola con lo elegido por lote" : (showLotEntry || showDirectEntry) ? "Se calcula sola con la suma de los lotes" : "Cantidad"}
                        style={{ width:56, background: (showLotPick || showLotEntry || showDirectEntry) ? "rgba(255,255,255,0.02)" : "rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color: (showLotPick || showLotEntry || showDirectEntry) ? "#888" : "#f0f0f0", fontSize:12, outline:"none", textAlign:"center" }} />
                      {showMoveModal === "entrada" && (
                        <input type="number" min="0" step="0.01" placeholder="$ costo c/u" value={it.cost ?? ""}
                          onChange={e => setMoveList(prev => prev.map(x => x.item===it.item ? { ...x, cost: e.target.value === "" ? undefined : parseFloat(e.target.value) } : x))}
                          title="Costo unitario (opcional)"
                          style={{ width:76, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"4px 6px", color:"#00d4aa", fontSize:12, outline:"none", textAlign:"center" }} />
                      )}
                      <button onClick={() => removeFromMoveList(it.item)} style={{ padding:"3px 8px", borderRadius:6, fontSize:11, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                    </div>
                    {showSourceToggle && (
                      <div style={{ display:"flex", gap:6, paddingLeft:2 }}>
                        <button onClick={() => setDirectSource(it.item, false)}
                          style={{ padding:"3px 9px", borderRadius:6, fontSize:10, fontWeight:600, cursor:"pointer",
                            background: !it.directSource ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.04)",
                            border:`1px solid ${!it.directSource ? "rgba(0,212,170,0.3)" : "rgba(255,255,255,0.08)"}`,
                            color: !it.directSource ? "#00d4aa" : "#666" }}>
                          🔄 Jalar de Qual·CITIO
                        </button>
                        <button onClick={() => setDirectSource(it.item, true)}
                          title="El medicamento no vino de Qual -- lo compró CITIO directo a otro proveedor"
                          style={{ padding:"3px 9px", borderRadius:6, fontSize:10, fontWeight:600, cursor:"pointer",
                            background: it.directSource ? "rgba(255,179,71,0.12)" : "rgba(255,255,255,0.04)",
                            border:`1px solid ${it.directSource ? "rgba(255,179,71,0.3)" : "rgba(255,255,255,0.08)"}`,
                            color: it.directSource ? "#ffb347" : "#666" }}>
                          📦 Compra directa (otro proveedor)
                        </button>
                      </div>
                    )}
                    {(showLotEntry || showDirectEntry) && (
                      <div style={{ display:"flex", flexDirection:"column", gap:4, paddingLeft:2 }}>
                        {(it.lotEntries || []).map((e, ei) => (
                          <div key={ei} style={{ display:"flex", gap:5 }}>
                            <input placeholder="Lote *" value={e.lote || ""} onChange={ev => setLotEntryField(it.item, ei, "lote", ev.target.value)}
                              style={{ flex:1, minWidth:0, background: e.lote ? "rgba(255,255,255,0.05)" : "rgba(255,107,107,0.06)", border:`1px solid ${e.lote ? "rgba(255,255,255,0.09)" : "rgba(255,107,107,0.3)"}`, borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:11, outline:"none" }} />
                            <input type="date" placeholder="Caducidad *" value={e.caducidad || ""} onChange={ev => setLotEntryField(it.item, ei, "caducidad", ev.target.value)}
                              style={{ flex:1, minWidth:0, background: e.caducidad ? "rgba(255,255,255,0.05)" : "rgba(255,107,107,0.06)", border:`1px solid ${e.caducidad ? "rgba(255,255,255,0.09)" : "rgba(255,107,107,0.3)"}`, borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:11, outline:"none" }} />
                            <input placeholder="Marca *" value={e.marca || ""} onChange={ev => setLotEntryField(it.item, ei, "marca", ev.target.value)}
                              style={{ flex:1, minWidth:0, background: e.marca ? "rgba(255,255,255,0.05)" : "rgba(255,107,107,0.06)", border:`1px solid ${e.marca ? "rgba(255,255,255,0.09)" : "rgba(255,107,107,0.3)"}`, borderRadius:6, padding:"4px 6px", color:"#f0f0f0", fontSize:11, outline:"none" }} />
                            <input type="number" min="0" placeholder="Cant *" value={e.qty || ""} onChange={ev => setLotEntryQty(it.item, ei, parseInt(ev.target.value) || 0)}
                              style={{ width:52, background: e.qty > 0 ? "rgba(255,255,255,0.05)" : "rgba(255,107,107,0.06)", border:`1px solid ${e.qty > 0 ? "rgba(255,255,255,0.09)" : "rgba(255,107,107,0.3)"}`, borderRadius:6, padding:"4px 6px", color:"#00d4aa", fontSize:11, outline:"none", textAlign:"center" }} />
                            {(it.lotEntries || []).length > 1 && (
                              <button onClick={() => removeLotEntryRow(it.item, ei)} style={{ padding:"3px 7px", borderRadius:6, fontSize:10, cursor:"pointer", background:"rgba(255,107,107,0.1)", border:"1px solid rgba(255,107,107,0.25)", color:"#ff6b6b" }}>✕</button>
                            )}
                          </div>
                        ))}
                        <button onClick={() => addLotEntryRow(it.item)} style={{ alignSelf:"flex-start", padding:"3px 10px", borderRadius:6, fontSize:10, fontWeight:600, cursor:"pointer", background:"rgba(0,212,170,0.08)", border:"1px solid rgba(0,212,170,0.25)", color:"#00d4aa" }}>
                          + Otro lote de este mismo artículo
                        </button>
                      </div>
                    )}
                    {showLotPick && (
                      <div style={{ paddingLeft:2, display:"flex", flexDirection:"column", gap:4 }}>
                        {qualLots.length === 0 ? (
                          <div style={{ fontSize:11, color:"#ff6b6b" }}>⚠ No hay lotes disponibles en Qual·CITIO para este artículo -- regístralo ahí primero.</div>
                        ) : (
                          <>
                            {qualLots.map(lot => {
                              const pick = (it.lotPicks || []).find(p => p.lotId === lot.id);
                              return (
                                <div key={lot.id} style={{ display:"flex", alignItems:"center", gap:6, fontSize:11 }}>
                                  <span style={{ flex:1, color:"#ccc" }}>🏷️ {lot.lote} · cad. {lot.caducidad} · {lot.marca} <span style={{ color:"#555" }}>(disp. {lot.cantidadDisponible})</span></span>
                                  <input type="number" min="0" max={lot.cantidadDisponible} placeholder="0" value={pick?.qty || ""}
                                    onChange={e => setLotPickQty(it.item, lot, parseInt(e.target.value) || 0)}
                                    style={{ width:56, background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", borderRadius:6, padding:"3px 6px", color:"#00d4aa", fontSize:11, outline:"none", textAlign:"center" }} />
                                </div>
                              );
                            })}
                            <div style={{ fontSize:10, color: pickedTotal > 0 ? "#00d4aa" : "#888" }}>Tomando {pickedTotal} en total</div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
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
              <button onClick={() => { setShowMoveModal(null); setEditingPO(null); setNewItemDraft(null); setLinkedPO(null); }} disabled={saving} style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: saving ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={showMoveModal === "transferencia" ? registerTransfer : showMoveModal === "compra" ? generatePurchaseOrder : registerMovement}
                disabled={saving || moveList.length===0 || (showMoveModal === "transferencia" && !transferTo) || (showMoveModal === "compra" && !purchaseConcept.trim())}
                style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: (saving || moveList.length===0) ? "not-allowed" : "pointer",
                background: showMoveModal === "entrada" ? "linear-gradient(135deg,#00d4aa,#0F6E56)" : showMoveModal === "transferencia" ? "linear-gradient(135deg,#AFA9EC,#8B7FD8)" : showMoveModal === "compra" ? "linear-gradient(135deg,#ffb347,#e08e2a)" : "linear-gradient(135deg,#ff6b6b,#c94848)", border:"none", color: showMoveModal === "compra" ? "#000" : "#fff", opacity: (saving || moveList.length===0) ? 0.5 : 1 }}>
                {saving ? (showMoveModal === "compra" ? "Generando…" : "Guardando…") : `✓ ${showMoveModal === "transferencia" ? "Transferir" : showMoveModal === "compra" ? (editingPO ? "Guardar cambios" : "Generar PDF") : "Guardar"} (${moveList.length} artículo${moveList.length!==1?"s":""})`}
              </button>
            </div>
          </div>
        </div>
      )}

      {regularizeLot && (
        <div onClick={() => !savingRegularize && setRegularizeLot(null)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:400, display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>💰 Registrar cotización</div>
              <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{regularizeLot.item} — lote {regularizeLot.lote} · cad. {regularizeLot.caducidad}</div>
              <div style={{ fontSize:11, color:"#666", marginTop:6 }}>
                Esto solo le abona a CITIO -- no vuelve a descontar Qual·CITIO (ya se descontó el día de la sesión en que se usó). Captura la cantidad que viene en la factura/cotización oficial.
              </div>
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Cantidad comprada (según la cotización)</label>
              <input type="number" min="0" step="0.01" value={regularizeQty} onChange={e => setRegularizeQty(e.target.value)} autoFocus
                style={{ ...inputStyle, fontFamily:"'IBM Plex Mono', monospace" }} />
              <div style={{ fontSize:10, color:"#555", marginTop:4 }}>Saldo actual: {regularizeLot.cantidadDisponible} -- con esta cantidad quedaría en {(regularizeLot.cantidadDisponible ?? 0) + (parseFloat(regularizeQty) || 0)}.</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setRegularizeLot(null)} disabled={savingRegularize}
                style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: savingRegularize ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={saveRegularizeCotizacion} disabled={savingRegularize}
                style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: savingRegularize ? "wait" : "pointer", background:"linear-gradient(135deg,#ffb347,#e08e2a)", border:"none", color:"#000", opacity: savingRegularize ? 0.6 : 1 }}>
                {savingRegularize ? "Guardando…" : "✓ Registrar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {adjustLot && (
        <div onClick={() => !savingAdjust && setAdjustLot(null)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:400, display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>✏️ Ajustar cantidad real</div>
              <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{adjustLot.item} — lote {adjustLot.lote} · cad. {adjustLot.caducidad} · {warehouseLabel(adjustLot.warehouse)}</div>
              <div style={{ fontSize:11, color:"#666", marginTop:6 }}>
                Esto reemplaza la cantidad de este lote por la que captures aquí (no se suma) -- úsalo para poner el número real cuando quedó mal, por ejemplo por sesiones dadas de baja antes de que existiera el registro de lote. También se recalcula la existencia agregada de este artículo en {warehouseLabel(adjustLot.warehouse)} como la suma de todos sus lotes.
              </div>
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Cantidad real (puede ser 0)</label>
              <input type="number" step="0.01" value={adjustQty} onChange={e => setAdjustQty(e.target.value)} autoFocus
                style={{ ...inputStyle, fontFamily:"'IBM Plex Mono', monospace" }} />
              <div style={{ fontSize:10, color:"#555", marginTop:4 }}>Saldo actual: {adjustLot.cantidadDisponible}.</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setAdjustLot(null)} disabled={savingAdjust}
                style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: savingAdjust ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={saveAdjustLot} disabled={savingAdjust}
                style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: savingAdjust ? "wait" : "pointer", background:"linear-gradient(135deg,#4fc3f7,#2f8fb3)", border:"none", color:"#000", opacity: savingAdjust ? 0.6 : 1 }}>
                {savingAdjust ? "Guardando…" : "✓ Ajustar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {adjustStock && (
        <div onClick={() => !savingAdjustStock && setAdjustStock(null)}
          style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", display:"flex", alignItems:"center", justifyContent:"center", zIndex:1000, padding:16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background:"#161616", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:20, width:"100%", maxWidth:400, display:"flex", flexDirection:"column", gap:12 }}>
            <div>
              <div style={{ fontSize:15, fontWeight:600, color:"#f0f0f0" }}>✏️ Ajustar existencia real</div>
              <div style={{ fontSize:12, color:"#888", marginTop:2 }}>{adjustStock.item} — {warehouseLabel(adjustStock.warehouse)}</div>
              <div style={{ fontSize:11, color:"#666", marginTop:6 }}>
                Esto reemplaza la existencia de este artículo por la que captures aquí (no se suma) -- úsalo cuando no haya ningún lote que corregir. Si este artículo sí tiene lotes, es mejor ajustarlos a ellos (🏷️ ✏️ ajustar) en vez de este número, porque ese ajuste ya recalcula esto solo.
              </div>
            </div>
            <div>
              <label style={{ fontSize:11, color:"#666", textTransform:"uppercase", display:"block", marginBottom:4 }}>Cantidad real (puede ser 0)</label>
              <input type="number" step="0.01" value={adjustStockQty} onChange={e => setAdjustStockQty(e.target.value)} autoFocus
                style={{ ...inputStyle, fontFamily:"'IBM Plex Mono', monospace" }} />
              <div style={{ fontSize:10, color:"#555", marginTop:4 }}>Saldo actual: {adjustStock.currentStock}.</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={() => setAdjustStock(null)} disabled={savingAdjustStock}
                style={{ flex:1, padding:"9px", borderRadius:9, fontSize:13, cursor: savingAdjustStock ? "wait" : "pointer", background:"rgba(255,255,255,0.05)", border:"1px solid rgba(255,255,255,0.09)", color:"#888" }}>
                Cancelar
              </button>
              <button onClick={saveAdjustStock} disabled={savingAdjustStock}
                style={{ flex:2, padding:"9px", borderRadius:9, fontSize:13, fontWeight:600, cursor: savingAdjustStock ? "wait" : "pointer", background:"linear-gradient(135deg,#4fc3f7,#2f8fb3)", border:"none", color:"#000", opacity: savingAdjustStock ? 0.6 : 1 }}>
                {savingAdjustStock ? "Guardando…" : "✓ Ajustar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
