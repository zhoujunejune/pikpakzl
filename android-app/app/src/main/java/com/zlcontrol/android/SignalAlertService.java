package com.zlcontrol.android;

import android.Manifest;
import android.app.Service;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.RingtoneManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.io.OutputStream;
import java.net.URLEncoder;
import java.util.UUID;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.HashSet;
import java.util.Set;
import java.util.ArrayList;
import java.util.List;

/**
 * Explicitly user-enabled on-device signal watcher. No orders or production engine changes.
 * Native foreground service keeps polling when screen is locked, subject to Android power policies.
 */
public final class SignalAlertService extends Service {
    public static final String ACTION_STOP="com.zlcontrol.android.STOP_ALERTS";
    public static final String ACTION_SILENCE="com.zlcontrol.android.SILENCE_ALARM";
    public static final String ACTION_START="com.zlcontrol.android.START_ALERTS";
    public static final String PREF_ENABLED="event10_alert_enabled";
    public static final String PREF_REVERSE_ALERT="event10_alert_reverse_direction_v1";
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
    public static final String PREF_LAST_API_LATENCY_MS="event10_alert_last_api_latency_ms";
    public static final String PREF_LAST_ALARM_DELAY_MS="event10_alert_last_alarm_delay_ms";
    public static final String PREF_HANDLED_IDS="event10_alert_handled_ids_v2";
    public static final String PREF_AUDIT_TRAIL="event10_alert_audit_trail_v2";
    public static final String PREF_LAST_AUDIT_KEY="event10_alert_last_audit_key_v2";
    public static final String PREF_LAST_MISSED_TIME="event10_alert_last_missed_time_v2";
    public static final String PREF_LAST_FULL_SYNC="event10_alert_last_full_sync_v133";
    public static final String PREF_WATCH_MODE="event10_alert_watch_mode_v133";
    public static final String PREF_LAST_ACK_STATE="event10_alert_last_ack_state_v133";
    public static final String PREF_LAST_ACK_TIME="event10_alert_last_ack_time_v133";
    public static final String PREF_PENDING_RECEIPTS="event10_alert_pending_receipts_v133";
    public static final String PREF_ACK_CLIENT_ID="event10_alert_anon_id_v133";
    private static final String ACK_LAST_KEY="event10_alert_ack_last_key_v133";
    private static final String FOREGROUND_CHANNEL="zl_event10_foreground_v1";
    private static final String ALARM_CHANNEL="zl_event10_alarm_v3_silent_notice";
    private static final int FOREGROUND_ID=101;
    private static final int SIGNAL_ID=102;
    // Foreground-only low-latency polling: no speculative signals, no extra exchange requests.
    // If a request fails, retry after 2s rather than waiting for the old 5s interval.
    private static final int SIGNAL_POLL_SECONDS=2;
    private static final String SIGNAL_FULL_URL="https://prediction.47-237-188-69.sslip.io/event10/api/signals?limit=50&offset=0";
    private static final String SIGNAL_FAST_URL="https://prediction.47-237-188-69.sslip.io/event10/api/signals?limit=8&offset=0";
    private static final String SIGNAL_WATCH_URL="https://prediction.47-237-188-69.sslip.io/event10/api/watch?after=";
    private static final String SIGNAL_RECEIPT_URL="https://prediction.47-237-188-69.sslip.io/event10/api/alert-receipt";
    private ScheduledExecutorService executor;
    private final AlarmPlayer sound=new AlarmPlayer();
    private SignalPopupOverlay signalPopup;
    private volatile String activeAlarmSignalId;
    private volatile boolean stopped=false;
    private volatile long watchDisabledUntilElapsedMs=0L; // temporary, automatically retry WATCH


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
        signalPopup=new SignalPopupOverlay(this,this::confirmAndOpenBinance);
        SecureStore.prefs(this).edit().putString(PREF_LAST_STATE,"后台监听服务已启动").apply();
        NotificationManager nm=getSystemService(NotificationManager.class);
        NotificationChannel foreground=new NotificationChannel(FOREGROUND_CHANNEL,"10分钟信号后台监听",NotificationManager.IMPORTANCE_LOW);
        foreground.setDescription("开关开启期间在后台监听新的 Higher/Lower 信号");
        foreground.setSound(null,null);
        nm.createNotificationChannel(foreground);
        NotificationChannel alerts=new NotificationChannel(ALARM_CHANNEL,"10分钟信号闹铃",NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("独立高优先级通知不发第二种提示音；由本机闹钟播放器响铃");
        // System notification tone and manually played alarm would otherwise
        // generate two different audible alerts for one signal. Use alarm audio only.
        alerts.setSound(null,null);
        alerts.enableVibration(true); // Keep notification vibration when the alarm media route is inaudible.
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
    private PendingIntent signalActivityIntent(String signalId,String action,int discriminator){
        Intent intent=new Intent(this,MainActivity.class).setAction(action);
        intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        intent.putExtra("signal_id",signalId);
        int request=(signalId.hashCode()&0x3fffffff)^(discriminator<<27);
        return PendingIntent.getActivity(this,request,intent,
            PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
    }
    private PendingIntent openBinanceIntent(String signalId){
        return signalActivityIntent(signalId,MainActivity.ACTION_OPEN_BINANCE,1);
    }
    private PendingIntent openEvent10Intent(String signalId){
        return signalActivityIntent(signalId,MainActivity.ACTION_VIEW_EVENT10,2);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        if(intent!=null&&ACTION_SILENCE.equals(intent.getAction())){
            String id=intent.getStringExtra("signal_id");
            if(id!=null&&id.equals(activeAlarmSignalId)){
                sound.stop();
                activeAlarmSignalId=null;
                if(signalPopup!=null)signalPopup.dismissIfMatches(id);
            }
            getSystemService(NotificationManager.class)
                .cancel(intent.getIntExtra("signal_notification_id",SIGNAL_ID));
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
            executor.scheduleWithFixedDelay(this::pollSafe,0,SIGNAL_POLL_SECONDS,TimeUnit.SECONDS);
        }
        return START_STICKY;
    }
    private void status(String s){
        SecureStore.prefs(this).edit().putString(PREF_LAST_STATE,s).apply();
    }
    private void pollSafe(){
        if(stopped)return;
        SecureStore.prefs(this).edit().putLong(PREF_LAST_POLL,System.currentTimeMillis()).apply();
        PowerManager.WakeLock lock=null;
        try{
            PowerManager pm=(PowerManager)getSystemService(POWER_SERVICE);
            if(pm!=null){
                lock=pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,"ZLControl:event10-network-check");
                lock.acquire(27000L); // Bounded CPU lock for the 18s server long-poll; OS may still restrict network.
            }
            poll();
        }
        catch(Exception e){
            String code=e.getMessage();
            if(code==null)code=e.getClass().getSimpleName();
            String message=code.contains("401")?"HTTP 401：后台登录凭证失效，请重新登录":
                "后台读取失败："+code.substring(0,Math.min(90,code.length()));
            SharedPreferences prefs=SecureStore.prefs(this);
            prefs.edit().putString(PREF_LAST_ERROR,message)
                .putString(PREF_LAST_REASON,message).apply();
            audit(prefs,"POLL_ERROR",null,message,0L,0L);
            status(message);
        }finally{
            if(lock!=null&&lock.isHeld())lock.release();
        }
    }
    private HttpURLConnection authorizedRequest(URL url,String method,int readTimeout) throws Exception {
        String[] credentials=SecureStore.loadLogin(this);
        if(credentials==null)throw new IllegalStateException("登录信息不可用，请重新登录");
        if(!"https".equalsIgnoreCase(url.getProtocol())||
           !"prediction.47-237-188-69.sslip.io".equalsIgnoreCase(url.getHost()))
            throw new SecurityException("UNTRUSTED_SIGNAL_HOST");
        HttpURLConnection conn=(HttpURLConnection)url.openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod(method);
        conn.setConnectTimeout(3500);
        conn.setReadTimeout(readTimeout);
        conn.setRequestProperty("Accept","application/json");
        conn.setRequestProperty("Cache-Control","no-store");
        conn.setRequestProperty("Authorization","Basic "+Base64.encodeToString(
            (credentials[0]+":"+credentials[1]).getBytes(StandardCharsets.UTF_8),Base64.NO_WRAP));
        return conn;
    }
    private JSONObject getJson(String url,int timeout) throws Exception {
        HttpURLConnection conn=authorizedRequest(new URL(url),"GET",timeout);
        try{
            int code=conn.getResponseCode();
            if(code!=200)throw new IllegalStateException("HTTP "+code);
            try(InputStream in=conn.getInputStream();ByteArrayOutputStream out=new ByteArrayOutputStream()){
                byte[] buf=new byte[4096];int n;
                while((n=in.read(buf))!=-1){
                    if(out.size()+n>400000)throw new IllegalStateException("响应过大");
                    out.write(buf,0,n);
                }
                return new JSONObject(out.toString("UTF-8"));
            }
        }finally{conn.disconnect();}
    }
    private JSONObject fetch(boolean catchUp) throws Exception {
        SharedPreferences p=SecureStore.prefs(this);
        if(catchUp){
            p.edit().putString(PREF_WATCH_MODE,"定期完整对账").apply();
            return getJson(SIGNAL_FULL_URL,4500);
        }
        final String cursor=p.getString(PREF_LAST_SEEN,"");
        final boolean canWatch=cursor!=null&&!cursor.isEmpty()&&
            SystemClock.elapsedRealtime()>=watchDisabledUntilElapsedMs;
        if(!canWatch){
            p.edit().putString(PREF_WATCH_MODE,"短轮询兜底").apply();
            return getJson(SIGNAL_FAST_URL,4500);
        }
        try{
            p.edit().putString(PREF_WATCH_MODE,"服务器长轮询（最长18秒）").apply();
            String url=SIGNAL_WATCH_URL+URLEncoder.encode(cursor,"UTF-8");
            JSONObject result=getJson(url,21500);
            if(result.optBoolean("ok",false))return result;
            throw new IllegalStateException("WATCH_RESPONSE_INVALID");
        }catch(Exception watchError){
            // A proxy/OS timeout, or a server that has not been upgraded, must
            // never make signal notifications unavailable. Restore old polling.
            watchDisabledUntilElapsedMs=SystemClock.elapsedRealtime()+60_000L;
            p.edit().putString(PREF_WATCH_MODE,"长轮询异常，60秒短轮询兜底").apply();
            audit(p,"WATCH_FALLBACK",null,watchError.getClass().getSimpleName(),0,0);
            return getJson(SIGNAL_FAST_URL,4500);
        }
    }
    private void queueReceipt(SharedPreferences p,String id,String state){
        if(id==null||id.isEmpty())return;
        final String key=id+"|"+state;
        if(key.equals(p.getString(ACK_LAST_KEY,"")))return;
        try{
            JSONArray pending=new JSONArray(p.getString(PREF_PENDING_RECEIPTS,"[]"));
            for(int i=0;i<pending.length();i++){
                if(key.equals(pending.optString(i)))return;
            }
            JSONArray next=new JSONArray();
            for(int i=Math.max(0,pending.length()-18);i<pending.length();i++){
                next.put(pending.optString(i));
            }
            next.put(key);
            p.edit().putString(PREF_PENDING_RECEIPTS,next.toString()).commit();
        }catch(Exception ignored){}
    }
    private void transmitReceipts(SharedPreferences p){
        try{
            JSONArray pending=new JSONArray(p.getString(PREF_PENDING_RECEIPTS,"[]"));
            if(pending.length()==0)return;
            String item=pending.optString(0);
            int ix=item.lastIndexOf('|');
            if(ix<12)return;
            String id=item.substring(0,ix),state=item.substring(ix+1);
            String client=p.getString(PREF_ACK_CLIENT_ID,null);
            if(client==null){
                client=UUID.randomUUID().toString().toLowerCase(java.util.Locale.ROOT);
                if(!p.edit().putString(PREF_ACK_CLIENT_ID,client).commit())return;
            }
            JSONObject payload=new JSONObject().put("signalId",id)
                .put("clientId",client).put("state",state);
            HttpURLConnection conn=authorizedRequest(new URL(SIGNAL_RECEIPT_URL),"POST",1600);
            try{
                conn.setConnectTimeout(1600);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type","application/json");
                byte[] raw=payload.toString().getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(raw.length);
                try(OutputStream out=conn.getOutputStream()){out.write(raw);}
                if(conn.getResponseCode()!=200)return;
            }finally{conn.disconnect();}
            JSONArray remaining=new JSONArray();
            for(int i=1;i<pending.length();i++)remaining.put(pending.optString(i));
            p.edit().putString(PREF_PENDING_RECEIPTS,remaining.toString())
                .putString(ACK_LAST_KEY,item)
                .putString(PREF_LAST_ACK_STATE,state)
                .putLong(PREF_LAST_ACK_TIME,System.currentTimeMillis()).commit();
        }catch(Exception e){
            // This is telemetry only. A failed ACK must NEVER suppress or delay
            // a future signal (queue is persisted and retried on next cycle).
        }
    }

    private void audit(SharedPreferences p,String action,String id,String detail,
                       long openedAt,long expiresAt) {
        String fingerprint=String.valueOf(id)+"|"+action+"|"+String.valueOf(detail);
        if(fingerprint.equals(p.getString(PREF_LAST_AUDIT_KEY,"")))return;
        try {
            JSONArray history=new JSONArray(p.getString(PREF_AUDIT_TRAIL,"[]"));
            JSONObject e=new JSONObject();
            e.put("time",System.currentTimeMillis());
            e.put("signal_id",id==null?"":id);
            e.put("action",action);
            e.put("detail",detail==null?"":detail);
            e.put("openedAt",openedAt);
            e.put("expiresAt",expiresAt);
            JSONArray limited=new JSONArray();
            for(int i=Math.max(0,history.length()-38);i<history.length();i++){
                Object item=history.opt(i);
                if(item!=null)limited.put(item);
            }
            limited.put(e);
            p.edit().putString(PREF_AUDIT_TRAIL,limited.toString())
              .putString(PREF_LAST_AUDIT_KEY,fingerprint).apply();
        }catch(Exception ignored){}
    }

    private void poll() throws Exception {
        SharedPreferences p=SecureStore.prefs(this);
        if(!p.getBoolean(PREF_ENABLED,false))return;
        long requestStarted=System.currentTimeMillis();
        // Fast endpoint is sufficient for normal 4-minute spacing; full history
        // reconciles after a long offline gap or on service startup.
        long previousSuccess=p.getLong(PREF_LAST_SUCCESS,0L);
        boolean catchUp=previousSuccess<=0L||requestStarted-previousSuccess>60_000L||
            requestStarted-p.getLong(PREF_LAST_FULL_SYNC,0L)>45_000L;
        JSONObject response=fetch(catchUp);
        if(!response.optBoolean("ok",false))throw new IllegalStateException("服务响应异常");
        JSONArray records=response.optJSONArray("records");
        if(records==null)throw new IllegalStateException("信号记录缺失");
        long now=System.currentTimeMillis();
        SharedPreferences.Editor success=p.edit().putLong(PREF_LAST_SUCCESS,now)
            .putLong(PREF_LAST_API_LATENCY_MS,Math.max(0L,now-requestStarted));
        if(catchUp)success.putLong(PREF_LAST_FULL_SYNC,now);
        success
            .remove(PREF_LAST_ERROR).apply();
        String clockTime=new java.text.SimpleDateFormat("HH:mm:ss",java.util.Locale.CHINA)
            .format(new java.util.Date(now));
        if(records.length()==0){
            transmitReceipts(p);
            status("监听正常 "+clockTime+" · 等待新信号");
            return;
        }
        JSONObject latest=records.optJSONObject(0);
        if(latest!=null){
            p.edit().putString(PREF_LAST_SEEN,latest.optString("id",""))
                .putLong(PREF_LAST_SEEN_TIME,latest.optLong("openedAt",0L)).apply();
        }

        // Process the whole returned ledger, not just records[0].
        // When the phone was paused, an earlier signal must not be hidden by a newer one.
        List<JSONObject> ordered=new ArrayList<>();
        for(int i=0;i<records.length();i++){
            JSONObject signal=records.optJSONObject(i);
            if(signal!=null)ordered.add(signal);
        }
        ordered.sort((a,b)->Long.compare(a.optLong("openedAt",0L),b.optLong("openedAt",0L)));
        Set<String> processed=new HashSet<>(p.getStringSet(PREF_HANDLED_IDS,new HashSet<>()));
        long enabledAt=p.getLong(PREF_ENABLED_SINCE,0L);
        int missed=0;
        for(JSONObject signal:ordered){
            if(stopped||!p.getBoolean(PREF_ENABLED,false))return;
            String id=signal.optString("id","");
            String dir=signal.optString("direction","");
            long opened=signal.optLong("openedAt",0L);
            long expires=signal.optLong("expiresAt",0L);
            if(processed.contains(id))continue;
            String previous=id.equals(p.getString(PREF_LAST_ID,""))?id:null;
            String decision=SignalAlarmPolicy.decide(dir,id,previous,opened,expires,enabledAt,now);
            if("NO_SIGNAL".equals(decision)||"INVALID_ID".equals(decision))continue;
            if("ALREADY_HANDLED".equals(decision)){processed.add(id);continue;}
            if("BEFORE_ENABLED".equals(decision)){
                // This is a historical record, NOT a failure for a new signal.
                processed.add(id);
                continue;
            }
            if("SIGNAL_EXPIRED".equals(decision)||"SIGNAL_TOO_OLD".equals(decision)||
               "SIGNAL_TOO_LATE".equals(decision)){
                // Keep an explicit missed event so diagnosis can distinguish it from no signal.
                processed.add(id);
                missed++;
                p.edit().putLong(PREF_LAST_MISSED_TIME,now)
                    .putString(PREF_LAST_REASON,decision).apply();
                audit(p,"MISSED_EXPIRED",id,decision+" "+dir,opened,expires);
                queueReceipt(p,id,"MISSED_SIGNAL_EXPIRED");
                continue;
            }
            if(!SignalAlarmPolicy.ALERT.equals(decision)){
                audit(p,"BLOCKED",id,decision,opened,expires);
                p.edit().putString(PREF_LAST_REASON,decision).apply();
                continue;
            }
            if(Build.VERSION.SDK_INT>=33&&checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED){
                audit(p,"BLOCKED",id,"NO_NOTIFICATION_PERMISSION",opened,expires);
                queueReceipt(p,id,"NOTIFICATION_BLOCKED");
                p.edit().putString(PREF_LAST_REASON,"NO_NOTIFICATION_PERMISSION").apply();
                continue; // Permission may later be granted before contract expires.
            }
            NotificationManager nm=getSystemService(NotificationManager.class);
            if(!nm.areNotificationsEnabled()){
                audit(p,"BLOCKED",id,"NOTIFICATIONS_DISABLED",opened,expires);
                queueReceipt(p,id,"NOTIFICATION_BLOCKED");
                p.edit().putString(PREF_LAST_REASON,"NOTIFICATIONS_DISABLED").apply();
                continue;
            }
            NotificationChannel channel=nm.getNotificationChannel(ALARM_CHANNEL);
            if(channel!=null&&channel.getImportance()==NotificationManager.IMPORTANCE_NONE){
                audit(p,"BLOCKED",id,"ALARM_CHANNEL_DISABLED",opened,expires);
                queueReceipt(p,id,"NOTIFICATION_BLOCKED");
                p.edit().putString(PREF_LAST_REASON,"ALARM_CHANNEL_DISABLED").apply();
                continue;
            }
            // Notification/audio dispatch. Mark handled only after the attempt; retry transient
            // failures on the next poll while the signal remains live.
            long ageMs=Math.max(0L,System.currentTimeMillis()-opened);
            if(ageMs>15_000L)audit(p,"DELAYED_ALERT",id,dir+" delayMs="+ageMs,opened,expires);
            boolean soundStarted=alert(dir,signal);
            processed.add(id);
            // Persist as handled immediately AFTER the NotificationManager
            // accepted our call. Reduces repeat alarms on service/process crash.
            boolean saved=p.edit().putStringSet(PREF_HANDLED_IDS,new HashSet<>(processed))
                .putString(PREF_LAST_ID,id).putString(PREF_LAST_ALARM,id)
                .putLong(PREF_LAST_ALARM_TIME,System.currentTimeMillis())
                .putLong(PREF_LAST_ALARM_DELAY_MS,Math.max(0L,System.currentTimeMillis()-opened))
                .putString(PREF_LAST_REASON,soundStarted?"RING_STARTED":"SOUND_FAILED_NOTICE_ONLY")
                .commit();
            if(!saved)audit(p,"HANDLED_PERSIST_FAILED",id,"PREF_COMMIT_FAILED",opened,expires);
            final boolean muted=p.getInt("event10_alert_alarm_volume",-1)==0;
            queueReceipt(p,id,soundStarted?
                (muted?"NOTIFICATION_POSTED_ALARM_MUTED":"NOTIFICATION_POSTED_ALARM_STARTED"):
                "NOTIFICATION_POSTED_SOUND_FAILED");
            audit(p,soundStarted?"RING_STARTED":"SOUND_FAILED_NOTICE_ONLY",
                id,dir,opened,expires);
        }
        // Preserve at most the 100 newest handled IDs to avoid unbounded settings growth.
        if(processed.size()>100){
            Set<String> keep=new HashSet<>();
            for(int i=0;i<ordered.size()&&keep.size()<100;i++){
                String id=ordered.get(ordered.size()-1-i).optString("id","");
                if(processed.contains(id))keep.add(id);
            }
            processed=keep;
        }
        p.edit().putStringSet(PREF_HANDLED_IDS,processed).apply();
        transmitReceipts(p);
        if(missed>0){
            status("监听已恢复 · 发现"+missed+"条已过期未提醒信号");
        }else{
            status("监听正常 "+clockTime+" · 等待新信号");
        }
    }
    private boolean alert(String direction,JSONObject signal) {
        // The transform is strictly presentation-only and occurs AFTER the
        // original signal has passed freshness, permission and dedupe checks.
        // All backend records, success statistics and signal IDs remain original.
        boolean reverse=SecureStore.prefs(this).getBoolean(PREF_REVERSE_ALERT,false);
        String alertedDirection=AlertDirectionPolicy.notifiedDirection(direction,reverse);
        if(alertedDirection==null)return false;
        String name=alertedDirection.equals("UP")?"看涨":"看跌";
        String originalName=direction.equals("UP")?"看涨":"看跌";
        String trigger="AUTO".equals(signal.optString("trigger"))?"后台自动信号":"手动检测信号";
        String signalId=signal.optString("id","");
        int notificationId=(signalId.hashCode()&0x3fffffff)+2000;
        long opened=signal.optLong("openedAt",System.currentTimeMillis());
        String signalTime=new java.text.SimpleDateFormat("MM-dd HH:mm:ss",java.util.Locale.CHINA)
            .format(new java.util.Date(opened));
        
        long ageSeconds=Math.max(0L,(System.currentTimeMillis()-opened)/1000L);
        String freshness=ageSeconds>15L?" · 发现延迟"+ageSeconds+"秒":" · 及时发现";
        String content="BTC 10分钟 · "+(reverse?"反向提醒 · ":"")+name+" · "+signalTime+" · "+trigger+freshness;
        // Reference-cycle expiry is NOT the expiry of a new Binance order.
        String detail=content+(reverse?"。原规则方向："+originalName+"，仅本机提醒已反向。":"。")+"金额请在币安内核对。打开币安后进入 合约→事件→BTC→10分钟，"
            +"确认方向、开仓指数价格和最终到期时间，再由你手动下单。没有自动成交。";
        Intent silencer=new Intent(this,SignalAlertService.class)
            .setAction(ACTION_SILENCE)
            .setData(android.net.Uri.parse("zlcontrol://silence/"+android.net.Uri.encode(signalId)))
            .putExtra("signal_notification_id",notificationId)
            .putExtra("signal_id",signalId);
        PendingIntent silence=PendingIntent.getService(this,notificationId,silencer,
            PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent binance=openBinanceIntent(signalId);
        Notification notice=new Notification.Builder(this,ALARM_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle((reverse?"反向提醒：":"新信号：")+name+" · 请核对价格")
            .setContentText(content)
            .setStyle(new Notification.BigTextStyle().bigText(detail))
            .setAutoCancel(true)
            .setWhen(opened>0?opened:System.currentTimeMillis())
            .setShowWhen(true)
            .setPriority(Notification.PRIORITY_HIGH)
            .setCategory(Notification.CATEGORY_ALARM)
            .setContentIntent(binance)
            .addAction(new Notification.Action.Builder(null,"打开币安",binance).build())
            .addAction(new Notification.Action.Builder(null,"查看信号",openEvent10Intent(signalId)).build())
            .addAction(new Notification.Action.Builder(null,"停止响铃",silence).build())
            .build();
        getSystemService(NotificationManager.class).notify(notificationId,notice);
        activeAlarmSignalId=signalId;
        AudioManager audio=(AudioManager)getSystemService(AUDIO_SERVICE);
        int alarmVolume=audio==null?-1:audio.getStreamVolume(AudioManager.STREAM_ALARM);
        int maxAlarmVolume=audio==null?-1:audio.getStreamMaxVolume(AudioManager.STREAM_ALARM);
        SharedPreferences diagnostics=SecureStore.prefs(this);
        diagnostics.edit().putInt("event10_alert_alarm_volume",alarmVolume)
            .putInt("event10_alert_alarm_max_volume",maxAlarmVolume).apply();
        if(alarmVolume==0){
            audit(diagnostics,"AUDIO_VOLUME_ZERO",signalId,"ALARM_STREAM_MUTED",opened,
                signal.optLong("expiresAt",0L));
        }
        boolean started=sound.play(this,25);
        // Display only after the notification has been posted successfully.
        // Overlay permission is opt-in, and notification is always the fallback.
        if(signalPopup!=null)signalPopup.show(signalId,alertedDirection,opened,signal.optLong("expiresAt",0L),notificationId,reverse);
        status((started?"响铃提醒：":"系统铃声播放失败（仅通知）：")+name+(reverse?"（反向模式）":""));
        diagnostics.edit().putString("event10_alert_last_displayed_direction",alertedDirection)
            .putString("event10_alert_last_original_direction",direction).apply();
        return started;
    }
    private void confirmAndOpenBinance(String id,int notificationId){
        // Called by a real tap on the centered overlay. No auto trading.
        if(!id.equals(activeAlarmSignalId))return;
        sound.stop();
        activeAlarmSignalId=null;
        getSystemService(NotificationManager.class).cancel(notificationId);
        SharedPreferences p=SecureStore.prefs(this);
        p.edit().putString(PREF_LAST_REASON,"POPUP_CONFIRMED_BINANCE").apply();
        audit(p,"POPUP_CONFIRMED_BINANCE",id,"USER_TAP",0L,0L);
        try{
            Intent launch=getPackageManager().getLaunchIntentForPackage("com.binance.dev");
            if(launch!=null){
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(launch);
            }else{
                // This opens the app's existing Binance-help flow; never redirect
                // to an untrusted download page or trade automatically.
                Intent fallback=new Intent(this,MainActivity.class)
                    .setAction(MainActivity.ACTION_OPEN_BINANCE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        |Intent.FLAG_ACTIVITY_CLEAR_TOP
                        |Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(fallback);
            }
        }catch(Exception e){
            try{
                Intent fallback=new Intent(this,MainActivity.class)
                    .setAction(MainActivity.ACTION_OPEN_BINANCE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        |Intent.FLAG_ACTIVITY_CLEAR_TOP
                        |Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(fallback);
            }catch(Exception ignored){}
            p.edit().putString(PREF_LAST_REASON,"POPUP_BINANCE_LAUNCH_FAILED").apply();
            audit(p,"POPUP_BINANCE_LAUNCH_FAILED",id,"OPEN_ACTIVITY_RESTRICTED",0L,0L);
        }finally{
            if(signalPopup!=null)signalPopup.dismissIfMatches(id);
        }
    }

    @Override public void onDestroy(){
        stopped=true;
        if(executor!=null){executor.shutdownNow();executor=null;}
        sound.stop();
        activeAlarmSignalId=null;
        if(signalPopup!=null)signalPopup.dismiss();
        getSystemService(NotificationManager.class).cancel(SIGNAL_ID);
        super.onDestroy();
    }
}
