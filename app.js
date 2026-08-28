/**
 * Cleanroom — interface layer.
 *
 * Division of labour, and the reason this project exists:
 *   • The language model PROFILES the file — it reads headers and a sample of
 *     values and decides what each column means and which rules apply.
 *   • engine.js JUDGES the data — deterministic, reproducible, auditable.
 *
 * The model never produces a score. That is what makes the output defensible
 * in a migration review.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cleanroom.endpoint';
  var THEME_KEY = 'cleanroom.theme';
  var state = { report: null, profile: null, parsed: null, sourceName: '', aiSummary: '' };

  /* ---------------- small helpers ---------------- */
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function num(n) { return Number(n).toLocaleString('en-US'); }

  var SEVERITY_LABEL = { critical: 'Critical', serious: 'Serious', warning: 'Warning', low: 'Low' };

  function toast(msg, ms) {
    var existing = $('.toast');
    if (existing) existing.remove();
    var t = el('div', 'toast', msg);
    document.body.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.remove(); }, ms || 3500);
  }

  /* ---------------- theme ---------------- */
  function initTheme() {
    var saved = read(THEME_KEY);
    if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    $('#btn-theme').addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
        (!document.documentElement.getAttribute('data-theme') &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      var next = isDark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      store(THEME_KEY, next);
    });
  }

  /* ---------------- empty-state explainer ---------------- */
  function renderChecks() {
    var host = $('#checks');
    Cleanroom.DIMENSIONS.forEach(function (d) {
      var box = el('div');
      box.appendChild(el('h3', null, d.label));
      box.appendChild(el('p', null, d.question));
      host.appendChild(box);
    });
  }

  /* ---------------- AI profiling ---------------- */
  function getEndpoint() { return (read(STORAGE_KEY) || '').trim(); }

  function callEndpoint(payload, timeoutMs) {
    var endpoint = getEndpoint();
    if (!endpoint) return Promise.resolve(null);
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 20000) : null;

    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    }).then(function (r) {
      if (!r.ok) throw new Error('Endpoint returned ' + r.status);
      return r.json();
    }).then(function (data) {
      if (timer) clearTimeout(timer);
      // n8n commonly wraps the payload in an array or a `json` envelope.
      if (Array.isArray(data)) data = data[0];
      if (data && data.json) data = data.json;
      return data;
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      console.warn('[cleanroom] AI call failed:', err.message);
      return null;
    });
  }

  var VALID_SEMANTICS = ['identifier', 'name', 'taxid', 'email', 'phone', 'city', 'country',
    'currency', 'category', 'integer', 'amount', 'date', 'status', 'text'];

  /** Start from the heuristic profile, then let the model correct it. */
  function buildProfile(headers, rows) {
    var base = Cleanroom.inferProfile(headers, rows);
    if (!getEndpoint()) return Promise.resolve(base);

    return callEndpoint({
      mode: 'profile',
      headers: headers,
      sample: rows.slice(0, 15)
    }).then(function (data) {
      if (!data || !Array.isArray(data.fields)) return base;

      var applied = 0;
      data.fields.forEach(function (f) {
        if (!f || !f.name) return;
        var target = base.fields.filter(function (b) { return b.name === f.name; })[0];
        if (!target) return;
        if (f.semantic && VALID_SEMANTICS.indexOf(f.semantic) > -1) { target.semantic = f.semantic; applied++; }
        if (typeof f.mandatory === 'boolean') target.mandatory = f.mandatory;
        if (typeof f.unique === 'boolean') target.unique = f.unique;
        if (typeof f.controlled === 'boolean') target.controlled = f.controlled;
        if (typeof f.identity === 'boolean') target.identity = f.identity;
      });

      if (!base.fields.some(function (f) { return f.identity; })) {
        var n = base.fields.filter(function (f) { return f.semantic === 'name'; })[0];
        if (n) n.identity = true;
      }
      if (applied) base.source = 'model';
      return base;
    });
  }

  function fetchNarrative(report) {
    if (!getEndpoint()) return Promise.resolve('');
    return callEndpoint({
      mode: 'narrative',
      summary: {
        rows: report.meta.rowCount,
        score: report.overall.score,
        verdict: report.overall.verdict.key,
        dimensions: report.dimensions.map(function (d) { return { name: d.label, score: d.score }; }),
        themes: report.plan.map(function (p) { return { title: p.title, evidence: p.evidence, severity: p.severity }; })
      }
    }).then(function (data) {
      return data && typeof data.summary === 'string' ? data.summary : '';
    });
  }

  /* ---------------- audit run ---------------- */
  function runAudit(csvText, sourceName) {
    var parsed;
    try {
      parsed = Cleanroom.parseCSV(csvText);
    } catch (e) {
      toast('That file could not be parsed as CSV.');
      return;
    }
    if (!parsed.headers.length || !parsed.rows.length) {
      toast('No data rows found in that file.');
      return;
    }

    state.parsed = parsed;
    state.sourceName = sourceName;
    state.aiSummary = '';
    toast(getEndpoint() ? 'Profiling ' + num(parsed.rows.length) + ' records…' : 'Auditing ' + num(parsed.rows.length) + ' records…', 2000);

    buildProfile(parsed.headers, parsed.rows).then(function (profile) {
      state.profile = profile;
      state.report = Cleanroom.audit(parsed.headers, parsed.rows, profile);
      render(state.report);
      $('#empty').classList.add('hidden');
      $('#results').classList.remove('hidden');
      window.scrollTo({ top: 0, behavior: 'smooth' });

      return fetchNarrative(state.report);
    }).then(function (summary) {
      if (summary) {
        state.aiSummary = summary;
        renderPlan(state.report);
      }
    }).catch(function (err) {
      console.error(err);
      toast('Something went wrong during the audit.');
    });
  }

  /* ---------------- rendering ---------------- */
  function render(report) {
    renderVerdict(report);
    renderMeters(report);
    renderTiles(report);
    renderPlan(report);
    renderDuplicates(report);
    renderFields(report);
    renderIssueFilters(report);
    renderIssues();
  }

  function renderVerdict(r) {
    var verdictState = r.overall.verdict.key === 'go' ? 'good'
      : r.overall.verdict.key === 'conditional' ? 'warning' : 'critical';
    var profiledBy = r.meta.profileSource === 'model' ? 'Profiled by AI' : 'Profiled by rules';

    $('#verdict').innerHTML =
      '<div class="score-block">' +
        '<span class="score">' + esc(r.overall.score) + '</span>' +
        '<span class="score-meta">' +
          '<span class="score-grade">' + esc(r.overall.grade) + '</span>' +
          '<span class="score-of">of 100</span>' +
        '</span>' +
      '</div>' +
      '<div class="verdict-body">' +
        '<div class="verdict-head">' +
          '<span class="chip chip-' + verdictState + '">' + esc(r.overall.verdict.label) + '</span>' +
          '<span class="chip chip-neutral">' + esc(profiledBy) + '</span>' +
          (state.sourceName ? '<span class="chip chip-neutral">' + esc(state.sourceName) + '</span>' : '') +
        '</div>' +
        '<p class="verdict-note">' + esc(r.overall.verdict.note) + '</p>' +
        '<div class="verdict-meta">' +
          '<span>' + num(r.meta.rowCount) + ' records</span>' +
          '<span>' + num(r.meta.fieldCount) + ' fields</span>' +
          '<span>' + num(r.counts.affectedRows) + ' records with defects</span>' +
          '<span>audited ' + esc(r.meta.asOf) + '</span>' +
        '</div>' +
      '</div>';
  }

  function renderMeters(r) {
    var host = $('#meters');
    host.innerHTML = '';
    r.dimensions.forEach(function (d) {
      var row = el('div', 'meter');
      row.innerHTML =
        '<div class="meter-name">' + esc(d.label) +
          '<span class="meter-q">' + esc(d.question) + '</span></div>' +
        '<div class="meter-track" role="img" aria-label="' + esc(d.label + ' scores ' + d.score + ' out of 100') + '">' +
          '<div class="meter-fill fill-' + d.state + '" style="width:' + Math.max(1, d.score) + '%"></div>' +
        '</div>' +
        '<div class="meter-score">' + esc(d.score) + '</div>' +
        '<div class="meter-detail">' + num(d.failed) + '/' + num(d.checked) + ' cells<br>' +
          '<span class="chip chip-' + d.state + '" style="margin-top:.15rem">' +
            (d.state === 'good' ? 'Pass' : d.state === 'warning' ? 'Watch' : d.state === 'serious' ? 'Weak' : 'Fail') +
          '</span></div>';
      host.appendChild(row);
    });
  }

  function renderTiles(r) {
    var tiles = [
      { label: 'Critical', value: r.counts.critical, color: 'var(--critical)' },
      { label: 'Serious', value: r.counts.serious, color: 'var(--serious)' },
      { label: 'Warning', value: r.counts.warning, color: 'var(--warning)' },
      { label: 'Low', value: r.counts.low, color: 'var(--axis)' },
      { label: 'Records affected', value: r.counts.affectedRows + ' of ' + r.meta.rowCount, color: null }
    ];
    $('#tiles').innerHTML = tiles.map(function (t) {
      return '<div class="tile">' +
        '<div class="tile-value">' +
          (t.color ? '<span class="tile-dot" style="background:' + t.color + '"></span>' : '') +
          esc(t.value) +
        '</div>' +
        '<div class="tile-label">' + esc(t.label) + '</div>' +
      '</div>';
    }).join('');
  }

  function renderPlan(r) {
    var host = $('#plan');
    host.innerHTML = '';

    if (state.aiSummary) {
      var intro = el('div', 'panel plan-item');
      intro.innerHTML =
        '<div class="plan-top"><h3 class="plan-title">Summary</h3>' +
        '<span class="chip chip-neutral">Written by AI</span></div>' +
        '<p style="font-size:.9375rem;color:var(--ink-2);max-width:70ch">' + esc(state.aiSummary) + '</p>';
      host.appendChild(intro);
    }
    $('#plan-source').textContent = r.meta.profileSource === 'model'
      ? 'Root causes behind the findings. Column meanings were proposed by the model; every count below comes from the deterministic engine.'
      : 'Root causes behind the findings — five decisions, not four hundred rows.';

    r.plan.forEach(function (p, i) {
      var item = el('div', 'panel plan-item');
      item.innerHTML =
        '<div class="plan-top">' +
          '<h3 class="plan-title">' + (i + 1) + '. ' + esc(p.title) + '</h3>' +
          '<span class="chip chip-' + p.severity + '">' + esc(SEVERITY_LABEL[p.severity]) + '</span>' +
          '<span class="plan-evidence">' + esc(p.evidence) + '</span>' +
        '</div>' +
        '<dl class="plan-grid">' +
          '<div><dt>Why it happens</dt><dd>' + esc(p.cause) + '</dd></div>' +
          '<div><dt>What it costs</dt><dd>' + esc(p.impact) + '</dd></div>' +
          '<div><dt>What to do</dt><dd>' + esc(p.fix) + '</dd></div>' +
        '</dl>' +
        '<div class="plan-foot">' +
          '<span>Effort <b>' + esc(p.effort) + '</b></span>' +
          '<span>Owner <b>' + esc(p.owner) + '</b></span>' +
          '<span>Fields <b>' + esc(p.fields.join(', ')) + '</b></span>' +
        '</div>';
      host.appendChild(item);
    });
  }

  function renderDuplicates(r) {
    var host = $('#dups');
    host.innerHTML = '';
    if (!r.duplicates.length) {
      $('#dups-section').classList.add('hidden');
      return;
    }
    $('#dups-section').classList.remove('hidden');

    r.duplicates.forEach(function (d) {
      var card = el('div', 'panel dup');
      var rows = d.rows.map(function (row, idx) {
        return '<div class="dup-row' + (idx === 0 ? ' is-keep' : '') + '">' +
          '<span class="dup-line">line ' + row.line + '</span>' +
          '<span>' + esc(row.label) + '</span>' +
          '<span class="dup-tag">' + (idx === 0 ? 'suggested survivor' : 'merge & retire') + '</span>' +
        '</div>';
      }).join('');

      card.innerHTML =
        '<div class="dup-head">' +
          '<span class="dup-name">' + esc(d.label) + '</span>' +
          '<span class="chip chip-' + (d.confidence === 'exact' ? 'critical' : 'serious') + '">' +
            (d.confidence === 'exact' ? 'Exact match' : 'Likely match') + '</span>' +
          '<span class="dup-why">' + esc(d.reasons.join(' · ')) + '</span>' +
        '</div>' +
        '<div class="dup-rows">' + rows + '</div>';
      host.appendChild(card);
    });
  }

  function renderFields(r) {
    var body = $('#fields-table tbody');
    body.innerHTML = r.fields.map(function (f) {
      var rules = [];
      if (f.mandatory) rules.push('mandatory');
      if (f.unique) rules.push('unique');
      return '<tr>' +
        '<td class="mono">' + esc(f.name) + '</td>' +
        '<td>' + esc(f.semantic) + '</td>' +
        '<td class="fix-text">' + esc(rules.join(', ') || '—') + '</td>' +
        '<td><span class="bar">' +
          '<span class="bar-track"><span class="bar-fill" style="width:' + f.completeness + '%"></span></span>' +
          '<span class="bar-num">' + f.completeness + '%</span>' +
        '</span></td>' +
        '<td class="num">' + num(f.distinct) + '</td>' +
        '<td class="num">' + num(f.issues) + '</td>' +
        '<td>' + (f.worst
          ? '<span class="chip chip-' + f.worst + '">' + esc(SEVERITY_LABEL[f.worst]) + '</span>'
          : '<span class="chip chip-good">Clean</span>') + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderIssueFilters(r) {
    var dims = $('#f-dimension'), fields = $('#f-field');
    dims.innerHTML = '<option value="">All dimensions</option>' +
      r.dimensions.map(function (d) { return '<option value="' + esc(d.key) + '">' + esc(d.label) + '</option>'; }).join('');
    var names = r.fields.filter(function (f) { return f.issues > 0; }).map(function (f) { return f.name; });
    fields.innerHTML = '<option value="">All fields</option>' +
      names.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('');
  }

  function filteredIssues() {
    if (!state.report) return [];
    var sev = $('#f-severity').value;
    var dim = $('#f-dimension').value;
    var fld = $('#f-field').value;
    var q = $('#f-search').value.trim().toLowerCase();

    return state.report.issues.filter(function (x) {
      if (sev && x.severity !== sev) return false;
      if (dim && x.dimension !== dim) return false;
      if (fld && x.field !== fld) return false;
      if (q && (String(x.value).toLowerCase().indexOf(q) < 0 &&
                x.message.toLowerCase().indexOf(q) < 0 &&
                x.field.toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
  }

  var ROW_CAP = 300;
  function renderIssues() {
    var list = filteredIssues();
    var shown = list.slice(0, ROW_CAP);
    $('#issue-count').textContent = list.length === shown.length
      ? num(list.length) + ' issues'
      : num(shown.length) + ' of ' + num(list.length) + ' issues shown';

    $('#issues-table tbody').innerHTML = shown.map(function (x) {
      return '<tr>' +
        '<td class="num">' + x.row + '</td>' +
        '<td><span class="chip chip-' + x.severity + '">' + esc(SEVERITY_LABEL[x.severity]) + '</span></td>' +
        '<td class="mono">' + esc(x.field) + '</td>' +
        '<td>' + esc(x.message) + '</td>' +
        '<td class="cell-value">' + (x.value === '' ? '<span class="fix-text">(empty)</span>' : esc(x.value)) + '</td>' +
        '<td class="fix-text">' + esc(x.fix) + '</td>' +
      '</tr>';
    }).join('') || '<tr><td colspan="6" class="fix-text" style="padding:1rem">No issues match these filters.</td></tr>';
  }

  /* ---------------- exports ---------------- */
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportIssues() {
    if (!state.report) return;
    var rows = filteredIssues();
    var header = ['line', 'severity', 'dimension', 'field', 'code', 'finding', 'value', 'recommended_fix'];
    var body = rows.map(function (x) {
      return [x.row, x.severity, x.dimension, x.field, x.code, x.message, x.value, x.fix].map(csvCell).join(',');
    });
    download('cleanroom-issues.csv', header.join(',') + '\n' + body.join('\n'), 'text/csv');
    toast('Exported ' + num(rows.length) + ' issues.');
  }

  function exportPlan() {
    var r = state.report;
    if (!r) return;
    var out = [];
    out.push('# Data quality audit — ' + (state.sourceName || 'master data file'));
    out.push('');
    out.push('- **Score:** ' + r.overall.score + '/100 (grade ' + r.overall.grade + ')');
    out.push('- **Verdict:** ' + r.overall.verdict.label + ' — ' + r.overall.verdict.note);
    out.push('- **Scope:** ' + r.meta.rowCount + ' records, ' + r.meta.fieldCount + ' fields, audited ' + r.meta.asOf);
    out.push('- **Defects:** ' + r.counts.total + ' across ' + r.counts.affectedRows + ' records ' +
      '(' + r.counts.critical + ' critical, ' + r.counts.serious + ' serious, ' +
      r.counts.warning + ' warning, ' + r.counts.low + ' low)');
    out.push('');
    if (state.aiSummary) { out.push('## Summary'); out.push(''); out.push(state.aiSummary); out.push(''); }

    out.push('## Dimension scores');
    out.push('');
    out.push('| Dimension | Score | Failed cells | Checked |');
    out.push('|---|---:|---:|---:|');
    r.dimensions.forEach(function (d) {
      out.push('| ' + d.label + ' | ' + d.score + ' | ' + d.failed + ' | ' + d.checked + ' |');
    });
    out.push('');

    out.push('## Remediation plan');
    out.push('');
    r.plan.forEach(function (p, i) {
      out.push('### ' + (i + 1) + '. ' + p.title + '  _(' + SEVERITY_LABEL[p.severity] + ')_');
      out.push('');
      out.push('- **Evidence:** ' + p.evidence);
      out.push('- **Why it happens:** ' + p.cause);
      out.push('- **What it costs:** ' + p.impact);
      out.push('- **What to do:** ' + p.fix);
      out.push('- **Effort:** ' + p.effort + '  ·  **Owner:** ' + p.owner);
      out.push('- **Fields:** ' + p.fields.join(', '));
      out.push('');
    });

    if (r.duplicates.length) {
      out.push('## Duplicate groups');
      out.push('');
      r.duplicates.forEach(function (d) {
        out.push('- **' + d.label + '** (' + d.confidence + ') — lines ' +
          d.rows.map(function (x) { return x.line; }).join(', ') + ' — ' + d.reasons.join('; '));
      });
      out.push('');
    }

    out.push('---');
    out.push('Generated by Cleanroom v' + r.version + '. Column meanings were proposed by ' +
      (r.meta.profileSource === 'model' ? 'a language model' : 'the built-in heuristic profiler') +
      '; all counts and scores are produced deterministically by the rules engine.');

    download('cleanroom-plan.md', out.join('\n'), 'text/markdown');
    toast('Exported the remediation plan.');
  }

  /* ---------------- settings drawer ---------------- */
  var REQ_SHAPE = JSON.stringify({
    mode: 'profile',
    headers: ['vendor_code', 'vendor_name', 'ntn', '…'],
    sample: [{ vendor_code: 'V-1001', vendor_name: 'Searle Pakistan Limited', ntn: '1234567-8' }]
  }, null, 2);

  var RES_SHAPE = JSON.stringify({
    fields: [
      { name: 'vendor_code', semantic: 'identifier', mandatory: true, unique: true },
      { name: 'vendor_name', semantic: 'name', mandatory: true, identity: true },
      { name: 'ntn', semantic: 'taxid', mandatory: true, unique: true }
    ]
  }, null, 2);

  function initDrawer() {
    var drawer = $('#drawer');
    var input = $('#endpoint');
    $('#req-shape').textContent = REQ_SHAPE;
    $('#res-shape').textContent = RES_SHAPE;
    input.value = getEndpoint();

    function open() { drawer.setAttribute('open', ''); input.focus(); }
    function close() { drawer.removeAttribute('open'); }

    $('#btn-settings').addEventListener('click', open);
    $('#btn-close-drawer').addEventListener('click', close);
    drawer.addEventListener('click', function (e) { if (e.target === drawer) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

    $('#btn-save-endpoint').addEventListener('click', function () {
      var v = input.value.trim();
      if (v && !/^https?:\/\//i.test(v)) { toast('The webhook URL must start with http:// or https://'); return; }
      store(STORAGE_KEY, v || null);
      toast(v ? 'Endpoint saved. Re-run an audit to use AI profiling.' : 'Endpoint cleared.');
      close();
    });

    $('#btn-clear-endpoint').addEventListener('click', function () {
      input.value = '';
      store(STORAGE_KEY, null);
      toast('Endpoint cleared — using the built-in profiler.');
    });
  }

  /* ---------------- file input ---------------- */
  function readFile(file) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('That file is larger than 8 MB — try a sample of it.'); return; }
    var reader = new FileReader();
    reader.onload = function () { runAudit(String(reader.result), file.name); };
    reader.onerror = function () { toast('The file could not be read.'); };
    reader.readAsText(file);
  }

  function initFiles() {
    var input = $('#file-input');
    input.addEventListener('change', function () { readFile(input.files[0]); input.value = ''; });

    ['#btn-upload', '#btn-upload-2'].forEach(function (sel) {
      $(sel).addEventListener('click', function () { input.click(); });
    });
    ['#btn-sample', '#btn-sample-2'].forEach(function (sel) {
      $(sel).addEventListener('click', function () {
        if (typeof window.CLEANROOM_SAMPLE !== 'string') { toast('Sample data is unavailable.'); return; }
        runAudit(window.CLEANROOM_SAMPLE, 'vendor-master.csv (sample)');
      });
    });

    var zone = $('#empty');
    ['dragenter', 'dragover'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('is-over'); });
    });
    zone.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });
  }

  /* ---------------- boot ---------------- */
  function init() {
    initTheme();
    renderChecks();
    initDrawer();
    initFiles();

    ['#f-severity', '#f-dimension', '#f-field'].forEach(function (sel) {
      $(sel).addEventListener('change', renderIssues);
    });
    $('#f-search').addEventListener('input', renderIssues);
    $('#btn-export-issues').addEventListener('click', exportIssues);
    $('#btn-export-plan').addEventListener('click', exportPlan);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
