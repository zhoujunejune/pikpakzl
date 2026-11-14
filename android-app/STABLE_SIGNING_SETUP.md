# ZL Control 安卓原生版本的长期覆盖升级签名

## 热更新与原生升级区别
- `mobile-app/**`：发布到同源、登录保护的阿里云 `/app/`，无需下载 APK。网页会在检测到新版本时提示刷新，并在切回前台时自动加载新页面。不能据此替换原生 Java 代码。
- `android-app/**`：Android 只接受应用 ID 相同、签名证书相同且版本号合适的覆盖安装。原生更新一般仍须用户同意安装，但不用清除原 App 数据。
- 历史 1.1.4 是 GitHub 临时 debug keystore 签名，新 stable release 与它签名不同，因此**需要一次性迁移**，之后始终使用同一 release keystore。
- 绝不可将 keystore、私钥或密码提交到 Git 仓库、工作流日志或静态服务器。

## 初次配置（必须由拥有仓库 Secrets 管理权限的人执行）
1. 在可信电脑上用 Android JDK `keytool` 生成独立、长期有效的 PKCS12/JKS 签名文件，妥善备份密钥文件与密码。私钥丢失将无法继续保持同签名覆盖升级。
2. 在 GitHub 仓库的 Actions Secrets 里添加：
   - `ZL_ANDROID_KEYSTORE_B64`：keystore 文件的 base64（**不是公开证书**）
   - `ZL_ANDROID_STORE_PASSWORD`
   - `ZL_ANDROID_KEY_ALIAS`
   - `ZL_ANDROID_KEY_PASSWORD`
3. 第一次 release 构建成功后，核对 apksigner 的 Signer #1 SHA-256 digest，并设置仓库 Actions Variable `ZL_ANDROID_CERT_SHA256` 用于阻止以后意外更换证书。后续每轮都必须保持同一个 signing keystore 与 alias。
4. 用 GitHub workflow `.github/workflows/zl-android-apk.yml` 构建正式 APK：只有全部四项 Secret 可用，才发布标注 `STABLE-RELEASE` 的升级安装包；未配置时仅产生 `DEBUG-ONLY-NOT-UPGRADEABLE` 测试件，**禁止作为手机端更新包分发**。
5. 首次从旧 debug APK 切换正式签名需要卸载旧版（会丢失 App 本地账号/提醒偏好）；之后正式版本的 `versionCode` 只能递增，并用同一个证书覆盖升级，保留手机本地数据。

## 特别说明
- Google Play/系统安全限制仍可能要求用户点击确认安装，不能承诺静默安装。
- 服务器发布热更新仅覆盖前端静态资源，不自动更改或触发五分钟生产下单、十分钟信号决策、交易金额及任何交易接口。
- APP 的事件合约交易仍为「信号提醒 → 打开币安 → 用户手动确认」，不存在非官方静默下单。
