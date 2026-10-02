// Mostrar un PDF generado (blob) al usuario.
//
// Antes cada pantalla hacía `window.open(URL.createObjectURL(blob), "_blank")`,
// que funciona en una pestaña normal de navegador pero falla en la app
// instalada como PWA (todo el personal la usa así): el WebView en modo
// standalone no siempre sabe navegar a una URL blob: en una "pestaña nueva"
// y termina mostrando su propio error genérico de red.
//
// La primera corrección forzaba la descarga de TODOS los PDF -- resolvía lo
// anterior, pero muchos documentos solo se consultan o se imprimen una vez,
// sin necesidad de guardarlos, así que descargar todo de más fue un paso
// atrás. Ahora se abre un visor dentro de la misma app (modal con iframe)
// con botones aparte para Imprimir y Descargar -- nada se guarda solo, y
// "Imprimir" no depende de que el WebView sepa abrir pestañas nuevas.
export function openPdfBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  let closed = false;

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;flex-direction:column;";

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:"
    + "10px max(10px, env(safe-area-inset-right)) 10px max(10px, env(safe-area-inset-left));"
    + "background:#161616;border-bottom:1px solid rgba(255,255,255,0.1);flex-shrink:0;";

  const mkBtn = (label, bg, border, color) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = `padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;background:${bg};border:1px solid ${border};color:${color};white-space:nowrap;`;
    return b;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    document.body.removeChild(overlay);
    document.body.style.overflow = "";
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.title = filename || "documento.pdf";
  iframe.style.cssText = "flex:1;border:none;width:100%;background:#525659;";

  const printBtn = mkBtn("🖨️ Imprimir", "rgba(0,212,170,0.12)", "rgba(0,212,170,0.3)", "#00d4aa");
  printBtn.onclick = () => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch (e) {
      alert("No se pudo abrir el diálogo de impresión aquí. Usa \"Descargar\" y ábrelo desde el visor de PDF de tu dispositivo para imprimirlo.");
    }
  };

  const downloadBtn = mkBtn("⬇️ Descargar", "rgba(255,255,255,0.06)", "rgba(255,255,255,0.15)", "#ccc");
  downloadBtn.onclick = () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || "documento.pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const closeBtn = mkBtn("✕ Cerrar", "rgba(255,255,255,0.06)", "rgba(255,255,255,0.15)", "#999");
  closeBtn.onclick = close;

  bar.appendChild(printBtn);
  bar.appendChild(downloadBtn);
  bar.appendChild(closeBtn);
  overlay.appendChild(bar);
  overlay.appendChild(iframe);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
}
