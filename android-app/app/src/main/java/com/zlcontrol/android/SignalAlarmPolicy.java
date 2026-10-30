package com.zlcontrol.android;

/** Pure deterministic guard. Only genuinely new live UP/DOWN signals may ring. */
public final class SignalAlarmPolicy {
    private SignalAlarmPolicy() {}
    public static final String ALERT = "ALERT";
    public static String decide(String direction,String id,String lastId,long openedAt,
                                long expiresAt,long enabledAt,long nowMs){
        if(!"UP".equals(direction)&&!"DOWN".equals(direction))return "NO_SIGNAL";
        if(id==null||id.isEmpty())return "INVALID_ID";
        if(id.equals(lastId))return "ALREADY_HANDLED";
        if(enabledAt<=0)return "MISSING_ENABLE_TIME";
        if(openedAt<=0)return "INVALID_TIME";
        // Allow small clock differences, never ring for a signal produced before switch-on.
        if(openedAt+3000L<enabledAt)return "BEFORE_ENABLED";
        if(openedAt>nowMs+10000L)return "PHONE_CLOCK_BEHIND";
        // Market has an explicit expiry: do not wake user for dead event contracts.
        if(expiresAt>0){
            if(expiresAt<=openedAt)return "BAD_EXPIRY";
            if(nowMs>=expiresAt)return "SIGNAL_EXPIRED";
        }else if(nowMs-openedAt>360000L){
            return "SIGNAL_TOO_OLD";
        }
        return ALERT;
    }
}
