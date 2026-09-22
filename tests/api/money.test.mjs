/* Step 0 — money arithmetic, proven before anything depends on it.
   Pure functions, no server needed. */
/* Dynamic import: the specifier is resolved RELATIVE TO THIS FILE, so the suite works from
   any checkout. Requires `npm run build` in backend/ first - this is the one suite that
   imports compiled output rather than talking to a running server. */
const { calculateAmountPaise, rupeesToPaise, paiseToRupees, formatPaise } =
  await import(new URL('../../backend/dist/utils/money.js', import.meta.url).href);

let pass = 0, fail = 0; const failures = [];
const chk = (name, expected, actual) => {
  if (Object.is(expected, actual)) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}  (expected ${expected}, got ${actual})`); failures.push(name); fail++; }
};

console.log('=== THE WORKED EXAMPLES FROM THE BRIEF ===');
chk('1 kWh x Rs10 = Rs10.00', 1000, calculateAmountPaise(1000, 1000));
chk('2.5 kWh x Rs10 = Rs25.00', 2500, calculateAmountPaise(2500, 1000));
chk('2.5 kWh x Rs12 = Rs30.00', 3000, calculateAmountPaise(2500, 1200));
chk('4.75 kWh x Rs10 = Rs47.50', 4750, calculateAmountPaise(4750, 1000));
chk('   and it formats as Rs47.50', '₹47.50', formatPaise(4750));

console.log('\n=== FLOAT DRIFT MUST BE UNREPRESENTABLE ===');
// The classic. If money were floats, repeated addition would drift.
let drift = 0;
for (let i = 0; i < 10; i++) drift += 0.1;
chk('   (float addition really does drift)', false, drift === 1);
let paise = 0;
for (let i = 0; i < 10; i++) paise += 10;
chk('   integer paise do not', 100, paise);
chk('Rs10.50 is exactly 1050 paise', 1050, rupeesToPaise(10.5));
chk('   and never 1049.99...', true, Number.isInteger(rupeesToPaise(10.5)));
// 12.34 * 100 === 1233.9999999999998 in IEEE-754; trunc would give Rs12.33.
chk('Rs12.34 rounds up, not down', 1234, rupeesToPaise(12.34));
chk('Rs0.07 survives the conversion', 7, rupeesToPaise(0.07));
chk('Rs8.29 survives the conversion', 829, rupeesToPaise(8.29));

console.log('\n=== ROUNDING ===');
chk('0.333 kWh x Rs12.99 -> 433 paise', 433, calculateAmountPaise(333, 1299));
chk('half rounds up', 3, calculateAmountPaise(25, 100));
chk('a sub-paise amount rounds to 0', 0, calculateAmountPaise(1, 5));
chk('rounded exactly once (not per-step)', 12346, calculateAmountPaise(12345.6789, 1000));
chk('every result is an integer', true,
  [calculateAmountPaise(333, 1299), calculateAmountPaise(2500, 1200), calculateAmountPaise(4750, 1000)]
    .every(Number.isInteger));

console.log('\n=== DEFENSIVE CASES (a charge can never be negative) ===');
chk('zero energy -> 0', 0, calculateAmountPaise(0, 1200));
chk('negative energy -> 0', 0, calculateAmountPaise(-500, 1200));
chk('zero rate -> 0', 0, calculateAmountPaise(2500, 0));
chk('negative rate -> 0', 0, calculateAmountPaise(2500, -1200));
chk('NaN energy -> 0', 0, calculateAmountPaise(NaN, 1200));
chk('Infinity energy -> 0', 0, calculateAmountPaise(Infinity, 1200));

console.log('\n=== ROUND TRIP ===');
chk('paise -> rupees -> paise is stable', 3000, rupeesToPaise(paiseToRupees(3000)));
chk('a large session stays exact', 4200000, calculateAmountPaise(3500000, 1200));

console.log(`\n=========== MONEY: ${pass} passed, ${fail} failed ===========`);
if (fail) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
