package com.getcapacitor;

import static com.getcapacitor.plugin.util.HttpRequestHandler.isDomainExcludedFromSSL;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.plugin.util.CapacitorHttpUrlConnection;
import com.getcapacitor.plugin.util.HttpRequestHandler;
import fi.iki.elonen.NanoHTTPD;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLConnection;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class LocalAssetServer extends NanoHTTPD {

    private static final String capacitorFileStart = Bridge.CAPACITOR_FILE_START;
    private static final String capacitorContentStart = Bridge.CAPACITOR_CONTENT_START;
    private String basePath;
    private final Context context;
    // Async ping results storage
    private static final java.util.concurrent.ConcurrentHashMap<String, org.json.JSONObject> pingResults = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> pingCompleted = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> pingTotal = new java.util.concurrent.ConcurrentHashMap<>();
    private final Bridge bridge;
    private JSInjector jsInjector;
    private final ArrayList<String> authorities;
    private final AndroidProtocolHandler protocolHandler;
    private boolean isAsset;
    private final boolean html5mode;
    private boolean started = false;

    public LocalAssetServer(Context context, Bridge bridge, JSInjector jsInjector, ArrayList<String> authorities, boolean html5mode) {
        super(4568); // Fixed port for stable origin (localStorage persistence)
        // Note: port 4568 avoids conflict with embedded Node backend on 4567
        this.context = context.getApplicationContext();
        this.bridge = bridge;
        this.jsInjector = jsInjector;
        this.authorities = authorities;
        this.html5mode = html5mode;
        this.protocolHandler = new AndroidProtocolHandler(this.context);
    }

    public int getPort() {
        return getListeningPort();
    }

    public String getBasePath() {
        return this.basePath;
    }

    public void setJsInjector(JSInjector injector) {
        this.jsInjector = injector;
    }

    public void hostAssets(String assetPath) {
        this.isAsset = true;
        this.basePath = assetPath;
        ensureStarted();
    }

    public void hostFiles(String basePath) {
        this.isAsset = false;
        this.basePath = basePath;
        ensureStarted();
    }

    private synchronized void ensureStarted() {
        if (!started) {
            try {
                start();
                started = true;
            } catch (IOException e) {
                Logger.error("Failed to start LocalAssetServer", e);
            }
        }
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        Method method = session.getMethod();
        Map<String, String> headers = session.getHeaders();

        // Debug: log ALL requests to understand what reaches NanoHTTPD
        android.util.Log.d("InkOS_Nano", method + " " + uri);

        // Health check — handled directly in Java, no Node proxy needed.
        // The frontend uses this to detect whether the Node backend is alive.
        if (uri != null && (uri.equals("/api/health") || uri.equals("/health") || uri.equals("/api/v1/health"))) {
            return handleHealthCheck();
        }

        // GeckoView eval polling — content script polls for pending eval commands
        // when the WebExtension Port is unavailable (connectNative failed).
        if (uri != null && uri.equals("/__cap_eval") && Method.GET.equals(method)) {
            return handleEvalPoll();
        }
        if (uri != null && uri.equals("/__cap_eval_result") && Method.POST.equals(method)) {
            return handleEvalResult(session);
        }

        // Capacitor plugin call via HTTP — bypasses the broken native messaging bridge.
        if (uri != null && uri.equals("/__cap_plugin") && Method.POST.equals(method)) {
            return handlePluginCall(session);
        }

        // File picker via hidden WebView — bypasses GeckoView's missing onFilePrompt.
        if (uri != null && uri.equals("/__cap_pick_file") && Method.POST.equals(method)) {
            return handleFilePick(session);
        }

        // Ping URL for update source checking — bypasses broken Capacitor bridge.
        if (uri != null && uri.equals("/__cap_ping_batch") && Method.POST.equals(method)) {
            Logger.debug("Ping batch POST received");
            return handlePingBatch(session);
        }

        // Ping status polling
        if (uri != null && uri.startsWith("/__cap_ping_batch/") && Method.GET.equals(method)) {
            String batchId = uri.substring("/__cap_ping_batch/".length());
            Logger.debug("Ping status GET: " + batchId);
            return handlePingStatus(batchId);
        }

        // APK download — bypasses broken Capacitor bridge in GeckoView.
        if (uri != null && uri.equals("/__cap_download_apk") && Method.POST.equals(method)) {
            return handleDownloadApk(session);
        }

        // APK download queue — pages POST download requests here, content script polls GET.
        if (uri != null && uri.equals("/__cap_download_queue") && Method.POST.equals(method)) {
            return handleDownloadQueuePost(session);
        }
        if (uri != null && uri.equals("/__cap_download_queue") && Method.GET.equals(method)) {
            return handleDownloadQueuePoll();
        }

        // APK download status polling
        if (uri != null && uri.startsWith("/__cap_download_apk/") && Method.GET.equals(method)) {
            String downloadId = uri.substring("/__cap_download_apk/".length());
            return handleDownloadStatus(downloadId);
        }

        // APK download cancel
        if (uri != null && uri.startsWith("/__cap_download_apk/") && uri.endsWith("/cancel") && Method.POST.equals(method)) {
            String downloadId = uri.substring("/__cap_download_apk/".length(), uri.length() - "/cancel".length());
            return handleDownloadCancel(downloadId);
        }

        // Direct battery optimization request — bypasses Capacitor bridge entirely for GeckoView.
        if (uri != null && uri.equals("/__cap_battery_exemption") && Method.POST.equals(method)) {
            return handleBatteryExemption();
        }

        // Install downloaded APK — bypasses Capacitor bridge for GeckoView.
        if (uri != null && uri.equals("/__cap_install_apk") && Method.POST.equals(method)) {
            return handleInstallApk(session);
        }

        // Open install permission settings — bypasses Capacitor bridge for GeckoView.
        if (uri != null && uri.equals("/__cap_install_permission") && Method.POST.equals(method)) {
            return handleInstallPermissionSettings();
        }

        // TTS endpoints — local text-to-speech via Android TextToSpeech API.
        if (uri != null && uri.equals("/__cap_tts/speak") && Method.POST.equals(method)) {
            return handleTtsSpeak(session);
        }
        if (uri != null && uri.equals("/__cap_tts/pause") && Method.POST.equals(method)) {
            return handleTtsPause();
        }
        if (uri != null && uri.equals("/__cap_tts/resume") && Method.POST.equals(method)) {
            return handleTtsResume();
        }
        if (uri != null && uri.equals("/__cap_tts/stop") && Method.POST.equals(method)) {
            return handleTtsStop();
        }
        if (uri != null && uri.equals("/__cap_tts/status") && Method.GET.equals(method)) {
            return handleTtsStatus();
        }

        // Endings endpoints — read directly in Java, bypass Node proxy.
        // GeckoView fetch hangs when proxying to Node before it's ready.
        if (uri != null && uri.endsWith("/endings/origin")) {
            return handleEndingsOrigin(uri);
        }
        if (uri != null && uri.matches(".*/books/[^/]+/endings$") && Method.GET.equals(method)) {
            return handleEndings(uri);
        }

        // Endings data injection — content script polls this to get endings data
        // and injects it into the page via eval, bypassing GeckoView's broken fetch.
        if (uri != null && uri.equals("/__cap_endings_data") && Method.GET.equals(method)) {
            return handleEndingsDataInjection();
        }

        // SSE events — when Node backend is not ready, return an empty SSE stream
        // instead of a 500 error, so the EventSource stays connected and auto-retries.
        if (uri != null && uri.equals("/api/v1/events")) {
            try {
                return proxyToNodeBackend(session);
            } catch (Exception e) {
                Response resp = newFixedLengthResponse(Response.Status.OK, "text/event-stream", ":ok\n\n");
                resp.addHeader("Cache-Control", "no-cache");
                resp.addHeader("Connection", "keep-alive");
                return resp;
            }
        }

        if (uri != null && uri.startsWith("/api/")) {
            try {
                return proxyToNodeBackend(session);
            } catch (Exception e) {
                Logger.error("Reverse proxy to Node failed: " + uri, e);
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Proxy error: " + e.getMessage());
            }
        }

        // Handle _capacitor_http_interceptor_ proxy requests
        if (uri != null && uri.startsWith(Bridge.CAPACITOR_HTTP_INTERCEPTOR_START)) {
            try {
                return handleCapacitorHttpRequest(session);
            } catch (Exception e) {
                Logger.error("CapacitorHttp request error: " + e.getLocalizedMessage());
                return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_PLAINTEXT, "Proxy error");
            }
        }

        Uri parsed = Uri.parse(uri);
        String path = parsed.getPath();
        if (path == null) path = "/";

        // Handle _capacitor_file_ and _capacitor_content_ URLs
        if (path.startsWith(capacitorFileStart)) {
            return serveFile(path);
        }
        if (path.startsWith(capacitorContentStart)) {
            return serveContent(parsed);
        }

        // Handle / (root) or html5mode fallback to index.html
        if (path.equals("/") || (isHtml5ModePath(path))) {
            return serveIndexHtml();
        }

        // Handle /cordova.js by returning empty
        if ("/cordova.js".equals(path)) {
            return newFixedLengthResponse(Response.Status.OK, "application/javascript", "");
        }

        // Handle /favicon.ico
        if ("/favicon.ico".equalsIgnoreCase(path)) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "image/png", "");
        }

        // Serve the actual asset/file
        return serveAsset(path);
    }

    private boolean isHtml5ModePath(String path) {
        if (!html5mode) return false;
        String lastSegment = path.substring(path.lastIndexOf('/') + 1);
        return !lastSegment.contains(".");
    }

    private Response serveIndexHtml() {
        String startPath = this.basePath + "/index.html";
        if (bridge.getRouteProcessor() != null) {
            ProcessedRoute processedRoute = bridge.getRouteProcessor().process(this.basePath, "/index.html");
            startPath = processedRoute.getPath();
            isAsset = processedRoute.isAsset();
        }

        try {
            InputStream stream;
            if (isAsset) {
                stream = protocolHandler.openAsset(startPath);
            } else {
                stream = protocolHandler.openFile(startPath);
            }
            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_HTML, "Not found");
            }

            if (jsInjector != null) {
                // Inject Capacitor JS into the HTML response
                InputStream injected = jsInjector.getInjectedStream(stream);
                return newFixedLengthResponse(Response.Status.OK, MIME_HTML, injected, -1);
            }
            return newFixedLengthResponse(Response.Status.OK, MIME_HTML, stream, -1);
        } catch (IOException e) {
            Logger.error("Unable to open index.html", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, MIME_HTML, "Server error");
        }
    }

    private Response serveAsset(String path) {
        try {
            InputStream stream;
            boolean ignoreAssetPath = false;

            RouteProcessor routeProcessor = bridge.getRouteProcessor();
            String resolvedPath = path;
            if (routeProcessor != null) {
                ProcessedRoute processedRoute = routeProcessor.process("", path);
                resolvedPath = processedRoute.getPath();
                isAsset = processedRoute.isAsset();
                ignoreAssetPath = processedRoute.isIgnoreAssetPath();
            }

            if (!isAsset) {
                if (routeProcessor == null) {
                    resolvedPath = basePath + path;
                }
                stream = protocolHandler.openFile(resolvedPath);
            } else if (ignoreAssetPath) {
                stream = protocolHandler.openAsset(resolvedPath);
            } else {
                stream = protocolHandler.openAsset(basePath + path);
            }

            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
            }

            String mimeType = getMimeType(path, stream);

            // Inject JS into HTML files
            if (path.endsWith(".html") && jsInjector != null) {
                stream = jsInjector.getInjectedStream(stream);
                mimeType = MIME_HTML;
            }

            return newFixedLengthResponse(Response.Status.OK, mimeType, stream, -1);
        } catch (IOException e) {
            Logger.error("Unable to open asset: " + path, e);
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
        }
    }

    private Response serveFile(String path) {
        try {
            InputStream stream = protocolHandler.openFile(path);
            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
            }
            String mimeType = getMimeType(path, stream);
            return newFixedLengthResponse(Response.Status.OK, mimeType, stream, -1);
        } catch (IOException e) {
            Logger.error("Unable to open file: " + path, e);
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
        }
    }

    private Response serveContent(Uri uri) {
        try {
            InputStream stream = protocolHandler.openContentUrl(uri);
            if (stream == null) {
                return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
            }
            String path = uri.getPath();
            String mimeType = getMimeType(path, stream);
            return newFixedLengthResponse(Response.Status.OK, mimeType, stream, -1);
        } catch (IOException e) {
            Logger.error("Unable to open content: " + uri, e);
            return newFixedLengthResponse(Response.Status.NOT_FOUND, MIME_PLAINTEXT, "Not found");
        }
    }

    private Response handleCapacitorHttpRequest(IHTTPSession session) throws IOException {
        String uri = session.getUri();
        Uri parsed = Uri.parse(uri);
        String urlString = parsed.getQueryParameter(Bridge.CAPACITOR_HTTP_INTERCEPTOR_URL_PARAM);
        if (urlString == null) {
            return newFixedLengthResponse(Response.Status.BAD_REQUEST, MIME_PLAINTEXT, "Missing URL param");
        }

        URL url = new URL(urlString);
        JSObject headers = new JSObject();
        for (Map.Entry<String, String> header : session.getHeaders().entrySet()) {
            headers.put(header.getKey(), header.getValue());
        }

        String userAgentValue = headers.getString("x-cap-user-agent");
        if (userAgentValue != null) {
            headers.put("User-Agent", userAgentValue);
        }
        headers.remove("x-cap-user-agent");

        HttpRequestHandler.HttpURLConnectionBuilder connectionBuilder = new HttpRequestHandler.HttpURLConnectionBuilder()
            .setUrl(url)
            .setMethod(session.getMethod().name())
            .setHeaders(headers)
            .openConnection();

        CapacitorHttpUrlConnection connection = connectionBuilder.build();

        if (!isDomainExcludedFromSSL(bridge, url)) {
            connection.setSSLSocketFactory(bridge);
        }

        connection.connect();

        String mimeType = null;
        String encoding = null;
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            StringBuilder builder = new StringBuilder();
            for (String value : entry.getValue()) {
                builder.append(value).append(", ");
            }
            if (builder.length() >= 2) builder.setLength(builder.length() - 2);

            if ("Content-Type".equalsIgnoreCase(entry.getKey())) {
                String[] contentTypeParts = builder.toString().split(";");
                mimeType = contentTypeParts[0].trim();
                if (contentTypeParts.length > 1) {
                    String[] encodingParts = contentTypeParts[1].split("=");
                    if (encodingParts.length > 1) {
                        encoding = encodingParts[1].trim();
                    }
                }
            }
        }

        InputStream inputStream = connection.getErrorStream();
        if (inputStream == null) {
            inputStream = connection.getInputStream();
        }

        if (mimeType == null) {
            mimeType = getMimeType(parsed.getPath(), inputStream);
        }

        int responseCode = connection.getResponseCode();
        Response.IStatus status = toNanoStatus(responseCode);

        Response response = newFixedLengthResponse(status, mimeType, inputStream, -1);

        // Forward response headers
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() != null && !"Content-Type".equalsIgnoreCase(entry.getKey()) && !"Content-Length".equalsIgnoreCase(entry.getKey())) {
                for (String val : entry.getValue()) {
                    response.addHeader(entry.getKey(), val);
                }
            }
        }

        return response;
    }

    private String getMimeType(String path, InputStream stream) {
        String mimeType = null;
        try {
            mimeType = URLConnection.guessContentTypeFromName(path);
            if (mimeType == null) {
                if (path.endsWith(".js") || path.endsWith(".mjs")) {
                    mimeType = "application/javascript";
                } else if (path.endsWith(".wasm")) {
                    mimeType = "application/wasm";
                } else if (path.endsWith(".html")) {
                    mimeType = "text/html";
                } else if (path.endsWith(".css")) {
                    mimeType = "text/css";
                } else if (path.endsWith(".json")) {
                    mimeType = "application/json";
                } else if (path.endsWith(".svg")) {
                    mimeType = "image/svg+xml";
                } else if (path.endsWith(".png")) {
                    mimeType = "image/png";
                } else if (path.endsWith(".jpg") || path.endsWith(".jpeg")) {
                    mimeType = "image/jpeg";
                } else if (path.endsWith(".woff2")) {
                    mimeType = "font/woff2";
                } else if (path.endsWith(".woff")) {
                    mimeType = "font/woff";
                } else if (path.endsWith(".ttf")) {
                    mimeType = "font/ttf";
                } else if (path.endsWith(".ico")) {
                    mimeType = "image/x-icon";
                } else {
                    mimeType = URLConnection.guessContentTypeFromStream(stream);
                }
            }
        } catch (Exception ex) {
            Logger.error("Unable to get mime type: " + path, ex);
        }
        return mimeType != null ? mimeType : "application/octet-stream";
    }

    private static Response.IStatus toNanoStatus(int code) {
        return new Response.IStatus() {
            @Override
            public int getRequestStatus() { return code; }
            @Override
            public String getDescription() { return code + " " + reasonPhrase(code); }
        };
    }

    private static String reasonPhrase(int code) {
        return switch (code) {
            case 200 -> "OK";
            case 206 -> "Partial Content";
            case 301 -> "Moved Permanently";
            case 302 -> "Found";
            case 304 -> "Not Modified";
            case 400 -> "Bad Request";
            case 401 -> "Unauthorized";
            case 403 -> "Forbidden";
            case 404 -> "Not Found";
            case 500 -> "Internal Server Error";
            default -> "Unknown";
        };
    }

    /**
     * Capacitor plugin call via HTTP — processes the plugin request asynchronously.
     * The response is delivered back to the page via eval polling (window.Capacitor.fromNative).
     */
    private Response handlePluginCall(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String jsonStr = new String(buffer, "UTF-8");
            // The content script wraps plugin calls in {"__iface":"capacitor","jsonStr":"..."}.
            // Extract the inner jsonStr for the message handler (same as Port-based path in Bridge.java).
            try {
                org.json.JSONObject wrapper = new org.json.JSONObject(jsonStr);
                if ("capacitor".equals(wrapper.optString("__iface", ""))) {
                    jsonStr = wrapper.optString("jsonStr", jsonStr);
                }
            } catch (Exception ignored) { /* not a wrapper, use raw body */ }
            // Route through the standard MessageHandler which dispatches to plugins.
            // Plugin responses go through bridge.eval() → pendingHttpEvalQueue → content script polling.
            bridge.msgHandler.postMessage(jsonStr);
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
        } catch (Exception e) {
            Logger.error("Plugin call via HTTP failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    /**
     * File picker via hidden WebView — bypasses GeckoView's missing onFilePrompt.
     * Called by JS via POST /__cap_pick_file.
     */
    private Response handleFilePick(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String body = new String(buffer, "UTF-8");

            String accept = "*/*";
            boolean multiple = false;
            try {
                org.json.JSONObject req = new org.json.JSONObject(body);
                accept = req.optString("accept", "*/*");
                multiple = req.optBoolean("multiple", false);
            } catch (Exception ignored) {}

            final java.util.concurrent.CompletableFuture<String[]> future = new java.util.concurrent.CompletableFuture<>();
            bridge.triggerFilePicker(accept, multiple, future);

            // Block this NanoHTTPD thread until the user picks a file (max 120s).
            String[] uris;
            try {
                uris = future.get(120, java.util.concurrent.TimeUnit.SECONDS);
            } catch (java.util.concurrent.TimeoutException te) {
                uris = new String[0];
            } catch (Exception e) {
                uris = new String[0];
            }

            org.json.JSONObject resp = new org.json.JSONObject();
            if (uris == null || uris.length == 0) {
                resp.put("uris", new org.json.JSONArray());
                resp.put("error", "cancelled");
            } else {
                org.json.JSONArray urisArray = new org.json.JSONArray();
                org.json.JSONArray namesArray = new org.json.JSONArray();
                org.json.JSONArray typesArray = new org.json.JSONArray();
                org.json.JSONArray dataArray = new org.json.JSONArray();
                for (String u : urisArray.length() < uris.length ? uris : uris) {
                    urisArray.put(u);
                    android.net.Uri uri = android.net.Uri.parse(u);
                    String name = "unknown";
                    String type = "application/octet-stream";
                    String base64 = "";
                    try {
                        // Get display name
                        android.database.Cursor cursor = bridge.getContext().getContentResolver().query(
                            uri, null, null, null, null);
                        if (cursor != null) {
                            if (cursor.moveToFirst()) {
                                int nameIdx = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME);
                                if (nameIdx >= 0) name = cursor.getString(nameIdx);
                                int sizeIdx = cursor.getColumnIndex(android.provider.OpenableColumns.SIZE);
                            }
                            cursor.close();
                        }
                        // Get MIME type
                        type = bridge.getContext().getContentResolver().getType(uri);
                        if (type == null) type = "application/octet-stream";
                        // Read file content as base64
                        java.io.InputStream inputStream = bridge.getContext().getContentResolver().openInputStream(uri);
                        if (inputStream != null) {
                            byte[] bytes = readAllBytes(inputStream);
                            inputStream.close();
                            base64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP);
                        } else {
                            Logger.error("File pick: openInputStream returned null for " + u);
                        }
                    } catch (Exception e) {
                        Logger.error("Error reading picked file: " + u, e);
                    }
                    namesArray.put(name);
                    typesArray.put(type);
                    dataArray.put(base64);
                }
                resp.put("uris", urisArray);
                resp.put("names", namesArray);
                resp.put("types", typesArray);
                resp.put("data", dataArray);
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json", resp.toString());
        } catch (Exception e) {
            Logger.error("File pick via HTTP failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"uris\":[],\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    /**
     * Batch ping multiple URLs for update source checking.
     * Starts pings in background threads and returns batch ID immediately.
     * Called by JS via POST /__cap_ping_batch.
     */
    private Response handlePingBatch(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String body = new String(buffer, "UTF-8");

            java.util.List<String> urls = new java.util.ArrayList<>();
            try {
                org.json.JSONArray arr = new org.json.JSONArray(body);
                for (int i = 0; i < arr.length(); i++) urls.add(arr.getString(i));
            } catch (Exception ignored) {}

            // Generate batch ID and start pings in background threads (non-blocking)
            String batchId = "ping-" + System.currentTimeMillis();
            pingTotal.put(batchId, new java.util.concurrent.atomic.AtomicInteger(urls.size()));
            pingCompleted.put(batchId, new java.util.concurrent.atomic.AtomicInteger(0));

            final java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(
                Math.min(urls.size(), 8));
            for (int i = 0; i < urls.size(); i++) {
                final String u = urls.get(i);
                final int idx = i;
                pool.submit(() -> {
                    org.json.JSONObject result = pingUrl(u);
                    try { result.put("index", idx); } catch (org.json.JSONException ignored) {}
                    pingResults.put(batchId + ":" + idx, result);
                    pingCompleted.get(batchId).incrementAndGet();
                });
            }
            pool.shutdown();

            org.json.JSONObject resp = new org.json.JSONObject();
            resp.put("batchId", batchId);
            resp.put("total", urls.size());
            return newFixedLengthResponse(Response.Status.OK, "application/json", resp.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    /**
     * Check status of a ping batch.
     * Called by JS via GET /__cap_ping_batch/{batchId}.
     */
    private Response handlePingStatus(String batchId) {
        java.util.concurrent.atomic.AtomicInteger total = pingTotal.get(batchId);
        java.util.concurrent.atomic.AtomicInteger completed = pingCompleted.get(batchId);
        if (total == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json",
                "{\"error\":\"batch not found\"}");
        }
        int totalVal = total.get();
        int completedVal = completed.get();
        boolean done = completedVal >= totalVal;

        org.json.JSONArray results = new org.json.JSONArray();
        if (done) {
            for (int i = 0; i < totalVal; i++) {
                org.json.JSONObject r = pingResults.remove(batchId + ":" + i);
                results.put(r != null ? r : new org.json.JSONObject());
            }
            pingTotal.remove(batchId);
            pingCompleted.remove(batchId);
        }

        org.json.JSONObject resp = new org.json.JSONObject();
        try {
            resp.put("done", done);
            resp.put("completed", completedVal);
            resp.put("total", totalVal);
            resp.put("results", results);
        } catch (org.json.JSONException ignored) {}
        return newFixedLengthResponse(Response.Status.OK, "application/json", resp.toString());
    }

    private org.json.JSONObject pingUrl(String urlString) {
        long startedAt = System.currentTimeMillis();
        org.json.JSONObject result = new org.json.JSONObject();
        java.net.HttpURLConnection connection = null;
        try {
            java.net.URL url = new java.net.URL(urlString);
            connection = (java.net.HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod("HEAD");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("User-Agent", "InkOS-Studio-Android");
            int code = connection.getResponseCode();
            if (code == java.net.HttpURLConnection.HTTP_BAD_METHOD) {
                connection.disconnect();
                connection = (java.net.HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("Range", "bytes=0-0");
                code = connection.getResponseCode();
                try (java.io.InputStream input = connection.getInputStream()) { input.read(); }
            }
            long latencyMs = Math.max(1L, System.currentTimeMillis() - startedAt);
            result.put("ok", code >= 200 && code < 400);
            result.put("statusCode", code);
            result.put("latencyMs", latencyMs);
        } catch (org.json.JSONException e) {
            // Ignore JSON formatting errors
        } catch (Exception error) {
            long latencyMs = Math.max(1L, System.currentTimeMillis() - startedAt);
            try {
                result.put("ok", false);
                result.put("statusCode", 0);
                result.put("latencyMs", latencyMs);
                result.put("error", error.getMessage());
            } catch (org.json.JSONException ignored) {}
        } finally {
            if (connection != null) connection.disconnect();
        }
        return result;
    }

    // ==================== APK Download (bypass GeckoView broken bridge) ====================

    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> downloadTotal = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.atomic.AtomicInteger> downloadCompleted = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, String> downloadPaths = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, String> downloadErrors = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, Long> downloadSizes = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, java.net.HttpURLConnection> downloadConnections = new java.util.concurrent.ConcurrentHashMap<>();
    private static final java.util.concurrent.ConcurrentHashMap<String, Boolean> downloadCancelledFlags = new java.util.concurrent.ConcurrentHashMap<>();

    private Response handleDownloadApk(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String body = new String(buffer, "UTF-8");
            org.json.JSONObject req = new org.json.JSONObject(body);
            String url = req.optString("url", "");
            String sha256 = req.optString("sha256", "");
            String fileName = req.optString("fileName", "inkos-update.apk");

            if (url.isEmpty() || sha256.isEmpty()) {
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
                    "{\"error\":\"url and sha256 are required\"}");
            }

            String downloadId = "dl-" + System.currentTimeMillis();
            downloadTotal.put(downloadId, new java.util.concurrent.atomic.AtomicInteger(0));
            downloadCompleted.put(downloadId, new java.util.concurrent.atomic.AtomicInteger(0));
            downloadCancelledFlags.put(downloadId, false);

            final String dlUrl = url;
            final String dlSha256 = sha256;
            final String dlFileName = fileName;
            final String dlId = downloadId;

            new Thread(() -> {
                java.io.File updatesDir = new java.io.File(bridge.getContext().getCacheDir(), "updates");
                if (!updatesDir.exists()) updatesDir.mkdirs();
                java.io.File target = new java.io.File(updatesDir, dlFileName);
                java.io.File temporary = new java.io.File(updatesDir, dlFileName + ".download");

                java.net.HttpURLConnection connection = null;
                try {
                    java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                    java.net.URL u = new java.net.URL(dlUrl);
                    connection = (java.net.HttpURLConnection) u.openConnection();
                    downloadConnections.put(dlId, connection);
                    connection.setInstanceFollowRedirects(true);
                    connection.setConnectTimeout(15000);
                    connection.setReadTimeout(120000);
                    connection.setRequestProperty("User-Agent", "InkOS-Studio-Android");
                    int code = connection.getResponseCode();
                    if (code < 200 || code >= 300) {
                        throw new java.io.IOException("HTTP " + code);
                    }
                    long contentLen = connection.getContentLengthLong();
                    downloadTotal.get(dlId).set((int) contentLen);
                    downloadSizes.put(dlId, contentLen);

                    try (java.io.InputStream input = connection.getInputStream();
                         java.io.FileOutputStream output = new java.io.FileOutputStream(temporary, false)) {
                        byte[] buf = new byte[64 * 1024];
                        int r;
                        long totalBytes = 0;
                        while ((r = input.read(buf)) != -1) {
                            if (Boolean.TRUE.equals(downloadCancelledFlags.get(dlId))) {
                                temporary.delete();
                                downloadErrors.put(dlId, "cancelled");
                                return;
                            }
                            digest.update(buf, 0, r);
                            output.write(buf, 0, r);
                            totalBytes += r;
                            downloadCompleted.get(dlId).set((int) totalBytes);
                        }
                    }

                    String actualSha256 = hex(digest.digest());
                    if (!actualSha256.equalsIgnoreCase(dlSha256)) {
                        temporary.delete();
                        throw new java.io.IOException("SHA-256 mismatch. Expected " + dlSha256 + " but got " + actualSha256);
                    }
                    if (target.exists()) target.delete();
                    // Use Files.move instead of File.renameTo (more reliable on Android)
                    try {
                        java.nio.file.Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    } catch (Exception moveEx) {
                        // Fallback: copy + delete
                        java.nio.file.Files.copy(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                        temporary.delete();
                    }
                    downloadPaths.put(dlId, target.getAbsolutePath());
                } catch (Exception e) {
                    downloadErrors.put(dlId, e.getMessage());
                } finally {
                    downloadConnections.remove(dlId);
                    if (connection != null) connection.disconnect();
                }
            }, "inkos-dl-http").start();

            org.json.JSONObject resp = new org.json.JSONObject();
            resp.put("downloadId", downloadId);
            return newFixedLengthResponse(Response.Status.OK, "application/json", resp.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    private Response handleDownloadStatus(String downloadId) {
        java.util.concurrent.atomic.AtomicInteger total = downloadTotal.get(downloadId);
        java.util.concurrent.atomic.AtomicInteger completed = downloadCompleted.get(downloadId);
        if (total == null) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "application/json",
                "{\"error\":\"download not found\"}");
        }
        String path = downloadPaths.get(downloadId);
        String error = downloadErrors.get(downloadId);
        boolean done = path != null || error != null;
        long totalVal = total.get();
        long completedVal = completed.get();
        long size = downloadSizes.containsKey(downloadId) ? downloadSizes.get(downloadId) : 0;

        org.json.JSONObject resp = new org.json.JSONObject();
        try {
            resp.put("done", done);
            resp.put("bytesDownloaded", completedVal);
            resp.put("totalBytes", totalVal);
            resp.put("size", size);
            if (path != null) resp.put("path", path);
            if (error != null) resp.put("error", error);
        } catch (org.json.JSONException ignored) {}

        if (done) {
            downloadTotal.remove(downloadId);
            downloadCompleted.remove(downloadId);
            downloadPaths.remove(downloadId);
            downloadErrors.remove(downloadId);
            downloadSizes.remove(downloadId);
            downloadCancelledFlags.remove(downloadId);
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", resp.toString());
    }

    private Response handleDownloadCancel(String downloadId) {
        downloadCancelledFlags.put(downloadId, true);
        java.net.HttpURLConnection conn = downloadConnections.remove(downloadId);
        if (conn != null) {
            try { conn.disconnect(); } catch (Exception ignored) {}
        }
        downloadErrors.put(downloadId, "cancelled");
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
    }

    private String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
        }
        return builder.toString();
    }

    // ==================== Download Queue (page POSTs, content script polls GET) ====================

    private static volatile String pendingDownloadRequest = null;

    private Response handleDownloadQueuePost(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            pendingDownloadRequest = new String(buffer, "UTF-8");
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    private Response handleDownloadQueuePoll() {
        String request = pendingDownloadRequest;
        pendingDownloadRequest = null;
        if (request != null) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", request);
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", "null");
    }

    // ==================== Battery Exemption ====================

    /**
     * Open battery optimization exemption dialog directly, bypassing Capacitor bridge.
     * Called by JS via POST /__cap_battery_exemption when GeckoView bridge is broken.
     */
    private Response handleBatteryExemption() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) bridge.getContext().getSystemService(android.content.Context.POWER_SERVICE);
            boolean isIgnoring = pm != null && pm.isIgnoringBatteryOptimizations(bridge.getContext().getPackageName());

            if (!isIgnoring && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
                try {
                    Intent request = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    request.setData(android.net.Uri.parse("package:" + bridge.getContext().getPackageName()));
                    request.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    bridge.getActivity().startActivity(request);
                } catch (Exception e) {
                    // Fallback: open app detail settings
                    Intent appSettings = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appSettings.setData(android.net.Uri.parse("package:" + bridge.getContext().getPackageName()));
                    appSettings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    bridge.getContext().startActivity(appSettings);
                }
            } else {
                try {
                    Intent settings = new Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    bridge.getContext().startActivity(settings);
                } catch (Exception e) {
                    Intent appSettings = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appSettings.setData(android.net.Uri.parse("package:" + bridge.getContext().getPackageName()));
                    appSettings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    bridge.getContext().startActivity(appSettings);
                }
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"ok\":true,\"ignoring\":" + isIgnoring + "}");
        } catch (Exception e) {
            Logger.error("Battery exemption failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    // ==================== Install APK ====================

    /**
     * Install a downloaded APK file, bypassing Capacitor bridge for GeckoView.
     * Called by JS via POST /__cap_install_apk with { path } body.
     */
    private Response handleInstallApk(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String body = new String(buffer, "UTF-8");
            org.json.JSONObject req = new org.json.JSONObject(body);
            String path = req.optString("path", "").trim();

            java.io.File apk;
            if (path.isEmpty()) {
                apk = new java.io.File(new java.io.File(bridge.getContext().getCacheDir(), "updates"), "inkos-update.apk");
            } else {
                apk = new java.io.File(path);
            }

            if (!apk.exists() || !apk.isFile()) {
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
                    "{\"ok\":false,\"error\":\"Downloaded APK is missing: " + apk.getAbsolutePath() + "\"}");
            }

            // Check install permission
            boolean canInstall = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.O
                || bridge.getContext().getPackageManager().canRequestPackageInstalls();
            if (!canInstall) {
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"ok\":false,\"needsPermission\":true,\"message\":\"Android requires permission to install APKs from this app.\"}");
            }

            android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                bridge.getContext(),
                bridge.getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            bridge.getContext().startActivity(intent);

            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"ok\":true,\"path\":\"" + apk.getAbsolutePath() + "\"}");
        } catch (Exception e) {
            Logger.error("Install APK failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    // ==================== Install Permission Settings ====================

    /**
     * Open the install unknown apps permission settings for this app.
     * Called by JS via POST /__cap_install_permission.
     */
    private Response handleInstallPermissionSettings() {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(android.net.Uri.parse("package:" + bridge.getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            bridge.getContext().startActivity(intent);
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
        } catch (Exception e) {
            Logger.error("Open install permission settings failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    // ── TTS handlers ──

    private TtsManager ttsManager;

    private TtsManager getTtsManager() {
        if (ttsManager == null) {
            ttsManager = new TtsManager(bridge.getContext());
        }
        return ttsManager;
    }

    private Response handleTtsSpeak(IHTTPSession session) {
        try {
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String jsonStr = new String(buffer, "UTF-8");
            org.json.JSONObject body = new org.json.JSONObject(jsonStr);
            String text = body.optString("text", "");
            float rate = (float) body.optDouble("rate", 1.0);

            if (text.isEmpty()) {
                return newFixedLengthResponse(Response.Status.BAD_REQUEST, "application/json",
                    "{\"ok\":false,\"error\":\"text is required\"}");
            }

            getTtsManager().speak(text, rate);
            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"ok\":true,\"ready\":" + getTtsManager().isReady() + "}");
        } catch (Exception e) {
            Logger.error("TTS speak failed", e);
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    private Response handleTtsPause() {
        getTtsManager().pause();
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
    }

    private Response handleTtsResume() {
        getTtsManager().resume();
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
    }

    private Response handleTtsStop() {
        getTtsManager().stop();
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
    }

    private Response handleTtsStatus() {
        TtsManager mgr = getTtsManager();
        try {
            org.json.JSONObject json = new org.json.JSONObject();
            json.put("ok", true);
            json.put("ready", mgr.isReady());
            json.put("speaking", mgr.isSpeaking());
            json.put("paused", mgr.isPaused());
            json.put("progress", mgr.getProgress());
            json.put("spokenChars", mgr.getSpokenChars());
            json.put("totalChars", mgr.getTotalChars());
            return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "application/json",
                "{\"ok\":false,\"error\":\"" + e.getMessage() + "\"}");
        }
    }

    /**
     * Read endings.json directly from Java filesystem.
     */
    private Response handleEndings(String uri) {
        try {
            String decoded = java.net.URLDecoder.decode(uri, "UTF-8");
            String bookId = decoded.replaceFirst("^/api/v1/books/", "").replaceFirst("/endings$", "");
            String path = "/storage/emulated/0/Documents/InkOS Studio/books/" + bookId + "/endings.json";
            java.io.File file = new java.io.File(path);
            if (!file.exists()) {
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"endings\":[],\"activeEnding\":null}");
            }
            String content = new String(java.nio.file.Files.readAllBytes(file.toPath()), "UTF-8");
            return newFixedLengthResponse(Response.Status.OK, "application/json", content);
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"endings\":[],\"activeEnding\":null}");
        }
    }

    /**
     * Return both endings datasets as a single JSON object for content script injection.
     * Used when GeckoView's fetch() hangs — content script polls this instead.
     * Format: { "bookId": "...", "endings": {...}, "origin": {...} }
     */
    private Response handleEndingsDataInjection() {
        try {
            // List all books and return endings for each
            java.io.File booksDir = new java.io.File("/storage/emulated/0/Documents/InkOS Studio/books");
            org.json.JSONArray result = new org.json.JSONArray();
            if (booksDir.exists()) {
                for (java.io.File bookDir : booksDir.listFiles()) {
                    if (!bookDir.isDirectory()) continue;
                    String bookId = bookDir.getName();
                    // Read user endings
                    String endingsJson = "{\"endings\":[],\"activeEnding\":null}";
                    java.io.File endingsFile = new java.io.File(bookDir, "endings.json");
                    if (endingsFile.exists()) {
                        endingsJson = new String(java.nio.file.Files.readAllBytes(endingsFile.toPath()), "UTF-8");
                    }
                    // Read origin endings
                    String originJson = "{\"endings\":[],\"activeEnding\":null}";
                    java.io.File storyFrame = new java.io.File(bookDir, "story/outline/story_frame.md");
                    if (storyFrame.exists()) {
                        String content = new String(java.nio.file.Files.readAllBytes(storyFrame.toPath()), "UTF-8");
                        java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                            "## \\u7EC8\\u5C40\\u65B9\\u5411.*?\\+.*?\\u5168\\u4E66\\s+Objective\\s*\\n([\\s\\S]*?)(?=\\n##|$)"
                        ).matcher(content);
                        String desc = m.find() ? m.group(1).trim() : "";
                        if (desc.isEmpty() && content.length() > 100) {
                            desc = content.substring(content.length() - Math.min(500, content.length()));
                        }
                        if (!desc.isEmpty()) {
                            originJson = "{\"endings\":[{\"id\":\"origin\",\"name\":\"原始结局\",\"description\":\""
                                + desc.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "")
                                + "\",\"type\":\"good\",\"chapters\":[],\"createdAt\":\"\"}],\"activeEnding\":null}";
                        }
                    }
                    org.json.JSONObject entry = new org.json.JSONObject();
                    entry.put("bookId", bookId);
                    entry.put("endings", new org.json.JSONObject(endingsJson));
                    entry.put("origin", new org.json.JSONObject(originJson));
                    result.put(entry);
                }
            }
            return newFixedLengthResponse(Response.Status.OK, "application/json", result.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
        }
    }

    /**
     * Read story_frame.md directly in Java and extract endings.
     * Bypasses the Node proxy which GeckoView's fetch hangs on for this endpoint.
     */
    private Response handleEndingsOrigin(String uri) {
        try {
            // Extract bookId from URI: /api/v1/books/{bookId}/endings/origin
            // URI is URL-decoded by NanoHTTPD
            String decoded = java.net.URLDecoder.decode(uri, "UTF-8");
            String bookId = decoded.replaceFirst("^/api/v1/books/", "").replaceFirst("/endings/origin$", "");
            Logger.debug("Endings origin bookId: " + bookId);
            // Books are stored in Documents directory, not app private data
            String path = "/storage/emulated/0/Documents/InkOS Studio/books/" + bookId + "/story/outline/story_frame.md";
            java.io.File file = new java.io.File(path);
            if (!file.exists()) {
                return newFixedLengthResponse(Response.Status.OK, "application/json",
                    "{\"endings\":[],\"activeEnding\":null}");
            }
            String content = new String(java.nio.file.Files.readAllBytes(file.toPath()), "UTF-8");
            // Extract endings from "## 终局方向 + 全书 Objective" section
            java.util.regex.Matcher m = java.util.regex.Pattern.compile(
                "## \\u7EC8\\u5C40\\u65B9\\u5411.*?\\+.*?\\u5168\\u4E66\\s+Objective\\s*\\n([\\s\\S]*?)(?=\\n##|$)"
            ).matcher(content);
            String desc = m.find() ? m.group(1).trim() : content.substring(Math.min(content.length() - 1, 0)).trim();
            if (desc.isEmpty()) {
                // Fallback: use last 500 chars of the file as description
                desc = content.length() > 500 ? content.substring(content.length() - 500) : content;
            }
            String json = "{\"endings\":[{\"id\":\"origin\",\"name\":\"原始结局\",\"description\":\""
                + desc.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\","
                + "\"type\":\"good\",\"chapters\":[],\"createdAt\":\"\"}],\"activeEnding\":null}";
            return newFixedLengthResponse(Response.Status.OK, "application/json", json);
        } catch (Exception e) {
            Logger.error("Endings origin read failed", e);
            return newFixedLengthResponse(Response.Status.OK, "application/json",
                "{\"endings\":[],\"activeEnding\":null}");
        }
    }

    /**
     * GeckoView eval polling — returns pending eval commands for the content script.
     * Called by content script via GET /__cap_eval every 100ms when Port is unavailable.
     */
    private Response handleEvalPoll() {
        try {
            String evals = bridge.getAndClearPendingHttpEvals();
            return newFixedLengthResponse(Response.Status.OK, "application/json", evals);
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "[]");
        }
    }

    /**
     * GeckoView eval result — receives eval execution results from the content script.
     * Called by content script via POST /__cap_eval_result after executing each eval command.
     */
    private Response handleEvalResult(IHTTPSession session) {
        try {
            // Read request body
            int contentLength = Integer.parseInt(session.getHeaders().getOrDefault("content-length", "0"));
            byte[] buffer = new byte[contentLength];
            java.io.InputStream is = session.getInputStream();
            int read = 0;
            while (read < contentLength) {
                int n = is.read(buffer, read, contentLength - read);
                if (n == -1) break;
                read += n;
            }
            String body = new String(buffer, "UTF-8");
            org.json.JSONObject json = new org.json.JSONObject(body);
            int id = json.optInt("id", 0);
            String value = json.isNull("value") ? null : json.getString("value");
            bridge.completeHttpEval(id, value);
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}");
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":false}");
        }
    }

    /**
     * Read runtime-status.json directly from Java filesystem.
     * Returns {ok:true, state:"running"} when the Node backend is alive.
     * This avoids the Node proxy entirely, so it works even when Node is starting up.
     */
    private Response handleHealthCheck() {
        try {
            java.io.File statusFile = new java.io.File(context.getFilesDir(), "InkOS Studio/runtime-status.json");
            if (statusFile.exists()) {
                String content = new String(java.nio.file.Files.readAllBytes(statusFile.toPath()), "UTF-8");
                // Quick parse: extract "state":"..." without org.json dependency
                String state = "unknown";
                int idx = content.indexOf("\"state\"");
                if (idx >= 0) {
                    int colon = content.indexOf(':', idx);
                    int start = content.indexOf('"', colon + 1);
                    int end = content.indexOf('"', start + 1);
                    if (start >= 0 && end > start) {
                        state = content.substring(start + 1, end);
                    }
                }
                String json = "{\"ok\":" + "running".equals(state) + ",\"state\":\"" + state + "\"}";
                return newFixedLengthResponse(Response.Status.OK, "application/json", json);
            }
        } catch (Exception e) {
            Logger.error("Health check failed", e);
        }
        return newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":false,\"state\":\"unknown\"}");
    }

    private Response proxyToNodeBackend(IHTTPSession session) throws Exception {
        String uri = session.getUri();
        String query = session.getQueryParameterString();
        String targetUrl = "http://127.0.0.1:4567" + uri;
        if (query != null && !query.trim().isEmpty()) {
            targetUrl += "?" + query;
        }

        boolean isSSE = uri != null && uri.equals("/api/v1/events");
        boolean isLongRunning = uri != null && (
            uri.endsWith("/agent")
            || uri.contains("/generate")
            || uri.contains("/translate")
            || uri.contains("/simulate-comments")
            || uri.contains("/audiobook-adapt")
            || uri.contains("/summary")
            || uri.contains("/detect-sensitive")
            || uri.contains("/analyze-dialogue")
            || uri.contains("/check-style-consistency")
            || uri.contains("/analyze-pacing")
            || uri.contains("/detect-conflicts")
            || uri.contains("/highlights")
            || uri.contains("/beats")
        );

        URL url = new URL(targetUrl);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(session.getMethod().name());
        conn.setUseCaches(false);
        conn.setConnectTimeout(5000);
        if (isSSE) {
            conn.setReadTimeout(0); // Essential for long-lived SSE connections
        } else if (isLongRunning) {
            conn.setReadTimeout(0); // LLM/image generation can take many minutes
        } else {
            conn.setReadTimeout(30000); // 30-second timeout for other API requests
        }

        // Forward request headers
        for (Map.Entry<String, String> entry : session.getHeaders().entrySet()) {
            String key = entry.getKey();
            String val = entry.getValue();
            if (key != null && !"host".equalsIgnoreCase(key) && !"content-length".equalsIgnoreCase(key)) {
                conn.setRequestProperty(key, val);
            }
        }

        // Forward request body if present
        String contentLengthStr = session.getHeaders().get("content-length");
        if (contentLengthStr != null) {
            try {
                long contentLength = Long.parseLong(contentLengthStr);
                if (contentLength > 0) {
                    conn.setDoOutput(true);
                    conn.setFixedLengthStreamingMode(contentLength);
                    // Read the full body into a buffer first to avoid partial reads
                    // from NanoHTTPD's stream handling.
                    byte[] bodyBytes = new byte[(int) contentLength];
                    InputStream reqInput = session.getInputStream();
                    int totalRead = 0;
                    while (totalRead < contentLength) {
                        int read = reqInput.read(bodyBytes, totalRead, (int) (contentLength - totalRead));
                        if (read == -1) break;
                        totalRead += read;
                    }
                    if (totalRead < contentLength) {
                        Logger.warn("proxyToNodeBackend: body truncated, expected " + contentLength + " got " + totalRead + " for " + uri);
                    }
                    java.io.OutputStream reqOutput = conn.getOutputStream();
                    reqOutput.write(bodyBytes, 0, totalRead);
                    reqOutput.flush();
                }
            } catch (NumberFormatException e) {
                Logger.error("Failed to parse content-length in proxy: " + contentLengthStr, e);
            }
        }

        int responseCode = conn.getResponseCode();
        String contentType = conn.getContentType();

        InputStream respStream;
        if (responseCode >= 400) {
            respStream = conn.getErrorStream();
        } else {
            respStream = conn.getInputStream();
        }

        if (respStream == null) {
            respStream = new java.io.ByteArrayInputStream(new byte[0]);
        }

        // For SSE streams, bypass NanoHTTPD's buffering by writing directly
        // to the socket output stream. NanoHTTPD's ChunkedOutputStream never
        // calls flush(), so small SSE events are held in the buffer until the
        // stream closes or the buffer fills (16 KB).
        if (isSSE) {
            return proxySSEDirect(session, conn, responseCode, contentType, respStream);
        }

        Response.IStatus status = toNanoStatus(responseCode);
        Response response = newFixedLengthResponse(status, contentType, respStream, -1);

        // Forward response headers
        for (Map.Entry<String, List<String>> entry : conn.getHeaderFields().entrySet()) {
            String key = entry.getKey();
            if (key != null && !"Content-Type".equalsIgnoreCase(key) && !"Content-Length".equalsIgnoreCase(key) && !"Transfer-Encoding".equalsIgnoreCase(key)) {
                for (String val : entry.getValue()) {
                    response.addHeader(key, val);
                }
            }
        }

        return response;
    }

    /**
     * Write an SSE response directly to the socket output stream, bypassing
     * NanoHTTPD's ChunkedOutputStream which never flushes small writes.
     * Finds the outputStream field by type (not name) to survive R8 obfuscation.
     */
    private Response proxySSEDirect(IHTTPSession session, HttpURLConnection conn,
            int responseCode, String contentType, InputStream respStream) {
        try {
            // Find the OutputStream field by type — survives R8 name obfuscation
            java.io.OutputStream socketOut = null;
            for (java.lang.reflect.Field field : session.getClass().getDeclaredFields()) {
                if (java.io.OutputStream.class.isAssignableFrom(field.getType())) {
                    field.setAccessible(true);
                    socketOut = (java.io.OutputStream) field.get(session);
                    break;
                }
            }
            if (socketOut == null) {
                throw new IllegalStateException("No OutputStream field found in " + session.getClass().getName());
            }

            // Send HTTP response headers
            String statusLine = "HTTP/1.1 " + responseCode + " OK\r\n";
            socketOut.write(statusLine.getBytes(StandardCharsets.UTF_8));
            socketOut.write(("Content-Type: " + (contentType != null ? contentType : "text/event-stream") + "\r\n").getBytes(StandardCharsets.UTF_8));
            socketOut.write("Cache-Control: no-cache\r\n".getBytes(StandardCharsets.UTF_8));
            socketOut.write("Connection: keep-alive\r\n".getBytes(StandardCharsets.UTF_8));
            socketOut.write("Transfer-Encoding: chunked\r\n".getBytes(StandardCharsets.UTF_8));
            socketOut.write("\r\n".getBytes(StandardCharsets.UTF_8));
            socketOut.flush();

            // Stream data in HTTP chunked encoding with immediate flush
            byte[] buffer = new byte[4096];
            int bytesRead;
            while ((bytesRead = respStream.read(buffer)) != -1) {
                // Write chunk: size in hex + CRLF + data + CRLF
                String chunkHeader = Integer.toHexString(bytesRead) + "\r\n";
                socketOut.write(chunkHeader.getBytes(StandardCharsets.UTF_8));
                socketOut.write(buffer, 0, bytesRead);
                socketOut.write("\r\n".getBytes(StandardCharsets.UTF_8));
                socketOut.flush(); // Force immediate delivery
            }
            // Terminal chunk
            socketOut.write("0\r\n\r\n".getBytes(StandardCharsets.UTF_8));
            socketOut.flush();

            respStream.close();
            conn.disconnect();
        } catch (Exception e) {
            Logger.error("SSE direct proxy failed, falling back to chunked response", e);
            try {
                respStream.close();
                conn.disconnect();
            } catch (Exception ignored) {}
        }

        // Return empty response — actual data was written above
        return newFixedLengthResponse(Response.Status.OK, "text/plain", "");
    }

    private static byte[] readAllBytes(java.io.InputStream is) throws java.io.IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = is.read(chunk)) != -1) {
            buffer.write(chunk, 0, n);
        }
        return buffer.toByteArray();
    }
}
