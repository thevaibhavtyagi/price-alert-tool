'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
const alerts = require('./alerts.js');
const {
  parseDecimal,
  isValidDate,
  loadPrices,
  loadRules,
  levelAlerts,
  maCrossAlerts,
  evaluate,
  formatAlerts,
} = alerts;

// Scale factor: 10^12 as BigInt
const SCALE = 10n ** 12n;

// ---------------------------------------------------------------------------
// Helper: build a sorted series Map from simple arrays
// ---------------------------------------------------------------------------
function buildSeries(instrument, dates, closes) {
  // closes are numbers (integers or decimals) for convenience; convert to BigInt
  const arr = dates.map((d, i) => ({
    date: d,
    close: parseDecimal(String(closes[i])),
  }));
  // sort by date ascending (D8)
  arr.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const map = new Map();
  map.set(instrument.toUpperCase(), arr);
  return map;
}

// Helper: run the CLI and return { stdout, stderr, exitCode }
function runCLI(args, cwd) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, 'alerts.js'), ...args], {
    cwd: cwd || __dirname,
    encoding: 'utf8',
    timeout: 30000,
  });
  return {
    stdout: (result.stdout || '').replace(/\r\n/g, '\n'),
    stderr: (result.stderr || '').replace(/\r\n/g, '\n'),
    exitCode: result.status,
  };
}

// Helper: write temp files and return paths
function writeTempFiles(pricesCsv, rulesJson) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-'));
  const pricesPath = path.join(dir, 'prices.csv');
  const rulesPath = path.join(dir, 'rules.json');
  fs.writeFileSync(pricesPath, pricesCsv);
  fs.writeFileSync(rulesPath, rulesJson);
  return { dir, pricesPath, rulesPath };
}

// ===========================
// parseDecimal tests
// ===========================
describe('parseDecimal', () => {
  it('parses a simple integer', () => {
    assert.equal(parseDecimal('1500'), 1500n * SCALE);
  });
  it('parses a decimal number', () => {
    assert.equal(parseDecimal('1520.50'), 1520500000000000n);
  });
  it('parses "0.15"', () => {
    assert.equal(parseDecimal('0.15'), 150000000000n);
  });
  it('parses "0.1"', () => {
    assert.equal(parseDecimal('0.1'), 100000000000n);
  });
  it('parses "0.2"', () => {
    assert.equal(parseDecimal('0.2'), 200000000000n);
  });
  it('parses "0.3"', () => {
    assert.equal(parseDecimal('0.3'), 300000000000n);
  });
  it('returns null for blank', () => {
    assert.equal(parseDecimal(''), null);
  });
  it('returns null for non-numeric', () => {
    assert.equal(parseDecimal('abc'), null);
  });
  it('returns null for NaN string', () => {
    assert.equal(parseDecimal('NaN'), null);
  });
  it('returns null for exponent form', () => {
    assert.equal(parseDecimal('1e3'), null);
  });
  it('returns null for zero', () => {
    assert.equal(parseDecimal('0'), null);
  });
  it('returns null for 0.00', () => {
    assert.equal(parseDecimal('0.00'), null);
  });
  it('returns null for negative', () => {
    assert.equal(parseDecimal('-5'), null);
  });
  it('returns null for more than 12 fractional digits after trailing zero strip', () => {
    // 0.1234567890123 has 13 significant fractional digits
    assert.equal(parseDecimal('0.1234567890123'), null);
  });
  it('accepts exactly 12 fractional digits', () => {
    assert.equal(parseDecimal('0.123456789012'), 123456789012n);
  });
  it('strips trailing zeros before counting fractional digits', () => {
    // 0.12345678901300 has 13 chars after dot but trailing zeros stripped = 12
    assert.equal(parseDecimal('0.12345678901300'), 123456789013n);
  });
  it('parses integer with leading zeros', () => {
    assert.equal(parseDecimal('0100'), 100n * SCALE);
  });
});

// ===========================
// isValidDate tests
// ===========================
describe('isValidDate', () => {
  it('accepts a valid date', () => {
    assert.equal(isValidDate('2026-09-01'), true);
  });
  it('rejects invalid month 13', () => {
    assert.equal(isValidDate('2026-13-01'), false);
  });
  it('rejects invalid month 00', () => {
    assert.equal(isValidDate('2026-00-15'), false);
  });
  it('rejects Feb 30', () => {
    assert.equal(isValidDate('2026-02-30'), false);
  });
  it('rejects Feb 29 in non-leap year (2025)', () => {
    assert.equal(isValidDate('2025-02-29'), false);
  });
  it('accepts Feb 29 in leap year (2024)', () => {
    assert.equal(isValidDate('2024-02-29'), true);
  });
  it('accepts Feb 29 in year 2000 (div by 400)', () => {
    assert.equal(isValidDate('2000-02-29'), true);
  });
  it('rejects Feb 29 in year 1900 (div by 100 not 400)', () => {
    assert.equal(isValidDate('1900-02-29'), false);
  });
  it('rejects day 0', () => {
    assert.equal(isValidDate('2026-01-00'), false);
  });
  it('rejects day 32 for January', () => {
    assert.equal(isValidDate('2026-01-32'), false);
  });
  it('accepts day 31 for January', () => {
    assert.equal(isValidDate('2026-01-31'), true);
  });
  it('rejects day 31 for April', () => {
    assert.equal(isValidDate('2026-04-31'), false);
  });
  it('rejects non-ISO format', () => {
    assert.equal(isValidDate('01-09-2026'), false);
  });
  it('rejects short year', () => {
    assert.equal(isValidDate('26-09-01'), false);
  });
  it('rejects text', () => {
    assert.equal(isValidDate('hello'), false);
  });
  it('rejects empty string', () => {
    assert.equal(isValidDate(''), false);
  });
});

// ===========================
// loadPrices tests
// ===========================
describe('loadPrices', () => {
  it('parses a basic CSV correctly', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,1520.50\n2026-09-02,INFY,1534.10\n';
    const result = loadPrices(csv);
    assert.equal(result.series.size, 1);
    const infy = result.series.get('INFY');
    assert.equal(infy.length, 2);
    assert.equal(infy[0].date, '2026-09-01');
    assert.equal(infy[0].close, parseDecimal('1520.50'));
  });

  it('handles BOM at start (D3)', () => {
    const csv = '\uFEFFdate,instrument,close\n2026-09-01,INFY,100\n';
    const result = loadPrices(csv);
    assert.equal(result.series.size, 1);
  });

  it('handles CRLF line endings (D3)', () => {
    const csv = 'date,instrument,close\r\n2026-09-01,INFY,100\r\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('handles lone CR line endings (D3)', () => {
    const csv = 'date,instrument,close\r2026-09-01,INFY,100\r';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('skips blank lines (D3)', () => {
    const csv = 'date,instrument,close\n\n2026-09-01,INFY,100\n\n\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('handles header columns in different order (D4)', () => {
    const csv = 'close,date,instrument\n100,2026-09-01,INFY\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY')[0].close, 100n * SCALE);
  });

  it('case-insensitive header matching (D4)', () => {
    const csv = 'Date,INSTRUMENT,Close\n2026-09-01,INFY,100\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('extra columns are ignored (D4)', () => {
    const csv = 'date,instrument,close,volume\n2026-09-01,INFY,100,5000\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('empty file produces note and no crash (D4)', () => {
    const csv = '';
    const result = loadPrices(csv);
    assert.equal(result.series.size, 0);
    assert.ok(result.warnings.some(w => w.includes('empty')));
  });

  it('header-only file is valid (D4)', () => {
    const csv = 'date,instrument,close\n';
    const result = loadPrices(csv);
    assert.equal(result.series.size, 0);
    assert.equal(result.skipped, 0);
  });

  it('throws on missing required column (D4)', () => {
    const csv = 'date,instrument\n2026-09-01,INFY\n';
    assert.throws(() => loadPrices(csv), { name: 'UserError' });
  });

  it('skips row with fewer fields than header (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY\n2026-09-02,INFY,200\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('skips row with extra non-empty field (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,100,extra\n2026-09-02,INFY,200\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('allows extra trailing empty field (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,100,\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 0);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('trims whitespace around fields (D5)', () => {
    const csv = 'date,instrument,close\n  2026-09-01 , INFY , 100 \n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY')[0].date, '2026-09-01');
    assert.equal(result.series.get('INFY')[0].close, 100n * SCALE);
  });

  it('strips one pair of surrounding double quotes (D5)', () => {
    const csv = 'date,instrument,close\n"2026-09-01","INFY","100"\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('skips row with invalid date (D5)', () => {
    const csv = 'date,instrument,close\n2026-02-30,INFY,100\n2026-09-01,INFY,200\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
    assert.equal(result.series.get('INFY').length, 1);
  });

  it('skips row with empty instrument (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,,100\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('skips row with non-numeric close (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,abc\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('skips row with exponent close (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,1e3\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('skips row with zero close (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,0\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('skips row with negative close (D5)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,-5\n';
    const result = loadPrices(csv);
    assert.equal(result.skipped, 1);
  });

  it('last row wins on duplicate (date, instrument) (D6)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,100\n2026-09-01,INFY,200\n';
    const result = loadPrices(csv);
    assert.equal(result.series.get('INFY').length, 1);
    assert.equal(result.series.get('INFY')[0].close, 200n * SCALE);
    assert.ok(result.warnings.some(w => w.includes('duplicate')));
  });

  it('mixed-case instruments merge (D7)', () => {
    const csv = 'date,instrument,close\n2026-09-01,infy,100\n2026-09-02,INFY,200\n';
    const result = loadPrices(csv);
    assert.equal(result.series.size, 1);
    assert.equal(result.series.get('INFY').length, 2);
  });

  it('sorts by date ascending after dedup (D8)', () => {
    const csv = 'date,instrument,close\n2026-09-03,INFY,300\n2026-09-01,INFY,100\n2026-09-02,INFY,200\n';
    const result = loadPrices(csv);
    const dates = result.series.get('INFY').map(r => r.date);
    assert.deepEqual(dates, ['2026-09-01', '2026-09-02', '2026-09-03']);
  });
});

// ===========================
// loadRules tests
// ===========================
describe('loadRules', () => {
  it('parses valid level rule', () => {
    const json = '[{"id":"r1","instrument":"INFY","type":"level","direction":"below","level":1500}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].id, 'r1');
  });

  it('parses valid ma_cross rule', () => {
    const json = '[{"id":"r2","instrument":"TCS","type":"ma_cross","short":5,"long":20,"direction":"above"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].type, 'ma_cross');
  });

  it('throws on invalid JSON (D10)', () => {
    assert.throws(() => loadRules('{not json'), { name: 'UserError' });
  });

  it('throws on root not an array (D10)', () => {
    assert.throws(() => loadRules('{"a":1}'), { name: 'UserError' });
  });

  it('empty array is valid (D10)', () => {
    const result = loadRules('[]');
    assert.equal(result.rules.length, 0);
  });

  it('skips rule with unknown type (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"unknown","direction":"above","level":100}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
    assert.equal(result.skipped, 1);
  });

  it('skips rule with unknown direction (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"sideways","level":100}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
    assert.equal(result.skipped, 1);
  });

  it('skips rule with missing fields (D10)', () => {
    const json = '[{"id":"r1"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
    assert.equal(result.skipped, 1);
  });

  it('skips ma_cross rule when short >= long (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"ma_cross","short":20,"long":5,"direction":"above"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
  });

  it('skips ma_cross rule when windows are non-integer (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"ma_cross","short":2.5,"long":5,"direction":"above"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
  });

  it('skips ma_cross rule when windows are zero (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"ma_cross","short":0,"long":5,"direction":"above"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
  });

  it('skips level rule with non-positive level (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":0}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
  });

  it('skips level rule with non-numeric level (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":"abc"}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 0);
  });

  it('accepts integer id stored as string (D10)', () => {
    const json = '[{"id":42,"instrument":"X","type":"level","direction":"below","level":100}]';
    const result = loadRules(json);
    assert.equal(result.rules[0].id, '42');
  });

  it('warns on duplicate rule ids but keeps both (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":100},{"id":"r1","instrument":"Y","type":"level","direction":"above","level":200}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 2);
    assert.ok(result.warnings.some(w => w.includes('duplicate')));
  });

  it('handles case-insensitive type and direction (D10)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"LEVEL","direction":"BELOW","level":100}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 1);
    assert.equal(result.rules[0].type, 'level');
    assert.equal(result.rules[0].direction, 'below');
  });

  it('handles BOM in rules file (D3)', () => {
    const json = '\uFEFF[{"id":"r1","instrument":"X","type":"level","direction":"below","level":100}]';
    const result = loadRules(json);
    assert.equal(result.rules.length, 1);
  });

  it('level 1500 displays as "1500" not "1500.0" (D9)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":1500}]';
    const result = loadRules(json);
    assert.equal(result.rules[0].levelText, '1500');
  });

  it('level 1500.0 displays as "1500.0" (D9)', () => {
    // JSON parses 1500.0 as 1500 (number), String(1500) = "1500"
    // But if given as string "1500.0", it should display as "1500.0"
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":"1500.0"}]';
    const result = loadRules(json);
    assert.equal(result.rules[0].levelText, '1500.0');
  });

  it('level given as string "1500" displays as "1500" (D9)', () => {
    const json = '[{"id":"r1","instrument":"X","type":"level","direction":"below","level":"1500"}]';
    const result = loadRules(json);
    assert.equal(result.rules[0].levelText, '1500');
  });
});

// ===========================
// levelAlerts tests — Golden Fixture BBB (D11)
// ===========================
describe('levelAlerts', () => {
  // BBB fixture: 09-01=100, 09-02=98, 09-03=97, 09-04=101, 09-07=99, 09-08=100, 09-09=95
  const bbbSeries = buildSeries('BBB', [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-07', '2026-09-08', '2026-09-09',
  ], [100, 98, 97, 101, 99, 100, 95]);

  it('level below 100 fires on 09-02, 09-07, 09-09 (BBB golden)', () => {
    const rule = { id: 'r1', instrument: 'BBB', instrumentKey: 'BBB', type: 'level', direction: 'below', level: 100n * SCALE, levelText: '100', fileIndex: 0 };
    const result = levelAlerts(bbbSeries, rule);
    const dates = result.map(a => a.date);
    assert.deepEqual(dates, ['2026-09-02', '2026-09-07', '2026-09-09']);
  });

  it('level below 100: 09-03 does NOT fire (still below)', () => {
    const rule = { id: 'r1', instrument: 'BBB', instrumentKey: 'BBB', type: 'level', direction: 'below', level: 100n * SCALE, levelText: '100', fileIndex: 0 };
    const result = levelAlerts(bbbSeries, rule);
    const dates = result.map(a => a.date);
    assert.ok(!dates.includes('2026-09-03'));
  });

  it('level below 100: 09-08 does NOT fire (100 is not < 100)', () => {
    const rule = { id: 'r1', instrument: 'BBB', instrumentKey: 'BBB', type: 'level', direction: 'below', level: 100n * SCALE, levelText: '100', fileIndex: 0 };
    const result = levelAlerts(bbbSeries, rule);
    const dates = result.map(a => a.date);
    assert.ok(!dates.includes('2026-09-08'));
  });

  it('level below 100: 09-09 fires because prev (100) == level (D11 touch semantics)', () => {
    const rule = { id: 'r1', instrument: 'BBB', instrumentKey: 'BBB', type: 'level', direction: 'below', level: 100n * SCALE, levelText: '100', fileIndex: 0 };
    const result = levelAlerts(bbbSeries, rule);
    const dates = result.map(a => a.date);
    assert.ok(dates.includes('2026-09-09'));
  });

  it('level above 100 fires only on 09-04 (BBB golden)', () => {
    const rule = { id: 'r10', instrument: 'BBB', instrumentKey: 'BBB', type: 'level', direction: 'above', level: 100n * SCALE, levelText: '100', fileIndex: 1 };
    const result = levelAlerts(bbbSeries, rule);
    const dates = result.map(a => a.date);
    assert.deepEqual(dates, ['2026-09-04']);
  });

  it('first row of an instrument never fires', () => {
    const series = buildSeries('X', ['2026-01-01'], [50]);
    const rule = { id: 'r1', instrument: 'X', instrumentKey: 'X', type: 'level', direction: 'below', level: 100n * SCALE, levelText: '100', fileIndex: 0 };
    assert.equal(levelAlerts(series, rule).length, 0);
  });

  it('decimal level 1500.1 with closes 1500.2 then 1500.10 does not fire below', () => {
    // 1500.10 == 1500.1 so today is NOT < level; should not fire
    const series = buildSeries('X', ['2026-01-01', '2026-01-02'], [1500.2, 1500.1]);
    const rule = { id: 'r1', instrument: 'X', instrumentKey: 'X', type: 'level', direction: 'below', level: parseDecimal('1500.1'), levelText: '1500.1', fileIndex: 0 };
    assert.equal(levelAlerts(series, rule).length, 0);
  });
});

// ===========================
// maCrossAlerts tests — Golden Fixture AAA (D12)
// ===========================
describe('maCrossAlerts', () => {
  // AAA fixture: 09-01=10, 09-02=10, 09-03=10, 09-04=12, 09-07=14, 09-08=9, 09-09=8, 09-10=15
  const aaaSeries = buildSeries('AAA', [
    '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
    '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10',
  ], [10, 10, 10, 12, 14, 9, 8, 15]);

  it('ma_cross 2/3 above fires on 09-04 and 09-10 (AAA golden)', () => {
    const rule = { id: 'r2', instrument: 'AAA', instrumentKey: 'AAA', type: 'ma_cross', direction: 'above', short: 2, long: 3, fileIndex: 2 };
    const result = maCrossAlerts(aaaSeries, rule);
    const dates = result.map(a => a.date);
    assert.deepEqual(dates, ['2026-09-04', '2026-09-10']);
  });

  it('ma_cross 2/3 below fires only on 09-08 (AAA golden)', () => {
    const rule = { id: 'r3', instrument: 'AAA', instrumentKey: 'AAA', type: 'ma_cross', direction: 'below', short: 2, long: 3, fileIndex: 3 };
    const result = maCrossAlerts(aaaSeries, rule);
    const dates = result.map(a => a.date);
    assert.deepEqual(dates, ['2026-09-08']);
  });

  it('DEC exactness fixture: fires on day 4 only (D12)', () => {
    // closes: 0.15, 0.1, 0.2, 0.3 on four consecutive days
    // Day 2 (index 2): short = (0.1+0.2)/2 = 0.15, long = (0.15+0.1+0.2)/3 = 0.15 → TIE
    // Day 3 (index 3): short = (0.2+0.3)/2 = 0.25, long = (0.1+0.2+0.3)/3 = 0.2 → short > long
    // Prev was tie (short <= long), today short > long → above fires
    const decSeries = buildSeries('DEC', [
      '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
    ], [0.15, 0.1, 0.2, 0.3]);
    const rule = { id: 'r1', instrument: 'DEC', instrumentKey: 'DEC', type: 'ma_cross', direction: 'above', short: 2, long: 3, fileIndex: 0 };
    const result = maCrossAlerts(decSeries, rule);
    assert.equal(result.length, 1);
    assert.equal(result[0].date, '2026-01-04');
  });

  it('25 flat-price days produce no alerts in either direction', () => {
    const dates = [];
    for (let i = 1; i <= 25; i++) {
      dates.push(`2026-01-${String(i).padStart(2, '0')}`);
    }
    const closes = new Array(25).fill(50);
    const series = buildSeries('FLAT', dates, closes);

    const ruleAbove = { id: 'r1', instrument: 'FLAT', instrumentKey: 'FLAT', type: 'ma_cross', direction: 'above', short: 5, long: 20, fileIndex: 0 };
    const ruleBelow = { id: 'r2', instrument: 'FLAT', instrumentKey: 'FLAT', type: 'ma_cross', direction: 'below', short: 5, long: 20, fileIndex: 1 };
    assert.equal(maCrossAlerts(series, ruleAbove).length, 0);
    assert.equal(maCrossAlerts(series, ruleBelow).length, 0);
  });

  it('5/20: no alert on data point 20 (first day long MA exists) even if short > long', () => {
    // 20 closes of 100 then close 21 of 200 — at point 20 (index 20), long MA just defined
    // but prevLong is NOT defined (index 19 has only 19+1=20 points, long MA needs index >= 19, so it IS defined)
    // Actually: long MA window 20, defined from index 19 (0-based). Cross needs prev long defined too,
    // so needs index >= 20 for today, making the first day data point index 20 (the 21st point).
    // Build data: 19 closes of 100, then index 19 = 100, index 20 = 200 (the 21st point)
    // At index 20: prevLong is defined (index 19), todayLong is defined. Let's check:
    // Short MA(5) at 20: mean of indices 16-20. If 16-19 are 100 and 20 is 200: (100*4+200)/5 = 120
    // Long MA(20) at 20: mean of indices 1-20. Indices 1-19 are 100 (19 of them), 20 is 200: (19*100+200)/20 = 105
    // PrevShort(19): 100 (all 100s). PrevLong(19): 100 (all 100s). 100 <= 100 → qualifies.
    // todayShort 120 > todayLong 105 → fires. That's fine for index 20 (the 21st point).
    // For index 19 (the 20th point): todayLong defined, but prevLong (index 18) needs 19 points from 0..18
    // which is 19 data points but window is 20 → NOT defined. So index 19 cannot fire.
    // Build: 21 closes where the first 20 are 100, then 200
    const dates = [];
    for (let i = 1; i <= 21; i++) {
      dates.push(`2026-01-${String(i).padStart(2, '0')}`);
    }
    const closes = new Array(20).fill(100);
    closes.push(200);
    const series = buildSeries('TEST', dates, closes);

    const rule = { id: 'r1', instrument: 'TEST', instrumentKey: 'TEST', type: 'ma_cross', direction: 'above', short: 5, long: 20, fileIndex: 0 };
    const result = maCrossAlerts(series, rule);
    // Alert should fire on data point 20 (index 20, the 21st point) not on index 19
    assert.equal(result.length, 1);
    assert.equal(result[0].date, '2026-01-21');
  });

  it('cross before long MA was defined never fires below', () => {
    // 15 closes of 200 then 5 of 100 then more 100s (total 25)
    // Long MA(20) defined from index 19. The "drop" from 200 to 100 happens at index 15.
    // At index 15-19, long MA not fully defined → cannot fire.
    // At index 20+, both MAs are fully in the 100-range → no cross.
    const dates = [];
    for (let i = 1; i <= 25; i++) {
      dates.push(`2026-01-${String(i).padStart(2, '0')}`);
    }
    const closes = new Array(15).fill(200).concat(new Array(10).fill(100));
    const series = buildSeries('TEST2', dates, closes);
    const rule = { id: 'r1', instrument: 'TEST2', instrumentKey: 'TEST2', type: 'ma_cross', direction: 'below', short: 5, long: 20, fileIndex: 0 };
    const result = maCrossAlerts(series, rule);
    assert.equal(result.length, 0);
  });

  it('fewer than long+1 data points gives no alert and a D15 warning', () => {
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03'];
    const closes = [10, 20, 30];
    const series = buildSeries('SHORT', dates, closes);
    const rule = { id: 'r1', instrument: 'SHORT', instrumentKey: 'SHORT', type: 'ma_cross', direction: 'above', short: 2, long: 3, fileIndex: 0 };
    // Series has 3 points, needs at least long+1 = 4 for a cross
    // Actually: long MA needs index >= 2 (0-based) for window 3. Cross needs prev long MA at index >= 2,
    // and today at index >= 3. So needs at least 4 points.
    const result = maCrossAlerts(series, rule);
    assert.equal(result.length, 0);
  });

  it('windows counted in data points, not calendar days (D8/D12)', () => {
    // Same closes with weekend gaps should give same results as consecutive dates
    const closesArr = [10, 10, 10, 12, 14, 9, 8, 15];
    const gapDates = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06',
                       '2026-01-12', '2026-01-13', '2026-01-14', '2026-01-20'];
    const seqDates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04',
                       '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08'];
    const gapSeries = buildSeries('GAP', gapDates, closesArr);
    const seqSeries = buildSeries('SEQ', seqDates, closesArr);
    const ruleGap = { id: 'r1', instrument: 'GAP', instrumentKey: 'GAP', type: 'ma_cross', direction: 'above', short: 2, long: 3, fileIndex: 0 };
    const ruleSeq = { id: 'r1', instrument: 'SEQ', instrumentKey: 'SEQ', type: 'ma_cross', direction: 'above', short: 2, long: 3, fileIndex: 0 };
    const gapResult = maCrossAlerts(gapSeries, ruleGap);
    const seqResult = maCrossAlerts(seqSeries, ruleSeq);
    // Same number of alerts at the same indices
    assert.equal(gapResult.length, seqResult.length);
  });
});

// ===========================
// evaluate / ordering / format tests (D13, D14)
// ===========================
describe('evaluate and formatAlerts', () => {
  it('combined golden test: shuffled input equals expected output', () => {
    const csv = [
      'date,instrument,close',
      '2026-09-04,BBB,101', '2026-09-03,AAA,10', '2026-09-01,BBB,100',
      '2026-09-08,AAA,9', '2026-09-07,BBB,99', '2026-09-02,AAA,10',
      '2026-09-09,AAA,8', '2026-09-01,AAA,10', '2026-09-02,BBB,98',
      '2026-09-10,AAA,15', '2026-09-04,AAA,12', '2026-09-03,BBB,97',
      '2026-09-08,BBB,100', '2026-09-07,AAA,14', '2026-09-09,BBB,95',
    ].join('\n');
    const json = JSON.stringify([
      {"id":"r1","instrument":"BBB","type":"level","direction":"below","level":100},
      {"id":"r10","instrument":"BBB","type":"level","direction":"above","level":100},
      {"id":"r2","instrument":"AAA","type":"ma_cross","short":2,"long":3,"direction":"above"},
      {"id":"r3","instrument":"AAA","type":"ma_cross","short":2,"long":3,"direction":"below"},
    ]);

    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    const output = formatAlerts(alertList);

    const expected = [
      '2026-09-02  r1   BBB  level below 100',
      '2026-09-04  r10  BBB  level above 100',
      '2026-09-04  r2   AAA  ma_cross 2/3 above',
      '2026-09-07  r1   BBB  level below 100',
      '2026-09-08  r3   AAA  ma_cross 2/3 below',
      '2026-09-09  r1   BBB  level below 100',
      '2026-09-10  r2   AAA  ma_cross 2/3 above',
    ].join('\n') + '\n';
    assert.equal(output, expected);
  });

  it('reversed input gives same output as shuffled', () => {
    const rows = [
      '2026-09-09,BBB,95', '2026-09-07,AAA,14', '2026-09-08,BBB,100',
      '2026-09-03,BBB,97', '2026-09-04,AAA,12', '2026-09-10,AAA,15',
      '2026-09-02,BBB,98', '2026-09-01,AAA,10', '2026-09-09,AAA,8',
      '2026-09-02,AAA,10', '2026-09-07,BBB,99', '2026-09-08,AAA,9',
      '2026-09-01,BBB,100', '2026-09-03,AAA,10', '2026-09-04,BBB,101',
    ];
    const csv = 'date,instrument,close\n' + rows.join('\n');
    const json = JSON.stringify([
      {"id":"r1","instrument":"BBB","type":"level","direction":"below","level":100},
      {"id":"r10","instrument":"BBB","type":"level","direction":"above","level":100},
      {"id":"r2","instrument":"AAA","type":"ma_cross","short":2,"long":3,"direction":"above"},
      {"id":"r3","instrument":"AAA","type":"ma_cross","short":2,"long":3,"direction":"below"},
    ]);
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    const output = formatAlerts(alertList);

    const expected = [
      '2026-09-02  r1   BBB  level below 100',
      '2026-09-04  r10  BBB  level above 100',
      '2026-09-04  r2   AAA  ma_cross 2/3 above',
      '2026-09-07  r1   BBB  level below 100',
      '2026-09-08  r3   AAA  ma_cross 2/3 below',
      '2026-09-09  r1   BBB  level below 100',
      '2026-09-10  r2   AAA  ma_cross 2/3 above',
    ].join('\n') + '\n';
    assert.equal(output, expected);
  });

  it('same-date alerts ordered by rule id with r10 before r2 (D13)', () => {
    // Already tested in golden, but explicit
    const csv = 'date,instrument,close\n2026-09-01,A,50\n2026-09-02,A,150\n';
    const json = JSON.stringify([
      {"id":"r2","instrument":"A","type":"level","direction":"above","level":100},
      {"id":"r10","instrument":"A","type":"level","direction":"above","level":100},
    ]);
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    // r10 < r2 in code-unit comparison, so r10 comes first
    assert.equal(alertList[0].ruleId, 'r10');
    assert.equal(alertList[1].ruleId, 'r2');
  });

  it('stable tie-break for duplicate ids (D13)', () => {
    const csv = 'date,instrument,close\n2026-09-01,A,50\n2026-09-02,A,150\n2026-09-01,B,50\n2026-09-02,B,150\n';
    const json = JSON.stringify([
      {"id":"r1","instrument":"A","type":"level","direction":"above","level":100},
      {"id":"r1","instrument":"B","type":"level","direction":"above","level":100},
    ]);
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    // Both fire on 09-02 with id "r1"; tie-break is fileIndex order
    assert.equal(alertList[0].instrument, 'A');
    assert.equal(alertList[1].instrument, 'B');
  });

  it('no trailing spaces in output lines (D14)', () => {
    const csv = 'date,instrument,close\n2026-09-01,INFY,1600\n2026-09-02,INFY,1400\n';
    const json = '[{"id":"r1","instrument":"INFY","type":"level","direction":"below","level":1500}]';
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    const output = formatAlerts(alertList);
    const lines = output.split('\n').filter(l => l.length > 0);
    for (const line of lines) {
      assert.equal(line, line.trimEnd(), `Line has trailing whitespace: "${line}"`);
    }
  });

  it('empty alerts give empty string (D14)', () => {
    assert.equal(formatAlerts([]), '');
  });

  it('brief example: 5 rows with INFY and TCS rules print exactly one line', () => {
    const csv = [
      'date,instrument,close',
      '2026-09-01,INFY,1520.50',
      '2026-09-01,TCS,3890.00',
      '2026-09-02,INFY,1534.10',
      '2026-09-02,TCS,3902.25',
      '2026-09-03,INFY,1498.00',
    ].join('\n');
    const json = JSON.stringify([
      {"id":"r1","instrument":"INFY","type":"level","direction":"below","level":1500},
      {"id":"r2","instrument":"TCS","type":"ma_cross","short":5,"long":20,"direction":"above"},
    ]);
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    const { alerts: alertList } = evaluate(series, rules);
    const output = formatAlerts(alertList);
    assert.equal(output, '2026-09-03  r1  INFY  level below 1500\n');
  });
});

// ===========================
// CLI tests (child_process)
// ===========================
describe('CLI', () => {
  it('golden combined test: stdout matches expected_output.txt', () => {
    const expectedPath = path.resolve(__dirname, 'sample', 'expected_output.txt');
    const expected = fs.readFileSync(expectedPath, 'utf8').replace(/\r\n/g, '\n');
    const pricesPath = path.resolve(__dirname, 'sample', 'prices.csv');
    const rulesPath = path.resolve(__dirname, 'sample', 'rules.json');

    // Run from a different cwd (os.tmpdir) with absolute paths
    const result = runCLI([pricesPath, rulesPath], os.tmpdir());
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, expected);
  });

  it('stdout contains only alerts, warnings appear on stderr', () => {
    // The sample prices.csv has a bad row which should produce a warning on stderr
    const pricesPath = path.resolve(__dirname, 'sample', 'prices.csv');
    const rulesPath = path.resolve(__dirname, 'sample', 'rules.json');
    const result = runCLI([pricesPath, rulesPath]);
    // stderr should have the warning about the bad row
    assert.ok(result.stderr.length > 0, 'stderr should have warnings');
    // stdout should not contain "warning" or "error"
    assert.ok(!result.stdout.toLowerCase().includes('warning'));
    assert.ok(!result.stdout.toLowerCase().includes('error'));
  });

  it('no arguments gives exit code 2 and usage message', () => {
    const result = runCLI([]);
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes('usage:'));
  });

  it('one argument gives exit code 2', () => {
    const result = runCLI(['prices.csv']);
    assert.equal(result.exitCode, 2);
  });

  it('missing prices file gives exit code 1', () => {
    const { rulesPath } = writeTempFiles('', '[]');
    const result = runCLI(['/nonexistent/prices.csv', rulesPath]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('error:'));
  });

  it('prices path is a directory gives exit code 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat-'));
    const { rulesPath } = writeTempFiles('', '[]');
    const result = runCLI([dir, rulesPath]);
    assert.equal(result.exitCode, 1);
  });

  it('path containing a space works', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pat space-'));
    const pricesPath = path.join(dir, 'prices.csv');
    const rulesPath = path.join(dir, 'rules.json');
    fs.writeFileSync(pricesPath, 'date,instrument,close\n2026-09-01,X,100\n');
    fs.writeFileSync(rulesPath, '[]');
    const result = runCLI([pricesPath, rulesPath], dir);
    assert.equal(result.exitCode, 0);
  });

  it('invalid JSON in rules gives exit code 1 with no stack trace', () => {
    const { pricesPath, rulesPath } = writeTempFiles(
      'date,instrument,close\n2026-09-01,X,100\n',
      '{not json'
    );
    const result = runCLI([pricesPath, rulesPath]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.stderr.includes('error:'));
    assert.ok(!result.stderr.includes('    at '), 'Should not have stack trace');
  });

  it('rules root not an array gives exit code 1', () => {
    const { pricesPath, rulesPath } = writeTempFiles(
      'date,instrument,close\n2026-09-01,X,100\n',
      '{"a":1}'
    );
    const result = runCLI([pricesPath, rulesPath]);
    assert.equal(result.exitCode, 1);
  });

  it('rule for instrument absent from prices: warning, other rules still run', () => {
    const { pricesPath, rulesPath } = writeTempFiles(
      'date,instrument,close\n2026-09-01,INFY,1600\n2026-09-02,INFY,1400\n',
      JSON.stringify([
        {"id":"r1","instrument":"MISSING","type":"level","direction":"below","level":100},
        {"id":"r2","instrument":"INFY","type":"level","direction":"below","level":1500},
      ])
    );
    const result = runCLI([pricesPath, rulesPath]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.stderr.includes('no prices'));
    assert.ok(result.stdout.includes('r2'));
  });
});

// ===========================
// Cross-check: property test with naive reference implementation
// ===========================
describe('Cross-check: property test', () => {
  // Seeded PRNG: mulberry32
  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Naive reference: level alerts
  function naiveLevelAlerts(points, direction, level) {
    const results = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1].close;
      const today = points[i].close;
      if (direction === 'below' && prev >= level && today < level) {
        results.push(points[i].date);
      }
      if (direction === 'above' && prev <= level && today > level) {
        results.push(points[i].date);
      }
    }
    return results;
  }

  // Naive reference: ma_cross alerts (deliberately uses slice + sum, no prefix sums)
  function naiveMaCrossAlerts(points, shortW, longW, direction) {
    const results = [];
    function maSum(end, window) {
      if (end - window + 1 < 0) return null;
      let s = 0n;
      for (let j = end - window + 1; j <= end; j++) {
        s += points[j].close;
      }
      return s;
    }
    // Cross needs both today's and prev's long MA defined
    // Today's long MA defined when i >= longW - 1
    // Prev's long MA defined when i-1 >= longW - 1, i.e., i >= longW
    for (let i = longW; i < points.length; i++) {
      const todayShortSum = maSum(i, shortW);
      const todayLongSum = maSum(i, longW);
      const prevShortSum = maSum(i - 1, shortW);
      const prevLongSum = maSum(i - 1, longW);
      if (todayShortSum === null || todayLongSum === null || prevShortSum === null || prevLongSum === null) continue;

      // Compare without division: shortSum * longWindow vs longSum * shortWindow
      const todayShortScaled = todayShortSum * BigInt(longW);
      const todayLongScaled = todayLongSum * BigInt(shortW);
      const prevShortScaled = prevShortSum * BigInt(longW);
      const prevLongScaled = prevLongSum * BigInt(shortW);

      if (direction === 'above' && prevShortScaled <= prevLongScaled && todayShortScaled > todayLongScaled) {
        results.push(points[i].date);
      }
      if (direction === 'below' && prevShortScaled >= prevLongScaled && todayShortScaled < todayLongScaled) {
        results.push(points[i].date);
      }
    }
    return results;
  }

  it('300 random datasets: maCrossAlerts matches naive reference', () => {
    const baseSeed = 12345;
    for (let trial = 0; trial < 300; trial++) {
      const rng = mulberry32(baseSeed + trial);
      const n = Math.floor(rng() * 50) + 5; // 5 to 54 data points
      const shortW = Math.floor(rng() * 3) + 2; // 2 to 4
      const longW = shortW + Math.floor(rng() * 5) + 1; // short+1 to short+5
      const direction = rng() > 0.5 ? 'above' : 'below';

      const points = [];
      for (let i = 0; i < n; i++) {
        const day = String(i + 1).padStart(2, '0');
        const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
        const dayOfMonth = String((i % 28) + 1).padStart(2, '0');
        // Small integer prices so ties are frequent
        const price = Math.floor(rng() * 10) + 1; // 1 to 10
        points.push({
          date: `2026-${month}-${dayOfMonth}`,
          close: BigInt(price) * SCALE,
        });
      }

      const series = new Map();
      series.set('TEST', points);

      const rule = { id: 'r1', instrument: 'TEST', instrumentKey: 'TEST', type: 'ma_cross', direction, short: shortW, long: longW, fileIndex: 0 };
      const actual = maCrossAlerts(series, rule).map(a => a.date);
      const expected = naiveMaCrossAlerts(points, shortW, longW, direction);

      assert.deepEqual(actual, expected,
        `Mismatch on trial ${trial} (seed=${baseSeed + trial}, n=${n}, short=${shortW}, long=${longW}, dir=${direction})`
      );
    }
  });

  it('300 random datasets: levelAlerts matches naive reference', () => {
    const baseSeed = 67890;
    for (let trial = 0; trial < 300; trial++) {
      const rng = mulberry32(baseSeed + trial);
      const n = Math.floor(rng() * 30) + 2; // 2 to 31
      const direction = rng() > 0.5 ? 'above' : 'below';
      const levelPrice = Math.floor(rng() * 8) + 2; // 2 to 9

      const points = [];
      for (let i = 0; i < n; i++) {
        const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
        const dayOfMonth = String((i % 28) + 1).padStart(2, '0');
        const price = Math.floor(rng() * 10) + 1;
        points.push({
          date: `2026-${month}-${dayOfMonth}`,
          close: BigInt(price) * SCALE,
        });
      }

      const series = new Map();
      series.set('TEST', points);

      const level = BigInt(levelPrice) * SCALE;
      const rule = { id: 'r1', instrument: 'TEST', instrumentKey: 'TEST', type: 'level', direction, level, levelText: String(levelPrice), fileIndex: 0 };
      const actual = levelAlerts(series, rule).map(a => a.date);
      const expected = naiveLevelAlerts(points, direction, level);

      assert.deepEqual(actual, expected,
        `Mismatch on trial ${trial} (seed=${baseSeed + trial}, n=${n}, level=${levelPrice}, dir=${direction})`
      );
    }
  });
});

// ===========================
// Performance sanity test
// ===========================
describe('Performance', () => {
  it('200,000 rows across 5 instruments and 3 rules completes in under 10 seconds', () => {
    // Build a CSV with 200,000 rows (40,000 per instrument)
    const instruments = ['INST_A', 'INST_B', 'INST_C', 'INST_D', 'INST_E'];
    const lines = ['date,instrument,close'];
    let dayCounter = 0;
    for (const inst of instruments) {
      for (let i = 0; i < 40000; i++) {
        const year = 2020 + Math.floor(dayCounter / 365);
        const dayOfYear = (dayCounter % 365) + 1;
        // Simple date generation: approximate
        const month = Math.min(12, Math.floor((dayOfYear - 1) / 28) + 1);
        const day = ((dayOfYear - 1) % 28) + 1;
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const price = 100 + (i % 50);
        lines.push(`${dateStr},${inst},${price}`);
        dayCounter++;
      }
    }
    const csv = lines.join('\n');
    const json = JSON.stringify([
      {"id":"r1","instrument":"INST_A","type":"level","direction":"below","level":120},
      {"id":"r2","instrument":"INST_B","type":"ma_cross","short":5,"long":20,"direction":"above"},
      {"id":"r3","instrument":"INST_C","type":"ma_cross","short":10,"long":50,"direction":"below"},
    ]);

    const start = process.hrtime.bigint();
    const { series } = loadPrices(csv);
    const { rules } = loadRules(json);
    evaluate(series, rules);
    const elapsed = Number(process.hrtime.bigint() - start) / 1e9;

    assert.ok(elapsed < 10, `Took ${elapsed.toFixed(2)}s, expected under 10s`);
  });
});
