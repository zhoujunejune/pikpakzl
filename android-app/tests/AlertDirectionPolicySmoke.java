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
        // Both states must agree across the heads-up notification and the overlay.
        expect(AlertDirectionPolicy.overlayLabel("UP",false),"↑  看涨  UP","off up overlay");
        expect(AlertDirectionPolicy.overlayLabel("DOWN",false),"↓  看跌  DOWN","off down overlay");
        expect(AlertDirectionPolicy.overlayLabel("UP",true),"↓  买跌  DOWN","on up overlay");
        expect(AlertDirectionPolicy.overlayLabel("DOWN",true),"↑  买涨  UP","on down overlay");
        expect(AlertDirectionPolicy.notificationTitle("UP",false),"模型信号：看涨 UP","off up notice");
        expect(AlertDirectionPolicy.notificationTitle("DOWN",false),"模型信号：看跌 DOWN","off down notice");
        expect(AlertDirectionPolicy.notificationTitle("UP",true),"反向操作：买跌 DOWN","on up notice");
        expect(AlertDirectionPolicy.notificationTitle("DOWN",true),"反向操作：买涨 UP","on down notice");
        expect(AlertDirectionPolicy.overlayLabel("WAIT",true),null,"no fake reverse");
        expect(AlertDirectionPolicy.notificationTitle("WAIT",false),null,"no fake normal");
        if(!AlertDirectionPolicy.modeHint("UP",false).contains("已关闭"))throw new AssertionError("off hint");
        if(!AlertDirectionPolicy.modeHint("UP",true).contains("原始模型方向：看涨 UP"))throw new AssertionError("on source hint");
        System.out.println("HAIPAI_REVERSE_DIRECTION_POLICY_TESTS_OK=true");
    }
}
