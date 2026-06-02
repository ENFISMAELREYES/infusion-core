import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

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

async function fetchAllSessions(token, date) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } }
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const CAT_COLOR = { premedicacion:"#FAC775", inmunoterapia:"#5DCAA5", quimioterapia:"#F09595", adicional:"#AFA9EC" };
const CAT_LABEL = { premedicacion:"Pre", inmunoterapia:"Inmuno", quimioterapia:"Quimio", adicional:"Adic." };

function getStatus(s) {
  if (!s.authorized)       return { label:"Sin autorizar", color:"#ffb347" };
  if (!s.events?.ingreso)  return { label:"En espera",     color:"#666" };
  if (s.status === "completado") return { label:"Retirado", color:"#4fc3f7" };
  const me = s.medEvents || {};
  const active = (s.meds||[]).find(m => me[`med_${m.id}`]?.inicio && !me[`med_${m.id}`]?.fin);
  if (active) return { label:"En infusión", color:"#1D9E75" };
  return { label:"Pausado", color:"#EF9F27" };
}

function getProgress(s) {
  const timed = (s.meds||[]).filter(m => m.time);
  if (!timed.length) return 0;
  const total = timed.reduce((acc, m) => acc + m.time, 0);
  const me = s.medEvents || {};
  const done = timed.filter(m => me[`med_${m.id}`]?.fin).reduce((acc, m) => acc + m.time, 0);
  return Math.round((done / total) * 100);
}

function MedTimeline({ meds, medEvents }) {
  const me = medEvents || {};
  return (
    <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
      {(meds||[]).map((m, i) => {
        const ev = me[`med_${m.id}`] || {};
        const done = !!ev.fin, active = !!ev.inicio && !ev.fin;
        const color = CAT_COLOR[m.category] || "#888";
        return (
          <div key={m.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div title={`${m.name} ${m.dose}`} style={{
              position:"relative", overflow:"hidden", height:22, borderRadius:5,
              width: m.time ? Math.max(30, Math.round(m.time * 1.1)) : 26,
              background:"rgba(255,255,255,0.05)",
              border:`1px solid ${done||active ? color : "rgba(255,255,255,0.09)"}`,
            }}>
              {(done||active)import { useEffect, useState } from "react";
import { useAuth } from "../hooks/useAuth";

const PROJECT_ID = "infusion-core";
const API_KEY = "AIzaSyBXz5TRpGHX7nbFjQYjGJi2l17YBpxtjFw";

function getToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
}

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

async function fetchAllSessions(token, date) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/default/documents:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "sessions" }],
        where: { fieldFilter: { field: { fieldPath: "date" }, op: "EQUAL", value: { stringValue: date } } }
      }
    })
  });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(d => d.document).map(d => parseDoc(d.document));
}

const CAT_COLOR = { premedicacion:"#FAC775", inmunoterapia:"#5DCAA5", quimioterapia:"#F09595", adicional:"#AFA9EC" };
const CAT_LABEL = { premedicacion:"Pre", inmunoterapia:"Inmuno", quimioterapia:"Quimio", adicional:"Adic." };

function getStatus(s) {
  if (!s.authorized)       return { label:"Sin autorizar", color:"#ffb347" };
  if (!s.events?.ingreso)  return { label:"En espera",     color:"#666" };
  if (s.status === "completado") return { label:"Retirado", color:"#4fc3f7" };
  const me = s.medEvents || {};
  const active = (s.meds||[]).find(m => me[`med_${m.id}`]?.inicio && !me[`med_${m.id}`]?.fin);
  if (active) return { label:"En infusión", color:"#1D9E75" };
  return { label:"Pausado", color:"#EF9F27" };
}

function getProgress(s) {
  const timed = (s.meds||[]).filter(m => m.time);
  if (!timed.length) return 0;
  const total = timed.reduce((acc, m) => acc + m.time, 0);
  const me = s.medEvents || {};
  const done = timed.filter(m => me[`med_${m.id}`]?.fin).reduce((acc, m) => acc + m.time, 0);
  return Math.round((done / total) * 100);
}

function MedTimeline({ meds, medEvents }) {
  const me = medEvents || {};
  return (
    <div style={{ display:"flex", gap:4, alignItems:"center", flexWrap:"wrap" }}>
      {(meds||[]).map((m, i) => {
        const ev = me[`med_${m.id}`] || {};
        const done = !!ev.fin, active = !!ev.inicio && !ev.fin;
        const color = CAT_COLOR[m.category] || "#888";
        return (
          <div key={m.id} style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div title={`${m.name} ${m.dose}`} style={{
              position:"relative", overflow:"hidden", height:22, borderRadius:5,
              width: m.time ? Math.max(30, Math.round(m.time * 1.1)) : 26,
              background:"rgba(255,255,255,0.05)",
              border:`1px solid ${done||active ? color : "rgba(255,255,255,0.09)"}`,
            }}>
              {(done||active)
