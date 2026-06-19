package com.getcapacitor.cordova;

import org.apache.cordova.ICordovaCookieManager;

/**
 * Best-effort cookie manager for GeckoView.
 * GeckoView has no global CookieManager equivalent; this provides basic functionality.
 */
class CapacitorCordovaCookieManager implements ICordovaCookieManager {

    private boolean cookiesEnabled = true;

    public CapacitorCordovaCookieManager() {
        // No WebView reference needed for GeckoView; cookie management is session-scoped
    }

    @Override
    public void setCookiesEnabled(boolean accept) {
        cookiesEnabled = accept;
    }

    @Override
    public void setCookie(final String url, final String value) {
        // GeckoView does not expose a programmatic CookieManager.
        // Cookies are set automatically by the HTTP engine for same-origin requests.
    }

    @Override
    public String getCookie(final String url) {
        // Cannot retrieve cookies programmatically in GeckoView without WebExtension
        return null;
    }

    @Override
    public void clearCookies() {
        // Use GeckoRuntime.getStorageController().clearData(StorageController.CLEAR_COOKIES) if needed
    }

    @Override
    public void flush() {
        // No-op for GeckoView; cookies persist automatically
    }
}
