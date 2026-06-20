# 下载功能修复文档 (v1.6.4)

## 问题背景

在 GeckoView 内核下，在线下载更新功能存在多个严重问题：

1. **下载无响应** - 点击下载后一直显示"正在准备下载"
2. **进度条不动** - 下载进度百分比不更新
3. **下载速度不显示** - 速度统计始终为 0
4. **文件重命名失败** - `File.renameTo()` 在 Android 上不可靠
5. **安装按钮无响应** - Capacitor 桥接在 GeckoView 中不可靠
6. **权限按钮无响应** - 同样受 Capacitor 桥接问题影响

## 根本原因

GeckoView 的 WebExtension 架构与标准 Android WebView 不同：

1. **Capacitor 桥接不可靠** - 传统 Capacitor 插件调用在 GeckoView 中经常失败或超时
2. **CustomEvent 通信限制** - content script 和页面之间的 CustomEvent 传递不稳定
3. **content script 轮询问题** - 当 WebExtension Port 连接成功时，下载轮询不会启动

## 解决方案

### 核心思路：绕开所有中间层，直接走 HTTP

放弃 Capacitor 桥接和 CustomEvent 机制，改为页面直接与 NanoHTTPD HTTP 端点通信（与已正常工作的测速功能保持一致）。

### 1. 下载功能修复

**修改前：**
```
页面 → CustomEvent → content script → HTTP 轮询 → NanoHTTPD
```

**修改后：**
```
页面 → POST /__cap_download_apk → NanoHTTPD
页面 ← 轮询 GET /__cap_download_apk/{id} ← NanoHTTPD
```

**关键代码变更 (android-runtime-plugin.ts)：**
- `downloadUpdateApk()` 直接 POST 到 `/__cap_download_apk` 启动下载
- 自行轮询 `GET /__cap_download_apk/{downloadId}` 获取进度
- 使用 AbortController 支持取消下载

### 2. 进度显示修复

**修改前：** 依赖 CustomEvent `__cap_download_progress`（不可靠）

**修改后：** 页面直接轮询 HTTP 端点获取进度数据，通过模块级回调传递给 UI。

**速度计算：**
```typescript
const now = Date.now();
const elapsed = (now - lastTime) / 1000;
const speed = elapsed > 0 ? Math.round((bytesDownloaded - lastBytes) / elapsed) : 0;
```

### 3. 文件重命名修复

**修改前：**
```java
if (!temporary.renameTo(target)) {
    throw new IOException("Failed to rename");
}
```

**修改后：**
```java
try {
    Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
} catch (Exception moveEx) {
    Files.copy(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING);
    temporary.delete();
}
```

**原因：** `File.renameTo()` 在 Android 上跨文件系统边界经常失败。`Files.move()` 更可靠，失败时回退到 copy+delete。

### 4. 安装功能修复

**修改前：** 使用 `InkOSRuntime.installDownloadedApk()` Capacitor 插件

**修改后：** 新增 HTTP 端点 `/__cap_install_apk`

```java
// LocalAssetServer.java
private Response handleInstallApk(IHTTPSession session) {
    // 1. 解析请求获取 APK 路径
    // 2. 检查安装权限
    // 3. 使用 FileProvider 获取 URI
    // 4. 启动系统安装界面
}
```

**前端调用：**
```typescript
const res = await fetch("/__cap_install_apk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
});
```

### 5. 权限设置修复

**修改前：** 使用 `InkOSRuntime.openInstallPermissionSettings()` Capacitor 插件

**修改后：** 新增 HTTP 端点 `/__cap_install_permission`

```java
// LocalAssetServer.java
private Response handleInstallPermissionSettings() {
    Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
    intent.setData(Uri.parse("package:" + packageName));
    startActivity(intent);
}
```

### 6. 权限状态主动检查

下载完成后立即检查安装权限状态，如缺少权限则显示"授权安装权限"按钮：

```typescript
// DoctorView.tsx
getInstallPermissionStatus().then((canInstall) => {
    if (canInstall === false) setNeedsPermission(true);
});
```

## 新增 HTTP 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/__cap_download_apk` | POST | 启动 APK 下载 |
| `/__cap_download_apk/{id}` | GET | 查询下载进度 |
| `/__cap_download_apk/{id}/cancel` | POST | 取消下载 |
| `/__cap_install_apk` | POST | 安装已下载的 APK |
| `/__cap_install_permission` | POST | 打开安装权限设置 |

## 修改的文件

### 前端
- `packages/studio/src/lib/android-runtime-plugin.ts` - 下载、安装、权限逻辑
- `packages/studio/src/pages/DoctorView.tsx` - UI 交互逻辑

### Android 原生
- `packages/studio/android/capacitor-android-x5/capacitor/src/main/java/com/getcapacitor/LocalAssetServer.java` - HTTP 端点实现
- `packages/studio/android/app/src/main/java/io/qzz/christmas/inkoslocal/InkOSRuntimePlugin.java` - 文件重命名修复
- `packages/studio/android/capacitor-android-x5/capacitor/src/main/assets/capacitor-bridge/content.js` - 下载轮询修复

### 配置
- `packages/studio/package.json` - 版本号 1.6.3 → 1.6.4
- `packages/studio/android/app/build.gradle` - 版本号和 versionCode

## 测试验证

1. ✅ 测速功能正常
2. ✅ 下载功能正常
3. ✅ 进度条实时更新
4. ✅ 下载速度正确显示
5. ✅ 下载完成后弹窗自动关闭
6. ✅ 文件保存成功
7. ✅ 安装权限按钮正常工作
8. ✅ 系统安装界面正常弹出
