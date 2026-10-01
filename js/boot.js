/* boot.js — the first script of index.html: a readable on-screen error instead of a blank page (F1.showError, also
   used by main.js), and the name of any program file that fails to load. A file rather than an inline script: the
   page's Content Security Policy runs no inline script. */
(function () {
  'use strict';
  var F1 = (window.F1 = window.F1 || {});
  F1.showError = function (msg) {
    var box = document.getElementById('error'), pre = document.getElementById('error-text');
    if (!box || !pre) return;
    pre.textContent = (pre.textContent ? pre.textContent + '\n' : '') + msg;
    box.classList.remove('hidden');
  };
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') {
      F1.showError('無法載入程式檔：' + (e.target.getAttribute('src') || '?'));
    }
  }, true);
})();
