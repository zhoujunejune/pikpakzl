package com.zlcontrol.android;

import android.Manifest;
import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Explicitly user-enabled on-device signal watcher. No orders or production engine changes.
 * Native foreground service keeps polling when screen is locked, subject to Android power policies.
 */
public final class SignalAlertService extends Service {
    public static final String ACTION_STOP="com.zlcontrol.android.STOP_ALERTS";
    public static final String ACTION_SILENCE="com.zlcontrol.android.SILENCE_ALARM";
    public static final String ACTION_START="com.zlcontrol.android.START_ALERTS";
    public static final String PREF_ENABLED="event10_alert_enabled";
    public static final String PREF_ENABLED_SINCE="event10_alert_enabled_since";
    public static final String PREF_LAST_ID="event10_alert_last_id";
    public static final String PREF_LAST_STATE="event10_alert_state";
    public static final String PREF_LAST_POLL="event10_alert_last_poll";
    public static final String PREF_LAST_SUCCESS="event10_alert_last_success";
    public static final String PREF_LAST_SEEN="event10_alert_last_seen";
    public static final String PREF_LAST_SEEN_TIME="event10_alert_last_seen_time";
    public static final String PREF_LAST_REASON="event10_alert_last_reason";
    public static final String PREF_LAST_ALARM="event10_alert_last_alarm";
    public static final String PREF_LAST_ALARM_TIME="event10_alert_last_alarm_time";
    public static final String PREF_LAST_ERROR="event10_alert_last_error";
    private static final String FOREGROUND_CHANNEL="zl_event10_foreground_v1";
    private static final String ALARM_CHANNEL="zl_event10_alarm_v1";
    private static final int FOREGROUND_ID=101;
    private static final int SIGNAL_ID=102;
    private ScheduledExecutorService executor;
    private final AlarmPlayer sound=new AlarmPlayer();
    private volatile boolean stopped=false;

    public static void start(Context context){
        Intent intent=new Intent(context,SignalAlertService.class).setAction(ACTION_START);
        if(Build.VERSION.SDK_INT>=26)context.startForegroundService(intent);
        else context.startService(intent);
    }
    public static void stop(Context context){
        context.stopService(new Intent(context,SignalAlertService.class));
        SecureStore.prefs(context).edit().putString(PREF_LAST_STATE,"已关闭").apply();
    }
    @Override public IBinder onBind(Intent intent){return null;}

    @Override public void onCreate(){
        super.onCreate();
        SecureStore.prefs(this).edit().putString(PREF_LAST_STATE,"后台监听服务已启动").apply();
        NotificationManager nm=getSystemService(NotificationManager.class);
        NotificationChannel foreground=new NotificationChannel(FOREGROUND_CHANNEL,"10分钟信号后台监听",NotificationManager.IMPORTANCE_LOW);
        foreground.setDescription("开关开启期间在后台监听新的 Higher/Lower 信号");
        foreground.setSound(null,null);
        nm.createNotificationChannel(foreground);
        NotificationChannel alerts=new NotificationChannel(ALARM_CHANNEL,"10分钟信号闹铃",NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("出现新的10分钟事件信号时显示高优先级通知，响系统闹钟铃声");
        alerts.setSound(null,null); // AlarmPlayer uses ALARM audio stream; avoid double ringing.
        alerts.enableVibration(false); // AlarmPlayer handles the alarm vibration.
        nm.createNotificationChannel(alerts);
        Notification ongoing=new Notification.Builder(this,FOREGROUND_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("ZL · 十分钟信号闹铃已开启")
            .setContentText("后台监听 Higher / Lower · 仅监控，不下单")
            .setContentIntent(openAppIntent())
            .setOngoing(true).setCategory(Notification.CATEGORY_SERVICE)
            .build();
        if(Build.VERSION.SDK_INT>=34){
            startForeground(FOREGROUND_ID,ongoing,ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        }else{
            startForeground(FOREGROUND_ID,ongoing);
        }
    }

    private PendingIntent openAppIntent(){
        Intent intent=new Intent(this,MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this,1,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&ACTION_SILENCE.equals(intent.getAction())){
            sound.stop();
            getSystemService(NotificationManager.class).cancel(SIGNAL_ID);
            return START_STICKY;
        }
        if(intent!=null&&ACTION_STOP.equals(intent.getAction())){
            SecureStore.prefs(this).edit().putBoolean(PREF_ENABLED,false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if(!SecureStore.prefs(this).getBoolean(PREF_ENABLED,false)){stopSelf();return START_NOT_STICKY;}
        if(executor==null||executor.isShutdown()){
            stopped=false;
            executor=Executors.newSingleThreadScheduledExecutor(r->{
                Thread t=new Thread(r,"event10-signal-poller");
                t.setDaemon(true);
                return t;
            });
            executor.scheduleWithFixedDelay(this::pollSafe,1,10,TimeUnit.SECONDS);
        }
        return START_STICKY;
    }
    private void status(String s){
        SecureStore.prefs(this).edit().putString(PREF_LAST_STATE,s).apply();
    }
    private void pollSafe(){
        if(stopped)return;
        SecureStore.prefs(this).edit().putLong(PREF_LAST_POLL,System.currentTimeMillis()).apply();
        try{poll();}
        catch(Exception e){
            String code=e.getMessage();
            if(code==null)code=e.getClass().getSimpleName();
            String message=code.contains("401")?"HTTP 401：后台登录凭证失效，请重新登录":
                "后台读取失败："+code.substring(0,Math.min(90,code.length()));
            SecureStore.prefs(this).edit().putString(PREF_LAST_ERROR,message)
                .putString(PREF_LAST_REASON,message).apply();
            status(message);
        }
    }
    private JSONObject fetch() throws Exception {
        String[] credentials=SecureStore.loadLogin(this);
        if(credentials==null)throw new IllegalStateException("登录信息不可用，请重新登录");
        // No caller-provided URLs: credentials are transmitted only to the verified HTTPS host.
        URL url=new URL("https://prediction.47-237-188-69.sslip.io/event10/api/signals?limit=50&offset=0");
        HttpURLConnection conn=(HttpURLConnection)url.openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(6000);
        conn.setReadTimeout(6000);
        conn.setRequestProperty("Accept","application/json");
        conn.setRequestProperty("Cache-Control","no-store");
        conn.setRequestProperty("Authorization","Basic "+Base64.encodeToString(
            (credentials[0]+":"+credentials[1]).getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP));
        try{
            int code=conn.getResponseCode();
            if(code!=200)throw new IllegalStateException("HTTP "+code);
            try(InputStream in=conn.getInputStream(); ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[4096];
                int n;
                while((n=in.read(buf))!=-1){
                    if(out.size()+n>400000)throw new IllegalStateException("响应过大");
                    out.write(buf,0,n);
                }
                return new JSONObject(out.toString("UTF-8"));
            }
        }finally{conn.disconnect();}
    }
    private void poll() throws Exception {
        SharedPreferences p=SecureStore.prefs(this);
        if(!p.getBoolean(PREF_ENABLED,false))return;
        JSONObject response=fetch();
        if(!response.optBoolean("ok",false))throw new IllegalStateException("服务响应异常");
        JSONArray records=response.optJSONArray("records");
        if(records==null)throw new IllegalStateException("信号记录缺失");
        long now=System.currentTimeMillis();
        p.edit().putLong(PREF_LAST_SUCCESS,now).remove(PREF_LAST_ERROR).apply();
        String time=new java.text.SimpleDateFormat("HH:mm:ss",java.util.Locale.CHINA).format(new java.util.Date(now));
        if(records.length()==0){
            status("监听正常 "+time+" · 尚无有效信号");
            p.edit().putString(PREF_LAST_REASON,"暂无有效 Higher/Lower 信号").apply();
            return;
        }
        JSONObject latest=records.optJSONObject(0);
        if(latest==null)return;
        String id=latest.optString("id","");
        String direction=latest.optString("direction","");
        long openedAt=latest.optLong("openedAt",0L);
        long expiresAt=latest.optLong("expiresAt",0L);
        p.edit().putString(PREF_LAST_SEEN,id).putLong(PREF_LAST_SEEN_TIME,openedAt).apply();

        String previous=p.getString(PREF_LAST_ID,null);
        String decision=SignalAlarmPolicy.decide(direction,id,previous,openedAt,expiresAt,
            p.getLong(PREF_ENABLED_SINCE,0L),now);
        if(!SignalAlarmPolicy.ALERT.equals(decision)){
            if(!"ALREADY_HANDLED".equals(decision)){
                p.edit().putString(PREF_LAST_REASON,decision).apply();
                if("BEFORE_ENABLED".equals(decision)||"SIGNAL_EXPIRED".equals(decision)
                    ||"SIGNAL_TOO_OLD".equals(decision)){
                    p.edit().putString(PREF_LAST_ID,id).apply();
                }
            }
            status("监听正常 "+time+" · "+("ALREADY_HANDLED".equals(decision)?"等待新信号":decision));
            return;
        }
        // Do not consider an unnotified signal completed. Retry failures while it is valid.
        if(!p.getBoolean(PREF_ENABLED,false)||stopped)return;
        if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
            p.edit().putString(PREF_LAST_REASON,"NO_NOTIFICATION_PERMISSION").apply();
            status("未授予通知权限，无法提醒");
            return;
        }
        NotificationManager nm=getSystemService(NotificationManager.class);
        if(!nm.areNotificationsEnabled()){
            p.edit().putString(PREF_LAST_REASON,"NOTIFICATIONS_DISABLED").apply();
            status("系统已关闭本 App 通知，无法提醒");
            return;
        }
        NotificationChannel channel=nm.getNotificationChannel(ALARM_CHANNEL);
        if(channel!=null&&channel.getImportance()==NotificationManager.IMPORTANCE_NONE){
            p.edit().putString(PREF_LAST_REASON,"ALARM_CHANNEL_DISABLED").apply();
            status("系统已关闭信号闹铃通知渠道");
            return;
        }
        alert(direction,latest);
        p.edit().putString(PREF_LAST_ID,id).putString(PREF_LAST_ALARM,id)
            .putLong(PREF_LAST_ALARM_TIME,System.currentTimeMillis())
            .putString(PREF_LAST_REASON,"ALERT_DELIVERED").apply();
    }
    private void alert(String direction,JSONObject signal) {
        String name=direction.equals("UP")?"Higher · 看涨":"Lower · 看跌";
        String trigger="AUTO".equals(signal.optString("trigger"))?"后台自动信号":"手动检测信号";
        String content="BTC 10分钟事件合约 · "+name+" · "+trigger;
        Intent silencer=new Intent(this,SignalAlertService.class).setAction(ACTION_SILENCE);
        PendingIntent silence=PendingIntent.getService(this,2,silencer,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notice=new Notification.Builder(this,ALARM_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("🔔 新信号："+name)
            .setContentText(content)
            .setStyle(new Notification.BigTextStyle().bigText(content+"。信号仅供参考，不是实际成交订单。"))
            .setAutoCancel(true)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setPriority(Notification.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(openAppIntent())
            .addAction(new Notification.Action.Builder(null,"停止响铃",silence).build())
            .build();
        getSystemService(NotificationManager.class).notify(SIGNAL_ID,notice);
        boolean started=sound.play(this,25);
        status((started?"响铃提醒：":"通知提醒：")+name);
    }
    @Override public void onDestroy(){
        stopped=true;
        if(executor!=null){executor.shutdownNow();executor=null;}
        sound.stop();
        getSystemService(NotificationManager.class).cancel(SIGNAL_ID);
        super.onDestroy();
    }
}
