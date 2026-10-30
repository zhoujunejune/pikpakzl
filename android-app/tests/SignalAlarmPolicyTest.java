package com.zlcontrol.android;

public final class SignalAlarmPolicyTest {
    public static void main(String[] args) {
        long enabled=1_000_000_000L;
        long opened=enabled+100_000;
        long expiry=opened+140_000;
        long now=opened+10_000;
        eq("ALERT",SignalAlarmPolicy.decide("DOWN","new",null,opened,expiry,enabled,now));
        eq("ALERT",SignalAlarmPolicy.decide("UP","first","",opened,expiry,enabled,now));
        eq("NO_SIGNAL",SignalAlarmPolicy.decide("NO_SIGNAL","x",null,opened,expiry,enabled,now));
        eq("NO_SIGNAL",SignalAlarmPolicy.decide("WAIT","x",null,opened,expiry,enabled,now));
        eq("NO_SIGNAL",SignalAlarmPolicy.decide("", "x",null,opened,expiry,enabled,now));
        eq("ALREADY_HANDLED",SignalAlarmPolicy.decide("DOWN","same","same",opened,expiry,enabled,now));
        eq("BEFORE_ENABLED",SignalAlarmPolicy.decide("DOWN","old",null,enabled-1,expiry,enabled,now));
        eq("SIGNAL_EXPIRED",SignalAlarmPolicy.decide("DOWN","late",null,opened,expiry,enabled,expiry+1));
        eq("SIGNAL_TOO_OLD",SignalAlarmPolicy.decide("UP","late",null,opened,0,enabled,opened+361_000));
        eq("ALERT",SignalAlarmPolicy.decide("UP","late-but-live",null,opened,expiry,enabled,opened+170_000-31_000));
        eq("MISSING_ENABLE_TIME",SignalAlarmPolicy.decide("UP","x",null,opened,expiry,0,now));
        eq("INVALID_TIME",SignalAlarmPolicy.decide("DOWN","x",null,0,expiry,enabled,now));
        eq("INVALID_ID",SignalAlarmPolicy.decide("DOWN","",null,opened,expiry,enabled,now));
        eq("PHONE_CLOCK_BEHIND",SignalAlarmPolicy.decide("DOWN","x",null,opened,expiry,enabled,opened-11_000));
        eq("BAD_EXPIRY",SignalAlarmPolicy.decide("DOWN","x",null,opened,opened,enabled,now));
        System.out.println("ZL_ALARM_POLICY_REGRESSION_TESTS_PASS");
    }
    private static void eq(String expected,String actual) {
        if(!expected.equals(actual))throw new AssertionError(expected+" != "+actual);
    }
}
