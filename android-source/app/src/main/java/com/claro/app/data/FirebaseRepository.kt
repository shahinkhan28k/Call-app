package com.claro.app.data

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

data class ChatMessage(
    val messageId: String = "",
    val chatId: String = "",
    val senderId: String = "",
    val receiverId: String = "",
    val messageType: String = "text",
    val messageText: String = "",
    val ciphertext: String = "",
    val iv: String = "",
    val isEncrypted: Boolean = false,
    val attachmentUrl: String = "",
    val deliveryStatus: String = "sent",
    val readStatus: Boolean = false
)

class FirebaseRepository(
    private val auth: FirebaseAuth = FirebaseAuth.getInstance(),
    private val db: FirebaseFirestore = FirebaseFirestore.getInstance()
) {
    fun currentUid(): String? = auth.currentUser?.uid

    fun observeMessages(chatId: String): Flow<List<ChatMessage>> = callbackFlow {
        val uid = currentUid() ?: run {
            close()
            return@callbackFlow
        }
        val listener = db.collection("chats").document(chatId)
            .collection("messages")
            .whereArrayContains("participantIds", uid)
            .addSnapshotListener { snap, err ->
                if (err != null) {
                    close(err)
                    return@addSnapshotListener
                }
                val items = snap?.documents
                    ?.mapNotNull { it.toObject(ChatMessage::class.java) }
                    ?.sortedBy { it.messageId }
                    ?: emptyList()
                trySend(items)
            }
        awaitClose { listener.remove() }
    }

    suspend fun sendMessage(
        chatId: String,
        receiverId: String,
        messageText: String,
        ciphertext: String = "",
        iv: String = "",
        isEncrypted: Boolean = false
    ) {
        val uid = currentUid() ?: return
        val messageId = "${System.currentTimeMillis().toString().padStart(15, '0')}_${java.util.UUID.randomUUID().toString().take(6)}"
        val payload = hashMapOf(
            "messageId" to messageId,
            "chatId" to chatId,
            "senderId" to uid,
            "receiverId" to receiverId,
            "participantIds" to listOf(uid, receiverId),
            "messageType" to "text",
            "messageText" to messageText,
            "ciphertext" to ciphertext,
            "iv" to iv,
            "isEncrypted" to isEncrypted,
            "deliveryStatus" to "sent",
            "readStatus" to false,
            "edited" to false,
            "deletedForEveryone" to false,
            "createdAt" to FieldValue.serverTimestamp(),
            "updatedAt" to FieldValue.serverTimestamp()
        )
        db.collection("chats").document(chatId)
            .collection("messages").document(messageId)
            .set(payload)
            .await()
    }
}
