'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Mutation check: copies alerts.js + alerts.test.js + sample/ to a temp dir,
// applies ONE string mutation at a time, runs tests, expects FAILURE.
// Zero dependencies, cross-platform, no shell commands.

const SRC_DIR = path.resolve(__dirname, '..');
const ALERTS_JS = path.join(SRC_DIR, 'alerts.js');
const TEST_JS = path.join(SRC_DIR, 'alerts.test.js');
const SAMPLE_DIR = path.join(SRC_DIR, 'sample');

const original = fs.readFileSync(ALERTS_JS, 'utf8');

// Each mutation: [name, target string, replacement string]
// Covers all 15 required behaviors from the brief exactly.
const mutations = [
  // 1. Level below uses <= instead of <
  ['level-below-lt-to-lte',
    'prev >= rule.level && today < rule.level)',
    'prev >= rule.level && today <= rule.level)'],

  // 2. Level below uses > instead of >= for prev
  ['level-below-prev-gte-to-gt',
    'prev >= rule.level && today < rule.level)',
    'prev > rule.level && today < rule.level)'],

  // 3. Level above uses >= instead of >
  ['level-above-gt-to-gte',
    'prev <= rule.level && today > rule.level)',
    'prev <= rule.level && today >= rule.level)'],

  // 4. MA tie rule changed (<= to <)
  ['ma-tie-lte-to-lt',
    '? (pS <= pL && tS > tL) : (pS >= pL && tS < tL)',
    '? (pS < pL && tS > tL) : (pS >= pL && tS < tL)'],

  // 5. First alert allowed at index long-1 instead of long
  ['ma-first-index-off-by-one',
    'for (let i = lW; i < n; i++) {',
    'for (let i = lW - 1; i < n; i++) {'],

  // 6. Short window off by one
  ['ma-short-window-off-by-one',
    'const tS = sum(i - sW + 1, i) * lB;',
    'const tS = sum(i - sW, i) * lB;'],

  // 7. Long window off by one
  ['ma-long-window-off-by-one',
    'const tL = sum(i - lW + 1, i) * sB;',
    'const tL = sum(i - lW, i) * sB;'],

  // 8. Undefined MA treated as zero (evaluates from day 1 with 0 for missing windows)
  ['undefined-ma-as-zero',
    `  for (let i = lW; i < n; i++) {
    const tS = sum(i - sW + 1, i) * lB;  // todayShort * longWindow
    const tL = sum(i - lW + 1, i) * sB;  // todayLong  * shortWindow
    const pS = sum(i - sW, i - 1) * lB;  // prevShort  * longWindow
    const pL = sum(i - lW, i - 1) * sB;  // prevLong   * shortWindow`,
    `  for (let i = 1; i < n; i++) {
    const tS = (i - sW + 1 >= 0 ? sum(i - sW + 1, i) : 0n) * lB;
    const tL = (i - lW + 1 >= 0 ? sum(i - lW + 1, i) : 0n) * sB;
    const pS = (i - sW >= 0 ? sum(i - sW, i - 1) : 0n) * lB;
    const pL = (i - lW >= 0 ? sum(i - lW, i - 1) : 0n) * sB;`],

  // 9. Series not sorted by date
  ['series-not-sorted',
    'arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));',
    '// sort removed'],

  // 10. Rule-id ordering removed
  ['rule-id-ordering-removed',
    '|| (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)',
    ''],

  // 11. Duplicate policy first-wins instead of last-wins
  ['dup-first-wins',
    'dm.set(date, { date, close });',
    'if (!dm.has(date)) dm.set(date, { date, close });'],

  // 12. BOM stripping removed
  ['bom-strip-removed',
    'return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t;',
    'return t;'],

  // 13. Alignment padding removed
  ['alignment-padding-removed',
    '`${a.date.padEnd(wD)}  ${a.ruleId.padEnd(wI)}  ${a.instrument.padEnd(wN)}  ${a.description}`',
    '`${a.date}  ${a.ruleId}  ${a.instrument}  ${a.description}`'],

  // 14. Instrument case-normalization removed
  ['instrument-case-normalization-removed',
    'const key = inst.toUpperCase();',
    'const key = inst;'],

  // 15. Header-order independence removed
  ['header-order-independence-removed',
    "const [dI, iI, cI, nC] = [col['date'], col['instrument'], col['close'], hdr.length];",
    'const [dI, iI, cI, nC] = [0, 1, 2, hdr.length];'],
];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const results = [];
let allKilled = true;

for (const [name, target, replacement] of mutations) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mut-'));
  try {
    fs.copyFileSync(ALERTS_JS, path.join(tmpDir, 'alerts.js'));
    fs.copyFileSync(TEST_JS, path.join(tmpDir, 'alerts.test.js'));
    copyDir(SAMPLE_DIR, path.join(tmpDir, 'sample'));

    const mutPath = path.join(tmpDir, 'alerts.js');
    let code = fs.readFileSync(mutPath, 'utf8');
    // Normalize CRLF to LF in code if needed for exact replacement
    const hasTarget = code.includes(target) || code.replace(/\r\n/g, '\n').includes(target.replace(/\r\n/g, '\n'));
    if (!hasTarget) {
      results.push({ name, status: 'DID NOT APPLY' });
      console.error(`ERROR: mutation "${name}" did not apply — target string not found`);
      allKilled = false;
      continue;
    }
    if (code.includes(target)) {
      code = code.replace(target, replacement);
    } else {
      code = code.replace(/\r\n/g, '\n').replace(target.replace(/\r\n/g, '\n'), replacement.replace(/\r\n/g, '\n'));
    }

    if (code === original && target !== replacement) {
      results.push({ name, status: 'NO CHANGE' });
      allKilled = false;
      continue;
    }
    fs.writeFileSync(mutPath, code);

    const res = spawnSync(process.execPath, ['--test', 'alerts.test.js'], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 60000,
    });

    const killed = res.status !== 0;
    results.push({ name, status: killed ? 'KILLED' : 'SURVIVED' });
    if (!killed) {
      allKilled = false;
      console.error(`WARNING: mutant "${name}" SURVIVED!`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log('\n=== MUTATION CHECK RESULTS ===');
console.log('Mutant'.padEnd(42) + 'Status');
console.log('-'.repeat(52));
for (const { name, status } of results) {
  console.log(name.padEnd(42) + status);
}
console.log('-'.repeat(52));
const killedCount = results.filter(r => r.status === 'KILLED').length;
const survivedCount = results.filter(r => r.status === 'SURVIVED').length;
console.log(`Total: ${results.length}, Killed: ${killedCount}, Survived: ${survivedCount}`);

if (!allKilled) {
  process.exitCode = 1;
  console.error('\nFAILURE: Not all mutants were killed!');
} else {
  console.log('\nSUCCESS: All mutants killed.');
}
