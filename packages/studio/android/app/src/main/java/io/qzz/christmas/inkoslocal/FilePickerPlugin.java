package io.qzz.christmas.inkoslocal;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import androidx.activity.result.ActivityResultCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;

@CapacitorPlugin(name = "FilePicker")
public class FilePickerPlugin extends Plugin {

    public static final String TAG = "InkOS-FilePicker";
    private PluginCall savedCall;
    private ActivityResultLauncher<Intent> filePickerLauncher;

    @Override
    public void load() {
        super.load();
        Activity activity = getActivity();
        if (activity instanceof AppCompatActivity) {
            AppCompatActivity appCompatActivity = (AppCompatActivity) activity;
            filePickerLauncher = appCompatActivity.registerForActivityResult(
                new ActivityResultContracts.StartActivityForResult(),
                new ActivityResultCallback<ActivityResult>() {
                    @Override
                    public void onActivityResult(ActivityResult result) {
                        handleFilePickerResultFromActivityResult(result);
                    }
                }
            );
        }
    }

    @PluginMethod
    public void pickFile(PluginCall call) {
        savedCall = call;

        String accept = call.getString("accept", "*/*");
        boolean multiple = call.getBoolean("multiple", false);

        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);

        // Set MIME type based on accept string
        if (accept == null || accept.isEmpty() || accept.equals("*") || accept.equals("*/*")) {
            intent.setType("*/*");
        } else if (accept.contains(",")) {
            // Multiple types
            intent.setType("*/*");
            String[] types = accept.split(",");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
        } else if (accept.startsWith("image/") || accept.equals("image/*")) {
            intent.setType("image/*");
        } else {
            intent.setType(accept);
        }

        if (multiple) {
            intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        if (filePickerLauncher != null) {
            filePickerLauncher.launch(intent);
        } else {
            startActivityForResult(call, intent, "handleFilePickerResult");
        }
    }

    private void handleFilePickerResultFromActivityResult(ActivityResult result) {
        if (savedCall == null) {
            return;
        }

        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Intent data = result.getData();
            processResult(data, savedCall);
        } else {
            savedCall.reject("File picker was cancelled");
        }
    }

    @ActivityCallback
    private void handleFilePickerResult(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }

        if (result.getResultCode() == Activity.RESULT_OK && result.getData() != null) {
            Intent data = result.getData();
            processResult(data, call);
        } else {
            call.reject("File picker was cancelled");
        }
    }

    private void processResult(Intent data, PluginCall call) {
        JSObject files = new JSObject();

        try {
            if (data.getClipData() != null) {
                int count = data.getClipData().getItemCount();
                String[] fileUris = new String[count];
                String[] fileNames = new String[count];
                String[] fileTypes = new String[count];

                for (int i = 0; i < count; i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    fileUris[i] = uri.toString();
                    fileNames[i] = getFileName(uri);
                    fileTypes[i] = getContext().getContentResolver().getType(uri);

                    // Take persistable permission
                    try {
                        getContext().getContentResolver().takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    } catch (Exception e) {
                        // Ignore
                    }
                }

                files.put("uris", fileUris);
                files.put("names", fileNames);
                files.put("types", fileTypes);
                files.put("count", count);
            } else if (data.getData() != null) {
                Uri uri = data.getData();
                files.put("uri", uri.toString());
                files.put("name", getFileName(uri));
                files.put("type", getContext().getContentResolver().getType(uri));
                files.put("count", 1);

                // Take persistable permission
                try {
                    getContext().getContentResolver().takePersistableUriPermission(
                        uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                } catch (Exception e) {
                    // Ignore
                }
            }

            call.resolve(files);
        } catch (Exception e) {
            Log.e(TAG, "Error processing result: " + e.getMessage());
            call.reject("Failed to process file picker result", e);
        }
    }

    private String getFileName(Uri uri) {
        String fileName = "";
        if (uri.getPath() != null) {
            fileName = uri.getPath().substring(uri.getPath().lastIndexOf('/') + 1);
        }
        return fileName;
    }
}