# DEVLOG — Price Alert Tool

## Entry 1: Project setup (Phase 0)
- Node v22.17.0 confirmed (meets requirement >= 18).
- Directory structure initialized: `price-alert-tool/` with `sample/` and `tools/` subdirectories.
- Created `price-alert-tool-PREP/` as a sibling directory outside the submission folder.
- Locked constraints review: Zero dependencies (built-ins only), CommonJS ("use strict"), no floats, no Date objects, no localeCompare, small readable codebase (target 200-280 lines).

## Entry 2: Fixture creation (Phase 1)
- Created `sample/prices.csv` with AAA (8 trading days) and BBB (7 trading days) rows intentionally shuffled, plus one deliberate bad row (`2026-bad-row,AAA,xyz`) at line 17 to verify row validation warnings on stderr.
- Created `sample/rules.json` with r1 (BBB level below 100), r10 (BBB level above 100), r2 (AAA ma_cross 2/3 above), r3 (AAA ma_cross 2/3 below).
- Created `sample/expected_output.txt` by hand computation:
  - BBB level below 100 fires on 2026-09-02, 2026-09-07, 2026-09-09. (09-03 does not fire as it was already below; 09-08 does not fire as 100 is not < 100; 09-09 fires because prev 100 >= 100 and today 95 < 100 per D11 touch semantics).
  - BBB level above 100 fires only on 2026-09-04 (prev 97 <= 100, today 101 > 100).
  - AAA ma_cross 2/3 above fires on 2026-09-04 (prev short 10 <= prev long 10 tie counts per D12, today short 11 > long 10.667) and 2026-09-10 (prev short 8.5 <= long 10.333, today short 11.5 > long 10.667).
  - AAA ma_cross 2/3 below fires on 2026-09-08 (prev short 13 >= long 12, today short 11.5 < long 11.667).
  - Sorted order: 09-02 r1, 09-04 r10, 09-04 r2, 09-07 r1, 09-08 r3, 09-09 r1, 2026-09-10 r2. Note r10 precedes r2 on 09-04 due to code-unit string sort (D13).

## Entry 3: Tests-first implementation (Phase 2)
- Authored comprehensive test suite in `alerts.test.js` using `node:test` and `node:assert/strict`.
- Total 113 test cases across 10 describe blocks:
  1. `parseDecimal`: valid integers, decimals, 12 fractional digits, trailing zeros, rejects negative, blank, NaN, exponent notation, zero.
  2. `isValidDate`: valid ISO dates, leap year arithmetic (divisible by 4 & not 100, or 400: 2024 leap, 2025 non-leap, 2000 leap, 1900 non-leap), days in month bounds, invalid months/days.
  3. `loadPrices`: BOM stripping, CRLF/CR/LF line endings, header order insensitivity, case insensitivity, blank lines, missing columns (throws UserError), row validation (field count, bad date, bad close, empty instrument), last-wins duplicate handling, instrument casing normalization, date ascending sort.
  4. `loadRules`: valid rules, JSON errors (UserError), non-array root, unknown types/directions, window validations (short < long, positive integers), positive levels, duplicate id warning.
  5. `levelAlerts`: BBB golden fixture, touch semantics, decimal comparisons without float inaccuracy.
  6. `maCrossAlerts`: AAA golden fixture, DEC exactness fixture, 25 flat-price days producing no alerts, point 20 vs 21 crossing checks, data-point vs calendar-day gap invariance.
  7. `evaluate and formatAlerts`: shuffled/reversed input equivalence, code-unit id ordering, padding alignment, brief example.
  8. `CLI`: exit codes (0, 1, 2), child_process execution, paths with spaces, stderr warnings vs stdout alerts.
  9. `Cross-check: property test`: seeded PRNG (mulberry32) comparing against naive reference on 300 random datasets for both level and ma_cross rules.
  10. `Performance`: 200,000 rows across 5 instruments benchmarked (completes in < 2 seconds, well under the 10-second bound).
- Executed `node --test alerts.test.js` before `alerts.js` existed; confirmed failure with `MODULE_NOT_FOUND`.

## Entry 4: Implementation & refactoring (Phase 3 & 4)
- Implemented `alerts.js` adhering to D1-D16.
- Defect caught during drafting of `loadPrices`: filtering blank lines before iterating lines resulted in incorrect 1-based line numbers reported in validation warnings. Refactored to scan raw split lines, locate the first non-blank line as the header, and compute exact line numbers `li + 1`.
- Defect / code size review: initial draft reached 322 lines. Cleaned up redundant code, consolidated blank lines and comments while preserving all WHY documentation and single-purpose function architecture. Final line count: 276 lines (within the target 200-280 lines).
- Executed `node --test alerts.test.js`: all 113 tests passed (10 suites, 0 failures).
- Verified sample execution against `sample/expected_output.txt`: exact byte-level match on stdout, warnings routed to stderr.

## Entry 5: Mutation check & survivor resolution (Phase 5)
- Created `tools/mutation_check.js` applying 15 distinct mutations across isolated temp copies.
- Survivor observed on first run: `ma-undefined-as-zero` survived when initially modeled as removing `if (n < lW + 1) return [];`.
  - Cause analysis: removing that early guard did not alter behavior because the main loop `for (let i = lW; i < n; i++)` is self-guarding when `n <= lW`, and `evaluate()` separately checks `pts.length < need`.
  - Resolution: updated the mutation to faithfully represent the bug "undefined MA treated as zero" by starting evaluation at index 1 and substituting `0n` for incomplete windows.
  - Verification: all 15 mutants killed (15/15 killed, 0 survived).

## Entry 6: Hostile review & fuzzing (Phase 6)
- Grep audit: confirmed zero usage of `new Date`, `parseFloat`, `localeCompare`, `process.exit(`, or debug `console.log`.
- Ran 500 random garbage inputs through `alerts.js` (binary bytes, missing headers, random delimiters, malformed JSON, extreme numbers). Zero unhandled exceptions; all exited cleanly with status 0, 1, or 2 and concise stderr messages.

## Entry 7: Sample Row Count Alignment (Review Phase)
- The project structure guideline called for `sample/prices.csv (about 40 rows: two instruments; both rule types fire; includes one out-of-order stretch, one weekend gap, one deliberately bad row)`.
- Initial fixture had 17 lines (15 golden rows + bad row + header). Expanded `sample/prices.csv` with 22 inactive trading rows (11 BBB rows at close 95; 11 AAA rows at close 15) bringing the file to 39 total rows (~40 rows).
- Hand verification proved zero alerts are produced by the additional rows (BBB remains below 100; AAA short and long MAs both converge to 15 without crossing). Output of `node alerts.js sample/prices.csv sample/rules.json` remains identical to `sample/expected_output.txt`.

## Entry 8: Final review in a second AI chat, stack overflow found
- After the build was complete, I uploaded alerts.js, the tests, DEVLOG.md, README.md and mutation_check.js to a separate AI chat and asked it to review everything as a hostile reviewer. I did not find the bug below myself; the reviewer found it, I reproduced it, and I applied the fix.
- Defect: in evaluate(), alerts were collected with `all.push(...levelAlerts(series, rule))` and `all.push(...maCrossAlerts(series, rule))`. The spread operator passes every alert as a separate function argument, and JavaScript has a limit on that. On a generated file of 400,000 rows with prices alternating above and below the level, the tool crashed with "Maximum call stack size exceeded".
- Why my tests missed it: the 200,000-row performance test used prices that rarely cross, so the alert arrays stayed small. The 113 tests and 15 mutants all passed even though this bug existed. Passing tests did not prove there were no bugs.
- Fix: replaced both lines with a loop that pushes one alert at a time: `for (const a of levelAlerts(series, rule)) all.push(a);` and the same for maCrossAlerts. No other code was changed, so the line count stayed at 276 and the line numbers did not shift.
- Verification after the fix: on the same 400,000-row alternating file with one level rule and one ma_cross rule, the tool finished without crashing and produced 399,999 alerts.

## Entry 9: Final verification run (after the Entry 8 fix)
- `node --test`: 113 tests, 10 suites, 113 pass, 0 fail.
- `node tools/mutation_check.js`: 15 mutants, 15 killed, 0 survived. None of the mutation target strings were affected by the Entry 8 change, so all 15 still applied.
- `node alerts.js sample/prices.csv sample/rules.json`: output matches sample/expected_output.txt. Warnings for the deliberately bad row appear on stderr only; stdout contains only alert lines.
- Grep audit of alerts.js for `new Date`, `parseFloat`, `localeCompare`, `process.exit(` and `console.log`: no use in code (two comments mention the names).
- alerts.js is 276 lines.
- Known gap: there is no dedicated regression test for the Entry 8 stack overflow. It was verified by a one-off script, not by a committed test.
- Remaining assumptions, listed in the README and worth confirming with the coordinator: ties and exact touches count as the other side (D11, D12), r10 sorts before r2 (D13), last duplicate row wins (D6), quoted CSV fields containing commas are not supported (D5).