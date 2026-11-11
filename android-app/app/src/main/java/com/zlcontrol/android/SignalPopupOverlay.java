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


    private GradientDrawable tile(int fill,int stroke,int radius){
        GradientDrawable d=new GradientDrawable();
        d.setColor(fill);
        d.setCornerRadius(dp(radius));
        d.setStroke(dp(1),stroke);
        return d;
    }

    private View detail(String label,String value,int valueColor){
        LinearLayout row=new LinearLayout(service);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12),0,dp(12),0);
        TextView left=line(label,12,Color.rgb(111,141,166),false);
        left.setGravity(Gravity.CENTER_VERTICAL|Gravity.LEFT);
        row.addView(left,new LinearLayout.LayoutParams(0,dp(36),1f));
        TextView right=line(value,12,valueColor,true);
        right.setGravity(Gravity.CENTER_VERTICAL|Gravity.RIGHT);
        right.setSingleLine(true);
        row.addView(right,new LinearLayout.LayoutParams(0,dp(36),1.3f));
        return row;
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
                final int navy=Color.rgb(24,61,94);
                final int secondary=Color.rgb(109,141,167);
                final int blue=Color.rgb(35,125,204);
                final int accent=up?Color.rgb(9,153,140):Color.rgb(220,93,106);
                final int paleBlue=Color.rgb(237,247,255);
                LinearLayout layout=new LinearLayout(service);
                layout.setOrientation(LinearLayout.VERTICAL);
                layout.setGravity(Gravity.CENTER_HORIZONTAL);
                layout.setPadding(dp(17),dp(17),dp(17),dp(15));
                layout.setBackground(tile(Color.WHITE,Color.rgb(219,234,248),24));
                layout.setElevation(dp(14));

                LinearLayout header=new LinearLayout(service);
                header.setGravity(Gravity.CENTER_VERTICAL);
                TextView brand=line("海",17,blue,true);
                brand.setBackground(tile(Color.rgb(224,240,253),Color.rgb(224,240,253),11));
                header.addView(brand,new LinearLayout.LayoutParams(dp(35),dp(35)));
                LinearLayout heading=new LinearLayout(service);
                heading.setOrientation(LinearLayout.VERTICAL);
                heading.setPadding(dp(10),0,0,0);
                TextView head=line("实时信号提醒",16,navy,true);
                head.setGravity(Gravity.LEFT);
                heading.addView(head);
                TextView sub=line("海派事件合约 · V20",11,secondary,false);
                sub.setGravity(Gravity.LEFT);
                heading.addView(sub);
                header.addView(heading,new LinearLayout.LayoutParams(0,-2,1f));
                TextView live=line("● 已送达",11,Color.rgb(49,170,148),false);
                header.addView(live,new LinearLayout.LayoutParams(dp(65),dp(30)));
                layout.addView(header,new LinearLayout.LayoutParams(-1,dp(42)));

                LinearLayout hero=new LinearLayout(service);
                hero.setOrientation(LinearLayout.HORIZONTAL);
                hero.setGravity(Gravity.CENTER_VERTICAL);
                hero.setPadding(dp(15),dp(8),dp(6),dp(7));
                hero.setBackground(tile(paleBlue,Color.rgb(232,244,253),20));
                LinearLayout.LayoutParams heroLp=new LinearLayout.LayoutParams(-1,dp(162));
                heroLp.topMargin=dp(13);
                layout.addView(hero,heroLp);

                LinearLayout introduction=new LinearLayout(service);
                introduction.setOrientation(LinearLayout.VERTICAL);
                introduction.setGravity(Gravity.CENTER_VERTICAL|Gravity.LEFT);
                hero.addView(introduction,new LinearLayout.LayoutParams(0,-1,1f));
                TextView ticker=line("BTC/USDT",11,blue,true);
                ticker.setGravity(Gravity.CENTER);
                ticker.setBackground(tile(Color.WHITE,Color.WHITE,12));
                introduction.addView(ticker,new LinearLayout.LayoutParams(dp(86),dp(26)));
                TextView product=line("BTC · 10分钟事件",13,navy,true);
                product.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams productLp=new LinearLayout.LayoutParams(-1,dp(35));
                productLp.topMargin=dp(6);
                introduction.addView(product,productLp);
                TextView direction=line(up?"买涨":"买跌",28,accent,true);
                direction.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);
                introduction.addView(direction,new LinearLayout.LayoutParams(-1,dp(38)));
                TextView directionEn=line(displayedDirection,17,accent,true);
                directionEn.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);
                introduction.addView(directionEn,new LinearLayout.LayoutParams(-1,dp(22)));
                TextView model=line("V20 信号已触发",11,secondary,false);
                model.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);
                introduction.addView(model,new LinearLayout.LayoutParams(-1,dp(21)));

                // Artwork is bundled as a bitmap drawable. Never regenerate or
                // paint the supplied character. FIT_CENTER preserves proportions.
                ImageView mascot=new ImageView(service);
                String asset=up?"haipai_up":"haipai_down";
                int artwork=service.getResources().getIdentifier(asset,"drawable",service.getPackageName());
                if(artwork==0)artwork=R.drawable.sea_friends_icon;
                mascot.setImageResource(artwork);
                mascot.setScaleType(ImageView.ScaleType.FIT_CENTER);
                hero.addView(mascot,new LinearLayout.LayoutParams(dp(122),dp(147)));

                TextView section=line("信号详情",15,navy,true);
                section.setGravity(Gravity.LEFT|Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams sectionLp=new LinearLayout.LayoutParams(-1,dp(35));
                sectionLp.topMargin=dp(9);
                layout.addView(section,sectionLp);

                LinearLayout info=new LinearLayout(service);
                info.setOrientation(LinearLayout.VERTICAL);
                info.setBackground(tile(Color.rgb(250,253,255),Color.rgb(223,237,249),16));
                String original="UP".equals(originalDirection)?"买涨 UP":"买跌 DOWN";
                info.addView(detail("V20 原始信号",original,
                    "UP".equals(originalDirection)?Color.rgb(9,153,140):Color.rgb(220,93,106)));
                info.addView(detail("反向模式",reversed?"已开启":"已关闭",navy));
                String signalTime=new SimpleDateFormat("HH:mm:ss",Locale.CHINA)
                    .format(new Date(openedAt));
                info.addView(detail("信号时间",signalTime,navy));
                long delayMs=Math.max(0L,System.currentTimeMillis()-openedAt);
                String delay=String.format(Locale.CHINA,"%.1f 秒",delayMs/1000.0);
                info.addView(detail("提醒延迟",delay,navy));
                layout.addView(info,new LinearLayout.LayoutParams(-1,dp(144)));

                LinearLayout buttons=new LinearLayout(service);
                buttons.setOrientation(LinearLayout.HORIZONTAL);
                buttons.setGravity(Gravity.CENTER_VERTICAL);
                LinearLayout.LayoutParams buttonGroupLp=new LinearLayout.LayoutParams(-1,dp(44));
                buttonGroupLp.topMargin=dp(13);

                Button silent=new Button(service);
                silent.setAllCaps(false);
                silent.setText("关闭提醒");
                silent.setTextSize(12);
                silent.setTextColor(blue);
                silent.setBackground(tile(Color.rgb(239,247,255),Color.rgb(217,234,248),13));
                buttons.addView(silent,new LinearLayout.LayoutParams(0,-1,1f));
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
                confirm.setTextSize(12);
                confirm.setTextColor(Color.WHITE);
                confirm.setBackground(tile(Color.rgb(36,128,208),Color.rgb(36,128,208),13));
                LinearLayout.LayoutParams confirmLp=new LinearLayout.LayoutParams(0,-1,1.45f);
                confirmLp.leftMargin=dp(9);
                buttons.addView(confirm,confirmLp);
                confirm.setOnClickListener(v->{
                    if(!signalId.equals(showingId))return;
                    listener.onConfirm(signalId,noticeId);
                });
                layout.addView(buttons,buttonGroupLp);
                TextView caution=line("仅信号提醒 · 不自动下单 · 锁屏以系统通知为准",10,secondary,false);
                LinearLayout.LayoutParams cautionLp=new LinearLayout.LayoutParams(-1,dp(21));
                cautionLp.topMargin=dp(6);
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
