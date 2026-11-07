package com.zlcontrol.android;

/**
 * Presentation-only alert direction transform. Source record, signal ID,
 * settlement, accuracy and cloud model output must NEVER be modified.
 */
public final class AlertDirectionPolicy {
    private AlertDirectionPolicy() {}

    public static String notifiedDirection(String original,boolean reverseEnabled) {
        if ("UP".equals(original)) return reverseEnabled ? "DOWN" : "UP";
        if ("DOWN".equals(original)) return reverseEnabled ? "UP" : "DOWN";
        return null; // WAIT/no-signal/invalid must not create an alert.
    }
}
