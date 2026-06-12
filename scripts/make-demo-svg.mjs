#!/usr/bin/env node
// scripts/make-demo-svg.mjs — regenerates assets/demo.svg from
// assets/demo-transcript.json. Run after any verb-output change:
//     node scripts/make-demo-svg.mjs
// The transcript's say-lines must be REAL captured verb output (see the
// capture one-liner in docs/superpowers/plans/2026-06-12-m7-adoption.md).
import { readFileSync, writeFileSync } from 'node:fs';

const t = JSON.parse(readFileSync('assets/demo-transcript.json', 'utf8'));
const W = 760;
const PAD = 16;
const LINE_H = 22;
const CHAR_W = 7.3;            // monospace estimate for wrapping
const MAX_CHARS = Math.floor((W - PAD * 2) / CHAR_W);
const COLORS = { user: '#e6edf3', agent: '#9da7b3', preview: '#d29922', ok: '#3fb950' };
const PREFIX = { user: '', agent: '  ', preview: '  │ ', ok: '  ✅ ' };

// wrap each logical line into physical rows
const rows = [];
for (const line of t.lines) {
  const prefix = PREFIX[line.role] ?? '';
  const words = line.text.split(' ');
  let cur = prefix;
  for (const w of words) {
    if ((cur + ' ' + w).length > MAX_CHARS && cur !== prefix) {
      rows.push({ role: line.role, text: cur, first: cur.startsWith(prefix) && rows.every((r) => r.lineRef !== line) });
      cur = ' '.repeat(prefix.length) + w;
    } else {
      cur = cur === prefix ? prefix + w : cur + ' ' + w;
    }
  }
  rows.push({ role: line.role, text: cur });
}

const BODY_TOP = 56;
const H = BODY_TOP + rows.length * LINE_H + PAD;
const TOTAL_S = rows.length * 0.9 + 3;  // reveal cadence + hold, then loop

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Per-row keyframes variant: each row gets its own @keyframes so that all rows
// share one animation duration (TOTAL_S) with no delay. The reveal slot for row i
// is baked into the percentage values — the loop is fully deterministic because
// every row's clock is identical (same duration, same start, no delay drift).
//
// With the shared-keyframe + animation-delay approach, on the 2nd and later cycles
// row 0 begins its 2nd loop at t=TOTAL_S while the last rows are still mid-reveal
// from their delayed first cycle, causing visible overlap. Per-row keyframes avoids
// this entirely.
const keyframes = rows.map((r, i) => {
  const beginPct = ((i * 0.9) / TOTAL_S * 100).toFixed(2);
  const onPct    = (((i * 0.9) + 0.3) / TOTAL_S * 100).toFixed(2);
  const offPct   = ((TOTAL_S - 0.5) / TOTAL_S * 100).toFixed(2);
  return `    @keyframes r${i} { 0%,${beginPct}% { opacity:0; } ${onPct}% { opacity:1; } ${offPct}%,100% { opacity:0; } }`;
}).join('\n');

const textRows = rows.map((r, i) => {
  return `  <text x="${PAD}" y="${BODY_TOP + i * LINE_H}" style="fill:${COLORS[r.role]};opacity:0;animation:r${i} ${TOTAL_S.toFixed(1)}s linear infinite;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px">${esc(r.text)}</text>`;
}).join('\n');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
  <style>
${keyframes}
  </style>
  <rect width="${W}" height="${H}" rx="8" fill="#0d1117"/>
  <rect width="${W}" height="34" rx="8" fill="#161b22"/>
  <circle cx="20" cy="17" r="6" fill="#ff5f57"/><circle cx="40" cy="17" r="6" fill="#febc2e"/><circle cx="60" cy="17" r="6" fill="#28c840"/>
  <text x="${W / 2}" y="21" text-anchor="middle" fill="#9da7b3" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="13">${esc(t.title)}</text>
${textRows}
</svg>\n`;

writeFileSync('assets/demo.svg', svg, 'utf8');
console.log(`assets/demo.svg written — ${rows.length} rows, ${TOTAL_S.toFixed(1)}s loop`);
