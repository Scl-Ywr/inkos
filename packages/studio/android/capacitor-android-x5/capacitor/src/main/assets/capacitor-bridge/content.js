// Capacitor Bridge Adapter — GeckoView WebExtension Content Script
// Runs at document_start on http://127.0.0.1:*/*
// Injects bridge proxies into PAGE context; communicates with native via Port or sendNativeMessage.

(function () {
  var port = null;
  var evalListenerRegistered = false;
  var pollTimer = null;

  function sendToNative(payload) {
    if (port) {
      // Preferred: bidirectional Port (connectNative succeeded)
      try {
        port.postMessage(payload);
      } catch (e) {
        console.error("CapacitorBridge: port send failed", e);
      }
    } else {
      // Port unavailable — route plugin calls via HTTP to Java LocalAssetServer.
      // Java processes the call asynchronously; the response arrives via eval polling.
      try {
        var body = typeof payload === "string" ? payload : JSON.stringify(payload);
        fetch("/__cap_plugin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
        }).catch(function () {});
      } catch (e) {
        // Silently ignore
      }
    }
  }

  // Inject bridge objects into PAGE context via <script> tag.
  // All proxies dispatch CustomEvents that this content script listens to.
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
  // GeckoView's page fetch() hangs, but content script fetch() works
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

  // Eval result listener — shared by both Port and HTTP polling paths
  function setupEvalResultListener() {
    if (evalListenerRegistered) return;
    evalListenerRegistered = true;
    window.addEventListener("__cap_eval_done", function (e) {
      try {
        var data = JSON.parse(e.detail);
        if (port) {
          port.postMessage({ __evalResult: data.id, value: data.value });
        } else {
          // HTTP polling fallback — post result via fetch
          fetch("/__cap_eval_result", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: data.id, value: data.value }),
          }).catch(function () {});
        }
      } catch (err) {}
    });
  }

  // Execute eval commands from native (used by both Port and polling)
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

  // HTTP polling for eval commands when Port is unavailable
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
      // Also poll endings data — inject into PAGE context via eval
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
    }, 100);
  }

  // Connect bidirectional Port to native
  // Try both browser.* and chrome.* namespaces (GeckoView may use either)
  var runtime = (typeof browser !== "undefined" && browser.runtime) || (typeof chrome !== "undefined" && chrome.runtime);
  try {
    if (runtime && typeof runtime.connectNative === "function") {
      // Preferred: bidirectional Port
      port = runtime.connectNative("capacitor");
    } else {
      // connectNative not available — check for sendNativeMessage
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
        // Port lost — start HTTP polling fallback
        startEvalPolling();
      });
    } else {
      // No port — start HTTP polling for eval responses
      startEvalPolling();
    }
  } catch (e) {
    console.error("CapacitorBridge: connectNative failed, using HTTP polling fallback", e);
    // connectNative unavailable — start HTTP polling immediately
    startEvalPolling();
  }
})();
