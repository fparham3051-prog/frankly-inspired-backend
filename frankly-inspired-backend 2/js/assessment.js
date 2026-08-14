/* ==========================================================================
   Frankly Inspired — Nonprofit Sustainability Self-Assessment
   Scoring logic. All calculation happens client-side; nothing is sent
   anywhere. Pillar scoring (3-15 per pillar, composite 15-75) matches the
   Engagement Tracker spreadsheet's Baseline columns 1:1, so assessment
   results and paid-engagement baselines stay comparable.
   ========================================================================== */

/* UPDATE THIS once frankly-inspired-backend is deployed to Render — same
   value as API_BASE in js/main.js. See that folder's README.md. */
var API_BASE = 'https://frankly-inspired-api.onrender.com';

document.addEventListener('DOMContentLoaded', function () {

  // Populated by renderResults() so the "email my results" form below can
  // send the same numbers the visitor is looking at.
  var lastResults = null;

  // Pillar definitions. "service" text is copied verbatim from the
  // Consulting section on index.html — do not paraphrase here, keep in
  // sync if that copy ever changes.
  // "anchor" points at the matching Service Pillar card's id on index.html,
  // so results link straight to that specific service instead of the
  // general Consulting section.
  var PILLARS = [
    {
      num: 1,
      label: 'Sustainability Strategy',
      service: 'Organizational assessment, strategic priorities, risk identification, sustainability roadmaps, and implementation planning.',
      anchor: 'pillar-sustainability'
    },
    {
      num: 2,
      label: 'Revenue Diversification',
      service: 'Fundraising strategy, partnership development, grant and public-funding strategy, sponsorship thinking, and revenue-pipeline design.',
      anchor: 'pillar-revenue'
    },
    {
      num: 3,
      label: 'Leadership & Organizational Development',
      service: 'Executive advising, leadership systems, role clarity, performance expectations, staff alignment, and change leadership.',
      anchor: 'pillar-leadership'
    },
    {
      num: 4,
      label: 'Operations & Infrastructure',
      service: 'Workflows, KPIs, dashboards, CRM/Salesforce practices, accountability systems, planning rhythms, and execution.',
      anchor: 'pillar-operations'
    },
    {
      num: 5,
      label: 'Partnership & Ecosystem Strategy',
      service: 'Education, workforce, government, corporate, philanthropic, and community partnership development.',
      anchor: 'pillar-partnership'
    }
  ];

  // recommendedTier maps to a specific pricing card id on index.html
  // (#pricing-implementation or #pricing-advisory) so the results page can
  // deep-link to the specific retainer that best matches this score band,
  // rather than sending every visitor to the same generic pricing section.
  var BANDS = [
    { max: 30, name: 'Foundational', desc: "This is a common starting point — and exactly where a focused strategy makes the most difference. The priority area below is where to start.", recommendedTier: 'implementation', tierName: 'Strategic Implementation Retainer', tierReason: "with this many areas to build at once, weekly hands-on support tends to move faster than periodic advisory alone." },
    { max: 55, name: 'Developing', desc: 'Some structure is in place, but meaningful gaps remain in one or more areas. Closing them is very achievable with the right focus.', recommendedTier: 'implementation', tierName: 'Strategic Implementation Retainer', tierReason: 'closing gaps across more than one pillar usually benefits from hands-on implementation, not just advisory guidance.' },
    { max: 80, name: 'Strengthening', desc: "A solid foundation is in place. The opportunity now is to sharpen and connect what's already working.", recommendedTier: 'advisory', tierName: 'Strategic Advisory Retainer', tierReason: 'with a solid foundation already in place, experienced strategic guidance is usually enough to sharpen it further.' },
    { max: 101, name: 'Resilient', desc: 'A strong sustainability posture. The opportunity now is to protect it and extend it as the organization grows.', recommendedTier: 'advisory', tierName: 'Strategic Advisory Retainer', tierReason: 'a strong foundation like this usually just needs a periodic strategic thought partner to protect and extend it.' }
  ];

  var form = document.getElementById('assessment-form');
  var status = document.getElementById('assessment-status');
  var resultsEl = document.getElementById('assessment-results');
  var barsEl = document.getElementById('results-bars');
  var priorityEl = document.getElementById('results-priority');
  var bandDescEl = document.getElementById('results-band-desc');
  var narrativeLoadingEl = document.getElementById('results-narrative-loading');

  /* ---------- Sticky progress bar ---------- */
  // Tracks which of the 5 pillar-group sections is currently in view and
  // updates the sticky label + fill accordingly, so a long, un-paginated
  // form still gives the visitor a sense of how far along they are.
  var progressEl = document.getElementById('assessment-progress');
  var progressLabel = document.getElementById('assessment-progress-label');
  var progressFill = document.getElementById('assessment-progress-fill');
  var pillarGroups = document.querySelectorAll('.pillar-group[data-pillar-index]');

  if (progressEl && progressLabel && progressFill && pillarGroups.length && 'IntersectionObserver' in window) {
    var pillarLabelByIndex = {};
    PILLARS.forEach(function (p) { pillarLabelByIndex[p.num] = p.label; });

    var progressObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var idx = Number(entry.target.getAttribute('data-pillar-index'));
          progressLabel.textContent = 'Section ' + idx + ' of ' + pillarGroups.length + ' — ' + (pillarLabelByIndex[idx] || '');
          progressFill.style.width = (idx / pillarGroups.length * 100) + '%';
        }
      });
    }, { rootMargin: '-15% 0px -70% 0px' });

    pillarGroups.forEach(function (group) { progressObserver.observe(group); });
  }

  function pillarScore(num, formEl) {
    var total = 0;
    for (var q = 1; q <= 3; q++) {
      var checked = formEl.querySelector('input[name="p' + num + 'q' + q + '"]:checked');
      total += checked ? Number(checked.value) : 0;
    }
    return total; // 3-15
  }

  function bandFor(pct) {
    for (var i = 0; i < BANDS.length; i++) {
      if (pct <= BANDS[i].max) { return BANDS[i]; }
    }
    return BANDS[BANDS.length - 1];
  }

  function renderResults(pillarScores) {
    var composite = pillarScores.reduce(function (sum, p) { return sum + p.score; }, 0); // 15-75
    var pct = Math.round(((composite - 15) / 60) * 100);
    var band = bandFor(pct);

    document.getElementById('results-score-num').textContent = pct + '%';
    document.getElementById('results-score-band').textContent = band.name;
    bandDescEl.textContent = band.desc;

    barsEl.innerHTML = '';
    pillarScores.forEach(function (p) {
      p.pct = Math.round(((p.score - 3) / 12) * 100);
      var row = document.createElement('div');
      row.className = 'results-bar-row';
      row.innerHTML =
        '<a class="results-bar-label" href="index.html#' + p.anchor + '">' + p.label + '</a>' +
        '<span class="results-bar-track">' +
          '<span class="results-bar-fill" style="width:' + p.pct + '%"></span>' +
          '<span class="results-bar-avg-marker" data-avg-marker="' + p.label + '" hidden></span>' +
        '</span>' +
        '<span class="results-bar-pct">' + p.pct + '%</span>' +
        '<span class="results-bar-avg" data-avg-text="' + p.label + '"></span>';
      barsEl.appendChild(row);
    });

    var lowest = pillarScores.reduce(function (min, p) { return p.pct < min.pct ? p : min; }, pillarScores[0]);

    priorityEl.innerHTML =
      '<h3 class="subhead">Priority Area: ' + lowest.label + '</h3>' +
      '<p>' + lowest.service + '</p>' +
      '<a class="link-more" href="index.html#' + lowest.anchor + '">See this service on the site</a>';

    var recommendationEl = document.getElementById('results-recommendation');
    if (recommendationEl) {
      recommendationEl.innerHTML =
        '<h3 class="subhead">Recommended Starting Point</h3>' +
        '<p>Based on your results, the <strong>' + band.tierName + '</strong> is likely the best fit — ' + band.tierReason + '</p>' +
        '<a class="btn btn-secondary" href="index.html#pricing-' + band.recommendedTier + '">See This Retainer</a>';
    }

    lastResults = {
      scorePct: pct,
      band: band.name,
      pillarScores: pillarScores.map(function (p) { return { label: p.label, pct: p.pct }; }),
    };

    form.hidden = true;
    if (progressEl) { progressEl.hidden = true; }
    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    fetchNarrative(lastResults);
    fetchBenchmarks(pct);
  }

  /* Benchmark comparison. Also an enhancement, not a dependency — if the
     database isn't reachable, has no data yet, or the sample is too small
     to be meaningful, the results the visitor already sees are unaffected;
     this just quietly adds a comparison line and tick marks when it can. */
  function fetchBenchmarks(compositePct) {
    var overallEl = document.getElementById('results-avg-overall');

    fetch(API_BASE + '/api/benchmarks')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var b = data && data.ok ? data.benchmarks : null;
        if (!b || !b.count) { return; } // nothing logged yet — say nothing rather than show a zero

        if (overallEl) {
          var lowSample = b.count < 5;
          overallEl.hidden = false;
          overallEl.innerHTML = 'Your score: <strong>' + compositePct + '%</strong> · Average so far: <strong>' + b.avgScore + '%</strong>' +
            (lowSample ? ' <span class="results-avg-caveat">(early data — ' + b.count + ' response' + (b.count === 1 ? '' : 's') + ' so far)</span>' : ' (' + b.count + ' responses)');
        }

        (b.pillarAverages || []).forEach(function (avg) {
          var marker = document.querySelector('[data-avg-marker="' + avg.label + '"]');
          var text = document.querySelector('[data-avg-text="' + avg.label + '"]');
          if (marker) {
            marker.hidden = false;
            marker.style.left = avg.avgPct + '%';
          }
          if (text) {
            text.innerHTML = 'Avg: <strong>' + avg.avgPct + '%</strong>';
          }
        });
      })
      .catch(function () {
        // Silent by design — same reasoning as fetchNarrative above.
      });
  }

  /* AI-generated personalized summary. This is an enhancement, not a
     dependency: the static band description is already visible from
     renderResults() above, so if this call is slow, fails, or the backend
     has no ANTHROPIC_API_KEY configured, the visitor still has a complete,
     correct set of results — this just quietly upgrades the description
     text if and when a narrative comes back. */
  function fetchNarrative(results) {
    if (narrativeLoadingEl) { narrativeLoadingEl.hidden = false; }

    fetch(API_BASE + '/api/assessment-narrative', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scorePct: results.scorePct,
        band: results.band,
        pillarScores: results.pillarScores,
      }),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && data.ok && data.narrative) {
          bandDescEl.textContent = data.narrative;
          lastResults.narrative = data.narrative;
        }
      })
      .catch(function () {
        // Silent by design — static description already shown, nothing to fix.
      })
      .finally(function () {
        if (narrativeLoadingEl) { narrativeLoadingEl.hidden = true; }
      });
  }

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (!form.checkValidity()) {
        form.reportValidity();
        if (status) { status.textContent = 'Please answer every question — one is still missing.'; }
        return;
      }

      var pillarScores = PILLARS.map(function (p) {
        return { num: p.num, label: p.label, service: p.service, anchor: p.anchor, score: pillarScore(p.num, form) };
      });

      status.textContent = '';
      renderResults(pillarScores);
    });
  }

  var retakeBtn = document.getElementById('results-retake');
  if (retakeBtn) {
    retakeBtn.addEventListener('click', function () {
      resultsEl.hidden = true;
      form.hidden = false;
      if (progressEl) {
        progressEl.hidden = false;
        progressLabel.textContent = 'Section 1 of ' + pillarGroups.length + ' — ' + (PILLARS[0] ? PILLARS[0].label : '');
        progressFill.style.width = (100 / pillarGroups.length) + '%';
      }
      form.reset();
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  var emailForm = document.getElementById('results-email-form');
  var emailStatus = document.getElementById('email-status');
  if (emailForm) {
    emailForm.addEventListener('submit', function (e) {
      e.preventDefault();

      if (!lastResults) {
        emailStatus.textContent = 'Please complete the assessment first.';
        return;
      }
      if (!emailForm.checkValidity()) {
        emailForm.reportValidity();
        return;
      }

      var formData = new FormData(emailForm);
      var payload = {
        email: formData.get('email'),
        hp_field: formData.get('hp_field'),
        scorePct: lastResults.scorePct,
        band: lastResults.band,
        pillarScores: lastResults.pillarScores,
        narrative: lastResults.narrative || null,
      };

      var submitBtn = emailForm.querySelector('button[type="submit"]');
      emailStatus.textContent = 'Sending...';
      if (submitBtn) { submitBtn.disabled = true; }

      fetch(API_BASE + '/api/assessment-lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (!result.ok || !result.data.ok) {
            throw new Error((result.data && result.data.error) || 'Something went wrong.');
          }
          emailStatus.textContent = 'Sent — check your inbox.';
          emailForm.reset();
        })
        .catch(function (err) {
          emailStatus.textContent = err.message;
        })
        .finally(function () {
          if (submitBtn) { submitBtn.disabled = false; }
        });
    });
  }

});
