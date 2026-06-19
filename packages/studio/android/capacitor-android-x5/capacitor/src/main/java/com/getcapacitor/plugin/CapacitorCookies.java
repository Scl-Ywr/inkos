package com.getcapacitor.plugin;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginConfig;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.UnsupportedEncodingException;
import java.net.CookieHandler;
import java.net.HttpCookie;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin
public class CapacitorCookies extends Plugin {

    CapacitorCookieManager cookieManager;

    @Override
    public void load() {
        // No addJavascriptInterface — CapacitorCookiesAndroidInterface is injected by content script
        this.cookieManager = new CapacitorCookieManager(null, java.net.CookiePolicy.ACCEPT_ALL, this.bridge);
        this.cookieManager.removeSessionCookies();
        CookieHandler.setDefault(this.cookieManager);
        super.load();
    }

    @Override
    protected void handleOnDestroy() {
        super.handleOnDestroy();
        this.cookieManager.removeSessionCookies();
    }

    /**
     * Called by the bridge when content script proxies CapacitorCookiesAndroidInterface.setCookie.
     */
    public void setCookieFromBridge(String domain, String action) {
        cookieManager.setCookie(domain, action);
    }

    /**
     * Called by content script proxy. Returns true if cookies plugin is enabled.
     * Note: returns false from content script default; actual value checked via native.
     */
    public boolean isEnabled() {
        PluginConfig pluginConfig = getBridge().getConfig().getPluginConfiguration("CapacitorCookies");
        return pluginConfig.getBoolean("enabled", false);
    }

    public void setCookie(String domain, String action) {
        cookieManager.setCookie(domain, action);
    }

    @PluginMethod
    public void getCookies(PluginCall call) {
        this.bridge.eval("document.cookie", (value) -> {
            String cookies = value.substring(1, value.length() - 1);
            String[] cookieArray = cookies.split(";");

            JSObject cookieMap = new JSObject();

            for (String cookie : cookieArray) {
                if (cookie.length() > 0) {
                    String[] keyValue = cookie.split("=", 2);

                    if (keyValue.length == 2) {
                        String key = keyValue[0].trim();
                        String val = keyValue[1].trim();
                        try {
                            key = URLDecoder.decode(keyValue[0].trim(), StandardCharsets.UTF_8.name());
                            val = URLDecoder.decode(keyValue[1].trim(), StandardCharsets.UTF_8.name());
                        } catch (UnsupportedEncodingException ignored) {}

                        cookieMap.put(key, val);
                    }
                }
            }

            call.resolve(cookieMap);
        });
    }

    @PluginMethod
    public void setCookie(PluginCall call) {
        String key = call.getString("key");
        if (null == key) {
            call.reject("Must provide key");
        }
        String value = call.getString("value");
        if (null == value) {
            call.reject("Must provide value");
        }
        String url = call.getString("url");
        String expires = call.getString("expires", "");
        String path = call.getString("path", "/");
        cookieManager.setCookie(url, key, value, expires, path);
        call.resolve();
    }

    @PluginMethod
    public void deleteCookie(PluginCall call) {
        String key = call.getString("key");
        if (null == key) {
            call.reject("Must provide key");
        }
        String url = call.getString("url");
        cookieManager.setCookie(url, key + "=; Expires=Wed, 31 Dec 2000 23:59:59 GMT");
        call.resolve();
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        String url = call.getString("url");
        HttpCookie[] cookies = cookieManager.getCookies(url);
        for (HttpCookie cookie : cookies) {
            cookieManager.setCookie(url, cookie.getName() + "=; Expires=Wed, 31 Dec 2000 23:59:59 GMT");
        }
        call.resolve();
    }

    @PluginMethod
    public void clearAllCookies(PluginCall call) {
        cookieManager.removeAllCookies();
        call.resolve();
    }
}
