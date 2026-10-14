// Classic (blocking) script in <head>: applies the saved theme before the first paint, so a dark-mode user never sees a
// light flash. js/theme.js takes over once the app has loaded.
(function () {
  var d = document.documentElement;
  var get = function (k, v) { try { return localStorage.getItem(k) || v; } catch (e) { return v; } };
  var theme = get('dalang-theme', 'system');
  d.dataset.theme = theme;
  d.dataset.palette = get('dalang-palette', 'iris');
  d.dataset.mode = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
})();
