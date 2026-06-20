package io.qzz.christmas.inkoslocal;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.FileProvider;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;

@CapacitorPlugin(name = "InkOSRuntime")
public class InkOSRuntimePlugin extends Plugin {
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    private volatile boolean downloadCancelled = false;
    private volatile HttpURLConnection activeDownloadConnection = null;
    private volatile Thread downloadThread = null;

    @PluginMethod
    public void restartNode(PluginCall call) {
        Intent intent = new Intent(getContext(), EmbeddedNodeService.class);
        intent.setAction(EmbeddedNodeService.ACTION_RESTART);
        try {
            getContext().startService(intent);
        } catch (Exception error) {
            ContextCompat.startForegroundService(getContext(), intent);
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void resetNodeRuntime(PluginCall call) {
        Intent intent = new Intent(getContext(), EmbeddedNodeService.class);
        intent.setAction(EmbeddedNodeService.ACTION_RESET_RUNTIME);
        try {
            getContext().startService(intent);
        } catch (Exception error) {
            ContextCompat.startForegroundService(getContext(), intent);
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void appVersion(PluginCall call) {
        JSObject result = new JSObject();
        result.put("packageName", getContext().getPackageName());
        result.put("versionCode", readAppVersionCode());
        result.put("versionName", readAppVersionName());
        result.put("canRequestPackageInstalls", canRequestPackageInstalls());
        call.resolve(result);
    }

    /**
     * Read the runtime-status.json file directly from Java (bypasses network and
     * Capacitor Filesystem plugin). Used by the frontend when GeckoView's fetch
     * and Capacitor bridge are unreliable.
     */
    @PluginMethod
    public void checkNodeStatus(PluginCall call) {
        JSObject result = new JSObject();
        try {
            File statusFile = new File(getContext().getFilesDir(), "InkOS Studio/runtime-status.json");
            if (statusFile.exists()) {
                String content = new String(java.nio.file.Files.readAllBytes(statusFile.toPath()), "UTF-8");
                org.json.JSONObject json = new org.json.JSONObject(content);
                result.put("state", json.optString("state", "unknown"));
                result.put("message", json.optString("message", ""));
                result.put("nativeLibSize", json.optLong("nativeLibSize", 0));
                result.put("packagedRuntimeVersion", json.optString("packagedRuntimeVersion", ""));
            } else {
                result.put("state", "no-status-file");
                result.put("message", "runtime-status.json not found.");
            }
        } catch (Exception e) {
            result.put("state", "error");
            result.put("message", e.getMessage());
        }
        call.resolve(result);
    }

    @PluginMethod
    public void installPermissionStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("canRequestPackageInstalls", canRequestPackageInstalls());
        call.resolve(result);
    }

    @PluginMethod
    public void openInstallPermissionSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            JSObject result = new JSObject();
            result.put("ok", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void downloadUpdateApk(PluginCall call) {
        String url = call.getString("url", "").trim();
        String sha256 = call.getString("sha256", "").trim();
        String fileName = sanitizeApkFileName(call.getString("fileName", "inkos-update.apk"));
        if (url.isEmpty()) {
            call.reject("APK URL is required.");
            return;
        }
        if (sha256.isEmpty()) {
            call.reject("APK sha256 is required.");
            return;
        }

        downloadCancelled = false;
        downloadThread = new Thread(() -> {
            try {
                call.resolve(downloadApk(url, sha256, fileName));
            } catch (Exception error) {
                call.reject(error.getMessage());
            } finally {
                downloadThread = null;
            }
        }, "inkos-apk-download");
        downloadThread.start();
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        downloadCancelled = true;
        HttpURLConnection conn = activeDownloadConnection;
        if (conn != null) {
            try { conn.disconnect(); } catch (Exception ignored) {}
        }
        Thread t = downloadThread;
        if (t != null) {
            t.interrupt();
        }
        call.resolve();
    }

    @PluginMethod
    public void pingUpdateUrl(PluginCall call) {
        String url = call.getString("url", "").trim();
        if (url.isEmpty()) {
            call.reject("APK URL is required.");
            return;
        }

        new Thread(() -> call.resolve(pingApkUrl(url)), "inkos-apk-source-ping").start();
    }

    @PluginMethod
    public void installDownloadedApk(PluginCall call) {
        String path = call.getString("path", "").trim();
        File apk = path.isEmpty()
            ? new File(new File(getContext().getCacheDir(), "updates"), "inkos-update.apk")
            : new File(path);
        if (!apk.exists() || !apk.isFile()) {
            call.reject("Downloaded APK is missing: " + apk.getAbsolutePath());
            return;
        }
        if (!canRequestPackageInstalls()) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("needsPermission", true);
            result.put("message", "Android requires permission to install APKs from this app.");
            call.resolve(result);
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, APK_MIME_TYPE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(intent);

            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("path", apk.getAbsolutePath());
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !isIgnoringBatteryOptimizations()) {
                // Try standard Android battery optimization request
                Intent request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                request.setData(Uri.parse("package:" + getContext().getPackageName()));
                try {
                    getActivity().startActivity(request);
                } catch (Exception e) {
                    // Fallback: open app detail settings (works on OPPO/ColorOS/Xiaomi)
                    Intent appSettings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appSettings.setData(Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(appSettings);
                }
            } else {
                // Already exempt or old device: open battery optimization settings list
                try {
                    Intent settings = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    getActivity().startActivity(settings);
                } catch (Exception e) {
                    // Final fallback: app detail settings
                    Intent appSettings = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    appSettings.setData(Uri.parse("package:" + getContext().getPackageName()));
                    getActivity().startActivity(appSettings);
                }
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("ignoring", isIgnoringBatteryOptimizations());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("无法打开权限设置页面，请手动在系统设置中关闭本应用的电池优化。", error.getMessage());
        }
    }

    @PluginMethod
    public void batteryOptimizationStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ignoring", isIgnoringBatteryOptimizations());
        call.resolve(result);
    }

    @PluginMethod
    public void updateTaskNotification(PluginCall call) {
        Intent intent = new Intent(getContext(), EmbeddedNodeService.class);
        intent.setAction(EmbeddedNodeService.ACTION_UPDATE_TASK_NOTIFICATION);
        intent.putExtra(
            EmbeddedNodeService.EXTRA_NOTIFICATION_TITLE,
            call.getString("title", "InkOS Studio")
        );
        intent.putExtra(
            EmbeddedNodeService.EXTRA_NOTIFICATION_TEXT,
            call.getString("message", "本地 Node 后端运行中")
        );
        intent.putExtra(
            EmbeddedNodeService.EXTRA_NOTIFICATION_BUSY,
            Boolean.TRUE.equals(call.getBoolean("busy", false))
        );
        try {
            getContext().startService(intent);
        } catch (Exception error) {
            ContextCompat.startForegroundService(getContext(), intent);
        }
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return true;
        }
        PowerManager powerManager = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return powerManager != null && powerManager.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    private boolean canRequestPackageInstalls() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.O
            || getContext().getPackageManager().canRequestPackageInstalls();
    }

    private long readAppVersionCode() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return info.getLongVersionCode();
            }
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException error) {
            return 0L;
        }
    }

    private String readAppVersionName() {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (PackageManager.NameNotFoundException error) {
            return "";
        }
    }

    private JSObject downloadApk(String urlString, String expectedSha256, String fileName) throws Exception {
        File updatesDir = new File(getContext().getCacheDir(), "updates");
        if (!updatesDir.exists() && !updatesDir.mkdirs()) {
            throw new IOException("Unable to create update cache directory: " + updatesDir);
        }
        File target = new File(updatesDir, fileName);
        File temporary = new File(updatesDir, fileName + ".download");

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long totalBytes = 0L;
        long contentLength = 0L;
        long lastEmitTime = 0L;
        long downloadStartTime = System.currentTimeMillis();
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            activeDownloadConnection = connection;
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(120000);
            connection.setRequestProperty("User-Agent", "InkOS-Studio-Android/" + readAppVersionName());
            int code = connection.getResponseCode();
            if (code < 200 || code >= 300) {
                throw new IOException("APK download failed with HTTP " + code);
            }
            contentLength = connection.getContentLengthLong();
            try (
                InputStream input = connection.getInputStream();
                FileOutputStream output = new FileOutputStream(temporary, false)
            ) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (downloadCancelled) {
                        temporary.delete();
                        throw new IOException("Download cancelled by user");
                    }
                    digest.update(buffer, 0, read);
                    output.write(buffer, 0, read);
                    totalBytes += read;

                    long now = System.currentTimeMillis();
                    if (now - lastEmitTime >= 500) {
                        lastEmitTime = now;
                        long elapsed = now - downloadStartTime;
                        long speed = elapsed > 0 ? (totalBytes * 1000) / elapsed : 0;
                        int percent = contentLength > 0 ? (int) (totalBytes * 100 / contentLength) : 0;
                        JSObject progress = new JSObject();
                        progress.put("bytesDownloaded", totalBytes);
                        progress.put("totalBytes", contentLength);
                        progress.put("percent", percent);
                        progress.put("speedBytesPerSec", speed);
                        notifyListeners("downloadProgress", progress);
                    }
                }
            }
        } finally {
            activeDownloadConnection = null;
            if (connection != null) connection.disconnect();
        }

        String actualSha256 = hex(digest.digest());
        if (!actualSha256.equalsIgnoreCase(expectedSha256)) {
            temporary.delete();
            throw new IOException("APK sha256 mismatch. Expected " + expectedSha256 + " but got " + actualSha256 + ".");
        }
        if (target.exists() && !target.delete()) {
            temporary.delete();
            throw new IOException("Unable to replace existing APK: " + target);
        }
        // Use Files.move instead of File.renameTo (more reliable on Android)
        try {
            java.nio.file.Files.move(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        } catch (Exception moveEx) {
            java.nio.file.Files.copy(temporary.toPath(), target.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            temporary.delete();
        }

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("path", target.getAbsolutePath());
        result.put("size", totalBytes);
        result.put("sha256", actualSha256);
        return result;
    }

    private JSObject pingApkUrl(String urlString) {
        long startedAt = System.currentTimeMillis();
        JSObject result = new JSObject();
        HttpURLConnection connection = null;
        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setRequestMethod("HEAD");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(8000);
            connection.setRequestProperty("User-Agent", "InkOS-Studio-Android/" + readAppVersionName());
            int code = connection.getResponseCode();
            if (code == HttpURLConnection.HTTP_BAD_METHOD) {
                connection.disconnect();
                connection = (HttpURLConnection) url.openConnection();
                connection.setInstanceFollowRedirects(true);
                connection.setConnectTimeout(5000);
                connection.setReadTimeout(8000);
                connection.setRequestProperty("User-Agent", "InkOS-Studio-Android/" + readAppVersionName());
                connection.setRequestProperty("Range", "bytes=0-0");
                code = connection.getResponseCode();
                try (InputStream input = connection.getInputStream()) {
                    input.read();
                }
            }
            long latencyMs = Math.max(1L, System.currentTimeMillis() - startedAt);
            result.put("ok", code >= 200 && code < 400);
            result.put("statusCode", code);
            result.put("latencyMs", latencyMs);
            return result;
        } catch (Exception error) {
            long latencyMs = Math.max(1L, System.currentTimeMillis() - startedAt);
            result.put("ok", false);
            result.put("statusCode", 0);
            result.put("latencyMs", latencyMs);
            result.put("error", error.getMessage());
            return result;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private String sanitizeApkFileName(String value) {
        String cleaned = value == null ? "" : value.trim().replaceAll("[^A-Za-z0-9._-]", "-");
        if (cleaned.isEmpty()) return "inkos-update.apk";
        return cleaned.endsWith(".apk") ? cleaned : cleaned + ".apk";
    }

    private String hex(byte[] bytes) {
        StringBuilder builder = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            builder.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return builder.toString();
    }
}
