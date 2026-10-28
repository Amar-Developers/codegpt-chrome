// Runs only on chat.codegpt.it.com/connect: hands the new key to the extension, once.
(function () {
  var el = document.getElementById('cg-ext-token');
  if (!el || el.dataset.client !== 'chrome' || !el.dataset.token) return;
  chrome.runtime.sendMessage({ type: 'cg-connect', token: el.dataset.token }, function (r) {
    if (r && r.ok) window.postMessage({ cgExtConnected: true }, location.origin);
  });
})();
