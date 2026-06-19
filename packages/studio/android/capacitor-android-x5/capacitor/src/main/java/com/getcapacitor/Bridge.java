package com.getcapacitor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContract;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.pm.PackageInfoCompat;
import androidx.fragment.app.Fragment;
import com.getcapacitor.android.R;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.cordova.MockCordovaInterfaceImpl;
import com.getcapacitor.cordova.MockCordovaWebViewImpl;
import com.getcapacitor.util.HostMask;
import com.getcapacitor.util.InternalUtils;
import com.getcapacitor.util.PermissionHelper;
import com.getcapacitor.util.WebColor;
import java.io.File;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.apache.cordova.ConfigXmlParser;
import org.apache.cordova.CordovaPreferences;
import org.apache.cordova.CordovaWebView;
import org.apache.cordova.PluginEntry;
import org.apache.cordova.PluginManager;
import org.json.JSONException;
import org.json.JSONObject;
import org.mozilla.geckoview.AllowOrDeny;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSession.NavigationDelegate;
import org.mozilla.geckoview.GeckoSession.ProgressDelegate;
import org.mozilla.geckoview.GeckoSession.ContentDelegate;
import org.mozilla.geckoview.GeckoSession.PermissionDelegate;
import org.mozilla.geckoview.GeckoSession.PromptDelegate;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoView;
import org.mozilla.geckoview.WebExtension;
import org.mozilla.geckoview.WebRequestError;

public class Bridge {

    private static final String PERMISSION_PREFS_NAME = "PluginPermStates";
    private static final String BUNDLE_LAST_PLUGIN_ID_KEY = "capacitorLastActivityPluginId";
    private static final String BUNDLE_LAST_PLUGIN_CALL_METHOD_NAME_KEY = "capacitorLastActivityPluginMethod";
    private static final String BUNDLE_PLUGIN_CALL_OPTIONS_SAVED_KEY = "capacitorLastPluginCallOptions";
    private static final String BUNDLE_PLUGIN_CALL_BUNDLE_KEY = "capacitorLastPluginCallBundle";
    private static final String LAST_BINARY_VERSION_CODE = "lastBinaryVersionCode";
    private static final String LAST_BINARY_VERSION_NAME = "lastBinaryVersionName";

    public static final String DEFAULT_WEB_ASSET_DIR = "public";
    public static final String CAPACITOR_HTTP_SCHEME = "http";
    public static final String CAPACITOR_HTTPS_SCHEME = "https";
    public static final String CAPACITOR_FILE_START = "/_capacitor_file_";
    public static final String CAPACITOR_CONTENT_START = "/_capacitor_content_";
    public static final String CAPACITOR_HTTP_INTERCEPTOR_START = "/_capacitor_http_interceptor_";
    public static final String CAPACITOR_HTTP_INTERCEPTOR_URL_PARAM = "u";
    public static final int DEFAULT_ANDROID_WEBVIEW_VERSION = 60;
    public static final int MINIMUM_ANDROID_WEBVIEW_VERSION = 55;
    public static final int DEFAULT_HUAWEI_WEBVIEW_VERSION = 10;
    public static final int MINIMUM_HUAWEI_WEBVIEW_VERSION = 10;

    private CapConfig config;
    private final AppCompatActivity context;
    private final Fragment fragment;
    private LocalAssetServer localServer;
    private String localUrl;
    private String appUrl;
    private String appUrlConfig;
    private HostMask appAllowNavigationMask;
    private Set<String> allowedOriginRules = new HashSet<>();
    private ArrayList<String> authorities = new ArrayList<>();
    private ArrayList<String> miscJSFileInjections = new ArrayList<>();
    private Boolean canInjectJS = true;

    private final GeckoView webView;
    private GeckoSession session;
    private GeckoRuntime runtime;
    public final MockCordovaInterfaceImpl cordovaInterface;
    private CordovaWebView cordovaWebView;
    private CordovaPreferences preferences;

    private App app;
    final MessageHandler msgHandler;
    private final HandlerThread handlerThread = new HandlerThread("CapacitorPlugins");
    private Handler taskHandler = null;
    private final List<Class<? extends Plugin>> initialPlugins;
    private final List<Plugin> pluginInstances;
    private Map<String, PluginHandle> plugins = new HashMap<>();
    private Map<String, PluginCall> savedCalls = new HashMap<>();
    private Map<String, LinkedList<String>> savedPermissionCallIds = new HashMap<>();
    private PluginCall pluginCallForLastActivity;
    private Uri intentUri;
    private List<WebViewListener> webViewListeners = new ArrayList<>();
    private RouteProcessor routeProcessor;
    private ServerPath serverPath;
    private JSInjector jsInjector;
    private String currentUrl;
    private WebExtension bridgeExtension;
    private WebExtension.Port bridgePort;
    private final Map<Integer, android.webkit.ValueCallback<String>> pendingEvalCallbacks = new HashMap<>();
    private int evalIdCounter = 0;
    private final java.util.List<Runnable> pendingEvalQueue = new java.util.ArrayList<>();

    // HTTP polling queue for eval commands when bridgePort is null (GeckoView fallback).
    // Content script polls GET /__cap_eval and posts results to POST /__cap_eval_result.
    private final java.util.concurrent.ConcurrentLinkedQueue<String> pendingHttpEvalQueue = new java.util.concurrent.ConcurrentLinkedQueue<>();

    // Tracks whether the WebExtension is registered; page load is deferred until then.
    // This prevents connectNative() from silently failing in the content script.
    private volatile boolean extensionReady = false;
    private String deferredLoadUrl = null;

    @Deprecated
    public Bridge(
        AppCompatActivity context,
        GeckoView webView,
        List<Class<? extends Plugin>> initialPlugins,
        MockCordovaInterfaceImpl cordovaInterface,
        PluginManager pluginManager,
        CordovaPreferences preferences,
        CapConfig config
    ) {
        this(context, null, null, webView, initialPlugins, new ArrayList<>(), cordovaInterface, pluginManager, preferences, config);
    }

    private Bridge(
        AppCompatActivity context,
        ServerPath serverPath,
        Fragment fragment,
        GeckoView webView,
        List<Class<? extends Plugin>> initialPlugins,
        List<Plugin> pluginInstances,
        MockCordovaInterfaceImpl cordovaInterface,
        PluginManager pluginManager,
        CordovaPreferences preferences,
        CapConfig config
    ) {
        this.app = new App();
        this.serverPath = serverPath;
        this.context = context;
        this.fragment = fragment;
        this.webView = webView;
        this.initialPlugins = initialPlugins;
        this.pluginInstances = pluginInstances;
        this.cordovaInterface = cordovaInterface;
        this.preferences = preferences;

        handlerThread.start();
        taskHandler = new Handler(handlerThread.getLooper());

        this.config = config != null ? config : CapConfig.loadDefault(getActivity());
        Logger.init(this.config);

        initRuntime();
        initWebView();
        this.setAllowedOriginRules();
        this.msgHandler = new MessageHandler(this, webView, session, pluginManager);

        Intent intent = context.getIntent();
        this.intentUri = intent.getData();
        this.registerAllPlugins();
        this.loadWebView();
    }

    private void initRuntime() {
        GeckoRuntimeSettings.Builder settingsBuilder = new GeckoRuntimeSettings.Builder()
            .javaScriptEnabled(true)
            .webManifest(true)
            .consoleOutput(true)
            .allowInsecureConnections(GeckoRuntimeSettings.ALLOW_ALL);

        if (this.config.isWebContentsDebuggingEnabled()) {
            settingsBuilder.remoteDebuggingEnabled(true).debugLogging(true);
        }

        String appendUserAgent = this.config.getAppendedUserAgentString();
        if (appendUserAgent != null) {
            String defaultUA = GeckoSession.getDefaultUserAgent();
            settingsBuilder.arguments(new String[]{"--user-agent=" + defaultUA + " " + appendUserAgent});
        }
        String overrideUserAgent = this.config.getOverriddenUserAgentString();
        if (overrideUserAgent != null) {
            settingsBuilder.arguments(new String[]{"--user-agent=" + overrideUserAgent});
        }

        runtime = GeckoRuntime.create(context, settingsBuilder.build());

        // Register built-in bridge WebExtension.
        // IMPORTANT: session.loadUri() is deferred until this accept() callback fires,
        // preventing a race where the page loads before the extension is registered and
        // browser.runtime.connectNative() silently fails in the content script.
        try {
            runtime
                .getWebExtensionController()
                .ensureBuiltIn("resource://android/assets/capacitor-bridge/", "capacitor-bridge@inkos.local")
                .accept(ext -> {
                    bridgeExtension = ext;
                    ext.setMessageDelegate(new WebExtension.MessageDelegate() {
                        @Override
                        public GeckoResult<Object> onMessage(String nativeApp, Object message, WebExtension.MessageSender sender) {
                            // Handle one-shot messages from sendNativeMessage() (GeckoView fallback
                            // when connectNative is unavailable). Routes to the same handler as Port messages.
                            try {
                                JSONObject msg;
                                if (message instanceof JSONObject) {
                                    msg = (JSONObject) message;
                                } else if (message instanceof String) {
                                    msg = new JSONObject((String) message);
                                } else {
                                    return GeckoResult.fromValue(null);
                                }

                                String iface = msg.optString("__iface", "");
                                if ("sysbars".equals(iface)) {
                                    PluginHandle sysBars = getPlugin("SystemBars");
                                    if (sysBars != null && sysBars.getInstance() instanceof com.getcapacitor.plugin.SystemBars) {
                                        String method = msg.optString("__method", "");
                                        if ("onDOMReady".equals(method)) {
                                            ((com.getcapacitor.plugin.SystemBars) sysBars.getInstance()).onDOMReadyFromBridge();
                                        }
                                    }
                                } else if ("cookies".equals(iface)) {
                                    PluginHandle cookiesPlugin = getPlugin("CapacitorCookies");
                                    if (cookiesPlugin != null && cookiesPlugin.getInstance() instanceof com.getcapacitor.plugin.CapacitorCookies) {
                                        String method = msg.optString("__method", "");
                                        if ("setCookie".equals(method)) {
                                            String domain = msg.optString("domain", "");
                                            String action = msg.optString("action", "");
                                            ((com.getcapacitor.plugin.CapacitorCookies) cookiesPlugin.getInstance()).setCookieFromBridge(domain, action);
                                        }
                                    }
                                } else if ("capacitor".equals(iface)) {
                                    String jsonStr = msg.optString("jsonStr", "");
                                    if (!jsonStr.isEmpty()) {
                                        msgHandler.postMessage(jsonStr);
                                    }
                                }
                            } catch (Exception e) {
                                Logger.error("Bridge one-shot message error", e);
                            }
                            return GeckoResult.fromValue(null);
                        }

                        @Override
                        public void onConnect(WebExtension.Port port) {
                            bridgePort = port;
                            // Flush any eval calls that were queued before the bridge connected
                            new android.os.Handler(context.getMainLooper()).post(() -> {
                                synchronized (pendingEvalQueue) {
                                    for (Runnable r : pendingEvalQueue) {
                                        r.run();
                                    }
                                    pendingEvalQueue.clear();
                                }
                            });
                            new android.os.Handler(context.getMainLooper()).post(() -> {
                                if (webView != null) {
                                    webView.requestApplyInsets();
                                }
                            });
                            port.setDelegate(new WebExtension.PortDelegate() {
                                @Override
                                public void onPortMessage(Object message, WebExtension.Port p) {
                                    try {
                                        JSONObject msg;
                                        if (message instanceof JSONObject) {
                                            msg = (JSONObject) message;
                                        } else if (message instanceof String) {
                                            msg = new JSONObject((String) message);
                                        } else {
                                            return;
                                        }

                                        if (msg.has("__evalResult")) {
                                            int id = msg.getInt("__evalResult");
                                            String value = msg.isNull("value") ? null : msg.getString("value");
                                            android.webkit.ValueCallback<String> cb;
                                            synchronized (pendingEvalCallbacks) {
                                                cb = pendingEvalCallbacks.remove(id);
                                            }
                                            if (cb != null) {
                                                cb.onReceiveValue(value);
                                            }
                                            return;
                                        }

                                        String iface = msg.optString("__iface", "");
                                        if ("sysbars".equals(iface)) {
                                            PluginHandle sysBars = getPlugin("SystemBars");
                                            if (sysBars != null && sysBars.getInstance() instanceof com.getcapacitor.plugin.SystemBars) {
                                                String method = msg.optString("__method", "");
                                                if ("onDOMReady".equals(method)) {
                                                    ((com.getcapacitor.plugin.SystemBars) sysBars.getInstance()).onDOMReadyFromBridge();
                                                }
                                            }
                                        } else if ("cookies".equals(iface)) {
                                            PluginHandle cookiesPlugin = getPlugin("CapacitorCookies");
                                            if (cookiesPlugin != null && cookiesPlugin.getInstance() instanceof com.getcapacitor.plugin.CapacitorCookies) {
                                                String method = msg.optString("__method", "");
                                                if ("setCookie".equals(method)) {
                                                    String domain = msg.optString("domain", "");
                                                    String action = msg.optString("action", "");
                                                    ((com.getcapacitor.plugin.CapacitorCookies) cookiesPlugin.getInstance()).setCookieFromBridge(domain, action);
                                                }
                                            }
                                        } else if ("capacitor".equals(iface)) {
                                            String jsonStr = msg.optString("jsonStr", "");
                                            if (!jsonStr.isEmpty()) {
                                                msgHandler.postMessage(jsonStr);
                                            }
                                        }
                                    } catch (Exception e) {
                                        Logger.error("Bridge Port message error", e);
                                    }
                                }

                                @Override
                                public void onDisconnect(WebExtension.Port p) {
                                    if (bridgePort == p) {
                                        bridgePort = null;
                                    }
                                }
                            });
                        }
                    }, "capacitor");

                    // Extension is now registered — safe to load the page.
                    // The content script will run and connectNative() will succeed.
                    extensionReady = true;
                    if (deferredLoadUrl != null) {
                        final String url = deferredLoadUrl;
                        deferredLoadUrl = null;
                        Logger.debug("WebExtension registered; loading deferred URL: " + url);
                        session.loadUri(url); // accept() fires on main thread, safe to call directly
                    }
                }, e -> {
                    // Extension registration failed — load page as fallback (bridge won't work)
                    Logger.error("Failed to register bridge WebExtension, loading page without bridge", e);
                    extensionReady = true;
                    if (deferredLoadUrl != null) {
                        final String url = deferredLoadUrl;
                        deferredLoadUrl = null;
                        session.loadUri(url);
                    }
                });
        } catch (Exception e) {
            Logger.error("Failed to register bridge WebExtension", e);
            // Synchronous failure: load page immediately as fallback
            extensionReady = true;
        }
    }

    private void setAllowedOriginRules() {
        String[] appAllowNavigationConfig = this.config.getAllowNavigation();
        String authority = this.getHost();
        String scheme = this.getScheme();
        allowedOriginRules.add(scheme + "://" + authority);
        if (this.getServerUrl() != null) {
            allowedOriginRules.add(this.getServerUrl());
        }
        if (appAllowNavigationConfig != null) {
            for (String allowNavigation : appAllowNavigationConfig) {
                if (!allowNavigation.startsWith("http")) {
                    allowedOriginRules.add("https://" + allowNavigation);
                } else {
                    allowedOriginRules.add(allowNavigation);
                }
            }
            authorities.addAll(Arrays.asList(appAllowNavigationConfig));
        }
        this.appAllowNavigationMask = HostMask.Parser.parse(appAllowNavigationConfig);
    }

    public App getApp() {
        return app;
    }

    private void loadWebView() {
        final boolean html5mode = this.config.isHTML5Mode();

        localServer = new LocalAssetServer(context, this, null, authorities, html5mode);
        localServer.hostAssets(DEFAULT_WEB_ASSET_DIR);

        // Build the app URL from the local server
        localUrl = "http://127.0.0.1:" + localServer.getPort();
        appUrl = localUrl;

        // Now that localUrl is known, create the JSInjector with correct WEBVIEW_SERVER_URL
        this.jsInjector = getJSInjector();
        localServer.setJsInjector(this.jsInjector);

        String appUrlPath = this.config.getStartPath();
        if (appUrlPath != null && !appUrlPath.trim().isEmpty()) {
            appUrl += appUrlPath;
        }

        Logger.debug("Loading app at " + appUrl);

        if (!isDeployDisabled() && !isNewBinary()) {
            SharedPreferences prefs = getContext().getSharedPreferences(
                com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
                Activity.MODE_PRIVATE
            );
            String path = prefs.getString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, null);
            if (path != null && !path.isEmpty() && new File(path).exists()) {
                setServerBasePath(path);
            }
        }

        if (serverPath != null) {
            if (serverPath.getType() == ServerPath.PathType.ASSET_PATH) {
                setServerAssetPath(serverPath.getPath());
            } else {
                setServerBasePath(serverPath.getPath());
            }
        } else {
            // Defer loading until WebExtension is registered (see initRuntime).
            // If the extension is already ready (e.g., on hot-reload), load immediately.
            if (extensionReady) {
                session.loadUri(appUrl);
            } else {
                deferredLoadUrl = appUrl;
                Logger.debug("Deferring page load until WebExtension is ready: " + appUrl);
            }
        }
    }

    @SuppressLint("WebViewApiAvailability")
    public boolean isMinimumWebViewInstalled() {
        return true;
    }

    public boolean launchIntent(Uri url) {
        for (Map.Entry<String, PluginHandle> entry : plugins.entrySet()) {
            Plugin plugin = entry.getValue().getInstance();
            if (plugin != null) {
                Boolean shouldOverrideLoad = plugin.shouldOverrideLoad(url);
                if (shouldOverrideLoad != null) {
                    return shouldOverrideLoad;
                }
            }
        }

        if (url.getScheme().equals("data") || url.getScheme().equals("blob")) {
            return false;
        }

        Uri appUri = Uri.parse(appUrl);
        if (
            !(appUri.getHost().equals(url.getHost()) && url.getScheme().equals(appUri.getScheme())) &&
            !appAllowNavigationMask.matches(url.getHost())
        ) {
            try {
                Intent openIntent = new Intent(Intent.ACTION_VIEW, url);
                getContext().startActivity(openIntent);
            } catch (ActivityNotFoundException e) {
                // TODO - trigger an event
            }
            return true;
        }
        return false;
    }

    private boolean isNewBinary() {
        String versionCode = "";
        String versionName = "";
        SharedPreferences prefs = getContext().getSharedPreferences(
            com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME,
            Activity.MODE_PRIVATE
        );
        String lastVersionCode = prefs.getString(LAST_BINARY_VERSION_CODE, null);
        String lastVersionName = prefs.getString(LAST_BINARY_VERSION_NAME, null);

        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pInfo = InternalUtils.getPackageInfo(pm, getContext().getPackageName());
            versionCode = Integer.toString((int) PackageInfoCompat.getLongVersionCode(pInfo));
            versionName = pInfo.versionName != null ? pInfo.versionName : "";
        } catch (Exception ex) {
            Logger.error("Unable to get package info", ex);
        }

        if (!versionCode.equals(lastVersionCode) || !versionName.equals(lastVersionName)) {
            SharedPreferences.Editor editor = prefs.edit();
            editor.putString(LAST_BINARY_VERSION_CODE, versionCode);
            editor.putString(LAST_BINARY_VERSION_NAME, versionName);
            editor.putString(com.getcapacitor.plugin.WebView.CAP_SERVER_PATH, "");
            editor.apply();
            return true;
        }
        return false;
    }

    public boolean isDeployDisabled() {
        return preferences.getBoolean("DisableDeploy", false);
    }

    public boolean shouldKeepRunning() {
        return preferences.getBoolean("KeepRunning", true);
    }

    public void handleAppUrlLoadError(Exception ex) {
        if (ex instanceof SocketTimeoutException) {
            Logger.error(
                "Unable to load app. Ensure the server is running at " + appUrl, ex
            );
        }
    }

    public boolean isDevMode() {
        return (getActivity().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    protected void setCordovaWebView(CordovaWebView cordovaWebView) {
        this.cordovaWebView = cordovaWebView;
    }

    public Context getContext() {
        return this.context;
    }

    public AppCompatActivity getActivity() {
        return this.context;
    }

    public Fragment getFragment() {
        return this.fragment;
    }

    public GeckoView getWebView() {
        return this.webView;
    }

    public GeckoSession getSession() {
        return this.session;
    }

    public GeckoRuntime getRuntime() {
        return this.runtime;
    }

    public Uri getIntentUri() {
        return intentUri;
    }

    public String getScheme() {
        return "http";
    }

    public String getHost() {
        return "127.0.0.1";
    }

    public String getServerUrl() {
        return this.config.getServerUrl();
    }

    public String getErrorUrl() {
        String errorPath = this.config.getErrorPath();
        if (errorPath != null && !errorPath.trim().isEmpty()) {
            return localUrl + "/" + errorPath;
        }
        return null;
    }

    public String getAppUrl() {
        return appUrl;
    }

    public CapConfig getConfig() {
        return this.config;
    }

    public void reset() {
        savedCalls = new HashMap<>();
        for (PluginHandle handle : this.plugins.values()) {
            handle.getInstance().removeAllListeners();
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void initWebView() {
        session = new GeckoSession();

        GeckoSessionSettings sessionSettings = session.getSettings();
        sessionSettings.setAllowJavascript(true);

        String backgroundColor = this.config.getBackgroundColor();
        try {
            if (backgroundColor != null) {
                webView.setBackgroundColor(WebColor.parseColor(backgroundColor));
            }
        } catch (IllegalArgumentException ex) {
            Logger.debug("WebView background color not applied");
        }

        if (config.isInitialFocus()) {
            webView.requestFocus();
        }

        session.setNavigationDelegate(new NavigationDelegate() {
            @Override
            public GeckoResult<AllowOrDeny> onLoadRequest(GeckoSession geckoSession, NavigationDelegate.LoadRequest request) {
                Uri url = Uri.parse(request.uri);
                if (launchIntent(url)) {
                    return GeckoResult.deny();
                }
                return GeckoResult.allow();
            }

            @Override
            public void onLocationChange(GeckoSession geckoSession, String url, List<PermissionDelegate.ContentPermission> perms, Boolean isFinal) {
                currentUrl = url;
            }

            @Override
            public void onCanGoBack(GeckoSession geckoSession, boolean canGoBack) {}

            @Override
            public void onCanGoForward(GeckoSession geckoSession, boolean canGoForward) {}

            @Override
            public GeckoResult<GeckoSession> onNewSession(GeckoSession geckoSession, String url) {
                return null;
            }

            @Override
            public GeckoResult<String> onLoadError(GeckoSession geckoSession, String url, WebRequestError error) {
                List<WebViewListener> listeners = webViewListeners;
                if (listeners != null) {
                    for (WebViewListener listener : listeners) {
                        listener.onReceivedError(webView);
                    }
                }
                String errorPath = getErrorUrl();
                if (errorPath != null) {
                    new Handler(context.getMainLooper()).post(() -> session.loadUri(errorPath));
                }
                return null;
            }
        });

        session.setProgressDelegate(new ProgressDelegate() {
            @Override
            public void onPageStart(GeckoSession geckoSession, String url) {
                Bridge.this.reset();
                List<WebViewListener> listeners = webViewListeners;
                if (listeners != null) {
                    for (WebViewListener listener : listeners) {
                        listener.onPageStarted(webView);
                    }
                }
            }

            @Override
            public void onPageStop(GeckoSession geckoSession, boolean success) {
                List<WebViewListener> listeners = webViewListeners;
                if (listeners != null) {
                    for (WebViewListener listener : listeners) {
                        listener.onPageLoaded(webView);
                    }
                }
            }

            @Override
            public void onProgressChange(GeckoSession geckoSession, int progress) {}

            @Override
            public void onSecurityChange(GeckoSession geckoSession, ProgressDelegate.SecurityInformation info) {}

            @Override
            public void onSessionStateChange(GeckoSession geckoSession, GeckoSession.SessionState state) {}
        });

        session.setContentDelegate(new ContentDelegate() {
            @Override
            public void onTitleChange(GeckoSession geckoSession, String title) {}

            @Override
            public void onFullScreen(GeckoSession geckoSession, boolean full) {}

            @Override
            public void onCloseRequest(GeckoSession geckoSession) {}

            @Override
            public void onCrash(GeckoSession geckoSession) {
                Logger.error("GeckoSession crashed");
            }

            @Override
            public void onKill(GeckoSession geckoSession) {
                Logger.error("GeckoSession killed");
            }

            @Override
            public void onFirstComposite(GeckoSession geckoSession) {}

            @Override
            public void onFirstContentfulPaint(GeckoSession geckoSession) {
                List<WebViewListener> listeners = webViewListeners;
                if (listeners != null) {
                    for (WebViewListener listener : listeners) {
                        listener.onPageCommitVisible(webView, currentUrl != null ? currentUrl : "");
                    }
                }
            }

            @Override
            public void onPreviewImage(GeckoSession geckoSession, String url) {}

            @Override
            public void onFocusRequest(GeckoSession geckoSession) {
                webView.requestFocus();
            }

            @Override
            public void onContextMenu(GeckoSession geckoSession, int screenX, int screenY, ContentDelegate.ContextElement element) {}

            @Override
            public void onExternalResponse(GeckoSession geckoSession, org.mozilla.geckoview.WebResponse response) {}

            @Override
            public void onMetaViewportFitChange(GeckoSession geckoSession, String viewportFit) {}

            @Override
            public void onPaintStatusReset(GeckoSession geckoSession) {}

            @Override
            public GeckoResult<org.mozilla.geckoview.SlowScriptResponse> onSlowScript(GeckoSession geckoSession, String scriptFileName) {
                return null;
            }

            @Override
            public void onShowDynamicToolbar(GeckoSession geckoSession) {}

            @Override
            public void onHideDynamicToolbar(GeckoSession geckoSession) {}

            @Override
            public void onCookieBannerDetected(GeckoSession geckoSession) {}

            @Override
            public void onCookieBannerHandled(GeckoSession geckoSession) {}

            @Override
            public void onWebAppManifest(GeckoSession geckoSession, JSONObject manifest) {}
        });

        session.open(runtime);
        webView.setSession(session);

        appUrlConfig = this.getServerUrl();
        String authority = this.getHost();
        authorities.add(authority);
    }

    private void registerAllPlugins() {
        this.registerPlugin(com.getcapacitor.plugin.CapacitorCookies.class);
        this.registerPlugin(com.getcapacitor.plugin.WebView.class);
        this.registerPlugin(com.getcapacitor.plugin.CapacitorHttp.class);
        this.registerPlugin(com.getcapacitor.plugin.SystemBars.class);

        for (Class<? extends Plugin> pluginClass : this.initialPlugins) {
            this.registerPlugin(pluginClass);
        }
        for (Plugin plugin : pluginInstances) {
            registerPluginInstance(plugin);
        }
    }

    public void registerPlugins(Class<? extends Plugin>[] pluginClasses) {
        for (Class<? extends Plugin> plugin : pluginClasses) {
            this.registerPlugin(plugin);
        }
    }

    public void registerPluginInstances(Plugin[] pluginInstances) {
        for (Plugin plugin : pluginInstances) {
            this.registerPluginInstance(plugin);
        }
    }

    @SuppressWarnings("deprecation")
    private String getLegacyPluginName(Class<? extends Plugin> pluginClass) {
        NativePlugin legacyPluginAnnotation = pluginClass.getAnnotation(NativePlugin.class);
        if (legacyPluginAnnotation == null) {
            Logger.error("Plugin doesn't have the @CapacitorPlugin annotation. Please add it");
            return null;
        }
        return legacyPluginAnnotation.name();
    }

    public void registerPlugin(Class<? extends Plugin> pluginClass) {
        String pluginId = pluginId(pluginClass);
        if (pluginId == null) return;
        try {
            this.plugins.put(pluginId, new PluginHandle(this, pluginClass));
        } catch (InvalidPluginException ex) {
            logInvalidPluginException(pluginClass);
        } catch (PluginLoadException ex) {
            logPluginLoadException(pluginClass, ex);
        }
    }

    public void registerPluginInstance(Plugin plugin) {
        Class<? extends Plugin> clazz = plugin.getClass();
        String pluginId = pluginId(clazz);
        if (pluginId == null) return;
        try {
            this.plugins.put(pluginId, new PluginHandle(this, plugin));
        } catch (InvalidPluginException ex) {
            logInvalidPluginException(clazz);
        }
    }

    private String pluginId(Class<? extends Plugin> clazz) {
        String pluginName = pluginName(clazz);
        String pluginId = clazz.getSimpleName();
        if (pluginName == null) return null;
        if (!pluginName.equals("")) {
            pluginId = pluginName;
        }
        Logger.debug("Registering plugin instance: " + pluginId);
        return pluginId;
    }

    private String pluginName(Class<? extends Plugin> clazz) {
        String pluginName;
        CapacitorPlugin pluginAnnotation = clazz.getAnnotation(CapacitorPlugin.class);
        if (pluginAnnotation == null) {
            pluginName = this.getLegacyPluginName(clazz);
        } else {
            pluginName = pluginAnnotation.name();
        }
        return pluginName;
    }

    private void logInvalidPluginException(Class<? extends Plugin> clazz) {
        Logger.error("NativePlugin " + clazz.getName() + " is invalid. Ensure the @CapacitorPlugin annotation exists.");
    }

    private void logPluginLoadException(Class<? extends Plugin> clazz, Exception ex) {
        Logger.error("NativePlugin " + clazz.getName() + " failed to load", ex);
    }

    public PluginHandle getPlugin(String pluginId) {
        return this.plugins.get(pluginId);
    }

    @Deprecated
    @SuppressWarnings("deprecation")
    public PluginHandle getPluginWithRequestCode(int requestCode) {
        for (PluginHandle handle : this.plugins.values()) {
            int[] requestCodes;
            CapacitorPlugin pluginAnnotation = handle.getPluginAnnotation();
            if (pluginAnnotation == null) {
                NativePlugin legacyPluginAnnotation = handle.getLegacyPluginAnnotation();
                if (legacyPluginAnnotation == null) continue;
                if (legacyPluginAnnotation.permissionRequestCode() == requestCode) return handle;
                requestCodes = legacyPluginAnnotation.requestCodes();
                for (int rc : requestCodes) { if (rc == requestCode) return handle; }
            } else {
                requestCodes = pluginAnnotation.requestCodes();
                for (int rc : requestCodes) { if (rc == requestCode) return handle; }
            }
        }
        return null;
    }

    public void callPluginMethod(String pluginId, final String methodName, final PluginCall call) {
        try {
            final PluginHandle plugin = this.getPlugin(pluginId);
            if (plugin == null) {
                Logger.error("unable to find plugin : " + pluginId);
                call.errorCallback("unable to find plugin : " + pluginId);
                return;
            }
            if (Logger.shouldLog()) {
                Logger.verbose(
                    "callback: " + call.getCallbackId() + ", pluginId: " + plugin.getId() + ", methodName: " + methodName
                );
            }
            Runnable currentThreadTask = () -> {
                try {
                    plugin.invoke(methodName, call);
                    if (call.isKeptAlive()) {
                        saveCall(call);
                    }
                } catch (PluginLoadException | InvalidPluginMethodException ex) {
                    Logger.error("Unable to execute plugin method", ex);
                } catch (Exception ex) {
                    Logger.error("Serious error executing plugin", ex);
                    throw new RuntimeException(ex);
                }
            };
            taskHandler.post(currentThreadTask);
        } catch (Exception ex) {
            Logger.error(Logger.tags("callPluginMethod"), "error : " + ex, null);
            call.errorCallback(ex.toString());
        }
    }

    /**
     * Evaluate JavaScript in the web page via the WebExtension Port channel.
     * Since GeckoView v152 has no session.evaluateJavaScript, we send __eval
     * to the content script which evaluates in page context and returns result.
     *
     * When bridgePort is unavailable (connectNative failed), eval commands are
     * queued for HTTP polling by the content script (GET /__cap_eval).
     */
    public void eval(final String js, final android.webkit.ValueCallback<String> callback) {
        Handler mainHandler = new Handler(context.getMainLooper());
        mainHandler.post(() -> {
            if (bridgePort != null) {
                try {
                    JSONObject msg = new JSONObject();
                    msg.put("__eval", js);
                    if (callback != null) {
                        int id;
                        synchronized (pendingEvalCallbacks) {
                            id = ++evalIdCounter;
                            pendingEvalCallbacks.put(id, callback);
                        }
                        msg.put("__id", id);
                    }
                    bridgePort.postMessage(msg);
                } catch (Exception e) {
                    Logger.error("eval via port error", e);
                    if (callback != null) callback.onReceiveValue(null);
                }
            } else {
                // Port unavailable — queue for HTTP polling by content script.
                int id = 0;
                if (callback != null) {
                    synchronized (pendingEvalCallbacks) {
                        id = ++evalIdCounter;
                        pendingEvalCallbacks.put(id, callback);
                    }
                }
                try {
                    JSONObject entry = new JSONObject();
                    entry.put("__eval", js);
                    entry.put("__id", id);
                    pendingHttpEvalQueue.add(entry.toString());
                } catch (Exception e) {
                    Logger.error("eval http queue error", e);
                    if (callback != null) callback.onReceiveValue(null);
                }
            }
        });
    }

    /**
     * Called by LocalAssetServer (GET /__cap_eval) to drain pending eval commands
     * for HTTP polling by the content script.
     */
    public String getAndClearPendingHttpEvals() {
        java.util.List<String> items = new java.util.ArrayList<>();
        String item;
        while ((item = pendingHttpEvalQueue.poll()) != null) {
            items.add(item);
        }
        try {
            org.json.JSONArray arr = new org.json.JSONArray();
            for (String s : items) {
                arr.put(new org.json.JSONObject(s));
            }
            return arr.toString();
        } catch (Exception e) {
            return "[]";
        }
    }

    /**
     * Called by LocalAssetServer (POST /__cap_eval_result) when the content script
     * returns an eval result via HTTP polling.
     */
    public void completeHttpEval(int id, String value) {
        if (id <= 0) return;
        android.webkit.ValueCallback<String> cb;
        synchronized (pendingEvalCallbacks) {
            cb = pendingEvalCallbacks.remove(id);
        }
        if (cb != null) {
            cb.onReceiveValue(value);
        }
    }

    public void logToJs(final String message, final String level) {
        eval("window.Capacitor.logJs(\"" + message + "\", \"" + level + "\")", null);
    }

    public void logToJs(final String message) {
        logToJs(message, "log");
    }

    public void triggerJSEvent(final String eventName, final String target) {
        eval("window.Capacitor.triggerEvent(\"" + eventName + "\", \"" + target + "\")", null);
    }

    public void triggerJSEvent(final String eventName, final String target, final String data) {
        eval("window.Capacitor.triggerEvent(\"" + eventName + "\", \"" + target + "\", " + data + ")", null);
    }

    public void triggerWindowJSEvent(final String eventName) {
        this.triggerJSEvent(eventName, "window");
    }

    public void triggerWindowJSEvent(final String eventName, final String data) {
        this.triggerJSEvent(eventName, "window", data);
    }

    public void triggerDocumentJSEvent(final String eventName) {
        this.triggerJSEvent(eventName, "document");
    }

    public void triggerDocumentJSEvent(final String eventName, final String data) {
        this.triggerJSEvent(eventName, "document", data);
    }

    public void execute(Runnable runnable) {
        taskHandler.post(runnable);
    }

    public void executeOnMainThread(Runnable runnable) {
        Handler mainHandler = new Handler(context.getMainLooper());
        mainHandler.post(runnable);
    }

    public void saveCall(PluginCall call) {
        this.savedCalls.put(call.getCallbackId(), call);
    }

    public PluginCall getSavedCall(String callbackId) {
        if (callbackId == null) return null;
        return this.savedCalls.get(callbackId);
    }

    PluginCall getPluginCallForLastActivity() {
        PluginCall call = this.pluginCallForLastActivity;
        this.pluginCallForLastActivity = null;
        return call;
    }

    void setPluginCallForLastActivity(PluginCall call) {
        this.pluginCallForLastActivity = call;
    }

    public void releaseCall(PluginCall call) {
        releaseCall(call.getCallbackId());
    }

    public void releaseCall(String callbackId) {
        this.savedCalls.remove(callbackId);
    }

    protected PluginCall getPermissionCall(String pluginId) {
        LinkedList<String> permissionCallIds = this.savedPermissionCallIds.get(pluginId);
        String savedCallId = null;
        if (permissionCallIds != null) {
            savedCallId = permissionCallIds.poll();
        }
        return getSavedCall(savedCallId);
    }

    protected void savePermissionCall(PluginCall call) {
        if (call != null) {
            if (!savedPermissionCallIds.containsKey(call.getPluginId())) {
                savedPermissionCallIds.put(call.getPluginId(), new LinkedList<>());
            }
            savedPermissionCallIds.get(call.getPluginId()).add(call.getCallbackId());
            saveCall(call);
        }
    }

    public <I, O> ActivityResultLauncher<I> registerForActivityResult(
        @NonNull final ActivityResultContract<I, O> contract,
        @NonNull final ActivityResultCallback<O> callback
    ) {
        if (fragment != null) {
            return fragment.registerForActivityResult(contract, callback);
        } else {
            return context.registerForActivityResult(contract, callback);
        }
    }

    private JSInjector getJSInjector() {
        try {
            String globalJS = JSExport.getGlobalJS(context, config.isLoggingEnabled(), isDevMode());
            String bridgeJS = JSExport.getBridgeJS(context);
            String pluginJS = JSExport.getPluginJS(plugins.values());
            String cordovaJS = JSExport.getCordovaJS(context);
            String cordovaPluginsJS = JSExport.getCordovaPluginJS(context);
            String cordovaPluginsFileJS = JSExport.getCordovaPluginsFileJS(context);
            String localUrlJS = "window.WEBVIEW_SERVER_URL = '" + localUrl + "';";
            String miscJS = JSExport.getMiscFileJS(miscJSFileInjections, context);
            miscJSFileInjections = new ArrayList<>();
            canInjectJS = false;
            return new JSInjector(globalJS, bridgeJS, pluginJS, cordovaJS, cordovaPluginsJS, cordovaPluginsFileJS, localUrlJS, miscJS);
        } catch (Exception ex) {
            Logger.error("Unable to export Capacitor JS. App will not function!", ex);
        }
        return null;
    }

    public void injectScriptBeforeLoad(String path) {
        if (canInjectJS) {
            miscJSFileInjections.add(path);
        }
    }

    public void restoreInstanceState(Bundle savedInstanceState) {
        String lastPluginId = savedInstanceState.getString(BUNDLE_LAST_PLUGIN_ID_KEY);
        String lastPluginCallMethod = savedInstanceState.getString(BUNDLE_LAST_PLUGIN_CALL_METHOD_NAME_KEY);
        String lastOptionsJson = savedInstanceState.getString(BUNDLE_PLUGIN_CALL_OPTIONS_SAVED_KEY);
        if (lastPluginId != null) {
            if (lastOptionsJson != null) {
                try {
                    JSObject options = new JSObject(lastOptionsJson);
                    pluginCallForLastActivity = new PluginCall(
                        msgHandler, lastPluginId, PluginCall.CALLBACK_ID_DANGLING, lastPluginCallMethod, options
                    );
                } catch (JSONException ex) {
                    Logger.error("Unable to restore plugin call", ex);
                }
            }
            Bundle bundleData = savedInstanceState.getBundle(BUNDLE_PLUGIN_CALL_BUNDLE_KEY);
            PluginHandle lastPlugin = getPlugin(lastPluginId);
            if (bundleData != null && lastPlugin != null) {
                lastPlugin.getInstance().restoreState(bundleData);
            } else {
                Logger.error("Unable to restore last plugin call");
            }
        }
    }

    public void saveInstanceState(Bundle outState) {
        Logger.debug("Saving instance state!");
        if (pluginCallForLastActivity != null) {
            PluginCall call = pluginCallForLastActivity;
            PluginHandle handle = getPlugin(call.getPluginId());
            if (handle != null) {
                Bundle bundle = handle.getInstance().saveInstanceState();
                if (bundle != null) {
                    outState.putString(BUNDLE_LAST_PLUGIN_ID_KEY, call.getPluginId());
                    outState.putString(BUNDLE_LAST_PLUGIN_CALL_METHOD_NAME_KEY, call.getMethodName());
                    outState.putString(BUNDLE_PLUGIN_CALL_OPTIONS_SAVED_KEY, call.getData().toString());
                    outState.putBundle(BUNDLE_PLUGIN_CALL_BUNDLE_KEY, bundle);
                }
            }
        }
    }

    @Deprecated
    @SuppressWarnings("deprecation")
    public void startActivityForPluginWithResult(PluginCall call, Intent intent, int requestCode) {
        Logger.debug("Starting activity for result");
        pluginCallForLastActivity = call;
        getActivity().startActivityForResult(intent, requestCode);
    }

    @SuppressWarnings("deprecation")
    boolean onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        PluginHandle plugin = getPluginWithRequestCode(requestCode);
        if (plugin == null) {
            boolean permissionHandled = false;
            try {
                permissionHandled = cordovaInterface.handlePermissionResult(requestCode, permissions, grantResults);
            } catch (JSONException e) {
                Logger.debug("Error on Cordova plugin permissions " + e.getMessage());
            }
            return permissionHandled;
        }
        if (plugin.getPluginAnnotation() == null) {
            plugin.getInstance().handleRequestPermissionsResult(requestCode, permissions, grantResults);
            return true;
        }
        return false;
    }

    protected boolean validatePermissions(Plugin plugin, PluginCall savedCall, Map<String, Boolean> permissions) {
        SharedPreferences prefs = getContext().getSharedPreferences(PERMISSION_PREFS_NAME, Activity.MODE_PRIVATE);
        for (Map.Entry<String, Boolean> permission : permissions.entrySet()) {
            String permString = permission.getKey();
            boolean isGranted = permission.getValue();
            if (isGranted) {
                String state = prefs.getString(permString, null);
                if (state != null) {
                    SharedPreferences.Editor editor = prefs.edit();
                    editor.remove(permString);
                    editor.apply();
                }
            } else {
                SharedPreferences.Editor editor = prefs.edit();
                if (ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), permString)) {
                    editor.putString(permString, PermissionState.PROMPT_WITH_RATIONALE.toString());
                } else {
                    editor.putString(permString, PermissionState.DENIED.toString());
                }
                editor.apply();
            }
        }
        String[] permStrings = permissions.keySet().toArray(new String[0]);
        if (!PermissionHelper.hasDefinedPermissions(getContext(), permStrings)) {
            StringBuilder builder = new StringBuilder();
            builder.append("Missing the following permissions in AndroidManifest.xml:\n");
            String[] missing = PermissionHelper.getUndefinedPermissions(getContext(), permStrings);
            for (String perm : missing) builder.append(perm + "\n");
            savedCall.reject(builder.toString());
            return false;
        }
        return true;
    }

    protected Map<String, PermissionState> getPermissionStates(Plugin plugin) {
        Map<String, PermissionState> permissionsResults = new HashMap<>();
        CapacitorPlugin annotation = plugin.getPluginHandle().getPluginAnnotation();
        for (Permission perm : annotation.permissions()) {
            if (perm.strings().length == 0 || (perm.strings().length == 1 && perm.strings()[0].isEmpty())) {
                String key = perm.alias();
                if (!key.isEmpty()) {
                    PermissionState existingResult = permissionsResults.get(key);
                    if (existingResult == null) {
                        permissionsResults.put(key, PermissionState.GRANTED);
                    }
                }
            } else {
                for (String permString : perm.strings()) {
                    String key = perm.alias().isEmpty() ? permString : perm.alias();
                    PermissionState permissionStatus;
                    if (ActivityCompat.checkSelfPermission(this.getContext(), permString) == PackageManager.PERMISSION_GRANTED) {
                        permissionStatus = PermissionState.GRANTED;
                    } else {
                        permissionStatus = PermissionState.PROMPT;
                        SharedPreferences prefs = getContext().getSharedPreferences(PERMISSION_PREFS_NAME, Activity.MODE_PRIVATE);
                        String state = prefs.getString(permString, null);
                        if (state != null) {
                            permissionStatus = PermissionState.byState(state);
                        }
                    }
                    PermissionState existingResult = permissionsResults.get(key);
                    if (existingResult == null || existingResult == PermissionState.GRANTED) {
                        permissionsResults.put(key, permissionStatus);
                    }
                }
            }
        }
        return permissionsResults;
    }

    @SuppressWarnings("deprecation")
    boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        PluginHandle plugin = getPluginWithRequestCode(requestCode);
        if (plugin == null || plugin.getInstance() == null) {
            try {
                return cordovaInterface.onActivityResult(requestCode, resultCode, data);
            } catch (Exception e) {
                return false;
            }
        }
        PluginCall lastCall = plugin.getInstance().getSavedCall();
        if (lastCall == null && pluginCallForLastActivity != null) {
            plugin.getInstance().saveCall(pluginCallForLastActivity);
        }
        plugin.getInstance().handleOnActivityResult(requestCode, resultCode, data);
        pluginCallForLastActivity = null;
        return true;
    }

    public void onNewIntent(Intent intent) {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnNewIntent(intent);
        }
        if (cordovaWebView != null) {
            cordovaWebView.onNewIntent(intent);
        }
    }

    public void onConfigurationChanged(Configuration newConfig) {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnConfigurationChanged(newConfig);
        }
    }

    public void onRestart() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnRestart();
        }
    }

    public void onStart() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnStart();
        }
        if (cordovaWebView != null) {
            cordovaWebView.handleStart();
        }
    }

    public void onResume() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnResume();
        }
        if (cordovaWebView != null) {
            cordovaWebView.handleResume(this.shouldKeepRunning());
        }
    }

    public void onPause() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnPause();
        }
        if (cordovaWebView != null) {
            boolean keepRunning = this.shouldKeepRunning() || cordovaInterface.getActivityResultCallback() != null;
            cordovaWebView.handlePause(keepRunning);
        }
    }

    public void onStop() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnStop();
        }
        if (cordovaWebView != null) {
            cordovaWebView.handleStop();
        }
    }

    public void onDestroy() {
        for (PluginHandle plugin : plugins.values()) {
            plugin.getInstance().handleOnDestroy();
        }
        handlerThread.quitSafely();
        if (cordovaWebView != null) {
            cordovaWebView.handleDestroy();
        }
        if (localServer != null) {
            localServer.stop();
        }
    }

    public void onDetachedFromWindow() {
        if (session != null) {
            session.close();
        }
        webView.releaseSession();
    }

    public String getServerBasePath() {
        return this.localServer != null ? this.localServer.getBasePath() : null;
    }

    public void setServerBasePath(String path) {
        if (localServer != null) {
            localServer.hostFiles(path);
        }
        webView.post(() -> {
            if (extensionReady) {
                session.loadUri(appUrl);
            } else {
                deferredLoadUrl = appUrl;
                Logger.debug("Deferring page load from setServerBasePath until WebExtension is ready: " + appUrl);
            }
        });
    }

    public void setServerAssetPath(String path) {
        if (localServer != null) {
            localServer.hostAssets(path);
        }
        webView.post(() -> {
            if (extensionReady) {
                session.loadUri(appUrl);
            } else {
                deferredLoadUrl = appUrl;
                Logger.debug("Deferring page load from setServerAssetPath until WebExtension is ready: " + appUrl);
            }
        });
    }

    public void reload() {
        webView.post(() -> {
            if (extensionReady) {
                session.loadUri(appUrl);
            } else {
                deferredLoadUrl = appUrl;
                Logger.debug("Deferring page load from reload until WebExtension is ready: " + appUrl);
            }
        });
    }

    public String getLocalUrl() {
        return localUrl;
    }

    public LocalAssetServer getLocalServer() {
        return localServer;
    }

    public HostMask getAppAllowNavigationMask() {
        return appAllowNavigationMask;
    }

    public Set<String> getAllowedOriginRules() {
        return allowedOriginRules;
    }

    public void addWebViewListener(WebViewListener webViewListener) {
        webViewListeners.add(webViewListener);
    }

    public void removeWebViewListener(WebViewListener webViewListener) {
        webViewListeners.remove(webViewListener);
    }

    RouteProcessor getRouteProcessor() {
        return routeProcessor;
    }

    void setRouteProcessor(RouteProcessor routeProcessor) {
        this.routeProcessor = routeProcessor;
    }

    ServerPath getServerPath() {
        return serverPath;
    }

    List<WebViewListener> getWebViewListeners() {
        return webViewListeners;
    }

    void setWebViewListeners(List<WebViewListener> webViewListeners) {
        this.webViewListeners = webViewListeners;
    }

    public static class Builder {
        private Bundle instanceState = null;
        private CapConfig config = null;
        private List<Class<? extends Plugin>> plugins = new ArrayList<>();
        private List<Plugin> pluginInstances = new ArrayList<>();
        private AppCompatActivity activity;
        private Fragment fragment;
        private RouteProcessor routeProcessor;
        private final List<WebViewListener> webViewListeners = new ArrayList<>();
        private ServerPath serverPath;

        public Builder(AppCompatActivity activity) {
            this.activity = activity;
        }

        public Builder(Fragment fragment) {
            this.activity = (AppCompatActivity) fragment.getActivity();
            this.fragment = fragment;
        }

        public Builder setInstanceState(Bundle instanceState) {
            this.instanceState = instanceState;
            return this;
        }

        public Builder setConfig(CapConfig config) {
            this.config = config;
            return this;
        }

        public Builder setPlugins(List<Class<? extends Plugin>> plugins) {
            this.plugins = plugins;
            return this;
        }

        public Builder addPlugin(Class<? extends Plugin> plugin) {
            this.plugins.add(plugin);
            return this;
        }

        public Builder addPlugins(List<Class<? extends Plugin>> plugins) {
            for (Class<? extends Plugin> cls : plugins) {
                this.addPlugin(cls);
            }
            return this;
        }

        public Builder addPluginInstance(Plugin plugin) {
            this.pluginInstances.add(plugin);
            return this;
        }

        public Builder addPluginInstances(List<Plugin> pluginInstances) {
            this.pluginInstances.addAll(pluginInstances);
            return this;
        }

        public Builder addWebViewListener(WebViewListener webViewListener) {
            webViewListeners.add(webViewListener);
            return this;
        }

        public Builder addWebViewListeners(List<WebViewListener> webViewListeners) {
            for (WebViewListener listener : webViewListeners) {
                this.addWebViewListener(listener);
            }
            return this;
        }

        public Builder setRouteProcessor(RouteProcessor routeProcessor) {
            this.routeProcessor = routeProcessor;
            return this;
        }

        public Builder setServerPath(ServerPath serverPath) {
            this.serverPath = serverPath;
            return this;
        }

        public Bridge create() {
            ConfigXmlParser parser = new ConfigXmlParser();
            parser.parse(activity.getApplicationContext());
            CordovaPreferences preferences = parser.getPreferences();
            preferences.setPreferencesBundle(activity.getIntent().getExtras());
            List<PluginEntry> pluginEntries = parser.getPluginEntries();

            MockCordovaInterfaceImpl cordovaInterface = new MockCordovaInterfaceImpl(activity);
            if (instanceState != null) {
                cordovaInterface.restoreInstanceState(instanceState);
            }

            GeckoView webView = this.fragment != null ? (GeckoView) fragment.getView().findViewById(R.id.webview) : (GeckoView) activity.findViewById(R.id.webview);
            MockCordovaWebViewImpl mockWebView = new MockCordovaWebViewImpl(activity.getApplicationContext());
            mockWebView.init(cordovaInterface, pluginEntries, preferences, webView, null);
            PluginManager pluginManager = mockWebView.getPluginManager();
            cordovaInterface.onCordovaInit(pluginManager);

            Bridge bridge = new Bridge(
                activity,
                serverPath,
                fragment,
                webView,
                plugins,
                pluginInstances,
                cordovaInterface,
                pluginManager,
                preferences,
                config
            );

            bridge.setCordovaWebView(mockWebView);
            bridge.setWebViewListeners(webViewListeners);
            bridge.setRouteProcessor(routeProcessor);

            if (instanceState != null) {
                bridge.restoreInstanceState(instanceState);
            }

            return bridge;
        }
    }
}
