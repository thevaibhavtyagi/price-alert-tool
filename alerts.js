'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SCALE = 12;         // D9: decimal places for BigInt price representation
const MAX_WARN = 20;      // D16: per-kind warning cap before summarizing

// UserError: expected failures print a clean message, no stack trace (D2)
class UserError extends Error {
  constructor(msg) { super(msg); this.name = 'UserError'; }
}

// parseDecimal(text) → BigInt scaled by 10^12, or null (D5, D9)
// String-only arithmetic — no parseFloat, no Number for prices.
// Rejects blank, negative, exponent form, zero, >12 significant fractional digits.
function parseDecimal(text) {
  if (typeof text !== 'string') return null;
  text = text.trim();
  if (text === '' || text[0] === '-' || /[eE]/.test(text)) return null;
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [intPart, rawFrac] = text.split('.');
  const frac = rawFrac || '';
  if (frac.replace(/0+$/, '').length > SCALE) return null; // D5: max 12 sig frac digits
  const val = BigInt(intPart + frac.padEnd(SCALE, '0').slice(0, SCALE));
  return val === 0n ? null : val;
}

// isValidDate(text) → boolean (D5)
// Strict YYYY-MM-DD with explicit leap-year arithmetic; no Date object.
function isValidDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const y = Number(text.slice(0, 4)), m = Number(text.slice(5, 7)), d = Number(text.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let max = dim[m];
  if (m === 2 && ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) max = 29;
  return d <= max;
}

// Strip UTF-8 BOM (D3) and unquote a single field (D5)
function stripBOM(t) { return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; }
function unquote(f) {
  f = f.trim();
  return (f.length >= 2 && f[0] === '"' && f[f.length - 1] === '"') ? f.slice(1, -1) : f;
}

// loadPrices(text) → { series, warnings, skipped } (D3-D8)
// series: Map from UPPERCASED instrument → sorted array of { date, close: BigInt }
function loadPrices(text) {
  text = stripBOM(text);
  const rawLines = text.split(/\r\n|\r|\n/);
  const warnings = [];
  let skipped = 0;
  // D4: first non-blank line is the header
  let hi = rawLines.findIndex(l => l.trim() !== '');
  if (hi === -1) { warnings.push('prices file is empty'); return { series: new Map(), warnings, skipped: 0 }; }
  // Header: case-insensitive, order-independent (D4)
  const hdr = rawLines[hi].split(',').map(unquote);
  const col = {};
  hdr.forEach((name, i) => { col[name.toLowerCase()] = i; });
  if (!('date' in col) || !('instrument' in col) || !('close' in col))
    throw new UserError('prices header missing required column (need: date, instrument, close)');
  const [dI, iI, cI, nC] = [col['date'], col['instrument'], col['close'], hdr.length];
  const instrMap = new Map(); // instrumentKey → Map(date → { date, close })
  const dupSeen = new Set();
  for (let li = hi + 1; li < rawLines.length; li++) {
    if (rawLines[li].trim() === '') continue;
    const ln = li + 1; // 1-based line number for warnings
    const fields = rawLines[li].split(',').map(unquote);
    if (fields.length < nC) { warnings.push(`line ${ln}: fewer fields than header`); skipped++; continue; }
    if (fields.length > nC && fields.slice(nC).some(f => f !== ''))
      { warnings.push(`line ${ln}: extra non-empty fields`); skipped++; continue; }
    const date = fields[dI], inst = fields[iI], closeStr = fields[cI];
    if (!isValidDate(date))   { warnings.push(`line ${ln}: invalid date "${date}"`); skipped++; continue; }
    if (inst === '')          { warnings.push(`line ${ln}: empty instrument`); skipped++; continue; }
    const close = parseDecimal(closeStr);
    if (close === null)       { warnings.push(`line ${ln}: invalid close "${closeStr}"`); skipped++; continue; }
    const key = inst.toUpperCase(); // D7: case-insensitive instrument matching
    if (!instrMap.has(key)) instrMap.set(key, new Map());
    const dm = instrMap.get(key);
    if (dm.has(date)) { // D6: duplicate (date,instrument) — last row wins
      const dk = key + '|' + date;
      if (!dupSeen.has(dk)) { warnings.push(`line ${ln}: duplicate (${date}, ${inst}), last row wins`); dupSeen.add(dk); }
    }
    dm.set(date, { date, close });
  }
  // D8: sort each instrument's data by date (string compare works for ISO dates)
  const series = new Map();
  for (const [key, dm] of instrMap) {
    const arr = Array.from(dm.values());
    arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    series.set(key, arr);
  }
  return { series, warnings, skipped };
}

// loadRules(text) → { rules, warnings, skipped } (D10)
function loadRules(text) {
  text = stripBOM(text);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new UserError('rules file is not valid JSON'); }
  if (!Array.isArray(parsed)) throw new UserError('rules root is not an array');
  const warnings = [], rules = [];
  let skipped = 0;
  const seenIds = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const r = parsed[i];
    const lbl = (r && r.id != null) ? `rule "${r.id}"` : `rule at index ${i}`;
    if (r === null || typeof r !== 'object' || Array.isArray(r))
      { warnings.push(`${lbl}: not an object`); skipped++; continue; }
    // id: non-empty string or integer, stored as string (D10)
    let id;
    if (typeof r.id === 'number' && Number.isInteger(r.id)) id = String(r.id);
    else if (typeof r.id === 'string' && r.id.trim() !== '') id = r.id.trim();
    else { warnings.push(`rule at index ${i}: missing or invalid id`); skipped++; continue; }
    if (typeof r.instrument !== 'string' || r.instrument.trim() === '')
      { warnings.push(`${lbl}: missing or empty instrument`); skipped++; continue; }
    const instrument = r.instrument.trim(), instrumentKey = instrument.toUpperCase();
    if (typeof r.type !== 'string') { warnings.push(`${lbl}: missing type`); skipped++; continue; }
    const type = r.type.trim().toLowerCase();
    if (type !== 'level' && type !== 'ma_cross')
      { warnings.push(`${lbl}: unknown type "${r.type}"`); skipped++; continue; }
    if (typeof r.direction !== 'string') { warnings.push(`${lbl}: missing direction`); skipped++; continue; }
    const direction = r.direction.trim().toLowerCase();
    if (direction !== 'above' && direction !== 'below')
      { warnings.push(`${lbl}: unknown direction "${r.direction}"`); skipped++; continue; }
    if (seenIds.has(id)) warnings.push(`duplicate rule id "${id}"`); // D10: warn but keep both
    seenIds.add(id);
    if (type === 'level') {
      let levelText, levelBI;
      if (typeof r.level === 'number') {
        let s = String(r.level);
        if (/[eE]/.test(s)) s = r.level.toFixed(SCALE); // D9: exponent form in JSON number
        levelText = s; levelBI = parseDecimal(s);
      } else if (typeof r.level === 'string') {
        levelText = r.level.trim(); levelBI = parseDecimal(levelText);
      } else { warnings.push(`${lbl}: missing or invalid level`); skipped++; continue; }
      if (levelBI === null) { warnings.push(`${lbl}: invalid or non-positive level "${r.level}"`); skipped++; continue; }
      rules.push({ id, instrument, instrumentKey, type, direction, level: levelBI, levelText, fileIndex: i });
    } else {
      const ok = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
      if (!ok(r.short)) { warnings.push(`${lbl}: short window must be a positive integer`); skipped++; continue; }
      if (!ok(r.long))  { warnings.push(`${lbl}: long window must be a positive integer`); skipped++; continue; }
      if (r.short >= r.long)
        { warnings.push(`${lbl}: short (${r.short}) must be less than long (${r.long})`); skipped++; continue; }
      rules.push({ id, instrument, instrumentKey, type, direction, short: r.short, long: r.long, fileIndex: i });
    }
  }
  return { rules, warnings, skipped };
}

// levelAlerts(series, rule) → Array<alert> (D11)
// below fires when prev >= level AND today < level
// above fires when prev <= level AND today > level
function levelAlerts(series, rule) {
  const pts = series.get(rule.instrumentKey);
  if (!pts) return [];
  const results = [];
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1].close, today = pts[i].close;
    const fires = rule.direction === 'below'
      ? (prev >= rule.level && today < rule.level)
      : (prev <= rule.level && today > rule.level);
    if (fires) results.push({ date: pts[i].date, ruleId: rule.id, instrument: rule.instrument,
      description: `level ${rule.direction} ${rule.levelText}`, fileIndex: rule.fileIndex });
  }
  return results;
}

// maCrossAlerts(series, rule) → Array<alert> (D12)
// O(n) via prefix sums. Compares WITHOUT division: shortSum*longW vs longSum*shortW.
function maCrossAlerts(series, rule) {
  const pts = series.get(rule.instrumentKey);
  if (!pts) return [];
  const n = pts.length, sW = rule.short, lW = rule.long;
  if (n < lW + 1) return []; // D15: need at least longW+1 data points
  // Prefix sums for O(n) window sums
  const pre = new Array(n + 1);
  pre[0] = 0n;
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + pts[i].close;
  const sum = (a, b) => pre[b + 1] - pre[a]; // sum of closes[a..b] inclusive
  const sB = BigInt(sW), lB = BigInt(lW);
  const results = [];
  // D12: first possible cross at index lW (both today's and prev's long MA must be defined)
  for (let i = lW; i < n; i++) {
    const tS = sum(i - sW + 1, i) * lB;  // todayShort * longWindow
    const tL = sum(i - lW + 1, i) * sB;  // todayLong  * shortWindow
    const pS = sum(i - sW, i - 1) * lB;  // prevShort  * longWindow
    const pL = sum(i - lW, i - 1) * sB;  // prevLong   * shortWindow
    const fires = rule.direction === 'above'
      ? (pS <= pL && tS > tL) : (pS >= pL && tS < tL);
    if (fires) results.push({ date: pts[i].date, ruleId: rule.id, instrument: rule.instrument,
      description: `ma_cross ${sW}/${lW} ${rule.direction}`, fileIndex: rule.fileIndex });
  }
  return results;
}

// evaluate(series, rules) → { alerts (sorted per D13), warnings }
function evaluate(series, rules) {
  const all = [], warnings = [];
  for (const rule of rules) {
    if (!series.has(rule.instrumentKey))
      { warnings.push(`rule ${rule.id}: no prices for ${rule.instrument}`); continue; }
    const pts = series.get(rule.instrumentKey);
    if (rule.type === 'level') {
      if (pts.length < 2) { warnings.push(`rule ${rule.id}: ${rule.instrument} has ${pts.length} data points, needs at least 2; no alerts possible`); continue; }
            for (const a of levelAlerts(series, rule)) all.push(a);
    } else {
      const need = rule.long + 1;
      if (pts.length < need) { warnings.push(`rule ${rule.id}: ${rule.instrument} has ${pts.length} data points, needs at least ${need}; no alerts possible`); continue; }
            for (const a of maCrossAlerts(series, rule)) all.push(a);
    }
  }
  // D13: sort by date (ascending), then rule id (code-unit, NOT localeCompare), then file order
  all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)
    || (a.fileIndex - b.fileIndex));
  return { alerts: all, warnings };
}

// formatAlerts(alerts) → string (D14)
// Columns left-aligned, padded to widest value, two-space separator, no trailing whitespace.
function formatAlerts(alerts) {
  if (alerts.length === 0) return '';
  let wD = 0, wI = 0, wN = 0;
  for (const a of alerts) {
    if (a.date.length > wD) wD = a.date.length;
    if (a.ruleId.length > wI) wI = a.ruleId.length;
    if (a.instrument.length > wN) wN = a.instrument.length;
  }
  return alerts.map(a =>
    `${a.date.padEnd(wD)}  ${a.ruleId.padEnd(wI)}  ${a.instrument.padEnd(wN)}  ${a.description}`
  ).join('\n') + '\n';
}

// main(argv) — CLI entry point (D1, D2, D16)
function main(argv) {
  process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; }); // D2: ignore EPIPE
  const args = argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write('usage: node alerts.js <prices.csv> <rules.json>\n');
    process.exitCode = 2; return;
  }
  let pricesText, rulesText;
  try { pricesText = fs.readFileSync(path.resolve(args[0]), 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read prices file: ${e.message}\n`); process.exitCode = 1; return; }
  try { rulesText = fs.readFileSync(path.resolve(args[1]), 'utf8'); }
  catch (e) { process.stderr.write(`error: cannot read rules file: ${e.message}\n`); process.exitCode = 1; return; }
  let series, rules, pWarn, rWarn, pSkip = 0, rSkip = 0;
  try { const r = loadPrices(pricesText); series = r.series; pWarn = r.warnings; pSkip = r.skipped; }
  catch (e) { if (e.name === 'UserError') { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 1; return; } throw e; }
  try { const r = loadRules(rulesText); rules = r.rules; rWarn = r.warnings; rSkip = r.skipped; }
  catch (e) { if (e.name === 'UserError') { process.stderr.write(`error: ${e.message}\n`); process.exitCode = 1; return; } throw e; }
  const { alerts: alertList, warnings: eWarn } = evaluate(series, rules);
  // D16: throttled warnings by kind
  const allW = [...pWarn, ...rWarn, ...eWarn];
  const byKind = new Map();
  for (const w of allW) {
    const k = w.startsWith('line ') ? 'row validation' : w.includes('duplicate') ? 'duplicate' : 'rule evaluation';
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(w);
  }
  for (const [kind, ws] of byKind) {
    for (let j = 0; j < Math.min(ws.length, MAX_WARN); j++) process.stderr.write(`warning: ${ws[j]}\n`);
    if (ws.length > MAX_WARN) process.stderr.write(`... and ${ws.length - MAX_WARN} more ${kind} warnings\n`);
  }
  if (pSkip > 0 || rSkip > 0)
    process.stderr.write(`summary: ${pSkip} price rows skipped, ${rSkip} rules skipped\n`);
  const output = formatAlerts(alertList);
  if (output) process.stdout.write(output);
  process.exitCode = 0;
}

// Exports for testing; run main only when invoked directly (C5)
module.exports = { UserError, parseDecimal, isValidDate, loadPrices, loadRules,
  levelAlerts, maCrossAlerts, evaluate, formatAlerts, main };
if (require.main === module) main(process.argv);
