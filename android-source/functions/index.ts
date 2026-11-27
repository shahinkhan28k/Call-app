import * as admin from 'firebase-admin';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

admin.initializeApp();

export const notifyOnNewMessage = onDocumentCreated(
  'chats/{chatId}/messages/{messageId}',
  async (event) => {
    const msg = event.data?.data();
    if (!msg || !msg.receiverId || !msg.senderId) return;

    const notifId = `msg_${event.params.messageId}`;
    await admin.firestore().collection('notifications').doc(notifId).set({
      notificationId: notifId,
      userId: msg.receiverId,
      title: 'New private message',
      body: msg.isEncrypted ? 'Encrypted message received' : String(msg.messageText || '').slice(0, 120),
      type: 'message',
      relatedId: event.params.chatId,
      readStatus: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
);

export const notifyOnIncomingCall = onDocumentCreated('calls/{callId}', async (event) => {
  const call = event.data?.data();
  if (!call || !call.receiverId) return;

  const notifId = `call_${event.params.callId}`;
  await admin.firestore().collection('notifications').doc(notifId).set({
    notificationId: notifId,
    userId: call.receiverId,
    title: `Incoming ${call.callType || 'audio'} call`,
    body: 'Tap to answer your private WebRTC call',
    type: 'missed_call',
    relatedId: event.params.callId,
    readStatus: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
});
