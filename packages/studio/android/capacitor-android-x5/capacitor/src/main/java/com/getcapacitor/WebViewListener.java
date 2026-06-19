package com.getcapacitor;

import org.mozilla.geckoview.GeckoView;

public abstract class WebViewListener {

    public void onPageLoaded(GeckoView webView) {}

    public void onReceivedError(GeckoView webView) {}

    public void onReceivedHttpError(GeckoView webView) {}

    public void onPageStarted(GeckoView webView) {}

    public void onPageCommitVisible(GeckoView view, String url) {}
}
