package io.qzz.christmas.inkoslocal;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.ActivityManager;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.os.PowerManager;
import android.system.ErrnoException;
import android.system.Os;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import org.json.JSONObject;

public class EmbeddedNodeService extends Service {
    private static final String TAG = "InkOSNode";
    private static final String CHANNEL_ID = "inkos_node_runtime";
    private static final String ALERT_CHANNEL_ID = "inkos_node_alerts";
    private static final int NOTIFICATION_ID = 4567;
    private static final int ALERT_NOTIFICATION_BASE_ID = 4600;
    private static final int MAX_AUTO_RESTARTS = 12;
    public static final int MIN_NODE24_SDK = 28;
    public static final String ACTION_RESTART = "io.qzz.christmas.inkoslocal.RESTART_NODE";
    public static final String ACTION_UPDATE_TASK_NOTIFICATION = "io.qzz.christmas.inkoslocal.UPDATE_TASK_NOTIFICATION";
    public static final String EXTRA_NOTIFICATION_TITLE = "notificationTitle";
    public static final String EXTRA_NOTIFICATION_TEXT = "notificationText";
    public static final String EXTRA_NOTIFICATION_BUSY = "notificationBusy";
    private static boolean startedNodeAlready = false;
    private static int autoRestartAttempts = 0;
    private Process nodeProcess = null;
    private volatile boolean progressMonitorRunning = false;
    private String lastProgressText = "";
    private String lastProgressSignature = "";
    private String lastNoticeId = "";
    private int alertNotificationCounter = 0;
    private String packagedRuntimeVersion = "";
    private String installedRuntimeVersion = "";
    private long nativeLibSize = 0L;
    private String nativeLibSha256 = "";
    private volatile boolean runtimeUnsupported = false;
    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        writeRuntimeStatus(
            "service-created",
            "EmbeddedNodeService onCreate entered. SDK " + Build.VERSION.SDK_INT + ", ABIS: " + Arrays.toString(Build.SUPPORTED_ABIS)
        );
        acquireWakeLock();
        safeStartForeground("InkOS local runtime starting");
        startProgressNotificationMonitor();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_UPDATE_TASK_NOTIFICATION.equals(intent.getAction())) {
            String title = intent.getStringExtra(EXTRA_NOTIFICATION_TITLE);
            String text = intent.getStringExtra(EXTRA_NOTIFICATION_TEXT);
            boolean busy = intent.getBooleanExtra(EXTRA_NOTIFICATION_BUSY, false);
            updateTaskNotification(title, text, busy);
            return START_STICKY;
        }
        if (intent != null && ACTION_RESTART.equals(intent.getAction())) {
            restartNodeIfNeeded();
            return START_STICKY;
        }
        startNodeOnce();
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        progressMonitorRunning = false;
        stopNodeProcess();
        releaseWakeLock();
        super.onDestroy();
    }

    private void acquireWakeLock() {
        try {
            PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
            if (powerManager == null) {
                return;
            }
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "InkOS:NodeRuntime");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(10L * 60L * 1000L);
        } catch (Exception error) {
            Log.w(TAG, "Unable to acquire InkOS Node wake lock", error);
            writeRuntimeStatus("wake-lock-skipped", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception error) {
            Log.w(TAG, "Unable to release InkOS Node wake lock", error);
        }
    }

    private synchronized void startNodeOnce() {
        if (startedNodeAlready) {
            return;
        }
        startedNodeAlready = true;
        new Thread(this::startNode, "inkos-node-start").start();
    }

    private synchronized void restartNodeIfNeeded() {
        if (isUnsupportedAndroidForNode24()) {
            markUnsupportedAndroidVersion();
            return;
        }
        if (startedNodeAlready) {
            writeRuntimeStatus("restart-skipped", "Node backend is already starting; restart request ignored.");
            updateNotification("InkOS local runtime is already starting");
            return;
        }
        if (canConnectToNode()) {
            autoRestartAttempts = 0;
            writeRuntimeStatus("running", "Node backend is already listening on http://127.0.0.1:4567.");
            updateNotification("InkOS local runtime running on 127.0.0.1:4567");
            return;
        }
        writeRuntimeStatus("restart-requested", "Restart requested from InkOS Studio.");
        startNodeOnce();
    }

    private void startNode() {
        try {
            runtimeUnsupported = false;
            writeRuntimeStatus("starting", "EmbeddedNodeService started.");
            if (isUnsupportedAndroidForNode24()) {
                markUnsupportedAndroidVersion();
                return;
            }
            File nodeExecutable = resolveNodeExecutable();
            if (!nodeExecutable.exists()) {
                Log.w(TAG, "Node executable is missing: " + nodeExecutable);
                writeRuntimeStatus(
                    "node24-executable-missing",
                    "Node24 executable is missing: " + nodeExecutable.getAbsolutePath() + ". SDK " + Build.VERSION.SDK_INT + ", ABIS: " + Arrays.toString(Build.SUPPORTED_ABIS)
                );
                updateNotification("InkOS local runtime unavailable");
                return;
            }

            File runtimeDir = new File(getFilesDir(), "embedded-node");
            File appDir = new File(runtimeDir, "app");
            File projectRoot = resolveProjectRoot();

            File builtinGenresDir = new File(runtimeDir, "genres");
            packagedRuntimeVersion = readAssetText("inkos-node/runtime-version.txt").trim();
            File installedVersionFile = new File(runtimeDir, "runtime-version.txt");
            installedRuntimeVersion = installedVersionFile.exists()
                ? readTextFile(installedVersionFile).trim()
                : "";
            nativeLibSize = nodeExecutable.exists() ? nodeExecutable.length() : 0L;
            nativeLibSha256 = nodeExecutable.exists() ? sha256File(nodeExecutable) : "";
            if (!packagedRuntimeVersion.equals(installedRuntimeVersion) || !new File(appDir, "server.cjs").exists()) {
                writeRuntimeStatus("extracting", "Updating embedded Node backend in app private storage.");
                copyAssetDirectory("inkos-node/app", appDir);
                copyAssetDirectory("inkos-node/genres", builtinGenresDir);
                writeTextFile(installedVersionFile, packagedRuntimeVersion + "\n");
                writeRuntimeStatus("extracted", "Embedded Node backend updated at " + appDir.getAbsolutePath());
            } else {
                writeRuntimeStatus("assets-current", "Embedded Node backend already matches packaged version.");
            }
            writeRuntimeStatus(
                "assets-ready",
                "Embedded backend files: app=" + countFiles(appDir) + ", genres=" + countFiles(builtinGenresDir)
            );
            File server = new File(appDir, "server.cjs");
            if (!server.exists()) {
                Log.w(TAG, "Embedded server bundle is missing: " + server);
                writeRuntimeStatus("server-missing", "Embedded server bundle is missing: " + server);
                return;
            }

            setNodeEnv("NODE_ENV", "production");
            setNodeEnv("INKOS_ANDROID", "1");
            setNodeEnv("INKOS_ANDROID_VERSION_CODE", String.valueOf(readAppVersionCode()));
            setNodeEnv("INKOS_ANDROID_VERSION_NAME", readAppVersionName());
            setNodeEnv("INKOS_STUDIO_PORT", "4567");
            setNodeEnv("INKOS_PROJECT_ROOT", projectRoot.getAbsolutePath());
            setNodeEnv("INKOS_BUILTIN_GENRES_DIR", builtinGenresDir.getAbsolutePath());
            setNodeEnv("HOME", getFilesDir().getAbsolutePath());
            setNodeEnv("TMPDIR", getCacheDir().getAbsolutePath());
            File privateStatusDir = new File(getFilesDir(), "InkOS Studio");
            if (!privateStatusDir.exists() && !privateStatusDir.mkdirs()) {
                Log.w(TAG, "Unable to create private runtime log dir: " + privateStatusDir);
            }
            setNodeEnv("INKOS_NODE_LOG", new File(privateStatusDir, "node-output.log").getAbsolutePath());
            setNodeEnv("INKOS_NODE_PROGRESS", new File(privateStatusDir, "node-progress.json").getAbsolutePath());

            startPortMonitor(projectRoot);
            updateNotification("InkOS local runtime starting on 127.0.0.1:4567");
            Log.i(TAG, "Starting Node24 executable runtime: " + server.getAbsolutePath());
            writeRuntimeStatus(
                "node-starting",
                "Starting Node24 executable: " + nodeExecutable.getAbsolutePath() + " -> " + server.getAbsolutePath()
            );
            String maxOldSpaceArg = "--max_old_space_size=" + resolveNodeMaxOldSpaceMb();
            int result = startNodeExecutable(
                nodeExecutable,
                new File(privateStatusDir, "node-output.log"),
                new File(privateStatusDir, "node-progress.json"),
                projectRoot,
                builtinGenresDir,
                maxOldSpaceArg,
                server.getAbsolutePath(),
                projectRoot.getAbsolutePath()
            );
            Log.i(TAG, "Node24 runtime exited with code " + result);
            writeRuntimeStatus("node-exited", "Node24 runtime exited with code " + result);
        } catch (Exception error) {
            Log.e(TAG, "Failed to start embedded Node runtime", error);
            writeRuntimeStatus("node-error", error.getClass().getSimpleName() + ": " + error.getMessage());
            updateNotification("InkOS local runtime unavailable");
        } finally {
            synchronized (this) {
                startedNodeAlready = false;
            }
            if (!runtimeUnsupported && !canConnectToNode()) {
                scheduleAutoRestart();
            }
        }
    }

    private boolean isUnsupportedAndroidForNode24() {
        return Build.VERSION.SDK_INT < MIN_NODE24_SDK;
    }

    private void markUnsupportedAndroidVersion() {
        runtimeUnsupported = true;
        autoRestartAttempts = MAX_AUTO_RESTARTS;
        String message = "当前内置 Node24 runtime 使用 Android API 28 构建，需要 Android 9.0+。当前设备 SDK "
            + Build.VERSION.SDK_INT
            + "，ABIS: "
            + Arrays.toString(Build.SUPPORTED_ABIS)
            + "。请使用 Android 9+ 设备，或重新打包 legacy Node18/API24 版本。";
        writeRuntimeStatus("unsupported-android-version", message);
        updateNotification("InkOS Node24 需要 Android 9.0+");
        releaseWakeLock();
    }

    private int resolveNodeMaxOldSpaceMb() {
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        ActivityManager manager = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        if (manager != null) {
            manager.getMemoryInfo(info);
            long totalMb = info.totalMem / (1024L * 1024L);
            if (totalMb > 0 && totalMb <= 4096L) {
                return 1024;
            }
        }
        return 1536;
    }

    private File resolveNodeExecutable() {
        String nativeLibraryDir = getApplicationInfo().nativeLibraryDir;
        if (nativeLibraryDir == null || nativeLibraryDir.trim().isEmpty()) {
            return new File(getFilesDir(), "missing-native-library-dir/libnode.so");
        }
        return new File(nativeLibraryDir, "libnode.so");
    }

    private int startNodeExecutable(
        File nodeExecutable,
        File logFile,
        File progressFile,
        File projectRoot,
        File builtinGenresDir,
        String... arguments
    ) throws IOException, InterruptedException {
        if (!nodeExecutable.canExecute()) {
            boolean executable = nodeExecutable.setExecutable(true, false);
            writeRuntimeStatus(
                executable ? "node24-executable-permission-fixed" : "node24-executable-permission-warning",
                "Node24 executable permission check for " + nodeExecutable.getAbsolutePath() + ": canExecute=" + nodeExecutable.canExecute()
            );
        }
        if (logFile.getParentFile() != null && !logFile.getParentFile().exists() && !logFile.getParentFile().mkdirs()) {
            Log.w(TAG, "Unable to create Node log directory: " + logFile.getParentFile());
        }

        java.util.ArrayList<String> command = new java.util.ArrayList<>();
        command.add(nodeExecutable.getAbsolutePath());
        command.addAll(Arrays.asList(arguments));

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.redirectErrorStream(true);
        builder.environment().put("NODE_ENV", "production");
        builder.environment().put("INKOS_ANDROID", "1");
        builder.environment().put("INKOS_NODE_EXECUTABLE_MODE", "1");
        builder.environment().put("INKOS_STUDIO_PORT", "4567");
        builder.environment().put("INKOS_PROJECT_ROOT", projectRoot.getAbsolutePath());
        builder.environment().put("INKOS_BUILTIN_GENRES_DIR", builtinGenresDir.getAbsolutePath());
        builder.environment().put("HOME", getFilesDir().getAbsolutePath());
        builder.environment().put("TMPDIR", getCacheDir().getAbsolutePath());
        builder.environment().put("INKOS_NODE_LOG", logFile.getAbsolutePath());
        builder.environment().put("INKOS_NODE_PROGRESS", progressFile.getAbsolutePath());
        builder.environment().put("LD_LIBRARY_PATH", nodeExecutable.getParentFile().getAbsolutePath());

        writeRuntimeStatus("node24-process-spawn", "Executing " + command);
        Process process = builder.start();
        synchronized (this) {
            nodeProcess = process;
        }
        Thread logPump = startProcessLogPump(process, logFile);
        int exitCode = process.waitFor();
        logPump.join(2000L);
        return exitCode;
    }

    private synchronized void stopNodeProcess() {
        if (isProcessAlive(nodeProcess)) {
            nodeProcess.destroy();
        }
        nodeProcess = null;
    }

    private Thread startProcessLogPump(Process process, File logFile) {
        Thread thread = new Thread(() -> {
            try (
                InputStream input = process.getInputStream();
                FileOutputStream output = new FileOutputStream(logFile, true)
            ) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                    output.flush();
                }
            } catch (IOException error) {
                Log.w(TAG, "Unable to append Node process output to " + logFile, error);
            }
        }, "inkos-node-log-pump");
        thread.setDaemon(true);
        thread.start();
        return thread;
    }

    private boolean isProcessAlive(Process process) {
        if (process == null) {
            return false;
        }
        try {
            process.exitValue();
            return false;
        } catch (IllegalThreadStateException running) {
            return true;
        }
    }

    private void scheduleAutoRestart() {
        synchronized (this) {
            if (autoRestartAttempts >= MAX_AUTO_RESTARTS) {
                writeRuntimeStatus(
                    "node-stopped",
                    "Node backend stopped and automatic restart limit was reached. Open InkOS local runtime status and tap start."
                );
                updateNotification("InkOS local runtime stopped");
                return;
            }
            autoRestartAttempts += 1;
        }
        final int attempt = autoRestartAttempts;
        writeRuntimeStatus("restart-scheduled", "Node backend stopped. Auto restart attempt " + attempt + "/" + MAX_AUTO_RESTARTS + " will run soon.");
        updateNotification("InkOS local runtime restarting");
        new Thread(() -> {
            try {
                Thread.sleep(Math.min(30000, 2000L * attempt));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            if (!canConnectToNode()) {
                startNodeOnce();
            }
        }, "inkos-node-auto-restart").start();
    }

    private void startPortMonitor(File projectRoot) {
        new Thread(() -> {
            for (int attempt = 1; attempt <= 120; attempt++) {
                if (canConnectToNode()) {
                    autoRestartAttempts = 0;
                    releaseWakeLock();
                    writeRuntimeStatus(
                        "running",
                        "Node backend is listening on http://127.0.0.1:4567. Project root: " + projectRoot.getAbsolutePath()
                    );
                    updateNotification("InkOS local runtime running on 127.0.0.1:4567");
                    return;
                }
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            writeRuntimeStatus(
                "port-timeout",
                "Node process was started, but port 4567 did not become reachable within 120 seconds. See node-output.log."
            );
            releaseWakeLock();
            updateNotification("InkOS local runtime did not answer on port 4567");
        }, "inkos-node-port-monitor").start();
    }

    private File resolveProjectRoot() {
        File privateRoot = new File(getFilesDir(), "InkOS Studio");
        File publicDocuments = new File(
            Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS),
            "InkOS Studio"
        );
        File externalDocuments = getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS);
        File appExternal = externalDocuments == null ? null : new File(externalDocuments, "InkOS Studio");

        boolean publicWritable = ensureWritableDirectory(publicDocuments);
        if (!publicWritable) {
            Log.w(TAG, "Forced public Documents project root is not writable yet: " + publicDocuments);
            writeRuntimeStatus("storage-public-not-writable", "Forced project root is not writable yet: " + publicDocuments.getAbsolutePath());
        }
        try {
            migrateCandidateRoots(publicDocuments, privateRoot, appExternal);
        } catch (IOException error) {
            Log.w(TAG, "Unable to migrate InkOS data into public Documents", error);
            writeRuntimeStatus("storage-migration-failed", "Unable to migrate data into Documents: " + error.getMessage());
        }
        Log.i(TAG, "Using forced public Documents project root: " + publicDocuments.getAbsolutePath());
        writeRuntimeStatus("storage-documents", "Using Documents project root: " + publicDocuments.getAbsolutePath());
        return publicDocuments;
    }

    private void migrateCandidateRoots(File target, File... candidates) throws IOException {
        int migrated = 0;
        for (File candidate : candidates) {
            if (candidate == null || sameFile(candidate, target) || projectDataScore(candidate) <= 0) {
                continue;
            }
            mergeProjectData(candidate, target);
            migrated += 1;
            Log.i(TAG, "Merged InkOS data from " + candidate.getAbsolutePath() + " into " + target.getAbsolutePath());
        }
        if (migrated > 0) {
            writeRuntimeStatus(
                "storage-migrated",
                "Merged existing InkOS data from " + migrated + " previous location(s) into " + target.getAbsolutePath()
            );
        }
    }

    private void mergeProjectData(File source, File target) throws IOException {
        copyDirectory(source, target, false);
        copyFileIfBetter(new File(source, "inkos.json"), new File(target, "inkos.json"));
        copyFileIfBetter(
            new File(new File(source, ".inkos"), "secrets.json"),
            new File(new File(target, ".inkos"), "secrets.json")
        );
        copyFileIfBetter(new File(source, "inkos-db.json"), new File(target, "inkos-db.json"));
    }

    private void copyFileIfBetter(File source, File target) throws IOException {
        if (source == null || !source.exists() || source.isDirectory()) {
            return;
        }
        if (
            !target.exists()
                || target.length() <= 8
                || source.length() > target.length()
                || source.lastModified() > target.lastModified()
        ) {
            copyDirectory(source, target, true);
        }
    }

    private File findBestExistingProjectRoot(File... candidates) {
        File best = null;
        int bestScore = 0;
        long bestModified = 0L;
        for (File candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            int score = projectDataScore(candidate);
            long modified = projectLastModified(candidate);
            if (score > bestScore || (score == bestScore && score > 0 && modified > bestModified)) {
                best = candidate;
                bestScore = score;
                bestModified = modified;
            }
        }
        return best;
    }

    private int projectDataScore(File root) {
        if (root == null || !root.exists()) {
            return 0;
        }
        int score = 0;
        File secrets = new File(new File(root, ".inkos"), "secrets.json");
        File config = new File(root, "inkos.json");
        File database = new File(root, "inkos-db.json");
        File books = new File(root, "books");
        if (secrets.exists() && secrets.length() > 8) score += 12;
        if (config.exists() && config.length() > 8) {
            score += 2;
            String compactConfig = readTextFile(config).replaceAll("\\s+", "");
            if (compactConfig.contains("\"services\":[") && !compactConfig.contains("\"services\":[]")) {
                score += 10;
            }
            if (compactConfig.contains("\"cover\":{") && compactConfig.contains("\"model\":")) {
                score += 2;
            }
        }
        if (database.exists() && database.length() > 8) score += 5;
        if (books.exists() && books.isDirectory()) score += 4;
        return score;
    }

    private String readTextFile(File file) {
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] bytes = new byte[(int) Math.min(file.length(), 1024 * 1024)];
            int read = input.read(bytes);
            if (read <= 0) {
                return "";
            }
            return new String(bytes, 0, read, StandardCharsets.UTF_8);
        } catch (Exception error) {
            return "";
        }
    }

    private long projectLastModified(File root) {
        if (root == null || !root.exists()) {
            return 0L;
        }
        long newest = root.lastModified();
        File[] children = root.listFiles();
        if (children == null) {
            return newest;
        }
        for (File child : children) {
            newest = Math.max(newest, projectLastModified(child));
        }
        return newest;
    }

    private boolean sameFile(File a, File b) {
        try {
            return a.getCanonicalFile().equals(b.getCanonicalFile());
        } catch (IOException error) {
            return a.getAbsolutePath().equals(b.getAbsolutePath());
        }
    }

    private boolean ensureWritableDirectory(File dir) {
        if (dir == null) {
            return false;
        }
        try {
            if (!dir.exists() && !dir.mkdirs()) {
                return false;
            }
            File hiddenDir = new File(dir, ".inkos");
            if (!hiddenDir.exists() && !hiddenDir.mkdirs()) {
                return false;
            }
            File hiddenProbe = new File(hiddenDir, ".write-test");
            try (FileOutputStream output = new FileOutputStream(hiddenProbe, false)) {
                output.write("ok".getBytes(StandardCharsets.UTF_8));
            }
            if (!hiddenProbe.delete()) {
                Log.w(TAG, "Unable to delete storage probe: " + hiddenProbe);
            }
            return true;
        } catch (Exception error) {
            Log.w(TAG, "Project root is not writable: " + dir, error);
            return false;
        }
    }

    private void copyDirectory(File source, File target, boolean overwrite) throws IOException {
        if (source.isDirectory()) {
            if (!target.exists() && !target.mkdirs()) {
                throw new IOException("Unable to create " + target);
            }
            File[] children = source.listFiles();
            if (children == null) {
                return;
            }
            for (File child : children) {
                copyDirectory(child, new File(target, child.getName()), overwrite);
            }
            return;
        }
        if (target.exists() && !overwrite) {
            return;
        }
        File parent = target.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Unable to create " + parent);
        }
        try (InputStream input = new java.io.FileInputStream(source);
             FileOutputStream output = new FileOutputStream(target, false)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
        }
    }

    private int countFiles(File root) {
        if (root == null || !root.exists()) {
            return 0;
        }
        if (root.isFile()) {
            return 1;
        }
        int count = 0;
        File[] children = root.listFiles();
        if (children == null) {
            return 0;
        }
        for (File child : children) {
            count += countFiles(child);
        }
        return count;
    }

    private boolean canConnectToNode() {
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 4567), 400);
            return true;
        } catch (IOException ignored) {
            return false;
        }
    }

    private void writeRuntimeStatus(String state, String message) {
        try {
            File projectRoot = new File(getFilesDir(), "InkOS Studio");
            if (!projectRoot.exists() && !projectRoot.mkdirs()) {
                Log.w(TAG, "Unable to create status dir: " + projectRoot);
                return;
            }
            File statusFile = new File(projectRoot, "runtime-status.json");
            JSONObject payload = new JSONObject();
            payload.put("state", state);
            payload.put("message", message == null ? "" : message);
            payload.put("updatedAt", System.currentTimeMillis());
            if (!packagedRuntimeVersion.isEmpty()) {
                payload.put("packagedRuntimeVersion", packagedRuntimeVersion);
            }
            if (!installedRuntimeVersion.isEmpty()) {
                payload.put("installedRuntimeVersion", installedRuntimeVersion);
            }
            if (nativeLibSize > 0L) {
                payload.put("nativeLibSize", nativeLibSize);
            }
            if (!nativeLibSha256.isEmpty()) {
                payload.put("nativeLibSha256", nativeLibSha256);
            }
            String json = payload.toString();
            try (FileOutputStream output = new FileOutputStream(statusFile, false)) {
                output.write(json.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception error) {
            Log.w(TAG, "Unable to write runtime status", error);
        }
    }

    private void setNodeEnv(String key, String value) {
        try {
            Os.setenv(key, value, true);
        } catch (ErrnoException error) {
            Log.w(TAG, "Unable to set environment variable " + key, error);
        }
    }

    private long readAppVersionCode() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
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
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "" : info.versionName;
        } catch (PackageManager.NameNotFoundException error) {
            return "";
        }
    }

    private void copyAssetDirectory(String assetPath, File targetDir) throws IOException {
        AssetManager assets = getAssets();
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            copyAssetFileIfExists(assetPath, targetDir);
            return;
        }
        if (!targetDir.exists() && !targetDir.mkdirs()) {
            throw new IOException("Unable to create " + targetDir);
        }
        for (String child : children) {
            copyAssetDirectory(assetPath + "/" + child, new File(targetDir, child));
        }
    }

    private String readAssetText(String assetPath) throws IOException {
        try (InputStream input = getAssets().open(assetPath)) {
            java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void writeTextFile(File file, String content) throws IOException {
        File parent = file.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("Unable to create " + parent);
        }
        try (FileOutputStream output = new FileOutputStream(file, false)) {
            output.write(content.getBytes(StandardCharsets.UTF_8));
        }
    }

    private String sha256File(File file) {
        try (InputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
            byte[] hash = digest.digest();
            StringBuilder builder = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                builder.append(String.format("%02x", value));
            }
            return builder.toString();
        } catch (Exception error) {
            Log.w(TAG, "Unable to hash native Node library", error);
            return "";
        }
    }

    private void copyAssetFileIfExists(String assetPath, File targetFile) throws IOException {
        try (InputStream input = getAssets().open(assetPath)) {
            File parent = targetFile.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                throw new IOException("Unable to create " + parent);
            }
            try (FileOutputStream output = new FileOutputStream(targetFile)) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    output.write(buffer, 0, read);
                }
            }
        } catch (IOException missing) {
            if (!"inkos-node/bin/node".equals(assetPath)) {
                throw missing;
            }
        }
    }

    private Notification buildNotification(String text) {
        return buildNotification("InkOS Studio", text, false);
    }

    private Notification buildNotification(String title, String text, boolean busy) {
        return buildNotification(title, text, text, "", busy);
    }

    private Notification buildNotification(String title, String text, String bigText, String subText, boolean busy) {
        ensureChannel();
        PendingIntent contentIntent = createLaunchPendingIntent(0);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(bigText == null || bigText.length() == 0 ? text : bigText))
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOnlyAlertOnce(true)
            .setCategory(busy ? NotificationCompat.CATEGORY_PROGRESS : NotificationCompat.CATEGORY_SERVICE)
            .setShowWhen(busy)
            .setUsesChronometer(busy);
        if (subText != null && subText.length() > 0) {
            builder.setSubText(subText);
        }
        if (busy) {
            builder.setProgress(0, 0, true);
        }
        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }
        return builder.build();
    }

    private Notification buildAlertNotification(String title, String message, String kind) {
        ensureChannel();
        PendingIntent contentIntent = createLaunchPendingIntent(1);
        int priority = "error".equals(kind) ? NotificationCompat.PRIORITY_MAX : NotificationCompat.PRIORITY_HIGH;
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, ALERT_CHANNEL_ID)
            .setSmallIcon(getApplicationInfo().icon)
            .setContentTitle(title)
            .setContentText(message)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
            .setPriority(priority)
            .setAutoCancel(true)
            .setOngoing(false)
            .setOnlyAlertOnce(false)
            .setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE);
        if (contentIntent != null) {
            builder.setContentIntent(contentIntent);
        }
        return builder.build();
    }

    private PendingIntent createLaunchPendingIntent(int requestCode) {
        Intent launchIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        return launchIntent == null
            ? null
            : PendingIntent.getActivity(
                this,
                requestCode,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
    }

    private void safeStartForeground(String text) {
        try {
            lastProgressSignature = notificationSignature("InkOS Studio", text, text, "", false);
            startForeground(NOTIFICATION_ID, buildNotification(text));
        } catch (Exception error) {
            Log.e(TAG, "Unable to enter foreground service mode", error);
            writeRuntimeStatus("foreground-start-failed", error.getClass().getSimpleName() + ": " + error.getMessage());
        }
    }

    private void updateNotification(String text) {
        updateNotification("InkOS Studio", text, false);
    }

    private void updateNotification(String title, String text, boolean busy) {
        updateNotification(title, text, text, "", busy);
    }

    private void updateNotification(String title, String text, String bigText, String subText, boolean busy) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            manager.notify(NOTIFICATION_ID, buildNotification(title, text, bigText, subText, busy));
        } catch (Exception error) {
            Log.w(TAG, "Unable to update InkOS foreground notification", error);
        }
    }

    private void updateTaskNotification(String title, String text, boolean busy) {
        String safeTitle = title == null || title.trim().isEmpty()
            ? (busy ? "InkOS 正在执行任务" : "InkOS Studio")
            : title.trim();
        String safeText = text == null || text.trim().isEmpty()
            ? (busy ? "任务正在运行" : "本地 Node 后端运行中")
            : text.trim();
        String signature = notificationSignature(safeTitle, safeText, safeText, "", busy);
        if (signature.equals(lastProgressSignature)) {
            return;
        }
        lastProgressSignature = signature;
        lastProgressText = safeTitle + " · " + safeText;
        updateNotification(safeTitle, safeText, busy);
    }

    private void sendAlertNotification(String title, String message, String kind) {
        try {
            NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (manager == null) {
                return;
            }
            int notificationId = ALERT_NOTIFICATION_BASE_ID + (alertNotificationCounter++ % 1000);
            manager.notify(notificationId, buildAlertNotification(title, message, kind));
        } catch (Exception error) {
            Log.w(TAG, "Unable to send InkOS writing alert notification", error);
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            "InkOS local runtime",
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription("InkOS embedded Node runtime progress");
        NotificationChannel alertChannel = new NotificationChannel(
            ALERT_CHANNEL_ID,
            "InkOS writing alerts",
            NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("InkOS chapter writing completion and error alerts");
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        manager.createNotificationChannel(channel);
        manager.createNotificationChannel(alertChannel);
    }

    private void startProgressNotificationMonitor() {
        if (progressMonitorRunning) {
            return;
        }
        progressMonitorRunning = true;
        new Thread(() -> {
            File progressFile = new File(new File(getFilesDir(), "InkOS Studio"), "node-progress.json");
            while (progressMonitorRunning) {
                try {
                    ProgressSnapshot snapshot = readProgressSnapshot(progressFile);
                    if (snapshot.hasNotification() && !snapshot.signature.equals(lastProgressSignature)) {
                        lastProgressSignature = snapshot.signature;
                        lastProgressText = snapshot.title + " · " + snapshot.text;
                        updateNotification(snapshot.title, snapshot.text, snapshot.bigText, snapshot.subText, snapshot.busy);
                    }
                    if (snapshot.noticeId.length() > 0 && !snapshot.noticeId.equals(lastNoticeId)) {
                        lastNoticeId = snapshot.noticeId;
                        sendAlertNotification(snapshot.noticeTitle, snapshot.noticeMessage, snapshot.noticeKind);
                    }
                    Thread.sleep(1500);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                } catch (Exception error) {
                    Log.w(TAG, "Unable to refresh progress notification", error);
                }
            }
        }, "inkos-progress-notification").start();
    }

    private ProgressSnapshot readProgressSnapshot(File progressFile) {
        if (!progressFile.exists()) {
            return ProgressSnapshot.empty();
        }
        try {
            String raw = readTextFile(progressFile);
            if (raw.trim().isEmpty()) {
                return ProgressSnapshot.empty();
            }
            JSONObject json = new JSONObject(raw);
            String state = json.optString("state", "idle");
            boolean busy = "busy".equals(state);
            String label = sanitize(json.optString("label", busy ? "正在执行任务" : "待命"));
            String message = sanitize(json.optString("message", ""));
            String type = sanitize(json.optString("type", ""));
            String bookId = sanitize(json.optString("bookId", ""));
            int chapter = json.optInt("chapter", 0);
            int activeCount = json.optInt("activeCount", busy ? 1 : 0);
            JSONObject notice = json.optJSONObject("notice");
            JSONObject tokenUsage = json.optJSONObject("tokenUsage");
            JSONObject tokenSavings = json.optJSONObject("tokenSavings");
            if (!busy && notice != null) {
                if (tokenUsage == null) tokenUsage = notice.optJSONObject("tokenUsage");
                if (tokenSavings == null) tokenSavings = notice.optJSONObject("tokenSavings");
            }

            String tokenLine = formatTokenLine(tokenUsage, tokenSavings);
            String context = formatTaskContext(bookId, chapter);
            String title = busy ? formatBusyTitle(type, label) : "InkOS 本地后端已就绪";
            String text;
            String bigText;
            String subText;
            if (busy) {
                text = joinParts(" · ", context, message.length() > 0 ? message : label, tokenLine);
                if (text.length() == 0) text = "后台任务正在运行";
                bigText = joinLines(
                    context,
                    message.length() > 0 ? message : label,
                    tokenLine,
                    activeCount > 1 ? "并行任务：" + activeCount + " 个" : "页面退到后台也会继续执行"
                );
                subText = activeCount > 1 ? activeCount + " 个任务" : label;
            } else {
                String noticeTitle = notice == null ? "" : sanitize(notice.optString("title", ""));
                String noticeMessage = notice == null ? "" : sanitize(notice.optString("message", ""));
                String recent = noticeMessage.length() > 0 ? noticeMessage : noticeTitle;
                text = recent.length() > 0
                    ? trimForNotification(recent, 120)
                    : (message.length() > 0 ? message : "本地 Node 后端正在运行，暂无写作任务。");
                bigText = joinLines(
                    "本地 Node 后端正在运行，暂无写作任务。",
                    recent.length() > 0 ? "最近：" + recent : "",
                    tokenLine
                );
                subText = noticeTitle.length() > 0 ? noticeTitle : "待命";
            }
            if (notice == null) {
                return new ProgressSnapshot(title, text, bigText, subText, busy);
            }
            String noticeId = notice.optString("id", "");
            String noticeKind = notice.optString("kind", "completed");
            String noticeTitle = notice.optString("title", "InkOS 写作提醒");
            String noticeMessage = notice.optString("message", "");
            if (noticeMessage.length() == 0) {
                noticeMessage = noticeTitle;
            }
            return new ProgressSnapshot(title, text, bigText, subText, busy, noticeId, noticeKind, noticeTitle, noticeMessage);
        } catch (Exception error) {
            return ProgressSnapshot.empty();
        }
    }

    private String formatBusyTitle(String type, String label) {
        String normalizedType = type == null ? "" : type.toLowerCase();
        String normalizedLabel = label == null ? "" : label;
        if (normalizedType.contains("rewrite") || normalizedLabel.contains("重写")) {
            return "InkOS · 章节重写中";
        }
        if (normalizedType.contains("revise") || normalizedLabel.contains("修订")) {
            return "InkOS · 章节修订中";
        }
        if (normalizedType.contains("write") || normalizedLabel.contains("章节") || normalizedLabel.contains("写作")) {
            return "InkOS · 章节写作中";
        }
        if (normalizedType.contains("agent") || normalizedLabel.contains("对话")) {
            return "InkOS · AI 对话处理中";
        }
        return normalizedLabel.length() > 0 ? "InkOS · " + normalizedLabel : "InkOS · 后台任务进行中";
    }

    private String formatTaskContext(String bookId, int chapter) {
        String safeBookId = sanitize(bookId);
        boolean hasBook = safeBookId.length() > 0 && !"project".equals(safeBookId);
        if (hasBook && chapter > 0) {
            return "《" + safeBookId + "》第 " + chapter + " 章";
        }
        if (hasBook) {
            return "《" + safeBookId + "》";
        }
        if (chapter > 0) {
            return "第 " + chapter + " 章";
        }
        return "";
    }

    private String formatTokenLine(JSONObject tokenUsage, JSONObject tokenSavings) {
        long total = tokenUsage == null ? 0L : Math.max(0L, tokenUsage.optLong("totalTokens", 0L));
        long prompt = tokenUsage == null ? 0L : Math.max(0L, tokenUsage.optLong("promptTokens", 0L));
        long completion = tokenUsage == null ? 0L : Math.max(0L, tokenUsage.optLong("completionTokens", 0L));
        long saved = tokenSavings == null ? 0L : Math.max(0L, tokenSavings.optLong("estimatedTokensSaved", 0L));
        String usage = "";
        if (total > 0L) {
            usage = "消耗 " + total + " tokens";
            if (prompt > 0L || completion > 0L) {
                usage += "（输入 " + prompt + " / 输出 " + completion + "）";
            }
        }
        String savings = saved > 0L ? "估算节省 " + saved + " tokens" : "";
        return joinParts(" · ", usage, savings);
    }

    private String sanitize(String value) {
        return value == null ? "" : value.trim();
    }

    private String trimForNotification(String value, int maxLength) {
        String safe = sanitize(value).replace('\n', ' ');
        if (safe.length() <= maxLength) return safe;
        return safe.substring(0, Math.max(0, maxLength - 1)).trim() + "…";
    }

    private String joinParts(String delimiter, String... parts) {
        StringBuilder builder = new StringBuilder();
        for (String part : parts) {
            String safe = sanitize(part);
            if (safe.length() == 0) continue;
            if (builder.length() > 0) builder.append(delimiter);
            builder.append(safe);
        }
        return builder.toString();
    }

    private String joinLines(String... parts) {
        return joinParts("\n", parts);
    }

    private String notificationSignature(String title, String text, String bigText, String subText, boolean busy) {
        return (busy ? "busy" : "idle")
            + "\u001f" + sanitize(title)
            + "\u001f" + sanitize(text)
            + "\u001f" + sanitize(bigText)
            + "\u001f" + sanitize(subText);
    }

    private static final class ProgressSnapshot {
        final String title;
        final String text;
        final String bigText;
        final String subText;
        final boolean busy;
        final String signature;
        final String noticeId;
        final String noticeKind;
        final String noticeTitle;
        final String noticeMessage;

        ProgressSnapshot(String title, String text, String bigText, String subText, boolean busy) {
            this(title, text, bigText, subText, busy, "", "", "", "");
        }

        ProgressSnapshot(
            String title,
            String text,
            String bigText,
            String subText,
            boolean busy,
            String noticeId,
            String noticeKind,
            String noticeTitle,
            String noticeMessage
        ) {
            this.title = title == null ? "" : title;
            this.text = text == null ? "" : text;
            this.bigText = bigText == null ? "" : bigText;
            this.subText = subText == null ? "" : subText;
            this.busy = busy;
            this.signature = (busy ? "busy" : "idle")
                + "\u001f" + this.title
                + "\u001f" + this.text
                + "\u001f" + this.bigText
                + "\u001f" + this.subText;
            this.noticeId = noticeId == null ? "" : noticeId;
            this.noticeKind = noticeKind == null ? "" : noticeKind;
            this.noticeTitle = noticeTitle == null ? "" : noticeTitle;
            this.noticeMessage = noticeMessage == null ? "" : noticeMessage;
        }

        boolean hasNotification() {
            return title.length() > 0 && text.length() > 0 && signature.length() > 0;
        }

        static ProgressSnapshot empty() {
            return new ProgressSnapshot("", "", "", "", false);
        }
    }

}
