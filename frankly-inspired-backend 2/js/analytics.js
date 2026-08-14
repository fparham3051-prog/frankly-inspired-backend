/* ==========================================================================
   Frankly Inspired — Analytics loader (consent-gated)

   NOTE FOR BRIAN / FRANKLIN: Google Analytics is not live yet. This file
   is the on/off switch for when it is. Replace GA_MEASUREMENT_ID below with
   the real "G-XXXXXXXXXX" ID from Google Analytics, and analytics will
   start loading automatically — but ONLY for visitors who click "Accept"
   on the cookie banner (js/cookie-consent.js). Nobody who declines, or
   hasn't answered yet, gets a tracking script loaded. Leave the ID as-is
   and this file does nothing.
   ========================================================================== */

(function () {
  var GA_MEASUREMENT_ID = ''; // e.g. 'G-XXXXXXXXXX' — leave blank until GA is set up

  function loadGoogleAnalytics() {
    if (!GA_MEASUREMENT_ID || window.__fiAnalyticsLoaded) { return; }
    window.__fiAnalyticsLoaded = true;

    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    window.gtag = gtag;
    gtag('js', new Date());
    // anonymize_ip retained for visitor privacy even with consent granted.
    gtag('config', GA_MEASUREMENT_ID, { anonymize_ip: true });
  }

  function init() {
    if (!window.cookieConsent) { return; } // cookie-consent.js must load first

    if (window.cookieConsent.get() === 'accepted') {
      loadGoogleAnalytics();
    }

    document.addEventListener(window.cookieConsent.CHANGE_EVENT, function (e) {
      if (e.detail && e.detail.consent === 'accepted') {
        loadGoogleAnalytics();
      }
      // Note: GA's own script, once loaded, can't be unloaded mid-session if a
      // visitor accepts then later declines. It will simply not be (re)loaded
      // on their next visit if they've since declined.
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
