# Price Alert Tool

A zero-dependency command-line tool that reads daily instrument prices from CSV, evaluates configurable alert rules from JSON, and prints alerts in chronological order and then by rule ID. Built with plain Node.js and `BigInt`-based fixed-point arithmetic.

## How to Run

Requires Node.js 18 or newer. No third-party packages are required.

```bash
node alerts.js <prices.csv> <rules.json>
```

Example:

```bash
node alerts.js sample/prices.csv sample/rules.json
```

Run the automated test suite:

```bash
node --test
```

## Tests and Verification

- **Golden fixtures:** Tests cover level crossings and moving-average crossovers, including boundary conditions and expected output.
- **Property-based cross-checks:** Seeded random datasets are compared with a simpler reference implementation for both level and moving-average alerts.
- **Mutation testing:** Run `node tools/mutation_check.js` to check whether the test suite detects selected logic errors. The recorded run killed 15 of 15 configured mutants; rerun it to verify the current version.
- **Performance:** The test suite includes a 200,000-row performance check.
- **Manual CLI checks:** I tested the sample output, missing arguments, a missing prices file, invalid JSON rules, empty rules, and custom level and moving-average crossover examples.

These results describe the tests and checks performed; they do not prove that every possible input or edge case is covered.

## Assumptions and Limitations

- **Duplicate prices:** For duplicate `(date, instrument)` pairs, the last row wins.
- **Instrument matching:** Instrument symbols are matched case-insensitively; alert output uses the casing specified in the rule.
- **Trading days:** The previous observation means the previous recorded row for that instrument, not necessarily the previous calendar day.
- **Level crossings:** A downward crossing fires when `prev >= level` and `today < level`; an upward crossing fires when `prev <= level` and `today > level`.
- **Moving-average crossings:** Both moving-average windows must be fully available. An undefined average is not treated as zero. Crossovers are checked using integer arithmetic rather than floating-point division.
- **Alert ordering:** Alerts are sorted by date, then by rule ID using code-unit string comparison (so `r10` sorts before `r2`), with rule-file order as a tie-breaker.
- **Output formatting:** Alert columns are left-aligned and padded, with two spaces between columns.
- **CSV limitation:** This is a deliberately simple CSV parser. Commas inside quoted fields are not supported; the limitation is documented rather than treated as full CSV compatibility.
- **Numeric precision:** Prices and levels are represented with fixed-point integer arithmetic, supporting up to 12 fractional decimal places. Scientific notation is rejected by the input parser.

## How I Used the AI Assistant

As a fifth-semester computer science student familiar with Node.js and the MERN stack, I used an AI assistant to help design the specification, implementation, and tests. I provided constraints covering the CLI interface, dependency-free execution, price precision, alert semantics, sorting, and edge cases. I then ran the tests and manually checked representative cases in my local terminal. I reviewed the generated code and used the test results to guide further verification.

## What the Assistant Got Wrong and What I Changed

- **CSV warning line numbers:** An initial parser approach filtered blank lines before processing rows, which could make warning line numbers inaccurate. The parser was changed to preserve original line positions.
- **Mutation modelling:** An initial version of the undefined-moving-average mutant did not expose the intended defect because the loop bounds prevented it from executing. The mutant was revised to model the defect more accurately.
- **Code size and readability:** The initial implementation was longer and contained redundant parsing logic. I requested a refactor to improve readability and make the code easier for me to explain and modify.

I used AI assistance, but I am responsible for understanding the submitted implementation, its assumptions, and the tests used to verify it.