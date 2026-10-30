package com.zlcontrol.android;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * Thin first-party Android shell around the existing authenticated Alibaba site.
 * The app never contains exchange secrets and never calls a trading API directly.
 * All transaction control remains on the unchanged original HTTPS site.
 */
public final class MainActivity extends Activity {
    private static final String HOST = "prediction.47-237-188-69.sslip.io";
    private static final String START_URL = "https://" + HOST + "/app/";

    private WebView webView;
    private final List<HttpAuthHandler> pendingAuth = new ArrayList<>();
    private boolean loginDialogOpen = false;
    private String sessionUsername = null;
    private String sessionPassword = null;
    private int cachedCredentialRetry = 0;

    private static boolean isTrusted(Uri uri) {
        return uri != null && "https".equalsIgnoreCase(uri.getScheme())
                && HOST.equalsIgnoreCase(uri.getHost())
                && uri.getPort() == -1;
    }

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(10, 18, 32));
        getWindow().setNavigationBarColor(Color.rgb(11, 22, 37));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(10, 18, 32));
        webView.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSaveFormData(false);
        if (Build.VERSION.SDK_INT >= 26) settings.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(false);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri uri = request.getUrl();
                if (isTrusted(uri)) return false;
                if ("about".equalsIgnoreCase(uri.getScheme())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, "无法打开外部链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler,
                                                  String host, String realm) {
                if (!HOST.equalsIgnoreCase(host)) {
                    handler.cancel();
                    return;
                }
                // WebView may challenge more than one parallel resource during login.
                // Reuse credentials only in memory. Prompt again after retries if invalid.
                if (sessionUsername != null && sessionPassword != null
                        && cachedCredentialRetry < 2 && !loginDialogOpen) {
                    cachedCredentialRetry++;
                    handler.proceed(sessionUsername, sessionPassword);
                    return;
                }
                requestLogin(handler);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (url != null && url.startsWith("https://" + HOST + "/")) {
                    cachedCredentialRetry = 0;
                }
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); // Never allow invalid TLS certificates.
                Toast.makeText(MainActivity.this, "服务器证书验证失败，已阻止连接", Toast.LENGTH_LONG).show();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this,
                            "无法连接阿里云控制台，请检查网络后重试", Toast.LENGTH_LONG).show();
                }
            }
        });
        webView.loadUrl(START_URL);
    }

    private void requestLogin(HttpAuthHandler handler) {
        pendingAuth.add(handler);
        if (loginDialogOpen) return;
        loginDialogOpen = true;

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24), dp(12), dp(24), dp(4));

        EditText username = new EditText(this);
        username.setSingleLine(true);
        username.setText(sessionUsername == null ? "zl" : sessionUsername);
        username.setHint("管理账号");
        username.setInputType(InputType.TYPE_CLASS_TEXT);
        layout.addView(username, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        EditText password = new EditText(this);
        password.setSingleLine(true);
        password.setHint("原有阿里云管理页面密码");
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        layout.addView(password, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        password.requestFocus();

        new AlertDialog.Builder(this)
                .setTitle("登录 ZL Control")
                .setMessage("继续使用原服务器 HTTPS 认证。密码只在当前 App 运行期间临时使用，不写入本地文件。")
                .setView(layout)
                .setCancelable(false)
                .setNegativeButton("取消", (dialog, which) -> {
                    for (HttpAuthHandler h : pendingAuth) h.cancel();
                    pendingAuth.clear();
                    loginDialogOpen = false;
                })
                .setPositiveButton("登录", (dialog, which) -> {
                    sessionUsername = username.getText().toString().trim();
                    sessionPassword = password.getText().toString();
                    cachedCredentialRetry = 0;
                    for (HttpAuthHandler h : pendingAuth) {
                        h.proceed(sessionUsername, sessionPassword);
                    }
                    pendingAuth.clear();
                    loginDialogOpen = false;
                })
                .show();
    }

    private int dp(int n) {
        return Math.round(n * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        sessionUsername = null;
        sessionPassword = null;
        for (HttpAuthHandler h : pendingAuth) h.cancel();
        pendingAuth.clear();
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
