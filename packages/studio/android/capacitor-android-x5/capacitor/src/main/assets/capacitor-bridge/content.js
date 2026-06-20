// Capacitor Bridge Adapter — GeckoView WebExtension Content Script
// Runs at document_start on http://127.0.0.1:*/*
// Injects bridge proxies into PAGE context; communicates with native via Port or sendNativeMessage.

(function () {
  var port = null;
  var evalListenerRegistered = false;
  var pollTimer = null;

  function sendToNative(payload) {
    if (port) {
      try {
        port.postMessage(payload);
      } catch (e) {
        console.error("CapacitorBridge: port send failed", e);
      }
    } else {
      try {
        var body = typeof payload === "string" ? payload : JSON.stringify(payload);
        fetch("/__cap_plugin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
        }).catch(function () {});
      } catch (e) {}
    }
  }

  // Inject bridge objects into PAGE context via <script> tag.
  var s = document.createElement("script");
  s.textContent = [
    "window.androidBridge = {",
    "  postMessage: function(jsonStr) {",
    "    window.dispatchEvent(new CustomEvent('__cap_bridge', {detail: jsonStr}));",
    "  }",
    "};",
    "window.CapacitorSystemBarsAndroidInterface = {",
    "  onDOMReady: function() {",
    "    window.dispatchEvent(new CustomEvent('__cap_sysbars_domready'));",
    "  }",
    "};",
    "window.CapacitorCookiesAndroidInterface = {",
    "  isEnabled: function() { return false; },",
    "  setCookie: function(domain, action) {",
    "    window.dispatchEvent(new CustomEvent('__cap_cookies_set', {detail: JSON.stringify({d:domain,a:action})}));",
    "  }",
    "};",
    "window.CapacitorHttpAndroidInterface = {",
    "  isEnabled: function() { return false; }",
    "};"
  ].join("\n");
  (document.head || document.documentElement).appendChild(s);
  s.parentNode.removeChild(s);

  // Immediately fetch endings data and inject into page context
  fetch("/__cap_endings_data")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.length > 0) {
        var s = document.createElement("script");
        s.textContent = "window.__capEndingsData=" + JSON.stringify(data);
        (document.head || document.documentElement).appendChild(s);
        s.parentNode.removeChild(s);
      }
    })
    .catch(function () {});

  // Ping batch proxy — page dispatches CustomEvent, content script fetches.
  window.addEventListener("__cap_ping_request", function (e) {
    try {
      var detail = JSON.parse(e.detail);
      var id = detail.id;
      var urls = detail.urls;
      fetch("/__cap_ping_batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(urls),
      })
        .then(function (r) { return r.json(); })
        .then(function (startResult) {
          var batchId = startResult.batchId;
          function pollStatus() {
            fetch("/__cap_ping_batch/" + batchId)
              .then(function (r) { return r.json(); })
              .then(function (status) {
                if (status.done) {
                  window.dispatchEvent(
                    new CustomEvent("__cap_ping_response", {
                      detail: JSON.stringify({ id: id, results: status.results }),
                    })
                  );
                } else {
                  setTimeout(pollStatus, 800);
                }
              })
              .catch(function (err) {
                window.dispatchEvent(
                  new CustomEvent("__cap_ping_response", {
                    detail: JSON.stringify({ id: id, error: err.message || "poll failed" }),
                  })
                );
              });
          }
          pollStatus();
        })
        .catch(function (err) {
          window.dispatchEvent(
            new CustomEvent("__cap_ping_response", {
              detail: JSON.stringify({ id: id, error: err.message || "start failed" }),
            })
          );
        });
    } catch (err) {}
  });

  // APK download proxy — poll NanoHTTPD queue endpoint.
  function pollDownloadQueue() {
    fetch("/__cap_download_queue")
      .then(function (r) { return r.json(); })
      .then(function (request) {
        if (!request) return;
        var id = request.id;
        var action = request.action;
        if (action === "cancel") {
          var dlId = request.downloadId;
          if (dlId) {
            fetch("/__cap_download_apk/" + dlId + "/cancel", { method: "POST" }).catch(function () {});
          }
          return;
        }
        fetch("/__cap_download_apk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: request.url, sha256: request.sha256, fileName: request.fileName }),
        })
          .then(function (r) { return r.json(); })
          .then(function (startResult) {
            if (startResult.error) {
              window.dispatchEvent(new CustomEvent("__cap_download_response", { detail: JSON.stringify({ id: id, error: startResult.error }) }));
              return;
            }
            var downloadId = startResult.downloadId;
            function pollProgress() {
              fetch("/__cap_download_apk/" + downloadId)
                .then(function (r) { return r.json(); })
                .then(function (status) {
                  window.dispatchEvent(new CustomEvent("__cap_download_progress", {
                    detail: JSON.stringify({ id: id, downloadId: downloadId, bytesDownloaded: status.bytesDownloaded, totalBytes: status.totalBytes, size: status.size })
                  }));
                  if (status.done) {
                    window.dispatchEvent(new CustomEvent("__cap_download_response", {
                      detail: JSON.stringify({ id: id, downloadId: downloadId, path: status.path, error: status.error })
                    }));
                  } else {
                    setTimeout(pollProgress, 500);
                  }
                })
                .catch(function (err) {
                  window.dispatchEvent(new CustomEvent("__cap_download_response", { detail: JSON.stringify({ id: id, error: err.message || "poll failed" }) }));
                });
            }
            pollProgress();
          })
          .catch(function (err) {
            window.dispatchEvent(new CustomEvent("__cap_download_response", { detail: JSON.stringify({ id: id, error: err.message || "start failed" }) }));
          });
      })
      .catch(function () {});
  }

  // Forward page CustomEvents to native
  window.addEventListener("__cap_bridge", function (e) {
    sendToNative({ __iface: "capacitor", jsonStr: e.detail });
  });
  window.addEventListener("__cap_sysbars_domready", function () {
    sendToNative({ __iface: "sysbars", __method: "onDOMReady" });
  });
  window.addEventListener("__cap_cookies_set", function (e) {
    try {
      var d = JSON.parse(e.detail);
      sendToNative({ __iface: "cookies", __method: "setCookie", domain: d.d, action: d.a });
    } catch (err) {}
  });

  // Eval result listener
  function setupEvalResultListener() {
    if (evalListenerRegistered) return;
    evalListenerRegistered = true;
    window.addEventListener("__cap_eval_done", function (e) {
      try {
        var data = JSON.parse(e.detail);
        if (port) {
          port.postMessage({ __evalResult: data.id, value: data.value });
        } else {
          fetch("/__cap_eval_result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: data.id, value: data.value }),
          }).catch(function () {});
        }
      } catch (err) {}
    });
  }

  function handleEvalMessage(m) {
    if (!m.__eval) return;
    var id = m.__id || 0;
    setupEvalResultListener();
    var wrappedScript =
      "try {" +
      "  var __cap_r = (function(){ return eval(" + JSON.stringify(m.__eval) + "); })();" +
      "  window.dispatchEvent(new CustomEvent('__cap_eval_done', {detail: JSON.stringify({id:" + id + ",value:__cap_r==null?null:String(__cap_r)})}));" +
      "} catch(__cap_e) {" +
      "  window.dispatchEvent(new CustomEvent('__cap_eval_done', {detail: JSON.stringify({id:" + id + ",value:null})}));" +
      "}";
    var scr = document.createElement("script");
    scr.textContent = wrappedScript;
    (document.head || document.documentElement).appendChild(scr);
    scr.parentNode.removeChild(scr);
  }

  // HTTP polling for eval commands + download queue
  var downloadPollTimer = null;

  function startDownloadPolling() {
    if (downloadPollTimer) return;
    downloadPollTimer = setInterval(function () {
      pollDownloadQueue();
    }, 200);
  }

  function startEvalPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      fetch("/__cap_eval")
        .then(function (r) { return r.json(); })
        .then(function (items) {
          if (Array.isArray(items)) {
            items.forEach(handleEvalMessage);
          }
        })
        .catch(function () {});
      fetch("/__cap_endings_data")
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.length > 0) {
            var s = document.createElement("script");
            s.textContent = "window.__capEndingsData=" + JSON.stringify(data);
            (document.head || document.documentElement).appendChild(s);
            s.parentNode.removeChild(s);
          }
        })
        .catch(function () {});
      pollDownloadQueue();
    }, 100);
  }

  // Connect bidirectional Port to native
  var runtime = (typeof browser !== "undefined" && browser.runtime) || (typeof chrome !== "undefined" && chrome.runtime);
  try {
    if (runtime && typeof runtime.connectNative === "function") {
      port = runtime.connectNative("capacitor");
    } else {
      var hasSendNative = runtime && typeof runtime.sendNativeMessage === "function";
      console.log("CapacitorBridge: connectNative=" + (typeof (runtime && runtime.connectNative)) +
        " sendNativeMessage=" + (typeof (runtime && runtime.sendNativeMessage)) +
        " sendMessage=" + (typeof (runtime && runtime.sendMessage)));
    }

    if (port) {
      port.onMessage.addListener(function (m) {
        if (!m) return;
        handleEvalMessage(m);
      });
      port.onDisconnect.addListener(function () {
        port = null;
        startEvalPolling();
      });
      // Download queue polling must always run, even with port connected,
      // because downloads go through HTTP endpoints, not the port.
      startDownloadPolling();
    } else {
      startEvalPolling();
    }
  } catch (e) {
    console.error("CapacitorBridge: connectNative failed, using HTTP polling fallback", e);
    startEvalPolling();
  }
})();
