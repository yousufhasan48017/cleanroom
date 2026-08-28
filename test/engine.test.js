/**
 * Engine tests. Run with:  node test/engine.test.js
 *
 * The audit date is pinned so scores are reproducible — a data quality tool
 * that returns a different number each run is not a data quality tool.
 */
var fs = require('fs');
var path = require('path');
var Cleanroom = require('../engine.js');

var AS_OF = '2026-08-28';
var passed = 0, failed = 0;

function check(name, condition, detail) {
  if (condition) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}

function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------------ */
section('CSV parsing');

var simple = Cleanroom.parseCSV('a,b\n1,2\n3,"x,y"\n');
check('reads headers', simple.headers.join('|') === 'a|b', simple.headers.join('|'));
check('reads rows', simple.rows.length === 2, String(simple.rows.length));
check('honours quoted commas', simple.rows[1].b === 'x,y', simple.rows[1].b);
check('handles escaped quotes', Cleanroom.parseCSV('a\n"he said ""hi"""').rows[0].a === 'he said "hi"');
check('skips blank lines', Cleanroom.parseCSV('a\n1\n\n2\n').rows.length === 2);

/* ------------------------------------------------------------------ */
section('Normalisation');

var I = Cleanroom._internals;
check('strips legal suffixes', I.entityKey('Zubair Trading Co.') === I.entityKey('Zubair Trading Company'),
  I.entityKey('Zubair Trading Co.') + ' vs ' + I.entityKey('Zubair Trading Company'));
check('Searle variants share a key',
  I.entityKey('Searle Pakistan Limited') === I.entityKey('SEARLE PAKISTAN LTD'),
  I.entityKey('Searle Pakistan Limited') + ' vs ' + I.entityKey('SEARLE PAKISTAN LTD'));
check('city alias resolves', I.canonical('Khi') === 'karachi', I.canonical('Khi'));
check('currency alias resolves', I.canonical('Rs.') === 'pkr', I.canonical('Rs.'));
check('ampersand normalises', I.canonical('Food & Beverage') === I.canonical('Food and Beverage'));
check('parses ISO date', I.parseDate('2026-08-28') !== null);
check('rejects junk date', I.parseDate('not a date') === null);

/* ------------------------------------------------------------------ */
section('Format rules');

var R = I.FORMAT_RULES;
check('valid NTN passes', R.taxid.test('1234567-8'));
check('short NTN fails', !R.taxid.test('12345-6'));
check('alpha NTN fails', !R.taxid.test('ABCD123-1'));
check('valid email passes', R.email.test('procurement@searle.pk'));
check('double-at email fails', !R.email.test('ahmed@@packages.pk'));
check('missing-at email fails', !R.email.test('info.tapal.pk'));
check('no-tld email fails', !R.email.test('alnoor@traders'));
check('valid phone passes', R.phone.test('0300-8451122'));
check('short phone fails', !R.phone.test('0300123'));
check('overlong phone fails', !R.phone.test('+92-300-12345678901'));

/* ------------------------------------------------------------------ */
section('Full audit of the sample vendor master');

var csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'vendor-master.csv'), 'utf8');
var parsed = Cleanroom.parseCSV(csv);
var profile = Cleanroom.inferProfile(parsed.headers, parsed.rows);
var report = Cleanroom.audit(parsed.headers, parsed.rows, profile, { asOf: AS_OF });

check('read all 48 records', report.meta.rowCount === 48, String(report.meta.rowCount));
check('read all 14 columns', report.meta.fieldCount === 14, String(report.meta.fieldCount));

function sem(name) { return profile.fields.filter(function (f) { return f.name === name; })[0].semantic; }
check('vendor_code → identifier', sem('vendor_code') === 'identifier', sem('vendor_code'));
check('ntn → taxid', sem('ntn') === 'taxid', sem('ntn'));
check('contact_email → email', sem('contact_email') === 'email', sem('contact_email'));
check('phone → phone', sem('phone') === 'phone', sem('phone'));
check('last_updated → date', sem('last_updated') === 'date', sem('last_updated'));
check('credit_limit → amount', sem('credit_limit') === 'amount', sem('credit_limit'));
check('payment_terms_days → integer', sem('payment_terms_days') === 'integer', sem('payment_terms_days'));
check('city → city', sem('city') === 'city', sem('city'));

check('found duplicate groups', report.duplicates.length >= 6, String(report.duplicates.length));
var searle = report.duplicates.filter(function (d) { return /searle/i.test(d.label); })[0];
check('caught all three Searle records', searle && searle.rows.length === 3, searle ? String(searle.rows.length) : 'not found');
check('duplicate group is labelled by vendor, not tax ID',
  report.duplicates.every(function (d) { return !/^\d{7}-\d$/.test(d.label); }),
  report.duplicates.map(function (d) { return d.label; }).join(', '));
check('caught the Zubair name variant',
  report.duplicates.some(function (d) { return /zubair/i.test(d.label); }));

function codes(c) { return report.issues.filter(function (x) { return x.code === c; }).length; }
check('flagged missing mandatory values', codes('MISSING_MANDATORY') > 0, String(codes('MISSING_MANDATORY')));
check('flagged bad formats', codes('BAD_FORMAT') >= 6, String(codes('BAD_FORMAT')));
check('flagged spelling variants', codes('VARIANT_SPELLING') > 0, String(codes('VARIANT_SPELLING')));
check('flagged the negative credit limit', codes('NEGATIVE_VALUE') >= 2, String(codes('NEGATIVE_VALUE')));
check('flagged the 9999-day payment term', codes('OUT_OF_RANGE') >= 1, String(codes('OUT_OF_RANGE')));
check('flagged the future date', codes('FUTURE_DATE') === 1, String(codes('FUTURE_DATE')));
check('flagged stale records', codes('VERY_STALE') + codes('STALE') > 0, String(codes('VERY_STALE') + codes('STALE')));
check('flagged trailing whitespace', codes('WHITESPACE') >= 1, String(codes('WHITESPACE')));

check('every dimension scored 0–100', report.dimensions.every(function (d) { return d.score >= 0 && d.score <= 100; }));
check('overall score in range', report.overall.score >= 0 && report.overall.score <= 100, String(report.overall.score));
check('sample data does not pass clean', report.overall.verdict.key !== 'go', report.overall.verdict.key);
check('remediation plan is grouped, not per-row', report.plan.length > 0 && report.plan.length <= 8, String(report.plan.length));
check('every issue names a fix', report.issues.every(function (x) { return !!x.fix; }));
check('every issue points at a real line', report.issues.every(function (x) { return x.row >= 2 && x.row <= 49; }));

/* deterministic re-run */
var again = Cleanroom.audit(parsed.headers, parsed.rows, profile, { asOf: AS_OF });
check('same input → same score', again.overall.score === report.overall.score);
check('same input → same issue count', again.issues.length === report.issues.length);

/* clean file scores high */
var cleanCsv = 'vendor_code,vendor_name,ntn,contact_email,city,currency,credit_limit,status\n' +
  'V-1,Alpha Traders,1111111-1,a@alpha.pk,Karachi,PKR,100000,Active\n' +
  'V-2,Beta Supplies,2222222-2,b@beta.pk,Lahore,PKR,120000,Active\n' +
  'V-3,Gamma Works,3333333-3,c@gamma.pk,Karachi,PKR,90000,Active\n';
var clean = Cleanroom.parseCSV(cleanCsv);
var cleanReport = Cleanroom.audit(clean.headers, clean.rows, Cleanroom.inferProfile(clean.headers, clean.rows), { asOf: AS_OF });
check('clean file scores 100', cleanReport.overall.score === 100, String(cleanReport.overall.score));
check('clean file is cleared to migrate', cleanReport.overall.verdict.key === 'go', cleanReport.overall.verdict.key);

/* ------------------------------------------------------------------ */
section('Report summary (sample file)');
console.log('  Overall            ' + report.overall.score + '  grade ' + report.overall.grade + '  → ' + report.overall.verdict.label);
report.dimensions.forEach(function (d) {
  console.log('  ' + d.label.padEnd(18) + String(d.score).padStart(5) +
    '   ' + d.failed + '/' + d.checked + ' cells   ' + d.state);
});
console.log('  Issues             ' + report.counts.total +
  '  (critical ' + report.counts.critical + ', serious ' + report.counts.serious +
  ', warning ' + report.counts.warning + ', low ' + report.counts.low + ')');
console.log('  Records affected   ' + report.counts.affectedRows + ' of ' + report.meta.rowCount);
console.log('  Duplicate groups   ' + report.duplicates.length);
console.log('  Plan items         ' + report.plan.length);

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
