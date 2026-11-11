package com.zlcontrol.android;

import android.Manifest;
import android.annotation.SuppressLint;
import android.webkit.JavascriptInterface;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.widget.ImageView;
import android.view.Gravity;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.app.NotificationManager;
import android.app.NotificationChannel;
import android.content.ClipboardManager;
import android.content.ClipData;
import org.json.JSONArray;
import org.json.JSONObject;
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
    private static final String START_URL="https://"+HOST+"/app/genius.html";
    private static final String EVENT10_URL="https://"+HOST+"/app/#event10";
    private static final int NOTIFICATION_REQUEST=734;
    public static final String ACTION_OPEN_BINANCE="com.zlcontrol.android.OPEN_BINANCE_MANUAL";
    public static final String ACTION_VIEW_EVENT10="com.zlcontrol.android.VIEW_EVENT10";
    private static final String BINANCE_PACKAGE="com.binance.dev";
    private WebView webView;
    private LinearLayout alarmContainer;
    private Switch alarmToggle;
    private TextView alarmStatus;
    private final AlarmPlayer preview=new AlarmPlayer();

    /**
     * Intentionally tiny WebView bridge. This device-local preference cannot
     * read secrets, trigger orders, modify server data or affect model output.
     * Website/PWA browsers without this bridge show the setting as unavailable.
     */
    private final class AlertSettingsBridge {
        @JavascriptInterface public boolean getReverseAlertsEnabled() {
            return SecureStore.prefs(MainActivity.this)
                .getBoolean(SignalAlertService.PREF_REVERSE_ALERT,false);
        }
        @JavascriptInterface public boolean setReverseAlertsEnabled(boolean enabled) {
            return SecureStore.prefs(MainActivity.this).edit()
                .putBoolean(SignalAlertService.PREF_REVERSE_ALERT,enabled).commit();
        }
    }
    /** Native-only counter: a press is one user's own declaration of a completed trade. */
    private final class RealTradeBridge {
        private final TradeJournal journal=new TradeJournal(MainActivity.this);
        @JavascriptInterface public String getSnapshot() {return journal.snapshot();}
        @JavascriptInterface public String confirmRealTrade() {return journal.record();}
        @JavascriptInterface public String undoLastToday() {return journal.undoLastToday();}
    }
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
    private GradientDrawable rounded(int fill,int stroke,int radius){
        GradientDrawable bg=new GradientDrawable();
        bg.setColor(fill);
        bg.setCornerRadius(dp(radius));
        bg.setStroke(dp(1),stroke);
        return bg;
    }
    private void styleButton(Button button,boolean primary){
        button.setAllCaps(false);
        button.setTextSize(12);
        button.setTextColor(primary?Color.WHITE:Color.rgb(32,110,170));
        button.setBackground(rounded(primary?Color.rgb(35,139,219):Color.rgb(242,249,255),
            primary?Color.rgb(35,139,219):Color.rgb(205,228,246),12));
    }
    @Override @SuppressLint("SetJavaScriptEnabled")
    public void onCreate(Bundle savedInstanceState){
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(222,240,255));
        getWindow().setNavigationBarColor(Color.rgb(241,249,255));
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR|View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        LinearLayout outer=new LinearLayout(this);
        outer.setOrientation(LinearLayout.VERTICAL);
        outer.setBackgroundColor(Color.rgb(234,246,255));
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

        // Compact light-ocean native watcher bar; the large optional diagnostic
        // actions are collapsed to leave the signal dashboard most of the screen.
        LinearLayout top=new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(14),dp(7),dp(14),dp(7));
        top.setBackgroundColor(Color.rgb(235,246,255));
        LinearLayout row=new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        TextView title=new TextView(this);
        title.setText("🔔 信号闹铃");
        title.setTextSize(14);
        title.setTextColor(Color.rgb(19,57,89));
        title.setTypeface(null,android.graphics.Typeface.BOLD);
        row.addView(title,new LinearLayout.LayoutParams(0,dp(38),1));
        alarmToggle=new Switch(this);
        alarmToggle.setText("关闭");
        alarmToggle.setTextSize(13);
        alarmToggle.setTextColor(Color.rgb(30,88,132));
        alarmToggle.setMinWidth(dp(112));
        alarmToggle.setPadding(dp(6),0,dp(6),0);
        alarmToggle.setContentDescription("十分钟事件合约有信号才响铃，开关");
        row.addView(alarmToggle,new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,dp(42)));
        top.addView(row);

        LinearLayout statusRow=new LinearLayout(this);
        statusRow.setGravity(Gravity.CENTER_VERTICAL);
        statusRow.setOrientation(LinearLayout.HORIZONTAL);
        alarmStatus=new TextView(this);
        alarmStatus.setTextSize(11);
        alarmStatus.setMaxLines(2);
        alarmStatus.setTextColor(Color.rgb(82,121,151));
        statusRow.addView(alarmStatus,new LinearLayout.LayoutParams(0,dp(34),1));
        Button manage=new Button(this);
        manage.setText("提醒管理 ▾");
        styleButton(manage,false);
        statusRow.addView(manage,new LinearLayout.LayoutParams(dp(110),dp(36)));
        top.addView(statusRow);

        LinearLayout advanced=new LinearLayout(this);
        advanced.setOrientation(LinearLayout.VERTICAL);
        advanced.setPadding(0,dp(6),0,0);
        advanced.setVisibility(View.GONE);
        LinearLayout actions=new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER_VERTICAL);
        Button binance=new Button(this);
        binance.setText("打开币安");
        styleButton(binance,true);
        binance.setContentDescription("打开币安App，手动确认10分钟事件合约下单");
        binance.setOnClickListener(v->launchBinance());
        actions.addView(binance,new LinearLayout.LayoutParams(0,dp(42),1));
        Button test=new Button(this);
        test.setText("试听");
        styleButton(test,false);
        test.setOnClickListener(v->{
            if(preview.play(this,5))toast("试听系统闹钟铃声（5秒）");
            else toast("未读取到系统闹钟铃声，请在手机设置中选择铃声");
        });
        LinearLayout.LayoutParams testLp=new LinearLayout.LayoutParams(0,dp(42),1);
        testLp.leftMargin=dp(7);
        actions.addView(test,testLp);
        Button settings=new Button(this);
        settings.setText("闹铃设置");
        styleButton(settings,false);
        settings.setOnClickListener(v->{
            try{startActivity(new Intent(Settings.ACTION_SOUND_SETTINGS));}
            catch(ActivityNotFoundException e){toast("请从手机设置调整闹铃音量与铃声");}
        });
        LinearLayout.LayoutParams settingsLp=new LinearLayout.LayoutParams(0,dp(42),1);
        settingsLp.leftMargin=dp(7);
        actions.addView(settings,settingsLp);
        advanced.addView(actions);
        Button diagnose=new Button(this);
        diagnose.setText("查看提醒诊断（最近读取、通知延迟、漏提醒原因）");
        styleButton(diagnose,false);
        diagnose.setOnClickListener(v->showAlarmDiagnostics());
        LinearLayout.LayoutParams diagLp=new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,dp(41));
        diagLp.topMargin=dp(7);
        advanced.addView(diagnose,diagLp);
        Button overlayAccess=new Button(this);
        overlayAccess.setText("屏幕弹窗权限 · 后台显示提醒");
        styleButton(overlayAccess,false);
        overlayAccess.setOnClickListener(v->openOverlayPermissionSettings());
        LinearLayout.LayoutParams overlayLp=new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,dp(41));
        overlayLp.topMargin=dp(7);
        advanced.addView(overlayAccess,overlayLp);
        top.addView(advanced);
        manage.setOnClickListener(v->{
            boolean expanded=advanced.getVisibility()!=View.VISIBLE;
            advanced.setVisibility(expanded?View.VISIBLE:View.GONE);
            manage.setText(expanded?"收起 ▴":"提醒管理 ▾");
        });
        outer.addView(top);
        alarmContainer=top;
        // The AI autonomous trading screen has its own toggle; legacy EVENT10 alarm controls
        // appear only on the legacy EVENT10 page, keeping the two-field AI UI uncluttered.
        top.setVisibility(View.GONE);

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
        webView.addJavascriptInterface(new AlertSettingsBridge(),"HaipaiAlertPrefs");
        webView.addJavascriptInterface(new RealTradeBridge(),"HaipaiRealTrades");
        webView.setBackgroundColor(Color.rgb(234,246,255));
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
                if(alarmContainer!=null&&url!=null&&isTrusted(Uri.parse(url))){
                    boolean genius="/app/genius.html".equals(Uri.parse(url).getPath());
                    alarmContainer.setVisibility(genius?View.GONE:View.VISIBLE);
                }
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){
                handler.cancel();
                toast("服务器 HTTPS 证书无效，已拒绝连接");
            }
            @Override public void onReceivedError(WebView view,WebResourceRequest req,WebResourceError err){
                if(req.isForMainFrame())toast("无法连接阿里云控制台，请检查网络");
            }
        });
        Intent launchIntent=getIntent();
        boolean fromSignal=launchIntent!=null&&
            (ACTION_OPEN_BINANCE.equals(launchIntent.getAction())||
             ACTION_VIEW_EVENT10.equals(launchIntent.getAction()));
        webView.loadUrl(fromSignal?EVENT10_URL:START_URL);
        if(launchIntent!=null&&ACTION_OPEN_BINANCE.equals(launchIntent.getAction()))
            statusHandler.post(this::launchBinance);
    }
    @Override protected void onNewIntent(Intent intent){
        super.onNewIntent(intent);
        setIntent(intent);
        if(intent==null)return;
        if(ACTION_OPEN_BINANCE.equals(intent.getAction()))launchBinance();
        else if(ACTION_VIEW_EVENT10.equals(intent.getAction())&&webView!=null)
            webView.loadUrl(EVENT10_URL);
    }
    private void launchBinance(){
        // Only launch Binance's installed official app; never inject orders,
        // auto-fill a direction/amount, or use unofficial event-contract APIs.
        try{
            Intent launch=getPackageManager().getLaunchIntentForPackage(BINANCE_PACKAGE);
            if(launch==null){
                toast("未检测到官方币安 App，请先安装或更新，然后前往 合约→事件→BTC→10分钟");
                return;
            }
            startActivity(launch);
        }catch(Exception e){
            toast("无法打开币安，请手动启动币安 App，进入 合约→事件→BTC→10分钟");
        }
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
                long lastSuccess=SecureStore.prefs(this).getLong(SignalAlertService.PREF_LAST_SUCCESS,0L);
                long since=SecureStore.prefs(this).getLong(SignalAlertService.PREF_ENABLED_SINCE,0L);
                long now=System.currentTimeMillis();
                if(now-Math.max(last,since)>35000L){
                    status="⚠ 后台监听超过35秒未运行，请检查后台权限和网络";
                }else if(now-Math.max(lastSuccess>=since?lastSuccess:0L,since)>45000L){
                    status="⚠ 超过45秒未完成信号同步，请查看提醒诊断";
                }
            }
            alarmStatus.setText(status);
        }
    }
    private String timeOf(long timestamp){
        if(timestamp<=0)return "无记录";
        return new java.text.SimpleDateFormat("MM-dd HH:mm:ss",java.util.Locale.CHINA)
            .format(new java.util.Date(timestamp));
    }

    private String alarmReason(String reason){
        switch(reason){
            case "RING_STARTED":return "已启动系统铃声";
            case "SOUND_FAILED_NOTICE_ONLY":return "通知已发出，但系统铃声播放失败";
            case "BEFORE_ENABLED":return "信号发生在本次开启提醒之前（历史信号）";
            case "MISSED_EXPIRED":return "后台恢复时信号过期或太晚，已记录但未补响";
            case "DELAYED_ALERT":return "新信号发现延迟超过15秒";
            case "SIGNAL_TOO_LATE":return "信号产生超过120秒，不再当新信号提醒";
            case "SIGNAL_EXPIRED":return "发现信号时已超过到期时间";
            case "NO_NOTIFICATION_PERMISSION":return "没有系统通知权限";
            case "ALARM_CHANNEL_DISABLED":return "信号提醒通知渠道已被关闭";
            case "NOTIFICATIONS_DISABLED":return "App 系统通知已关闭";
            case "POLL_ERROR":return "后台服务器请求失败";
            case "POPUP_CONFIRMED_BINANCE":return "已确认弹窗，结束本次提醒并打开币安";
            case "POPUP_BINANCE_LAUNCH_FAILED":return "已停止本次提醒，但系统未允许启动币安";
            case "SIGNAL_TOO_OLD":return "信号过旧，不再提醒";
            case "BLOCKED":return "信号被提醒条件拦截";
            default:return reason==null||reason.isEmpty()?"暂无":reason;
        }
    }
    private int pendingReceiptCount(android.content.SharedPreferences p){
        try{return new JSONArray(p.getString(SignalAlertService.PREF_PENDING_RECEIPTS,"[]")).length();}
        catch(Exception e){return -1;}
    }
    private String directionName(String direction){
        return "UP".equals(direction)?"看涨↑":
            "DOWN".equals(direction)?"看跌↓":direction;
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
        StringBuilder log=new StringBuilder();
        int recentRings=0,lateRings=0,missedSignals=0,requestFailures=0;
        long largestDelayMs=0L;
        try{
            JSONArray audit=new JSONArray(p.getString(SignalAlertService.PREF_AUDIT_TRAIL,"[]"));
            for(int i=0;i<audit.length();i++){
                JSONObject e=audit.optJSONObject(i);if(e==null)continue;
                String action=e.optString("action","");
                if("RING_STARTED".equals(action)||"SOUND_FAILED_NOTICE_ONLY".equals(action)){
                    recentRings++;
                    long t=e.optLong("time",0L),opened=e.optLong("openedAt",0L);
                    if(t>opened&&opened>0L){long delay=t-opened;
                        largestDelayMs=Math.max(largestDelayMs,delay);
                        if(delay>15_000L)lateRings++;}
                }
                if("MISSED_EXPIRED".equals(action))missedSignals++;
                if("POLL_ERROR".equals(action))requestFailures++;
            }
            for(int i=audit.length()-1;i>=Math.max(0,audit.length()-7);i--){
                JSONObject e=audit.optJSONObject(i);
                if(e==null)continue;
                String action=e.optString("action","");
                log.append("\n")
                    .append(timeOf(e.optLong("time",0L))).append(" ")
                    .append(alarmReason(action)).append(" ")
                    .append(directionName(e.optString("detail","")));
            }
        }catch(Exception e){log.append("\n日志读取失败");}
        if(log.length()==0)log.append("\n暂无提醒事件");
        String report="监控开关："+(enabled?"开启":"关闭")+
            "\n反向信号提醒："+(p.getBoolean(SignalAlertService.PREF_REVERSE_ALERT,false)?"已开启（仅通知显示反向）":"关闭（按原信号提醒）")+
            "\n最近提醒原模型方向："+directionName(p.getString("event10_alert_last_original_direction","无"))+
            "\n最近实际提醒方向："+directionName(p.getString("event10_alert_last_displayed_direction","无"))+
            "\n本次开启时间："+timeOf(p.getLong(SignalAlertService.PREF_ENABLED_SINCE,0L))+
            "\n后台最后尝试："+timeOf(lastPoll)+
            "\n后台最后成功："+timeOf(lastSuccess)+
            "\n提醒获取模式："+p.getString(SignalAlertService.PREF_WATCH_MODE,"未读取")+
            "\n最近完整对账："+timeOf(p.getLong(SignalAlertService.PREF_LAST_FULL_SYNC,0L))+
            "\n服务器回执状态："+p.getString(SignalAlertService.PREF_LAST_ACK_STATE,"未发送")+
            "\n最近服务器确认："+timeOf(p.getLong(SignalAlertService.PREF_LAST_ACK_TIME,0L))+
            "\n待上传回执："+pendingReceiptCount(p)+
            "\n最近接口耗时："+p.getLong(SignalAlertService.PREF_LAST_API_LATENCY_MS,0L)+"毫秒"+
            "\n最近信号通知延迟："+(lastAlarm>0?p.getLong(SignalAlertService.PREF_LAST_ALARM_DELAY_MS,0L)+"毫秒":"无记录")+
            "\n本机近期已发提醒："+recentRings+"次（发现延迟>15秒："+lateRings+"次，最长："+largestDelayMs+"毫秒）"+
            "\n本机近期漏提醒/过晚："+missedSignals+"次，接口失败审计："+requestFailures+"次"+
            "\n最近信号："+timeOf(lastSignal)+
            "\n最近信号ID："+p.getString(SignalAlertService.PREF_LAST_SEEN,"无")+
            "\n上次闹铃："+timeOf(lastAlarm)+
            "\n上次闹铃ID："+p.getString(SignalAlertService.PREF_LAST_ALARM,"无")+
            "\n最近判断："+alarmReason(p.getString(SignalAlertService.PREF_LAST_REASON,"暂无"))+
            "\n读取错误："+p.getString(SignalAlertService.PREF_LAST_ERROR,"无")+
            "\n系统闹钟音量："+p.getInt("event10_alert_alarm_volume",-1)+"/"+p.getInt("event10_alert_alarm_max_volume",-1)+
            "\n系统通知："+(notifyAllowed?"已授权":"已关闭/未授权")+
            "\n屏幕中央悬浮弹窗："+(Settings.canDrawOverlays(this)?"已授权":"未授权，将仅显示系统通知")+
            "\n忽略电池优化："+(batteryUnrestricted?"是":"否，锁屏后可能暂停")+
            "\n\n最近提醒审计记录："+log;
        new AlertDialog.Builder(this).setTitle("10分钟信号提醒诊断")
            .setMessage(report).setPositiveButton("知道了",null)
            .setNegativeButton("复制诊断",(dialog,which)->{
                ClipboardManager clipboard=(ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
                if(clipboard!=null){
                    clipboard.setPrimaryClip(ClipData.newPlainText("ZL信号提醒诊断",report));
                    toast("已复制诊断记录（不包含账号密码）");
                }
            })
            .setNeutralButton("后台权限设置",(dialog,which)->openBackgroundSettings())
            .show();
    }

    private void openOverlayPermissionSettings(){
        try{
            Intent request=new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:"+getPackageName()));
            startActivity(request);
        }catch(Exception e){
            try{startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:"+getPackageName())));}
            catch(Exception ignored){toast("请在手机设置中允许 ZL EVENT10 显示在其他应用上层");}
        }
    }
    private void showOverlayPermissionAdvice(){
        if(Settings.canDrawOverlays(this))return;
        new AlertDialog.Builder(this)
            .setTitle("开启信号居中弹窗")
            .setMessage("你已开启信号提醒。要让新 Higher / Lower 信号出现在其他应用的屏幕中央，"
                +"还需要允许 ZL EVENT10“显示在其他应用上层”。"
                +"\n\n未授权时会继续使用普通系统通知和铃声；锁屏及部分系统场景可能限制弹窗。"
                +"\n\n点击弹窗“确认并打开币安”后，本次响铃和弹窗都会结束，不会自动下单。")
            .setPositiveButton("去授权悬浮窗",(dialog,which)->openOverlayPermissionSettings())
            .setNegativeButton("暂时只用通知",null)
            .show();
    }
    private void openBackgroundSettings(){
        try{
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }catch(Exception e){
            try{startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:"+getPackageName())));}
            catch(Exception ignored){toast("请到手机设置 → 应用 → ZL EVENT10 → 电池 设置允许后台运行");}
        }
    }
    private void showBackgroundPermissionAdvice(){
        PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);
        if(pm==null||pm.isIgnoringBatteryOptimizations(getPackageName()))return;
        new AlertDialog.Builder(this)
            .setTitle("请允许后台运行，避免漏掉新信号")
            .setMessage("你的手机此前显示未忽略电池优化。系统可能在锁屏时暂停每2秒检查一次的监听。"
                +"\n\n建议在系统电池设置里为 ZL EVENT10 开启“无限制 / 允许后台运行”，"
                +"并允许开机自启动（手机提供时）。否则无法保证及时提醒。")
            .setPositiveButton("去设置",(dialog,which)->openBackgroundSettings())
            .setNegativeButton("稍后",null)
            .show();
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
            showBackgroundPermissionAdvice();
            showOverlayPermissionAdvice();
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
        // Preserve original Caddy HTTP Basic Auth and encrypted Keystore
        // storage. This is visual styling only, not a new login protocol.
        LinearLayout layout=new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(dp(22),dp(10),dp(22),dp(7));
        layout.setBackgroundColor(Color.WHITE);

        ImageView mascot=new ImageView(this);
        mascot.setImageResource(R.drawable.sea_friends_icon);
        mascot.setScaleType(ImageView.ScaleType.CENTER_CROP);
        mascot.setBackground(rounded(Color.rgb(234,246,255),Color.rgb(211,231,247),14));
        LinearLayout.LayoutParams mascotLp=new LinearLayout.LayoutParams(dp(62),dp(62));
        mascotLp.gravity=Gravity.CENTER_HORIZONTAL;
        mascotLp.bottomMargin=dp(10);
        layout.addView(mascot,mascotLp);
        TextView subtitle=new TextView(this);
        subtitle.setText("欢迎来到海派合约天才");
        subtitle.setTextSize(17);
        subtitle.setTypeface(null,android.graphics.Typeface.BOLD);
        subtitle.setTextColor(Color.rgb(21,61,95));
        subtitle.setGravity(Gravity.CENTER);
        layout.addView(subtitle);
        TextView secondary=new TextView(this);
        secondary.setText("使用原有管理账号安全登录");
        secondary.setTextSize(12);
        secondary.setTextColor(Color.rgb(102,132,157));
        secondary.setGravity(Gravity.CENTER);
        secondary.setPadding(0,dp(4),0,dp(17));
        layout.addView(secondary);

        EditText username=new EditText(this);
        username.setSingleLine(true);
        username.setText(sessionUsername==null?"zl":sessionUsername);
        username.setHint("管理账号");
        username.setTextSize(15);
        username.setTextColor(Color.rgb(24,62,91));
        username.setHintTextColor(Color.rgb(135,158,178));
        username.setPadding(dp(14),0,dp(12),0);
        username.setBackground(rounded(Color.rgb(247,251,255),Color.rgb(217,235,248),11));
        username.setInputType(InputType.TYPE_CLASS_TEXT);
        LinearLayout.LayoutParams unameLp=new LinearLayout.LayoutParams(-1,dp(51));
        layout.addView(username,unameLp);

        EditText password=new EditText(this);
        password.setSingleLine(true);
        password.setHint("管理密码");
        password.setTextSize(15);
        password.setTextColor(Color.rgb(24,62,91));
        password.setHintTextColor(Color.rgb(135,158,178));
        password.setPadding(dp(14),0,dp(12),0);
        password.setBackground(rounded(Color.rgb(247,251,255),Color.rgb(217,235,248),11));
        password.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout.LayoutParams passwordLp=new LinearLayout.LayoutParams(-1,dp(51));
        passwordLp.topMargin=dp(11);
        layout.addView(password,passwordLp);

        TextView privacy=new TextView(this);
        privacy.setText("登录凭证使用安卓 Keystore 加密保存，用于后台信号提醒。不存储交易 API 密钥。");
        privacy.setTextSize(11);
        privacy.setTextColor(Color.rgb(112,141,163));
        privacy.setPadding(0,dp(14),0,dp(1));
        layout.addView(privacy);

        AlertDialog dialog=new AlertDialog.Builder(this)
            .setView(layout).setCancelable(false)
            .setNegativeButton("取消",(d,which)->{
                for(HttpAuthHandler h:pendingAuth)h.cancel();
                pendingAuth.clear();loginDialogOpen=false;
            })
            .setPositiveButton("登录",(d,which)->{
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
            }).create();
        dialog.setOnShowListener(d->{
            if(dialog.getWindow()!=null){
                dialog.getWindow().setBackgroundDrawable(rounded(Color.WHITE,Color.rgb(213,232,246),22));
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(Color.rgb(27,132,208));
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(Color.rgb(105,140,167));
        });
        dialog.show();
    }
    @Override protected void onResume(){
        super.onResume();
        // Some Android WebViews do not reliably emit visibilitychange after an
        // OEM has frozen the activity. Explicitly recover in-flight status.
        if(webView!=null){
            webView.onResume();
            Uri current=webView.getUrl()==null?null:Uri.parse(webView.getUrl());
            if(isTrusted(current)){
                webView.evaluateJavascript(
                    "if(window.ZLForegroundResume)window.ZLForegroundResume('native-onResume');",
                    null);
            }
        }
        statusHandler.removeCallbacks(statusUpdate);
        statusHandler.post(statusUpdate);
        if(SecureStore.prefs(this).getBoolean(SignalAlertService.PREF_ENABLED,false)
            &&SecureStore.loadLogin(this)!=null){
            try{SignalAlertService.start(this);}catch(Exception ignored){}
        }
    }
    @Override protected void onPause(){
        statusHandler.removeCallbacks(statusUpdate);
        if(webView!=null)webView.onPause();
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
