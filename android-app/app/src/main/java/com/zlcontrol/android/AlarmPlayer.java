package com.zlcontrol.android;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.content.Context;
import android.os.Build;
import java.io.IOException;

/** Uses the user's currently selected SYSTEM ALARM ringtone and alarm audio volume. */
public final class AlarmPlayer {
    private MediaPlayer player;
    private Vibrator vibrator;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Runnable stopTask=this::stop;
    public synchronized boolean play(Context context,int seconds){
        stop();
        Uri sound=RingtoneManager.getActualDefaultRingtoneUri(context,RingtoneManager.TYPE_ALARM);
        if(sound==null)sound=RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
        try {
            if(sound==null)return false;
            MediaPlayer p=new MediaPlayer();
            p.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
            p.setDataSource(context,sound);
            p.setLooping(true);
            p.prepare();
            p.start();
            player=p;
        }catch(Exception e){
            if(player!=null){try{player.release();}catch(Exception ignored){} player=null;}
            return false;
        }
        try{
            vibrator=(Vibrator)context.getSystemService(Context.VIBRATOR_SERVICE);
            if(vibrator!=null&&vibrator.hasVibrator()){
                vibrator.vibrate(VibrationEffect.createWaveform(
                  new long[]{0,550,250,550,300,700,350,700},0));
            }
        }catch(Exception ignored){}
        handler.postDelayed(stopTask,seconds*1000L);
        return true;
    }
    public synchronized void stop(){
        handler.removeCallbacks(stopTask);
        if(player!=null){
            try{player.stop();}catch(Exception ignored){}
            try{player.release();}catch(Exception ignored){}
            player=null;
        }
        if(vibrator!=null){try{vibrator.cancel();}catch(Exception ignored){}vibrator=null;}
    }
}
