package com.zlcontrol.android;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Encrypts only the original website login credential for native background polling. */
public final class SecureStore {
    private static final String PREFS="zl_signal_settings";
    private static final String ALIAS="zl_signal_alarm_login_v1";
    private SecureStore(){}
    public static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS,Context.MODE_PRIVATE);
    }
    private static SecretKey key() throws Exception {
        KeyStore store=KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if(store.containsAlias(ALIAS))return ((KeyStore.SecretKeyEntry)store.getEntry(ALIAS,null)).getSecretKey();
        KeyGenerator gen=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(ALIAS,
              KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
              .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
              .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
              .setKeySize(256).build());
        return gen.generateKey();
    }
    public static void saveLogin(Context ctx,String username,String password) throws Exception {
        if(username==null||username.isEmpty()||password==null||password.isEmpty())throw new IllegalArgumentException("EMPTY_LOGIN");
        JSONObject raw=new JSONObject();
        raw.put("username",username);
        raw.put("password",password);
        Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE,key());
        byte[] iv=cipher.getIV();
        byte[] encrypted=cipher.doFinal(raw.toString().getBytes(StandardCharsets.UTF_8));
        JSONObject envelope=new JSONObject();
        envelope.put("iv",Base64.encodeToString(iv,Base64.NO_WRAP));
        envelope.put("ciphertext",Base64.encodeToString(encrypted,Base64.NO_WRAP));
        if(!prefs(ctx).edit().putString("encrypted_login",envelope.toString()).commit()){
            throw new IllegalStateException("LOGIN_PERSIST_FAILED");
        }
    }
    public static String[] loadLogin(Context ctx){
        String saved=prefs(ctx).getString("encrypted_login",null);
        if(saved==null)return null;
        try{
            JSONObject envelope=new JSONObject(saved);
            byte[] iv=Base64.decode(envelope.getString("iv"),Base64.NO_WRAP);
            if(iv.length!=12) return null;
            byte[] encrypted=Base64.decode(envelope.getString("ciphertext"),Base64.NO_WRAP);
            Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));
            JSONObject raw=new JSONObject(new String(cipher.doFinal(encrypted),StandardCharsets.UTF_8));
            String user=raw.getString("username"), pass=raw.getString("password");
            return user.isEmpty()||pass.isEmpty()?null:new String[]{user,pass};
        }catch(Exception e){return null;}
    }
    public static void clearLogin(Context ctx){
        prefs(ctx).edit().remove("encrypted_login").apply();
    }
}
