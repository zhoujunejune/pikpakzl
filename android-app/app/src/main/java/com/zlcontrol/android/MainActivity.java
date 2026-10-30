package com.zlcontrol.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.HttpAuthHandler;
import android.webkit.SslErrorHandler;
import android.net.http.SslError;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;

/**
 * Existing ZL HTTPS control panel, plus opt-in local event10 system-alarm monitoring.
 * All order controls remain on Alibaba; native code only reads event10 signal records.
 */
public final class MainActivity extends Activity {
    private static final String HOST="prediction.47-237-188-69.sslip.io";
    private static final String START_URL="https://"+HOST+"/app/";
    private static final int NOTIFICATION_REQUEST=734;
    private WebView webView;
    private Switch alarmToggle;
    private TextView alarmStatus;
    private final AlarmPlayer preview=new AlarmPlayer();
    private final Handler statusHandler=new Handler(Looper.getMainLooper());
    private final List<HttpAuthHandler> pendingAuth=new ArrayList<>();
    private boolean loginDialogOpen=false;
    private boolean suppressToggle=false;
    private boolean pendingEnable=false;
    private String sessionUsername=null;
    private String sessionPassword=null;
    private int cachedCredentialRetry=0;
    private final Runnable statusUpdate=new Runnable(){
        @Override public void run(){
            updateStatus();
            statusHandler.postDelayed(this,3000);
        }
    };

    private static boolean isTrusted(Uri uri){
        return uri!=null&&"https".equalsIgnoreCase(uri.getScheme())
            &&HOST.equalsIgnoreCase(uri.getHost())&&uri.getPort()==-1;
    }
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
    private void toast(String text){Toast.makeText(this,text,Toast.LENGTH_LONG).show();}
    @Override @SuppressLint("SetJavaScriptEnabled")
    public void onCreate(Bundle savedInstanceState){
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(10,18,32));
        getWindow().setNavigationBarColor(Color.rgb(11,22,37));
        LinearLayout outer=new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackgroundColor(Color.rgb(10,18,32));
        setContentView(outer);
        // Android 15+ draws app content behind the status bar by default.
        // Keep the native alarm toggle entirely below system UI on all API levels.
        outer.setOnApplyWindowInsetsListener((view,insets)->{
            final int topInset;
            final int bottomInset;
            if(Build.VERSION.SDK_INT>=30){
                topInset=insets.getInsets(WindowInsets.Type.statusBars()).top;
                bottomInset=insets.getInsets(WindowInsets.Type.navigationBars()).bottom;
            }else{
                topInset=insets.getSystemWindowInsetTop();
                bottomInset=insets.getSystemWindowInsetBottom();
            }
            view.setPadding(0,topInset,0,bottomInset);
            return insets;
        });
        outer.requestApplyInsets();

        LinearLayout top=new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(16),dp(8),dp(16),dp(6));
        top.setBackgroundColor(Color.rgb(17,30,47));
        LinearLayout line=new LinearLayout(this);
        line.setOrientation(LinearLayout.HORIZONTAL);
        line.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title=new TextView(this);
        title.setText("🔔 10分钟信号闹铃");
        title.setTextSize(15);
        title.setTextColor(Color.WHITE);
        title.setTypeface(null,android.graphics.Typeface.BOLD);
        line.addView(title,new LinearLayout.LayoutParams(0,dp(34),1));
        top.addView(line);

        // Full-width dedicated row: the control must not hide behind the status bar.
        LinearLayout toggleLine=new LinearLayout(this);
        toggleLine.setGravity(android.view.Gravity.CENTER_VERTICAL);
        toggleLine.setOrientation(LinearLayout.HORIZONTAL);
        TextView toggleHint=new TextView(this);
        toggleHint.setText("仅新 Higher / Lower 信号提醒");
        toggleHint.setTextSize(12);
        toggleHint.setTextColor(Color.rgb(171,200,229));
        toggleLine.addView(toggleHint,new LinearLayout.LayoutParams(0,dp(44),1));
        alarmToggle=new Switch(this);
        alarmToggle.setText("关闭");
        alarmToggle.setTextSize(14);
        alarmToggle.setTextColor(Color.WHITE);
        alarmToggle.setMinWidth(dp(118));
        alarmToggle.setPadding(dp(8),0,dp(8),0);
        alarmToggle.setContentDescription("十分钟事件合约有信号才响铃，开关");
        toggleLine.addView(alarmToggle,new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,dp(48)));
        top.addView(toggleLine);

        LinearLayout bottom=new LinearLayout(this);
        bottom.setOrientation(LinearLayout.HORIZONTAL);
        bottom.setGravity(android.view.Gravity.CENTER_VERTICAL);
        alarmStatus=new TextView(this);
        alarmStatus.setTextSize(11);
        alarmStatus.setTextColor(Color.rgb(156,182,211));
        bottom.addView(alarmStatus,new LinearLayout.LayoutParams(0,dp(36),1));
        Button test=new Button(this);
        test.setAllCaps(false);
        test.setText("试听");
        test.setTextSize(11);
        test.setOnClickListener(v->{
            if(preview.play(this,5))toast("试听系统闹钟铃声（5秒）");
            else toast("未读取到系统闹钟铃声，请在手机设置中选择铃声");
        });
        bottom.addView(test,new LinearLayout.LayoutParams(dp(66),dp(42)));
        Button settings=new Button(this);
        settings.setAllCaps(false);
        settings.setText("闹铃设置");
        settings.setTextSize(11);
        settings.setOnClickListener(v->{
            try{startActivity(new Intent(Settings.ACTION_SOUND_SETTINGS));}
            catch(ActivityNotFoundException e){toast("请从手机设置调整闹铃音量与铃声");}
        });
        bottom.addView(settings,new LinearLayout.LayoutParams(dp(96),dp(42)));
        top.addView(bottom);

        // User-visible observability: distinguish switch-on from actual successful polling.
        Button diagnose=new Button(this);
        diagnose.setAllCaps(false);
        diagnose.setText("查看提醒诊断（最近读取 / 最新信号 / 漏提醒原因）");
        diagnose.setTextSize(11);
        diagnose.setOnClickListener(v->showAlarmDiagnostics());
        top.addView(diagnose,new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,dp(40)));
        outer.addView(top);

        alarmToggle.setChecked(SecureStore.prefs(this)
            .getBoolean(SignalAlertService.PREF_ENABLED,false));
        alarmToggle.setText(alarmToggle.isChecked()?"开启":"关闭");
        alarmToggle.setOnCheckedChangeListener((button,checked)->{
            alarmToggle.setText(checked?"开启":"关闭");
            if(suppressToggle)return;
            if(checked)tryEnable();
            else{
                SecureStore.prefs(this).edit()
                    .putBoolean(SignalAlertService.PREF_ENABLED,false).apply();
                SignalAlertService.stop(this);
                updateStatus();
            }
        });

        webView=new WebView(this);
        webView.setBackgroundColor(Color.rgb(10,18,32));
        outer.addView(webView,new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,0,1));
        WebSettings ws=webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);
        ws.setSupportMultipleWindows(false);
        ws.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        ws.setSaveFormData(false);
        if(Build.VERSION.SDK_INT>=26)ws.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(false);
        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(!request.isForMainFrame())return false;
                Uri uri=request.getUrl();
                if(isTrusted(uri))return false;
                if("about".equalsIgnoreCase(uri.getScheme()))return false;
                try{startActivity(new Intent(Intent.ACTION_VIEW,uri));}
                catch(ActivityNotFoundException e){toast("无法打开外部链接");}
                return true;
            }
            @Override public void onReceivedHttpAuthRequest(WebView view,HttpAuthHandler handler,
                                                             String host,String realm){
                if(!HOST.equalsIgnoreCase(host)){handler.cancel();return;}
                if(sessionUsername!=null&&sessionPassword!=null
                    &&cachedCredentialRetry<2&&!loginDialogOpen){
                    cachedCredentialRetry++;
                    handler.proceed(sessionUsername,sessionPassword);
                    return;
                }
                requestLogin(handler);
            }
            @Override public void onPageFinished(WebView view,String url){
                super.onPageFinished(view,url);
                if(url!=null&&url.startsWith("https://"+HOST+"/"))cachedCredentialRetry=0;
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){
                handler.cancel();
                toast("服务器 HTTPS 证书无效，已拒绝连接");
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest req,WebResourceError err){
                if(req.isForMainFrame())toast("无法连接阿里云控制台，请检查网络");
            }
        });
        webView.loadUrl(START_URL);
    }
    private void updateStatus(){
        boolean enabled=SecureStore.prefs(this)
            .getBoolean(SignalAlertService.PREF_ENABLED,false);
        if(alarmToggle!=null){
            if(alarmToggle.isChecked()!=enabled){
                suppressToggle=true;alarmToggle.setChecked(enabled);suppressToggle=false;
            }
            alarmToggle.setText(enabled?"开启":"关闭");
        }
        if(alarmStatus!=null){
            String status=enabled?SecureStore.prefs(this).getString(
                SignalAlertService.PREF_LAST_STATE,"正在连接后台信号服务…"):
                "关闭时不响铃 · 开启后系统通知+闹铃（最多25秒）";
            if(enabled){
                long last=SecureStore.prefs(this).getLong(SignalAlertService.PREF_LAST_POLL,0L);
                long since=SecureStore.prefs(this).getLong(SignalAlertService.PREF_ENABLED_SINCE,0L);
                long age=System.currentTimeMillis()-(last>0?last:since);
                if(age>40000L)status="⚠ 后台监听已中断超过40秒，点下方查看诊断";
            }
            alarmStatus.setText(status);
        }
    }
    private String timeOf(long timestamp){
        if(timestamp<=0)return "无记录";
        return new java.text.SimpleDateFormat("MM-dd HH:mm:ss",java.util.Locale.CHINA)
            .format(new java.util.Date(timestamp));
    }

    private void showAlarmDiagnostics(){
        android.content.SharedPreferences p=SecureStore.prefs(this);
        boolean enabled=p.getBoolean(SignalAlertService.PREF_ENABLED,false);
        long lastPoll=p.getLong(SignalAlertService.PREF_LAST_POLL,0L);
        long lastSuccess=p.getLong(SignalAlertService.PREF_LAST_SUCCESS,0L);
        long lastSignal=p.getLong(SignalAlertService.PREF_LAST_SEEN_TIME,0L);
        long lastAlarm=p.getLong(SignalAlertService.PREF_LAST_ALARM_TIME,0L);
        boolean notifyAllowed=true;
        if(Build.VERSION.SDK_INT>=33&&
           checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)
           notifyAllowed=false;
        NotificationManager manager=getSystemService(NotificationManager.class);
        if(manager!=null&&!manager.areNotificationsEnabled())notifyAllowed=false;
        boolean batteryUnrestricted=false;
        PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);
        if(pm!=null&&Build.VERSION.SDK_INT>=23)
            batteryUnrestricted=pm.isIgnoringBatteryOptimizations(getPackageName());
        String report="监控开关："+(enabled?"开启":"关闭")+
            "\n后台最后尝试："+timeOf(lastPoll)+
            "\n后台最后成功："+timeOf(lastSuccess)+
            "\n最近信号："+timeOf(lastSignal)+
            "\n最近信号ID："+p.getString(SignalAlertService.PREF_LAST_SEEN,"无")+
            "\n上次闹铃："+timeOf(lastAlarm)+
            "\n上次闹铃ID："+p.getString(SignalAlertService.PREF_LAST_ALARM,"无")+
            "\n最近判断："+p.getString(SignalAlertService.PREF_LAST_REASON,"暂无")+
            "\n读取错误："+p.getString(SignalAlertService.PREF_LAST_ERROR,"无")+
            "\n系统通知："+(notifyAllowed?"已授权":"已关闭/未授权")+
            "\n忽略电池优化："+(batteryUnrestricted?"是":"否，锁屏后可能暂停");
        new AlertDialog.Builder(this).setTitle("10分钟信号提醒诊断")
            .setMessage(report).setPositiveButton("知道了",null)
            .setNeutralButton("后台权限设置",(dialog,which)->{
                try{startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));}
                catch(Exception e){toast("请到手机设置 → 应用 → ZL Control → 电池 设置允许后台运行");}
            }).show();
    }

    private void tryEnable(){
        if(SecureStore.loadLogin(this)==null){
            toast("请先在下方登录原阿里云控制台，再开启闹铃");
            setToggle(false);return;
        }
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
             !=PackageManager.PERMISSION_GRANTED){
            pendingEnable=true;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS},NOTIFICATION_REQUEST);
            return;
        }
        enableNow();
    }
    private void setToggle(boolean checked){
        suppressToggle=true;
        alarmToggle.setChecked(checked);
        alarmToggle.setText(checked?"开启":"关闭");
        suppressToggle=false;
    }
    private void enableNow(){
        SecureStore.prefs(this).edit()
            .remove(SignalAlertService.PREF_LAST_ID)
            .remove(SignalAlertService.PREF_LAST_POLL)
            .remove(SignalAlertService.PREF_LAST_SUCCESS)
            .remove(SignalAlertService.PREF_LAST_ERROR)
            .remove(SignalAlertService.PREF_LAST_REASON)
            .putLong(SignalAlertService.PREF_ENABLED_SINCE,System.currentTimeMillis())
            .putBoolean(SignalAlertService.PREF_ENABLED,true)
            .putString(SignalAlertService.PREF_LAST_STATE,"正在启动监控…").apply();
        try{
            SignalAlertService.start(this);
            toast("10分钟信号闹铃已开启。系统会显示持续监听通知。");
        }catch(Exception e){
            SecureStore.prefs(this).edit().putBoolean(SignalAlertService.PREF_ENABLED,false).apply();
            setToggle(false);
            toast("后台监听无法启动，请检查通知和系统后台运行权限");
        }
        updateStatus();
    }
    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] results){
        super.onRequestPermissionsResult(requestCode,permissions,results);
        if(requestCode!=NOTIFICATION_REQUEST)return;
        boolean allowed=results.length>0&&results[0]==PackageManager.PERMISSION_GRANTED;
        if(pendingEnable&&allowed)enableNow();
        else{
            setToggle(false);
            toast("未授权通知权限，信号闹铃保持关闭");
        }
        pendingEnable=false;
    }
    private void requestLogin(HttpAuthHandler handler){
        pendingAuth.add(handler);
        if(loginDialogOpen)return;
        loginDialogOpen=true;
        LinearLayout layout=new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(24),dp(12),dp(24),dp(4));
        EditText username=new EditText(this);
        username.setSingleLine(true);
        username.setText(sessionUsername==null?"zl":sessionUsername);
        username.setHint("原管理账号");
        username.setInputType(InputType.TYPE_CLASS_TEXT);
        layout.addView(username);
        EditText password=new EditText(this);
        password.setSingleLine(true);
        password.setHint("原管理密码");
        password.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        layout.addView(password);
        password.requestFocus();
        new AlertDialog.Builder(this)
            .setTitle("登录 ZL Control")
            .setMessage("为支持关屏后的信号提醒，App 使用安卓 Keystore 加密保管登录凭证；不保存交易 API 密钥。")
            .setView(layout).setCancelable(false)
            .setNegativeButton("取消",(dialog,which)->{
                for(HttpAuthHandler h:pendingAuth)h.cancel();
                pendingAuth.clear();loginDialogOpen=false;
            })
            .setPositiveButton("登录",(dialog,which)->{
                sessionUsername=username.getText().toString().trim();
                sessionPassword=password.getText().toString();
                try{SecureStore.saveLogin(this,sessionUsername,sessionPassword);}
                catch(Exception ex){toast("保存后台认证信息失败；信号提醒将不可用");}
                cachedCredentialRetry=0;
                for(HttpAuthHandler h:pendingAuth)h.proceed(sessionUsername,sessionPassword);
                pendingAuth.clear();loginDialogOpen=false;
                if(SecureStore.prefs(this).getBoolean(SignalAlertService.PREF_ENABLED,false)){
                    try{SignalAlertService.start(this);}catch(Exception ignored){}
                }
            }).show();
    }
    @Override protected void onResume(){
        super.onResume();
        statusHandler.removeCallbacks(statusUpdate);
        statusHandler.post(statusUpdate);
        if(SecureStore.prefs(this).getBoolean(SignalAlertService.PREF_ENABLED,false)
            &&SecureStore.loadLogin(this)!=null){
            try{SignalAlertService.start(this);}catch(Exception ignored){}
        }
    }
    @Override protected void onPause(){
        statusHandler.removeCallbacks(statusUpdate);
        super.onPause();
    }
    @Override public void onBackPressed(){
        if(webView!=null&&webView.canGoBack())webView.goBack();
        else super.onBackPressed();
    }
    @Override protected void onDestroy(){
        preview.stop();
        statusHandler.removeCallbacks(statusUpdate);
        sessionUsername=null;sessionPassword=null;
        for(HttpAuthHandler h:pendingAuth)h.cancel();
        pendingAuth.clear();
        if(webView!=null){webView.stopLoading();webView.destroy();webView=null;}
        super.onDestroy();
    }
}
