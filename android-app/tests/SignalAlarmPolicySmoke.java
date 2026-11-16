package com.zlcontrol.android;

/** Device-independent guard regression: new IDs only, never old signals or WAIT. */
public final class SignalAlarmPolicySmoke {
    private static void expect(String label,String actual,String expected) {
        if(!java.util.Objects.equals(actual,expected))
            throw new AssertionError(label+" expected="+expected+" actual="+actual);
    }
    public static void main(String[] args) {
        long now=1_794_000_000_000L;
        long enabled=now-600000;
        String id="auto-1m-1794000000000";
        expect("new UP",SignalAlarmPolicy.decide("UP",id,null,now-2000,now+598000,enabled,now),"ALERT");
        expect("new DOWN",SignalAlarmPolicy.decide("DOWN",id,null,now-2000,now+598000,enabled,now),"ALERT");
        expect("no signal",SignalAlarmPolicy.decide("WAIT",id,null,now-2000,now+598000,enabled,now),"NO_SIGNAL");
        expect("duplicate",SignalAlarmPolicy.decide("UP",id,id,now-2000,now+598000,enabled,now),"ALREADY_HANDLED");
        expect("before enabled",SignalAlarmPolicy.decide("UP",id,null,enabled-1,now+598000,enabled,now),"BEFORE_ENABLED");
        expect("late",SignalAlarmPolicy.decide("UP",id,null,now-121000,now+479000,enabled,now),"SIGNAL_TOO_LATE");
        expect("expired",SignalAlarmPolicy.decide("UP",id,null,now-5000,now-1,enabled,now),"SIGNAL_EXPIRED");
        expect("clock",SignalAlarmPolicy.decide("UP",id,null,now+12000,now+610000,enabled,now),"PHONE_CLOCK_BEHIND");
        System.out.println("HAIPAI_SIGNAL_ALARM_POLICY_TESTS_OK=true");
    }
}
