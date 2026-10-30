package com.zlcontrol.android;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.Manifest;
import android.os.Build;
import android.content.pm.PackageManager;

/** Resume the explicitly enabled watcher after device restart where OS permits it. */
public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        if(!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()))return;
        if(!SecureStore.prefs(context).getBoolean(SignalAlertService.PREF_ENABLED,false))return;
        if(SecureStore.loadLogin(context)==null)return;
        if(Build.VERSION.SDK_INT>=33&&
           context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED)return;
        try{SignalAlertService.start(context);}
        catch(RuntimeException ignored){
            SecureStore.prefs(context).edit().putString(SignalAlertService.PREF_LAST_STATE,
                    "重启后未能自动监听，请打开 App 重试").apply();
        }
    }
}
