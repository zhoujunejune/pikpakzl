package com.zlcontrol.android;

/**
 * Presentation-only alert direction transform. Source record, signal ID,
 * settlement, accuracy and cloud model output must NEVER be modified.
 */
public final class AlertDirectionPolicy {
    private AlertDirectionPolicy() {}

    /** UI text is derived from the SAME raw model direction as the Android alert. */
    public static String modelDirectionText(String original) {
        if ("UP".equals(original)) return "看涨";
        if ("DOWN".equals(original)) return "看跌";
        return null;
    }

    public static String overlayDirectionText(String original,boolean reverseEnabled) {
        String shown=notifiedDirection(original,reverseEnabled);
        if(shown==null)return null;
        if(reverseEnabled)return "UP".equals(shown)?"↑  反向买涨":"↓  反向买跌";
        return "UP".equals(shown)?"↑  看涨":"↓  看跌";
    }

    public static String notificationTitle(String original,boolean reverseEnabled) {
        String shown=notifiedDirection(original,reverseEnabled);
        if(shown==null)return null;
        String label=modelDirectionText(shown);
        return reverseEnabled?"反向提醒：买"+label.substring(1):"原始信号："+label;
    }

    public static String notifiedDirection(String original,boolean reverseEnabled) {
        if ("UP".equals(original)) return reverseEnabled ? "DOWN" : "UP";
        if ("DOWN".equals(original)) return reverseEnabled ? "UP" : "DOWN";
        return null; // WAIT/no-signal/invalid must not create an alert.
    }
}
