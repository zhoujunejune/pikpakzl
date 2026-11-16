package com.zlcontrol.android;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * Device-local, user-confirmed trade tally. One tap means the user declares
 * ONE real completed trade, NOT a verified Binance fill or model signal.
 * No Binance APIs, no orders, no server writes. Persist across app upgrades.
 */
public final class TradeJournal {
    private static final String KEY="haipai_manual_real_trades_v1";
    private static final String LAST_TAP="haipai_manual_real_trades_last_tap_v1";
    private static final long DOUBLE_TAP_GUARD_MS=1200L;
    private static final int DAILY_REFERENCE_LIMIT=10; // informational only: never hide actual trades.
    private final SharedPreferences prefs;

    public TradeJournal(Context context) {
        prefs=SecureStore.prefs(context);
    }

    private static String day(long timestamp) {
        SimpleDateFormat f=new SimpleDateFormat("yyyy-MM-dd",Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return f.format(new java.util.Date(timestamp));
    }

    private static String clock(long timestamp) {
        SimpleDateFormat f=new SimpleDateFormat("HH:mm:ss",Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("Asia/Shanghai"));
        return f.format(new java.util.Date(timestamp));
    }

    private JSONArray read() throws Exception {
        return new JSONArray(prefs.getString(KEY,"[]"));
    }

    private static String error(String message) {
        return "{\"ok\":false,\"error\":\""+message+"\"}";
    }

    private String render(JSONArray events) throws Exception {
        String today=day(System.currentTimeMillis());
        Map<String,Integer> counts=new LinkedHashMap<>();
        long lastAt=0L;
        boolean canUndo=false;
        for(int i=0;i<events.length();i++){
            JSONObject item=events.getJSONObject(i);
            long at=item.getLong("at");
            if(at<=0)throw new IllegalStateException("INVALID_TRADE_TIME");
            String d=day(at);
            counts.put(d,counts.getOrDefault(d,0)+1);
            if(at>=lastAt){
                lastAt=at;
                canUndo=today.equals(d);
            }
        }
        int count=counts.getOrDefault(today,0);
        JSONObject out=new JSONObject();
        out.put("ok",true).put("date",today).put("count",count)
            .put("limit",DAILY_REFERENCE_LIMIT).put("canUndo",canUndo)
            .put("lastTime",lastAt>0?day(lastAt)+" "+clock(lastAt):"")
            .put("totalRecorded",events.length());
        List<String> dates=new ArrayList<>(counts.keySet());
        if(!counts.containsKey(today))dates.add(today);
        Collections.sort(dates,Collections.reverseOrder());
        JSONArray history=new JSONArray();
        for(int i=0;i<dates.size()&&i<30;i++){
            String d=dates.get(i);
            history.put(new JSONObject().put("date",d).put("count",counts.getOrDefault(d,0)));
        }
        out.put("history",history);
        out.put("timeZone","Asia/Shanghai");
        out.put("source","MANUAL_USER_CONFIRMED_LOCAL_ONLY");
        return out.toString();
    }

    public synchronized String snapshot(){
        try{return render(read());}
        catch(Exception e){return error("READ_FAILED");}
    }

    public synchronized String record(){
        try{
            long now=System.currentTimeMillis();
            long lastTap=prefs.getLong(LAST_TAP,0L);
            if(lastTap>0&&now-lastTap>=0&&now-lastTap<DOUBLE_TAP_GUARD_MS)
                return error("DUPLICATE_TAP");
            JSONArray events=read();
            events.put(new JSONObject().put("at",now));
            if(!prefs.edit().putString(KEY,events.toString()).putLong(LAST_TAP,now).commit())
                return error("SAVE_FAILED");
            return render(events);
        }catch(Exception e){return error("SAVE_FAILED");}
    }

    public synchronized String undoLastToday(){
        try{
            JSONArray events=read();
            if(events.length()==0)return error("NOTHING_TO_UNDO");
            JSONObject last=events.getJSONObject(events.length()-1);
            if(!day(System.currentTimeMillis()).equals(day(last.getLong("at"))))
                return error("NOTHING_TO_UNDO");
            events.remove(events.length()-1);
            if(!prefs.edit().putString(KEY,events.toString()).remove(LAST_TAP).commit())
                return error("SAVE_FAILED");
            return render(events);
        }catch(Exception e){return error("UNDO_FAILED");}
    }
}
