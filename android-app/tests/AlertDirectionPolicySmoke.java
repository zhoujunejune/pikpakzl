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
        // Switch OFF is a first-class original-direction UI, not an implicit reverse.
        expect(AlertDirectionPolicy.overlayDirectionText("UP",false),"↑  看涨","off original up");
        expect(AlertDirectionPolicy.overlayDirectionText("DOWN",false),"↓  看跌","off original down");
        expect(AlertDirectionPolicy.notificationTitle("UP",false),"原始信号：看涨","off notice up");
        expect(AlertDirectionPolicy.notificationTitle("DOWN",false),"原始信号：看跌","off notice down");
        // Switch ON shows the inverse direction, clearly labelled as inverse.
        expect(AlertDirectionPolicy.overlayDirectionText("UP",true),"↓  反向买跌","on original up");
        expect(AlertDirectionPolicy.overlayDirectionText("DOWN",true),"↑  反向买涨","on original down");
        expect(AlertDirectionPolicy.notificationTitle("UP",true),"反向提醒：买跌","on notice down");
        expect(AlertDirectionPolicy.notificationTitle("DOWN",true),"反向提醒：买涨","on notice up");
        // Invalid directions never become actionable UI.
        expect(AlertDirectionPolicy.overlayDirectionText("WAIT",false),null,"off wait");
        expect(AlertDirectionPolicy.overlayDirectionText("WAIT",true),null,"on wait");
        expect(AlertDirectionPolicy.notificationTitle("",true),null,"on empty");
        expect(AlertDirectionPolicy.modelDirectionText("WAIT"),null,"raw wait");
        System.out.println("HAIPAI_REVERSE_DIRECTION_POLICY_TESTS_OK=true");
    }
}
