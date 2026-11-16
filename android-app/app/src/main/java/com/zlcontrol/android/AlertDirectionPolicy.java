package com.zlcontrol.android;

/** Presentation-only direction mapping: never modify model, ledger or settlement. */
public final class AlertDirectionPolicy {
    private AlertDirectionPolicy() {}

    public static String notifiedDirection(String original,boolean reverseEnabled) {
        if ("UP".equals(original)) return reverseEnabled ? "DOWN" : "UP";
        if ("DOWN".equals(original)) return reverseEnabled ? "UP" : "DOWN";
        return null; // WAIT/invalid never generates a trading prompt.
    }

    public static String originalDescription(String original) {
        if ("UP".equals(original)) return "看涨 UP";
        if ("DOWN".equals(original)) return "看跌 DOWN";
        return null;
    }

    public static String overlayLabel(String original,boolean reverseEnabled) {
        String shown=notifiedDirection(original,reverseEnabled);
        if(shown==null)return null;
        return ("UP".equals(shown)?"↑  ":"↓  ")
            +(reverseEnabled?"买":"看")+("UP".equals(shown)?"涨":"跌")+"  "+shown;
    }

    public static String notificationTitle(String original,boolean reverseEnabled) {
        String shown=notifiedDirection(original,reverseEnabled);
        if(shown==null)return null;
        return (reverseEnabled?"反向操作：":"模型信号：")
            +(reverseEnabled?"买":"看")+("UP".equals(shown)?"涨":"跌")+" "+shown;
    }

    public static String modeHint(String original,boolean reverseEnabled) {
        String source=originalDescription(original);
        if(source==null)return null;
        return reverseEnabled
            ?"V19原始模型方向："+source+"\n仅本机反向提醒，原始记录与胜率不变"
            :"反向提醒已关闭 · V19原始方向："+source+"\n请核对币安事件轮次和价格";
    }
}
