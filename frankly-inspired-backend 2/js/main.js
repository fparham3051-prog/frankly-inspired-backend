/* ==========================================================================
   Frankly Inspired and Associates, LLC — site interactivity
   1. Mobile nav toggle
   2. Close mobile nav when a link is clicked
   3. Active nav-link highlighting on scroll
   4. Contact form submit handling — posts to the backend below
   5. "More" nav dropdown (About / Experience & Impact / Speaking / Resume)
   6b. Recommended-tier highlight (arriving from assessment results)
   6c. Donor churn calculator
   6. Scroll reveal — fades/slides text and cards into view as you scroll
   ========================================================================== */

/* UPDATE THIS once frankly-inspired-backend is deployed to Render — see
   that folder's README.md. The service name you choose determines the
   URL; if you deploy it as "frankly-inspired-api" this is already correct. */
var API_BASE = 'https://frankly-inspired-api.onrender.com';

document.addEventListener('DOMContentLoaded', function () {

  /* ---------- 1. Mobile nav toggle ---------- */
  var navToggle = document.querySelector('.nav-toggle');
  var navMenu = document.getElementById('nav-menu');

  if (navToggle && navMenu) {
    navToggle.addEventListener('click', function () {
      var isOpen = navMenu.classList.toggle('is-open');
      navToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    /* ---------- 2. Close menu after tapping a link (mobile) ---------- */
    navMenu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        navMenu.classList.remove('is-open');
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* ---------- 3. Active section highlighting ---------- */
  var sections = document.querySelectorAll('main section[id]');
  var navLinks = document.querySelectorAll('.nav-menu a[href^="#"]');

  if (sections.length && navLinks.length && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var id = entry.target.getAttribute('id');
          navLinks.forEach(function (link) {
            link.classList.toggle('is-active', link.getAttribute('href') === '#' + id);
          });
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });

    sections.forEach(function (section) { observer.observe(section); });
  }

  /* ---------- 3b. Pricing card CTAs pre-check the matching service area ---------- */
  // data-plan accepts a comma-separated list, since a single retainer
  // often covers more than one service-area checkbox (e.g. the
  // Implementation Retainer's bullets span sustainability, revenue,
  // operations, and leadership — pre-checking just one box under-
  // represented what someone clicking it was actually signing up for).
  var planButtons = document.querySelectorAll('.plan-cta[data-plan]');
  planButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var plans = btn.getAttribute('data-plan').split(',');
      plans.forEach(function (plan) {
        var checkbox = document.querySelector('input[name="support_area"][value="' + plan.trim() + '"]');
        if (checkbox) { checkbox.checked = true; }
      });
    });
  });

  /* ---------- 4. Contact form ---------- */
  var form = document.getElementById('contact-form');
  var status = document.getElementById('form-status');
  var thankYou = document.getElementById('thank-you');
  var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

  if (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      var checked = form.querySelectorAll('input[name="support_area"]:checked');
      if (checked.length === 0) {
        if (status) {
          status.textContent = 'Please select at least one option under "How can I support your organization?"';
        }
        return;
      }

      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      var formData = new FormData(form);
      var payload = {
        name: formData.get('name'),
        organization: formData.get('organization'),
        title: formData.get('title'),
        email: formData.get('email'),
        phone: formData.get('phone'),
        org_website: formData.get('org_website'),
        support_area: formData.getAll('support_area'),
        challenge: formData.get('challenge'),
        timeline: formData.get('timeline'),
        referral: formData.get('referral'),
        hp_field: formData.get('hp_field'),
      };

      if (status) { status.textContent = 'Sending...'; }
      if (submitBtn) { submitBtn.disabled = true; }

      fetch(API_BASE + '/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (result) {
          if (!result.ok || !result.data.ok) {
            throw new Error((result.data && result.data.error) || 'Something went wrong.');
          }
          if (status) { status.textContent = ''; }
          form.hidden = true;
          if (thankYou) { thankYou.hidden = false; }
        })
        .catch(function (err) {
          if (status) {
            status.textContent = err.message + ' You can also email franklin@franklyinspired.associates directly.';
          }
        })
        .finally(function () {
          if (submitBtn) { submitBtn.disabled = false; }
        });
    });
  }

  /* ---------- 5. "More" nav dropdown ---------- */
  var dropdownToggle = document.querySelector('.nav-dropdown-toggle');
  var dropdownMenu = document.querySelector('.nav-dropdown-menu');
  var dropdownItem = document.querySelector('.nav-item-dropdown');

  if (dropdownToggle && dropdownMenu && dropdownItem) {
    function closeDropdown() {
      dropdownItem.classList.remove('is-open');
      dropdownToggle.setAttribute('aria-expanded', 'false');
    }
    function openDropdown() {
      dropdownItem.classList.add('is-open');
      dropdownToggle.setAttribute('aria-expanded', 'true');
    }

    dropdownToggle.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = dropdownItem.classList.contains('is-open');
      if (isOpen) { closeDropdown(); } else { openDropdown(); }
    });

    document.addEventListener('click', function (e) {
      if (!dropdownItem.contains(e.target)) { closeDropdown(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDropdown(); }
    });
  }

  /* ---------- 6b. Recommended-tier highlight ---------- */
  // The self-assessment results page links to index.html#pricing-advisory
  // or #pricing-implementation based on the visitor's score band. The
  // browser already scrolls there natively via the hash; this just makes
  // the specific recommended card unmistakable rather than merely scrolled-to.
  (function highlightRecommendedTier() {
    var hash = window.location.hash.replace('#', '');
    if (hash !== 'pricing-advisory' && hash !== 'pricing-implementation') { return; }
    var targetCard = document.getElementById(hash);
    if (!targetCard) { return; }
    targetCard.classList.add('is-recommended');
    var badge = targetCard.querySelector('.recommended-badge');
    if (badge) { badge.hidden = false; }
  })();

  /* ---------- 6c. Donor churn calculator ---------- */
  // Sector-average first-time donor retention rate (19.4%), from the AFP
  // Fundraising Effectiveness Project's 2025 data — same figure cited in
  // the homepage copy and the donor-retention article. Kept as a single
  // named constant so it only has to be updated in one place if the
  // sector figure is refreshed later.
  var FIRST_TIME_RETENTION_RATE = 0.194;

  var calcDonorsInput = document.getElementById('calc-donors');
  var calcGiftInput = document.getElementById('calc-gift');
  var calcResultEl = document.getElementById('calculator-result');
  var calcLostDonorsEl = document.getElementById('calc-lost-donors');
  var calcLostRevenueEl = document.getElementById('calc-lost-revenue');

  function updateCalculator() {
    var donors = Number(calcDonorsInput && calcDonorsInput.value);
    var gift = Number(calcGiftInput && calcGiftInput.value);

    if (!donors || donors <= 0 || !gift || gift <= 0) {
      if (calcResultEl) { calcResultEl.hidden = true; }
      return;
    }

    var lostDonors = Math.round(donors * (1 - FIRST_TIME_RETENTION_RATE));
    var lostRevenue = lostDonors * gift;

    if (calcLostDonorsEl) { calcLostDonorsEl.textContent = lostDonors.toLocaleString('en-US') + ' donors'; }
    if (calcLostRevenueEl) { calcLostRevenueEl.textContent = '$' + Math.round(lostRevenue).toLocaleString('en-US'); }
    if (calcResultEl) { calcResultEl.hidden = false; }
  }

  if (calcDonorsInput && calcGiftInput) {
    calcDonorsInput.addEventListener('input', updateCalculator);
    calcGiftInput.addEventListener('input', updateCalculator);
  }

  /* ---------- 6. Scroll reveal ---------- */
  /* Elements marked class="reveal" fade + slide up the first time they
     enter the viewport. CSS (see .reveal / .reveal.is-visible in
     styles.css) does the actual animating; this just toggles the class
     and unobserves once triggered so it never re-runs on repeat scrolls.
     Siblings get a small staggered delay so grids/lists cascade in
     instead of popping in all at once. Skips entirely if the browser
     doesn't support IntersectionObserver — content is simply visible. */
  var revealEls = document.querySelectorAll('.reveal');

  if (revealEls.length) {
    if ('IntersectionObserver' in window) {
      var delayCounts = new WeakMap();
      revealEls.forEach(function (el) {
        var parent = el.parentElement;
        var count = delayCounts.get(parent) || 0;
        if (count < 6) { el.style.transitionDelay = (count * 90) + 'ms'; }
        delayCounts.set(parent, count + 1);
      });

      var revealObserver = new IntersectionObserver(function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            obs.unobserve(entry.target);
          }
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

      revealEls.forEach(function (el) { revealObserver.observe(el); });

      // Safety net: if something goes wrong with the observer (a bug, an
      // unusual layout, a browser quirk) and an element never gets marked
      // visible on its own, force everything visible after a few seconds
      // rather than risk content staying hidden indefinitely.
      window.setTimeout(function () {
        document.querySelectorAll('.reveal:not(.is-visible)').forEach(function (el) {
          el.classList.add('is-visible');
        });
      }, 2500);
    } else {
      revealEls.forEach(function (el) { el.classList.add('is-visible'); });
    }
  }

});
