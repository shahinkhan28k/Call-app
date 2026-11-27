package com.claro.app.crypto

import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object E2eeCryptoManager {
    private const val CURVE = "secp256r1"
    private const val AES_GCM = "AES/GCM/NoPadding"

    fun generateDeviceKeyPair() = KeyPairGenerator.getInstance("EC").apply {
        initialize(ECGenParameterSpec(CURVE))
    }.generateKeyPair()

    fun deriveSharedAesKey(privateKey: PrivateKey, peerPublicKeyBase64: String): SecretKeySpec {
        val pubBytes = Base64.decode(peerPublicKeyBase64, Base64.NO_WRAP)
        val peerPublicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(pubBytes))
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(privateKey)
        agreement.doPhase(peerPublicKey, true)
        return SecretKeySpec(agreement.generateSecret().copyOf(32), "AES")
    }

    fun encrypt(plaintext: String, aesKey: SecretKeySpec): Pair<String, String> {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance(AES_GCM)
        cipher.init(Cipher.ENCRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(encrypted, Base64.NO_WRAP) to Base64.encodeToString(iv, Base64.NO_WRAP)
    }

    fun decrypt(ciphertextBase64: String, ivBase64: String, aesKey: SecretKeySpec): String {
        val cipher = Cipher.getInstance(AES_GCM)
        val iv = Base64.decode(ivBase64, Base64.NO_WRAP)
        cipher.init(Cipher.DECRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
        val plain = cipher.doFinal(Base64.decode(ciphertextBase64, Base64.NO_WRAP))
        return String(plain, Charsets.UTF_8)
    }
}
