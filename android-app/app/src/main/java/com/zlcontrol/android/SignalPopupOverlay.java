package com.zlcontrol.android;

import android.app.Service;
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
        d.setCornerRadius(dp(20));
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

    void show(String signalId,String direction,long openedAt,long expiresAt,int noticeId){
        main.post(()->{
            // The normal system notification is the fallback when overlay access
            // is unavailable, e.g. Android denies it on the lock screen.
            if(!Settings.canDrawOverlays(service))return;
            if(!"UP".equals(direction)&&!"DOWN".equals(direction))return;
            dismissNow();
            try{
                final boolean up="UP".equals(direction);
                int accent=Color.rgb(up?55:252,up?201:103,up?141:117);
                LinearLayout layout=new LinearLayout(service);
                layout.setOrientation(LinearLayout.VERTICAL);
                layout.setGravity(Gravity.CENTER);
                layout.setPadding(dp(22),dp(24),dp(22),dp(22));
                layout.setBackground(background(Color.rgb(18,33,53),accent));
                layout.setElevation(dp(16));

                TextView headline=line("BTC · 10分钟新信号",18,Color.WHITE,true);
                layout.addView(headline,new LinearLayout.LayoutParams(-1,dp(40)));
                TextView arrow=line(up?"↑  HIGHER · 看涨":"↓  LOWER · 看跌",
                    27,accent,true);
                layout.addView(arrow,new LinearLayout.LayoutParams(-1,dp(54)));
                String date=new SimpleDateFormat("HH:mm:ss",Locale.CHINA)
                    .format(new Date(openedAt));
                TextView time=line("出信号时间："+date,13,Color.rgb(193,211,233),false);
                layout.addView(time,new LinearLayout.LayoutParams(-1,dp(32)));
                TextView hint=line("确认后关闭本次弹窗和铃声，并打开币安。\n"
                    +"交易方向、价格与金额请自行核对。",13,
                    Color.rgb(199,214,232),false);
                LinearLayout.LayoutParams hintLp=new LinearLayout.LayoutParams(-1,dp(70));
                hintLp.topMargin=dp(6);
                layout.addView(hint,hintLp);

                Button confirm=new Button(service);
                confirm.setAllCaps(false);
                confirm.setText("确认并打开币安");
                confirm.setTextSize(16);
                confirm.setTextColor(Color.WHITE);
                confirm.setBackground(background(Color.rgb(35,110,194),
                    Color.rgb(60,146,233)));
                LinearLayout.LayoutParams buttonLp=new LinearLayout.LayoutParams(-1,dp(52));
                buttonLp.topMargin=dp(12);
                layout.addView(confirm,buttonLp);
                confirm.setOnClickListener(v->{
                    if(!signalId.equals(showingId))return;
                    // Handle the user's tap while the overlay is still visible.
                    // This matters for Android 15+ background launch restrictions.
                    listener.onConfirm(signalId,noticeId);
                });

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
