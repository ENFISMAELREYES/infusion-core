// Renderizador genérico de "bloques" de contenido (párrafo, encabezado,
// viñeta, nota destacada) -- lo comparten el panel de ayuda ("?") y
// Manuales y guías, para que el mismo tipo de contenido estructurado se
// vea igual en los dos lugares.
export const TONE = {
  info:   { color: "#3b82f6", bg: "rgba(59,130,246,0.08)" },
  warn:   { color: "#e08a1e", bg: "rgba(224,138,30,0.08)" },
  danger: { color: "#e04a3f", bg: "rgba(224,74,63,0.08)" },
  tip:    { color: "#00d4aa", bg: "rgba(0,212,170,0.08)" },
};

export function Block({ block }) {
  if (block.type === "h2") {
    return <div style={{ fontSize: 14, fontWeight: 700, color: "#00d4aa", marginTop: 20, marginBottom: 8 }}>{block.text}</div>;
  }
  if (block.type === "p") {
    return <p style={{ fontSize: 13, color: "#ccc", lineHeight: 1.6, margin: "0 0 10px" }}>{block.text}</p>;
  }
  if (block.type === "bullet" || block.type === "numbered") {
    return (
      <div style={{ display: "flex", gap: 8, marginBottom: 6, fontSize: 13, color: "#ccc", lineHeight: 1.6 }}>
        <span style={{ color: "#555", flexShrink: 0 }}>•</span>
        <span>{block.lead && <strong style={{ color: "#eee" }}>{block.lead}</strong>}{block.text}</span>
      </div>
    );
  }
  if (block.type === "callout") {
    const tone = TONE[block.tone] || TONE.info;
    return (
      <div style={{
        borderLeft: `3px solid ${tone.color}`, background: tone.bg,
        borderRadius: 6, padding: "10px 12px", margin: "10px 0",
      }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tone.color, marginBottom: 6 }}>{block.title}</div>
        {block.lines.map((l, i) => (
          <p key={i} style={{ fontSize: 12.5, color: "#ccc", lineHeight: 1.6, margin: i < block.lines.length - 1 ? "0 0 6px" : 0 }}>{l}</p>
        ))}
      </div>
    );
  }
  return null;
}
