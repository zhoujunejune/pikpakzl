package com.zlcontrol.android;

/** Standalone JDK-side checks: no Android dependency, fake signals, or trades. */
public final class AlertDirectionPolicySmoke {
    private static void expect(String actual,String expected,String label) {
        if (!java.util.Objects.equals(actual,expected))
            throw new AssertionError(label+": expected "+expected+", got "+actual);
    }
    public static void main(String[] args) {
        expect(AlertDirectionPolicy.notifiedDirection("UP",false),"UP","default up");
        expect(AlertDirectionPolicy.notifiedDirection("DOWN",false),"DOWN","default down");
        expect(AlertDirectionPolicy.notifiedDirection("UP",true),"DOWN","reverse up");
        expect(AlertDirectionPolicy.notifiedDirection("DOWN",true),"UP","reverse down");
        expect(AlertDirectionPolicy.notifiedDirection("WAIT",false),null,"wait default");
        expect(AlertDirectionPolicy.notifiedDirection("WAIT",true),null,"wait reverse");
        expect(AlertDirectionPolicy.notifiedDirection(null,true),null,"null reverse");
        expect(AlertDirectionPolicy.notifiedDirection("",true),null,"empty reverse");
        expect(AlertDirectionPolicy.notifiedDirection("UP",true),"DOWN","repeat deterministic");
        System.out.println("HAIPAI_REVERSE_DIRECTION_POLICY_TESTS_OK=true");
    }
}
