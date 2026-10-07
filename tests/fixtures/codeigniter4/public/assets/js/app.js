document.addEventListener('DOMContentLoaded', function () {
  fetch('/api/orders', { method: 'GET' }).then(function (r) { return r.json(); });
});
