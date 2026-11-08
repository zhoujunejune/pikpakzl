package com.zlcontrol.android;

import android.app.Service;
import android.content.Intent;
import android.widget.ImageView;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * User-consented, on-device signal overlay. Only displays directions received
 * from the authenticated EVENT10 signal ledger; never initiates an order.
 * Android 8+ overlays require the user's explicit "Display over other apps"
 * permission. Lock-screen / OEM policies may suppress overlays: the normal
 * high-priority notification always remains available as fallback.
 */
final class SignalPopupOverlay {
    interface Listener { void onConfirm(String signalId,int notificationId); }
    private final Service service;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final Listener listener;
    private WindowManager manager;
    private View panel;
    private String showingId;

    SignalPopupOverlay(Service service,Listener listener){
        this.service=service;
        this.listener=listener;
    }

    private int dp(int n){
        return Math.round(n*service.getResources().getDisplayMetrics().density);
    }

    private GradientDrawable background(int color,int stroke){
        GradientDrawable d=new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(22));
        d.setStroke(dp(1),stroke);
        return d;
    }

    private TextView line(String content,int size,int color,boolean bold){
        TextView v=new TextView(service);
        v.setText(content);
        v.setTextSize(size);
        v.setTextColor(color);
        v.setGravity(Gravity.CENTER);
        if(bold)v.setTypeface(null,Typeface.BOLD);
        return v;
    }

    void show(String signalId,String originalDirection,long openedAt,long expiresAt,int noticeId,boolean reversed){
        main.post(()->{
            // The normal system notification is the fallback when overlay access
            // is unavailable, e.g. Android denies it on the lock screen.
            if(!Settings.canDrawOverlays(service))return;
            final String displayedDirection=AlertDirectionPolicy.notifiedDirection(originalDirection,reversed);
            if(displayedDirection==null)return;
            dismissNow();
            try{
                final boolean up="UP".equals(displayedDirection);
                final int navy=Color.rgb(22,58,88);
                final int secondary=Color.rgb(92,125,151);
                final int blue=Color.rgb(34,139,219);
                final int accent=up?Color.rgb(18,148,106):Color.rgb(214,80,95);
                LinearLayout layout=new LinearLayout(service);
                layout.setOrientation(LinearLayout.VERTICAL);
                layout.setGravity(Gravity.CENTER);
                layout.setPadding(dp(19),dp(18),dp(19),dp(19));
                layout.setBackground(background(Color.rgb(250,253,255),Color.rgb(202,226,246)));
                layout.setElevation(dp(12));

                ImageView mascot=new ImageView(service);
                mascot.setImageResource(R.drawable.sea_friends_icon);
                mascot.setScaleType(ImageView.ScaleType.CENTER_CROP);
                LinearLayout.LayoutParams logoLp=new LinearLayout.LayoutParams(dp(52),dp(52));
                logoLp.bottomMargin=dp(8);
                layout.addView(mascot,logoLp);

                TextView headline=line(reversed?"BTC · 10分钟反向操作提示":"BTC · 10分钟模型原始信号",15,navy,true);
                layout.addView(headline,new LinearLayout.LayoutParams(-1,dp(32)));
                TextView arrow=line(AlertDirectionPolicy.overlayLabel(originalDirection,reversed),
                    31,accent,true);
                layout.addView(arrow,new LinearLayout.LayoutParams(-1,dp(66)));
                TextView subtitle=line(reversed?"反向提醒已开启 · V19 纯规则":"反向提醒已关闭 · V19 纯规则",12,secondary,false);
                layout.addView(subtitle,new LinearLayout.LayoutParams(-1,dp(26)));

                String date=new SimpleDateFormat("HH:mm:ss",Locale.CHINA)
                    .format(new Date(openedAt));
                long seconds=Math.max(0L,(System.currentTimeMillis()-openedAt)/1000L);
                TextView time=line("信号 "+date+" · 已过去"+seconds+"秒",13,navy,false);
                LinearLayout.LayoutParams timeLp=new LinearLayout.LayoutParams(-1,dp(38));
                timeLp.topMargin=dp(8);
                time.setBackground(background(Color.rgb(236,247,255),Color.rgb(226,241,251)));
                layout.addView(time,timeLp);

                String hintText=AlertDirectionPolicy.modeHint(originalDirection,reversed);
                TextView hint=line(hintText,12,secondary,false);
                LinearLayout.LayoutParams hintLp=new LinearLayout.LayoutParams(-1,dp(51));
                hintLp.topMargin=dp(7);
                layout.addView(hint,hintLp);

                LinearLayout buttons=new LinearLayout(service);
                buttons.setOrientation(LinearLayout.HORIZONTAL);
                buttons.setGravity(Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams buttonGroupLp=new LinearLayout.LayoutParams(-1,dp(50));
                buttonGroupLp.topMargin=dp(6);

                Button silent=new Button(service);
                silent.setAllCaps(false);
                silent.setText("关闭提醒");
                silent.setTextSize(13);
                silent.setTextColor(blue);
                silent.setBackground(background(Color.rgb(236,246,254),Color.rgb(204,229,246)));
                LinearLayout.LayoutParams silentLp=new LinearLayout.LayoutParams(0,-1,1f);
                buttons.addView(silent,silentLp);
                silent.setOnClickListener(v->{
                    if(!signalId.equals(showingId))return;
                    Intent stop=new Intent(service,SignalAlertService.class);
                    stop.setAction(SignalAlertService.ACTION_SILENCE);
                    stop.putExtra("signal_id",signalId);
                    stop.putExtra("signal_notification_id",noticeId);
                    service.startService(stop);
                    dismissIfMatches(signalId);
                });

                Button confirm=new Button(service);
                confirm.setAllCaps(false);
                confirm.setText("确认并打开币安");
                confirm.setTextSize(13);
                confirm.setTextColor(Color.WHITE);
                confirm.setBackground(background(blue,blue));
                LinearLayout.LayoutParams confirmLp=new LinearLayout.LayoutParams(0,-1,1.3f);
                confirmLp.leftMargin=dp(7);
                buttons.addView(confirm,confirmLp);
                confirm.setOnClickListener(v->{
                    if(!signalId.equals(showingId))return;
                    // A user gesture is required for the Binance activity.
                    listener.onConfirm(signalId,noticeId);
                });
                layout.addView(buttons,buttonGroupLp);
                TextView caution=line("仅提醒 · 不自动下单 · 锁屏以系统通知为准",11,secondary,false);
                LinearLayout.LayoutParams cautionLp=new LinearLayout.LayoutParams(-1,dp(22));
                cautionLp.topMargin=dp(7);
                layout.addView(caution,cautionLp);

                int width=Math.min(dp(350),
                    service.getResources().getDisplayMetrics().widthPixels-dp(28));
                WindowManager.LayoutParams params=new WindowManager.LayoutParams(
                    width,WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        |WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                    PixelFormat.TRANSLUCENT);
                params.gravity=Gravity.CENTER;
                params.setTitle("ZL Event10 Signal");
                manager=(WindowManager)service.getSystemService(Service.WINDOW_SERVICE);
                manager.addView(layout,params);
                panel=layout;
                showingId=signalId;
                // A ten-minute prediction cannot remain actionable after expiry.
                long remaining=expiresAt-System.currentTimeMillis();
                if(remaining>0L)main.postDelayed(()->dismissIfMatches(signalId),remaining);
                else dismissNow();
            }catch(Exception e){
                dismissNow();
                // Notification remains visible when the OS denies an overlay.
            }
        });
    }

    void dismissIfMatches(String signalId){
        main.post(()->{
            if(signalId!=null&&signalId.equals(showingId))dismissNow();
        });
    }

    void dismiss(){
        main.post(this::dismissNow);
    }

    private void dismissNow(){
        if(panel!=null&&manager!=null){
            try{manager.removeViewImmediate(panel);}catch(Exception ignored){}
        }
        panel=null;
        showingId=null;
        manager=null;
    }
}
