/* ==========================================================================
   Frankly Inspired — Cookie Consent Banner
   Loaded on every page (index.html, assessment.html, privacy.html,
   terms.html). Injects a bottom banner on first visit, remembers the
   visitor's choice in localStorage, and exposes a small API so other
   scripts (see js/analytics.js) can check consent before setting any
   non-essential cookie or loading a tracking script.

   Nothing in this file sets a cookie itself. The site currently has no
   analytics installed; this is the consent layer analytics.js checks
   before it loads anything, and it's also what the "Manage Cookie
   Preferences" footer link reopens.
   ========================================================================== */

(function () {
  var STORAGE_KEY = 'fi_cookie_consent'; // 'accepted' | 'declined'
  var CHANGE_EVENT = 'fi-cookie-consent-changed';

  function getConsent() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // localStorage unavailable (privacy mode, etc.) — treat as no choice made yet.
      return null;
    }
  }

  function setConsent(value) {
    try {
      window.localStorage.setItem(STORAGE_KEY, value);
    } catch (e) {
      // Ignore — banner will just reappear next visit if storage isn't available.
    }
    document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { consent: value } }));
  }

  function buildBanner() {
    var banner = document.createElement('div');
    banner.id = 'cookie-consent-banner';
    banner.className = 'cookie-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie consent');
    banner.innerHTML =
      '<div class="cookie-banner-inner">' +
      '<p class="cookie-banner-text">This site uses essential cookies to function, and may use optional analytics cookies to understand website traffic — only if you accept them. See our <a href="privacy.html">Privacy Policy</a> for details.</p>' +
      '<div class="cookie-banner-actions">' +
      '<button type="button" class="btn btn-secondary btn-small" id="cookie-decline">Decline</button>' +
      '<button type="button" class="btn btn-primary btn-small" id="cookie-accept">Accept</button>' +
      '</div>' +
      '</div>';
    return banner;
  }

  function showBanner() {
    if (document.getElementById('cookie-consent-banner')) { return; }
    var banner = buildBanner();
    document.body.appendChild(banner);

    document.getElementById('cookie-accept').addEventListener('click', function () {
      setConsent('accepted');
      hideBanner();
    });
    document.getElementById('cookie-decline').addEventListener('click', function () {
      setConsent('declined');
      hideBanner();
    });

    // Let the browser paint the element before animating it in.
    window.requestAnimationFrame(function () {
      banner.classList.add('cookie-banner-visible');
    });
  }

  function hideBanner() {
    var banner = document.getElementById('cookie-consent-banner');
    if (!banner) { return; }
    banner.classList.remove('cookie-banner-visible');
    window.setTimeout(function () {
      if (banner.parentNode) { banner.parentNode.removeChild(banner); }
    }, 300);
  }

  // Public API — used by js/analytics.js and the "Manage Cookie Preferences"
  // footer link on every page.
  window.cookieConsent = {
    get: getConsent,
    set: setConsent,
    reopen: showBanner,
    CHANGE_EVENT: CHANGE_EVENT
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (!getConsent()) {
      showBanner();
    }

    var manageLinks = document.querySelectorAll('[data-manage-cookies]');
    manageLinks.forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        showBanner();
      });
    });
  });
})();
