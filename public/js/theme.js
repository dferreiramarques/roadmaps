'use strict';
// Loaded in <head>, before the page paints, so the saved theme never flashes the wrong colours.
// Dark / light only swap colours (see app.css); nothing else about the page changes.
(function () {
  var KEY = 'roadmaps-theme';
  var theme = 'dark';
  try { theme = localStorage.getItem(KEY) || 'dark'; } catch (e) {}
  document.documentElement.setAttribute('data-theme', theme);

  var SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  var MOON = '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var svg = function (p) { return '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>'; };

  function apply(t, btn) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) {}
    if (btn) btn.innerHTML = svg(t === 'dark' ? SUN : MOON);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btn-theme');
    if (!btn) return;
    apply(document.documentElement.getAttribute('data-theme'), btn);
    btn.addEventListener('click', function () {
      apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark', btn);
    });
  });
})();
