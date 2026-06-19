# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin class * { *; }
-keep class io.qzz.christmas.inkoslocal.EmbeddedNodeService { *; }
-keep class io.qzz.christmas.inkoslocal.InkOSRuntimePlugin { *; }

# Mozilla GeckoView 内核
-keep class org.mozilla.geckoview.** { *; }
-keep class org.mozilla.gecko.** { *; }
-keep class org.nanohttpd.** { *; }
-keepclassmembers class fi.iki.elonen.NanoHTTPD$HTTPSession { *; }
-dontwarn org.mozilla.gecko.**
-dontwarn org.nanohttpd.**
