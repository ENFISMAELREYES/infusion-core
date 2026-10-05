import { useState, useMemo, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { HELP_SECTIONS, sectionForPath } from "../data/helpContent";
import { Block } from "./ContentBlocks";

export default function HelpPanel() {
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [query, setQuery] = useState("");
  const location = useLocation();

  useEffect(() => {
    if (open) return;
    setActiveId(sectionForPath(location.pathname));
  }, [location.pathname, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_SECTIONS;
    return HELP_SECTIONS.filter(s => {
      if (s.title.toLowerCase().includes(q)) return true;
      return s.blocks.some(b => {
        const text = [b.text, b.title, b.lead, ...(b.lines || [])].filter(Boolean).join(" ").toLowerCase();
        return text.includes(q);
      });
    });
  }, [query]);

  const active = HELP_SECTIONS.find(s => s.id === activeId) || HELP_SECTIONS[0];

  return (
    <>
      <button
        onClick={() => { setActiveId(sectionForPath(location.pathname)); setOpen(true); }}
        aria-label="Ayuda"
        style={{
          position: "fixed", right: 18, bottom: 24,
          width: 46, height: 46, borderRadius: "50%", zIndex: 200,
          background: "#00d4aa", color: "#04211b", border: "none",
          fontSize: 20, fontWeight: 800, cursor: "pointer",
          boxShadow: "0 4px 14px rgba(0,212,170,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}
        className="help-fab"
      >
        ?
      </button>

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 300, display: "flex", justifyContent: "flex-end" }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "min(440px, 100vw)", height: "100%", background: "#0c0e14",
              borderLeft: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column",
            }}
          >
            <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>Ayuda</div>
                <button onClick={() => setOpen(false)} style={{
                  background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
                  color: "#999", borderRadius: 8, width: 30, height: 30, cursor: "pointer", fontSize: 14,
                }}>✕</button>
              </div>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Buscar en la ayuda…"
                style={{
                  width: "100%", padding: "9px 12px", borderRadius: 9, fontSize: 13,
                  background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                  color: "#f0f0f0", outline: "none", boxSizing: "border-box",
                }}
              />
              <div style={{ display: "flex", gap: 6, overflowX: "auto", marginTop: 12, paddingBottom: 2 }}>
                {filtered.map(s => (
                  <button
                    key={s.id}
                    onClick={() => setActiveId(s.id)}
                    style={{
                      flexShrink: 0, display: "flex", alignItems: "center", gap: 6,
                      padding: "6px 10px", borderRadius: 8, fontSize: 11.5, fontWeight: 500,
                      cursor: "pointer", whiteSpace: "nowrap",
                      background: s.id === activeId ? "rgba(0,212,170,0.12)" : "rgba(255,255,255,0.03)",
                      color: s.id === activeId ? "#00d4aa" : "#888",
                      border: s.id === activeId ? "1px solid rgba(0,212,170,0.25)" : "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <span>{s.icon}</span>{s.title}
                  </button>
                ))}
                {filtered.length === 0 && (
                  <div style={{ fontSize: 12, color: "#666", padding: "6px 2px" }}>Sin resultados para "{query}"</div>
                )}
              </div>
            </div>

            <div style={{ flex: 1, overflowY: "auto", padding: "16px 18px 40px" }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: "#fff", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
                <span>{active.icon}</span>{active.title}
              </div>
              {active.blocks.map((b, i) => <Block key={i} block={b} />)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
