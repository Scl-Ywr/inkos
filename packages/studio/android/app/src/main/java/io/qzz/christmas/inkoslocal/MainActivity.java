package io.qzz.christmas.inkoslocal;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "InkOSNode";
    private static final long EMBEDDED_NODE_START_DELAY_MS = 1500L;
    private static final long BACKGROUND_CACHE_RELEASE_DELAY_MS = 15L * 60L * 1000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable backgroundCacheRelease = this::notifyBackgroundIdle;
    private final Runnable embeddedNodeStart = this::startEmbeddedNodeService;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(InkOSRuntimePlugin.class);
        registerPlugin(FilePickerPlugin.class);
        super.onCreate(savedInstanceState);
        requestNotificationPermissionIfNeeded();
        requestAllFilesAccessIfNeeded();
        scheduleEmbeddedNodeServiceStart();
    }

    @Override
    public void onResume() {
        super.onResume();
        mainHandler.removeCallbacks(backgroundCacheRelease);
        scheduleEmbeddedNodeServiceStart();
    }

    @Override
    public void onStop() {
        super.onStop();
        mainHandler.removeCallbacks(backgroundCacheRelease);
        mainHandler.postDelayed(backgroundCacheRelease, BACKGROUND_CACHE_RELEASE_DELAY_MS);
    }

    private void scheduleEmbeddedNodeServiceStart() {
        mainHandler.removeCallbacks(embeddedNodeStart);
        mainHandler.postDelayed(embeddedNodeStart, EMBEDDED_NODE_START_DELAY_MS);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 4567);
        }
    }

    private void requestAllFilesAccessIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()) {
            return;
        }
        if (getPreferences(MODE_PRIVATE).getBoolean("requestedAllFilesAccess", false)) {
            return;
        }
        getPreferences(MODE_PRIVATE).edit().putBoolean("requestedAllFilesAccess", true).apply();
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception error) {
            Log.w(TAG, "Unable to open app all-files access settings; trying global settings", error);
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            } catch (Exception fallbackError) {
                Log.e(TAG, "Unable to open all-files access settings", fallbackError);
            }
        }
    }

    private void startEmbeddedNodeService() {
        Intent intent = new Intent(this, EmbeddedNodeService.class);
        try {
            startService(intent);
        } catch (Exception error) {
            Log.w(TAG, "Unable to start EmbeddedNodeService with startService; trying foreground service", error);
            try {
                androidx.core.content.ContextCompat.startForegroundService(this, intent);
            } catch (Exception foregroundError) {
                Log.e(TAG, "Unable to start EmbeddedNodeService from MainActivity", foregroundError);
            }
        }
    }

    private void notifyBackgroundIdle() {
        new Thread(() -> {
            HttpURLConnection connection = null;
            try {
                URL url = new URL("http://127.0.0.1:4567/api/v1/runtime/background-idle");
                connection = (HttpURLConnection) url.openConnection();
                connection.setRequestMethod("POST");
                connection.setConnectTimeout(800);
                connection.setReadTimeout(1200);
                connection.setDoOutput(true);
                connection.getOutputStream().write(new byte[0]);
                int code = connection.getResponseCode();
                Log.i(TAG, "Background cache release returned HTTP " + code);
            } catch (Exception error) {
                Log.w(TAG, "Unable to notify Node backend about background idle", error);
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }, "inkos-background-cache-release").start();
    }
}
