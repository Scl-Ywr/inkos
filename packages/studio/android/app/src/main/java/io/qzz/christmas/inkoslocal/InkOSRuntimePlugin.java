package io.qzz.christmas.inkoslocal;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "InkOSRuntime")
public class InkOSRuntimePlugin extends Plugin {
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
    public void requestBatteryOptimizationExemption(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !isIgnoringBatteryOptimizations()) {
                Intent request = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                request.setData(Uri.parse("package:" + getContext().getPackageName()));
                getActivity().startActivity(request);
            } else {
                Intent settings = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                getActivity().startActivity(settings);
            }
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("ignoring", isIgnoringBatteryOptimizations());
            call.resolve(result);
        } catch (Exception error) {
            try {
                Intent settings = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                getActivity().startActivity(settings);
                JSObject result = new JSObject();
                result.put("ok", true);
                result.put("ignoring", isIgnoringBatteryOptimizations());
                call.resolve(result);
            } catch (Exception fallbackError) {
                call.reject(fallbackError.getMessage());
            }
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
}
