// Mostrar un PDF generado (blob) al usuario -- antes cada pantalla hacía
// `window.open(URL.createObjectURL(blob), "_blank")`, que funciona bien en
// una pestaña normal de navegador pero falla en la app instalada como PWA
// (todo el personal la usa así): un WebView en modo standalone no siempre
// sabe navegar a una URL blob: en una "pestaña nueva" y termina mostrando
// su propio error genérico de red, aunque el PDF sí se haya generado bien
// en el servidor. Forzar la descarga (en vez de intentar abrir una pestaña)
// evita ese problema por completo -- funciona igual dentro y fuera de la
// app instalada, en cualquier plataforma.
export function openPdfBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "documento.pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
