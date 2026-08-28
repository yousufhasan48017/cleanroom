/**
 * Cleanroom — master data quality engine.
 *
 * Deliberately dependency-free and deterministic: given the same file and the
 * same profile, it returns the same score every time. The language model in
 * this project decides *what* to check (it profiles the file and proposes the
 * rules); this module decides *whether the data passes*, so results are
 * reproducible and can be defended in a migration review.
 *
 * Works in the browser (window.Cleanroom) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cleanroom = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  /* ------------------------------------------------------------------ *
   * Dimensions — the DAMA data quality dimensions, weighted for an ERP
   * cutover. Uniqueness carries the most weight because duplicate master
   * records are the defect that survives migration and corrupts
   * transactions afterwards.
   * ------------------------------------------------------------------ */
  var DIMENSIONS = [
    { key: 'completeness', label: 'Completeness', weight: 0.20, question: 'Are mandatory fields populated?' },
    { key: 'uniqueness',   label: 'Uniqueness',   weight: 0.25, question: 'Is each real-world entity stored once?' },
    { key: 'validity',     label: 'Validity',     weight: 0.20, question: 'Do values match the required format?' },
    { key: 'consistency',  label: 'Consistency',  weight: 0.15, question: 'Is the same thing written the same way?' },
    { key: 'accuracy',     label: 'Accuracy',     weight: 0.15, question: 'Are the values plausible?' },
    { key: 'timeliness',   label: 'Timeliness',   weight: 0.05, question: 'Have records been maintained recently?' }
  ];

  var SEVERITY_RANK = { critical: 0, serious: 1, warning: 2, low: 3 };

  /* ------------------------------------------------------------------ *
   * CSV parsing (RFC 4180: quoted fields, escaped quotes, CRLF)
   * ------------------------------------------------------------------ */
  function parseCSV(text) {
    var rows = [], field = '', row = [], inQuotes = false, i;
    text = String(text).replace(/^﻿/, '');

    for (i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    rows = rows.filter(function (r) { return r.some(function (v) { return String(v).trim() !== ''; }); });
    if (!rows.length) return { headers: [], rows: [] };

    var headers = rows[0].map(function (h) { return String(h).trim(); });
    var records = rows.slice(1).map(function (r) {
      var o = {};
      headers.forEach(function (h, idx) { o[h] = r[idx] === undefined ? '' : r[idx]; });
      return o;
    });
    return { headers: headers, rows: records };
  }

  /* ------------------------------------------------------------------ *
   * Semantic type detection — the heuristic fallback used when no model
   * profile is supplied. Header name first, value shape as confirmation.
   * ------------------------------------------------------------------ */
  var HEADER_HINTS = [
    { semantic: 'identifier', re: /(^|_)(code|id|no|number|key)$|^(vendor|customer|item|material|supplier)_?(code|id)$/i },
    { semantic: 'taxid',      re: /ntn|tax_?(id|no|number)|strn|gst|vat|cnic|cuit|ein/i },
    { semantic: 'email',      re: /e?mail/i },
    { semantic: 'phone',      re: /phone|mobile|cell|contact_?(no|number)|tel/i },
    { semantic: 'name',       re: /name|title|description|vendor$|supplier$|customer$/i },
    { semantic: 'city',       re: /city|town|location/i },
    { semantic: 'country',    re: /country|nation/i },
    { semantic: 'currency',   re: /currency|curr$|ccy/i },
    { semantic: 'date',       re: /date|updated|modified|created|_on$|_at$/i },
    { semantic: 'amount',     re: /amount|limit|price|rate|value|cost|balance|total|salary/i },
    { semantic: 'integer',    re: /days|term|qty|quantity|count|age|duration/i },
    { semantic: 'status',     re: /status|state|active|flag/i },
    { semantic: 'category',   re: /category|type|group|class|segment/i }
  ];

  var VALUE_TESTS = {
    email:    function (v) { return v.indexOf('@') > -1; },
    date:     function (v) { return /^\d{4}-\d{2}-\d{2}/.test(v) || /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(v); },
    amount:   function (v) { return /^-?[\d,]+(\.\d+)?$/.test(v); },
    phone:    function (v) { return /[\d][\d\s\-\+\(\)]{6,}/.test(v); }
  };

  // Fields that must carry a value for the record to be usable downstream.
  var MANDATORY_BY_DEFAULT = ['identifier', 'name', 'taxid', 'email', 'city', 'currency', 'amount', 'status'];
  // Fields that identify the entity — a repeat here means a duplicate record.
  var UNIQUE_BY_DEFAULT = ['identifier', 'taxid'];

  function inferProfile(headers, rows) {
    var sample = rows.slice(0, 200);

    var fields = headers.map(function (h) {
      var semantic = 'text', hint;
      for (var i = 0; i < HEADER_HINTS.length; i++) {
        if (HEADER_HINTS[i].re.test(h)) { semantic = HEADER_HINTS[i].semantic; break; }
      }

      var values = sample.map(function (r) { return String(r[h] || '').trim(); })
                         .filter(function (v) { return v !== ''; });

      // Confirm or correct the header guess against the actual values.
      if (semantic === 'text' && values.length) {
        for (var t in VALUE_TESTS) {
          var hits = values.filter(VALUE_TESTS[t]).length;
          if (hits / values.length > 0.8) { semantic = t; break; }
        }
      }
      if (semantic === 'amount' && values.length && values.every(function (v) { return /^-?\d+$/.test(v); })) {
        var max = Math.max.apply(null, values.map(Number));
        if (max <= 400) semantic = 'integer';
      }

      var distinct = uniqueValues(values).length;
      // A low-cardinality text column behaves like a controlled list.
      if ((semantic === 'text' || semantic === 'name') && values.length > 12 && distinct <= Math.max(12, values.length * 0.25)) {
        semantic = 'category';
      }

      hint = {
        name: h,
        semantic: semantic,
        mandatory: MANDATORY_BY_DEFAULT.indexOf(semantic) > -1,
        unique: UNIQUE_BY_DEFAULT.indexOf(semantic) > -1,
        controlled: ['city', 'country', 'currency', 'category', 'status'].indexOf(semantic) > -1,
        distinct: distinct,
        filled: values.length
      };
      return hint;
    });

    // Exactly one identity column carries the fuzzy duplicate check.
    var nameField = fields.filter(function (f) { return f.semantic === 'name'; })[0];
    if (nameField) nameField.identity = true;

    return { fields: fields, source: 'heuristic' };
  }

  /* ------------------------------------------------------------------ *
   * Normalisation helpers
   * ------------------------------------------------------------------ */
  var LEGAL_SUFFIXES = /\b(private|pvt|limited|ltd|llc|inc|incorporated|company|co|corp|corporation|enterprises|the|and)\b/g;

  var ALIASES = {
    khi: 'karachi', lhr: 'lahore', isb: 'islamabad', rwp: 'rawalpindi', fsd: 'faisalabad',
    pak: 'pakistan', pk: 'pakistan',
    rs: 'pkr', 'rs.': 'pkr', rupees: 'pkr',
    usd$: 'usd'
  };

  function squash(v) {
    return String(v || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function canonical(v) {
    var s = squash(v);
    if (ALIASES[s]) s = ALIASES[s];
    return s.replace(/\s+/g, ' ');
  }

  function entityKey(v) {
    return squash(v).replace(LEGAL_SUFFIXES, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokenSet(v) {
    return uniqueValues(entityKey(v).split(' ').filter(Boolean));
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var setB = {}, hit = 0;
    b.forEach(function (t) { setB[t] = true; });
    a.forEach(function (t) { if (setB[t]) hit++; });
    return hit / (a.length + b.length - hit);
  }

  function uniqueValues(arr) {
    var seen = {}, out = [];
    arr.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
    return out;
  }

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function parseDate(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    var d = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/.exec(String(v).trim());
    if (d) return new Date(Date.UTC(+d[3], +d[2] - 1, +d[1]));
    return null;
  }

  function monthsBetween(a, b) {
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  }

  /* ------------------------------------------------------------------ *
   * Format rules
   * ------------------------------------------------------------------ */
  var FORMAT_RULES = {
    email: {
      test: function (v) { return /^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(v.trim()); },
      expected: 'name@domain.tld',
      fix: 'Apply an email mask on the entry form and reject on save.'
    },
    taxid: {
      // Pakistani NTN: seven digits, hyphen, one check digit.
      test: function (v) { return /^\d{7}-\d$/.test(v.trim()); },
      expected: '#######-# (7 digits, hyphen, check digit)',
      fix: 'Add an NTN format mask and validate the check digit at entry.'
    },
    phone: {
      test: function (v) {
        var digits = v.replace(/\D/g, '');
        if (digits.indexOf('92') === 0) digits = digits.slice(2);
        return digits.length >= 9 && digits.length <= 11;
      },
      expected: '9–11 national digits',
      fix: 'Store phone numbers in E.164 and normalise on import.'
    },
    date: {
      test: function (v) { return parseDate(v) !== null; },
      expected: 'YYYY-MM-DD',
      fix: 'Store dates as ISO 8601; never as free text.'
    },
    amount: {
      test: function (v) { return /^-?[\d,]+(\.\d+)?$/.test(v.trim()); },
      expected: 'numeric',
      fix: 'Type the column as decimal in the target system.'
    },
    integer: {
      test: function (v) { return /^-?\d+$/.test(v.trim()); },
      expected: 'whole number',
      fix: 'Type the column as integer in the target system.'
    }
  };

  /* ------------------------------------------------------------------ *
   * The audit
   * ------------------------------------------------------------------ */
  function audit(headers, rows, profile, options) {
    options = options || {};
    var asOf = options.asOf ? new Date(options.asOf) : new Date();
    var staleMonths = options.staleMonths || 24;
    var veryStaleMonths = options.veryStaleMonths || 48;
    var maxTermDays = options.maxTermDays || 180;

    profile = profile || inferProfile(headers, rows);
    var fields = profile.fields;
    var issues = [];
    var applicable = {}, failedCells = {};
    DIMENSIONS.forEach(function (d) { applicable[d.key] = 0; failedCells[d.key] = {}; });

    function flag(dimension, rowIndex, field, severity, code, message, value, fix) {
      issues.push({
        row: rowIndex + 2,           // +2 → spreadsheet line number (header is line 1)
        index: rowIndex,
        field: field,
        dimension: dimension,
        severity: severity,
        code: code,
        message: message,
        value: value,
        fix: fix
      });
      // One cell can fail more than once; the worst severity on it is what counts.
      var cell = rowIndex + '|' + field;
      var held = failedCells[dimension][cell];
      if (!held || SEVERITY_RANK[severity] < SEVERITY_RANK[held]) failedCells[dimension][cell] = severity;
    }

    function fieldByName(n) {
      return fields.filter(function (f) { return f.name === n; })[0];
    }

    /* --- 1. Completeness ------------------------------------------- */
    var mandatory = fields.filter(function (f) { return f.mandatory; });
    applicable.completeness = mandatory.length * rows.length;
    rows.forEach(function (r, i) {
      mandatory.forEach(function (f) {
        if (String(r[f.name] || '').trim() === '') {
          var sev = f.unique ? 'critical' : (f.identity || f.semantic === 'email' ? 'serious' : 'warning');
          flag('completeness', i, f.name, sev, 'MISSING_MANDATORY',
            'Mandatory field is empty', '',
            'Make ' + f.name + ' a required field and backfill before cutover.');
        }
      });
    });

    /* --- 2. Validity ------------------------------------------------ */
    fields.forEach(function (f) {
      var rule = FORMAT_RULES[f.semantic];
      if (!rule) return;
      rows.forEach(function (r, i) {
        var v = String(r[f.name] || '').trim();
        if (v === '') return;
        applicable.validity++;
        if (!rule.test(v)) {
          flag('validity', i, f.name, 'serious', 'BAD_FORMAT',
            'Does not match expected format (' + rule.expected + ')', v, rule.fix);
        }
      });
    });

    /* --- 3. Uniqueness ---------------------------------------------- */
    applicable.uniqueness = rows.length;
    var clusters = [];
    var claimed = {};

    // (a) exact repeats on a declared unique key
    fields.filter(function (f) { return f.unique; }).forEach(function (f) {
      var buckets = {};
      rows.forEach(function (r, i) {
        var v = String(r[f.name] || '').trim();
        if (!v) return;
        (buckets[v] = buckets[v] || []).push(i);
      });
      Object.keys(buckets).forEach(function (v) {
        if (buckets[v].length > 1) {
          clusters.push({ members: buckets[v], reason: 'Identical ' + f.name, key: v, field: f.name, confidence: 'exact' });
        }
      });
    });

    // (b) fuzzy repeats on the identity (name) column
    var idField = fields.filter(function (f) { return f.identity; })[0];
    if (idField) {
      var keys = rows.map(function (r) { return entityKey(r[idField.name]); });
      var toks = rows.map(function (r) { return tokenSet(r[idField.name]); });
      for (var a = 0; a < rows.length; a++) {
        if (!keys[a]) continue;
        for (var b = a + 1; b < rows.length; b++) {
          if (!keys[b]) continue;
          var same = keys[a] === keys[b];
          var sim = same ? 1 : jaccard(toks[a], toks[b]);
          if (same || sim >= 0.6) {
            clusters.push({
              members: [a, b],
              reason: same ? 'Same entity name once legal suffixes are removed'
                           : 'Names ' + Math.round(sim * 100) + '% similar',
              key: keys[a],
              field: idField.name,
              confidence: same ? 'exact' : 'fuzzy'
            });
          }
        }
      }
    }

    // Merge overlapping clusters into one group per real-world entity.
    var merged = [];
    clusters.forEach(function (c) {
      var target = merged.filter(function (m) {
        return m.members.some(function (x) { return c.members.indexOf(x) > -1; });
      })[0];
      if (target) {
        c.members.forEach(function (x) { if (target.members.indexOf(x) < 0) target.members.push(x); });
        if (target.reasons.indexOf(c.reason) < 0) target.reasons.push(c.reason);
        if (c.confidence === 'exact') target.confidence = 'exact';
      } else {
        merged.push({ members: c.members.slice(), reasons: [c.reason], key: c.key, field: c.field, confidence: c.confidence });
      }
    });

    merged.forEach(function (m) {
      m.members.sort(function (x, y) { return x - y; });
      m.members.slice(1).forEach(function (i) {
        if (claimed[i]) return;
        claimed[i] = true;
        flag('uniqueness', i, m.field, 'critical', 'DUPLICATE_ENTITY',
          'Duplicate of line ' + (m.members[0] + 2) + ' — ' + m.reasons.join('; '),
          String(rows[i][m.field] || ''),
          'Merge into a single master record and repoint transactions before migrating.');
      });
    });

    /* --- 4. Consistency --------------------------------------------- */
    var controlled = fields.filter(function (f) { return f.controlled; });
    controlled.forEach(function (f) {
      var groups = {};
      rows.forEach(function (r, i) {
        var raw = String(r[f.name] || '');
        if (raw.trim() === '') return;
        applicable.consistency++;
        var key = canonical(raw);
        if (!key) return;
        (groups[key] = groups[key] || []).push({ i: i, raw: raw });
      });

      Object.keys(groups).forEach(function (key) {
        var counts = {};
        groups[key].forEach(function (e) { counts[e.raw] = (counts[e.raw] || 0) + 1; });
        var forms = Object.keys(counts);
        if (forms.length < 2) return;
        var modal = forms.sort(function (x, y) { return counts[y] - counts[x] || x.localeCompare(y); })[0];
        groups[key].forEach(function (e) {
          if (e.raw !== modal) {
            flag('consistency', e.i, f.name, 'warning', 'VARIANT_SPELLING',
              'Written as "' + e.raw + '" elsewhere in the file as "' + modal + '"', e.raw,
              'Replace ' + f.name + ' free text with a controlled value list.');
          }
        });
      });
    });

    // Leading/trailing whitespace anywhere is a load-time hazard.
    fields.forEach(function (f) {
      rows.forEach(function (r, i) {
        var raw = String(r[f.name] === undefined ? '' : r[f.name]);
        if (raw !== raw.trim() && raw.trim() !== '') {
          flag('consistency', i, f.name, 'low', 'WHITESPACE',
            'Value has leading or trailing whitespace', raw,
            'Trim all string fields during extraction.');
        }
      });
    });

    /* --- 5. Accuracy ------------------------------------------------ */
    fields.forEach(function (f) {
      if (f.semantic !== 'amount' && f.semantic !== 'integer' && f.semantic !== 'date') return;

      var nums = rows.map(function (r) { return Number(String(r[f.name] || '').replace(/,/g, '')); })
                     .filter(function (n) { return isFinite(n) && n > 0; });
      var mid = median(nums);

      rows.forEach(function (r, i) {
        var v = String(r[f.name] || '').trim();
        if (v === '') return;
        applicable.accuracy++;

        if (f.semantic === 'date') {
          var d = parseDate(v);
          if (d && d > asOf) {
            flag('accuracy', i, f.name, 'serious', 'FUTURE_DATE',
              'Date is in the future', v, 'Reject future dates on audit fields at entry.');
          }
          return;
        }

        var n = Number(v.replace(/,/g, ''));
        if (!isFinite(n)) return;

        if (n < 0) {
          flag('accuracy', i, f.name, 'serious', 'NEGATIVE_VALUE',
            'Negative value where only zero or positive is meaningful', v,
            'Add a non-negative constraint on ' + f.name + '.');
        } else if (f.semantic === 'integer' && n > maxTermDays) {
          flag('accuracy', i, f.name, 'serious', 'OUT_OF_RANGE',
            'Exceeds the plausible ceiling of ' + maxTermDays, v,
            'Constrain ' + f.name + ' to an agreed range.');
        } else if (f.semantic === 'amount' && mid > 0 && n > mid * 20) {
          flag('accuracy', i, f.name, 'warning', 'OUTLIER',
            'More than 20× the median of ' + formatNumber(mid), v,
            'Review against source documents; likely a decimal or unit error.');
        }
      });
    });

    /* --- 6. Timeliness ---------------------------------------------- */
    var auditDates = fields.filter(function (f) {
      return f.semantic === 'date' && /updated|modified|changed|reviewed/i.test(f.name);
    });
    auditDates.forEach(function (f) {
      rows.forEach(function (r, i) {
        var v = String(r[f.name] || '').trim();
        if (v === '') return;
        applicable.timeliness++;
        var d = parseDate(v);
        if (!d || d > asOf) return;
        var age = monthsBetween(d, asOf);
        if (age >= veryStaleMonths) {
          flag('timeliness', i, f.name, 'serious', 'VERY_STALE',
            'Not reviewed in ' + age + ' months', v,
            'Include in the pre-cutover vendor confirmation exercise.');
        } else if (age >= staleMonths) {
          flag('timeliness', i, f.name, 'warning', 'STALE',
            'Not reviewed in ' + age + ' months', v,
            'Schedule a periodic master data review.');
        }
      });
    });

    /* --- Scoring -----------------------------------------------------
     * A failing cell is not worth the same as any other failing cell: a
     * duplicate vendor is a different order of problem from a trailing
     * space. Each failed cell is weighted by its worst severity, and the
     * penalty is capped at the number of cells checked so a score can
     * never fall below zero.
     * ------------------------------------------------------------------ */
    var SEVERITY_PENALTY = { critical: 3, serious: 2, warning: 1, low: 0.5 };

    var dimensions = DIMENSIONS.map(function (d) {
      var cells = failedCells[d.key];
      var failed = Object.keys(cells).length;
      var penalty = Object.keys(cells).reduce(function (sum, c) {
        return sum + (SEVERITY_PENALTY[cells[c]] || 1);
      }, 0);
      var app = applicable[d.key];
      var score = app > 0 ? Math.max(0, 100 * (1 - Math.min(penalty, app) / app)) : 100;
      return {
        key: d.key, label: d.label, question: d.question, weight: d.weight,
        checked: app, failed: failed, penalty: round1(penalty),
        score: round1(score),
        state: score >= 95 ? 'good' : score >= 85 ? 'warning' : score >= 70 ? 'serious' : 'critical'
      };
    });

    var overallScore = round1(dimensions.reduce(function (sum, d) { return sum + d.score * d.weight; }, 0));
    var criticalCount = issues.filter(function (x) { return x.severity === 'critical'; }).length;

    var verdict = overallScore >= 90 && criticalCount === 0
      ? { key: 'go', label: 'Ready to migrate', note: 'No blocking defects found.' }
      : overallScore >= 75
        ? { key: 'conditional', label: 'Conditional go', note: 'Migrate only after the critical and serious items below are cleared.' }
        : { key: 'nogo', label: 'Not ready', note: 'Cleansing is required before this file goes anywhere near a cutover.' };

    /* --- Field-level profile ---------------------------------------- */
    var fieldStats = fields.map(function (f) {
      var filled = 0, distinctVals = [];
      rows.forEach(function (r) {
        var v = String(r[f.name] || '').trim();
        if (v !== '') { filled++; distinctVals.push(v); }
      });
      var fieldIssues = issues.filter(function (x) { return x.field === f.name; });
      return {
        name: f.name,
        semantic: f.semantic,
        mandatory: !!f.mandatory,
        unique: !!f.unique,
        filled: filled,
        completeness: rows.length ? round1(100 * filled / rows.length) : 100,
        distinct: uniqueValues(distinctVals).length,
        issues: fieldIssues.length,
        worst: fieldIssues.length
          ? fieldIssues.slice().sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; })[0].severity
          : null
      };
    });

    issues.sort(function (a, b) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.row - b.row || a.field.localeCompare(b.field);
    });

    var report = {
      version: VERSION,
      meta: {
        rowCount: rows.length,
        fieldCount: fields.length,
        asOf: asOf.toISOString().slice(0, 10),
        profileSource: profile.source || 'heuristic'
      },
      overall: {
        score: overallScore,
        grade: grade(overallScore),
        verdict: verdict
      },
      counts: {
        total: issues.length,
        critical: criticalCount,
        serious: issues.filter(function (x) { return x.severity === 'serious'; }).length,
        warning: issues.filter(function (x) { return x.severity === 'warning'; }).length,
        low: issues.filter(function (x) { return x.severity === 'low'; }).length,
        affectedRows: uniqueValues(issues.map(function (x) { return x.index; })).length
      },
      dimensions: dimensions,
      fields: fieldStats,
      duplicates: merged.map(function (m) {
        // Label the group by the entity's name, not by whichever key matched
        // first — a migration lead thinks in vendors, not tax IDs.
        var nameCol = idField ? idField.name : m.field;
        var label = m.members.map(function (i) { return String(rows[i][nameCol] || '').trim(); })
                             .filter(Boolean)[0] || m.key || '(blank)';
        return {
          label: label,
          key: m.key,
          field: m.field,
          confidence: m.confidence,
          reasons: m.reasons,
          rows: m.members.map(function (i) {
            return {
              line: i + 2,
              index: i,
              label: String(rows[i][nameCol] || '(blank)'),
              matchedOn: String(rows[i][m.field] || ''),
              record: rows[i]
            };
          })
        };
      }).sort(function (a, b) { return b.rows.length - a.rows.length; }),
      issues: issues,
      plan: buildPlan(issues, merged, rows.length)
    };

    return report;
  }

  /* ------------------------------------------------------------------ *
   * Remediation plan — issues grouped into root causes, because a
   * migration lead needs five decisions, not four hundred rows.
   * ------------------------------------------------------------------ */
  var THEME_LIBRARY = [
    {
      codes: ['DUPLICATE_ENTITY'],
      title: 'No uniqueness control at vendor creation',
      cause: 'The same organisation can be created more than once because nothing blocks a repeated name or tax ID.',
      impact: 'Spend is split across records, payment terms drift apart, and duplicate payments become possible after cutover.',
      fix: 'Run a merge exercise now: pick a surviving record per group, repoint open transactions, block the rest. Then enforce a unique index on tax ID and a fuzzy-match warning on name at creation.',
      effort: 'High',
      owner: 'Master data owner + procurement'
    },
    {
      codes: ['MISSING_MANDATORY'],
      title: 'Mandatory fields are not enforced on the entry form',
      cause: 'Records can be saved with identity and contact fields empty.',
      impact: 'Records fail validation at load, or load with gaps that block payment and tax reporting.',
      fix: 'Mark the fields required in the target system, then backfill the existing gaps from source documents before extraction.',
      effort: 'Medium',
      owner: 'Functional consultant'
    },
    {
      codes: ['BAD_FORMAT'],
      title: 'No format masks on identifiers and contact fields',
      cause: 'Tax IDs, emails and phone numbers are captured as free text with no pattern validation.',
      impact: 'Automated tax filing and vendor communication fail silently on the malformed rows.',
      fix: 'Apply input masks in the target system and cleanse the failing rows during extraction.',
      effort: 'Low',
      owner: 'Functional consultant'
    },
    {
      codes: ['VARIANT_SPELLING', 'WHITESPACE'],
      title: 'Controlled lists are stored as free text',
      cause: 'City, country, currency and category are typed by hand, so the same value is spelled several ways.',
      impact: 'Grouping and reporting fragment — spend by city or category cannot be trusted.',
      fix: 'Replace these columns with value lists in the target system and map the existing variants during migration.',
      effort: 'Medium',
      owner: 'Business analyst'
    },
    {
      codes: ['NEGATIVE_VALUE', 'OUT_OF_RANGE', 'OUTLIER', 'FUTURE_DATE'],
      title: 'No range or plausibility constraints on numeric fields',
      cause: 'Credit limits, payment terms and audit dates accept any value the user types.',
      impact: 'Implausible values flow into credit control and ageing reports, and are hard to spot after go-live.',
      fix: 'Agree a valid range per field with the business, apply it as a constraint, and review the flagged rows against source documents.',
      effort: 'Low',
      owner: 'Business analyst + finance'
    },
    {
      codes: ['STALE', 'VERY_STALE'],
      title: 'No periodic master data review',
      cause: 'Records are created once and never revisited, so dormant vendors look identical to active ones.',
      impact: 'Dead vendors are migrated, inflating the master and the licensing and reconciliation effort.',
      fix: 'Run a confirmation exercise on records untouched for two years; archive rather than migrate the ones that do not respond.',
      effort: 'Medium',
      owner: 'Procurement'
    }
  ];

  function buildPlan(issues, clusters, rowCount) {
    return THEME_LIBRARY.map(function (theme) {
      var matched = issues.filter(function (x) { return theme.codes.indexOf(x.code) > -1; });
      if (!matched.length) return null;

      var rowsAffected = uniqueValues(matched.map(function (x) { return x.index; })).length;
      var worst = matched.slice().sort(function (a, b) { return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]; })[0].severity;
      var fieldsHit = uniqueValues(matched.map(function (x) { return x.field; }));

      var evidence = matched.length + ' issue' + (matched.length === 1 ? '' : 's') +
        ' across ' + rowsAffected + ' record' + (rowsAffected === 1 ? '' : 's') +
        ' (' + Math.round(100 * rowsAffected / Math.max(1, rowCount)) + '% of the file)';
      if (theme.codes.indexOf('DUPLICATE_ENTITY') > -1 && clusters.length) {
        evidence = clusters.length + ' duplicate group' + (clusters.length === 1 ? '' : 's') +
          ' covering ' + clusters.reduce(function (n, c) { return n + c.members.length; }, 0) + ' records';
      }

      return {
        title: theme.title,
        cause: theme.cause,
        impact: theme.impact,
        fix: theme.fix,
        effort: theme.effort,
        owner: theme.owner,
        severity: worst,
        count: matched.length,
        rowsAffected: rowsAffected,
        fields: fieldsHit,
        evidence: evidence
      };
    }).filter(Boolean).sort(function (a, b) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.rowsAffected - a.rowsAffected;
    });
  }

  /* ------------------------------------------------------------------ */
  function grade(score) {
    return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  }
  function round1(n) { return Math.round(n * 10) / 10; }
  function formatNumber(n) { return Number(n).toLocaleString('en-US'); }

  return {
    version: VERSION,
    DIMENSIONS: DIMENSIONS,
    parseCSV: parseCSV,
    inferProfile: inferProfile,
    audit: audit,
    // exported for tests and for the model-profile path
    _internals: { entityKey: entityKey, canonical: canonical, jaccard: jaccard, parseDate: parseDate, FORMAT_RULES: FORMAT_RULES }
  };
}));
