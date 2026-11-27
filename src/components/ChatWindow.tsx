import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCheck,
  Copy,
  Edit3,
  FileText,
  Film,
  Flag,
  Forward,
  Image as ImageIcon,
  Lock,
  Mic,
  Paperclip,
  Phone,
  Reply,
  Send,
  Shield,
  Smile,
  Square,
  Trash2,
  UserCheck,
  Video,
  X,
} from 'lucide-react';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { decryptMessageText, encryptMessageText } from '../lib/crypto';
import { compressImageFile, formatBytes, isSafeMediaUrl, uploadAttachment } from '../lib/media';
import type { ChatDoc, DataMode, MessageDoc, MessageType, UserDirectoryEntry } from '../types';
import { VALIDATION_LIMITS } from '../types';
import { Avatar } from './Avatar';

interface ChatWindowProps {
  chat: ChatDoc;
  currentUid: string;
  currentUserProfile: {
    fullName: string;
    readReceipts: boolean;
    lowDataMode: boolean;
  };
  dataMode: DataMode;
  myPrivateKey: CryptoKey | null;
  peer: UserDirectoryEntry | null;
  isBlocked: boolean;
  allContacts: UserDirectoryEntry[];
  onBackMobile: () => void;
  onStartCall: (peer: UserDirectoryEntry, type: 'audio' | 'video') => void;
  onToggleBlock: (peerUid: string, currentlyBlocked: boolean) => Promise<void>;
  onSubmitReport: (peerUid: string, reason: string, details: string) => Promise<void>;
  sendWsTyping?: (to: string, chatId: string, typing: boolean) => void;
  wsPeerTyping?: boolean;
}

const EMOJI_GRID = ['👍', '❤️', '😂', '🙏', '🎉', '🔥', '👏', '😊', '🤔', '👀', '✅', '✨', '📞', '📎', '🔒', '👋'];

export const ChatWindow: React.FC<ChatWindowProps> = ({
  chat,
  currentUid,
  currentUserProfile,
  dataMode,
  myPrivateKey,
  peer,
  isBlocked,
  allContacts,
  onBackMobile,
  onStartCall,
  onToggleBlock,
  onSubmitReport,
  sendWsTyping,
  wsPeerTyping,
}) => {
  const peerUid = chat.participantA === currentUid ? chat.participantB : chat.participantA;
  const isParticipantA = chat.participantA === currentUid;

  const [messages, setMessages] = useState<MessageDoc[]>([]);
  const [decryptedMap, setDecryptedMap] = useState<Record<string, string>>({});
  const [pageLimit, setPageLimit] = useState(60);

  const [composerText, setComposerText] = useState('');
  const [replyTarget, setReplyTarget] = useState<MessageDoc | null>(null);
  const [editingMsg, setEditingMsg] = useState<MessageDoc | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<MessageDoc | null>(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showProfileDrawer, setShowProfileDrawer] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportReason, setReportReason] = useState('Harassment or abuse');
  const [reportDetails, setReportDetails] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [loadedMediaIds, setLoadedMediaIds] = useState<Record<string, boolean>>({});

  // Voice recording state
  const [recording, setRecording] = useState(false);
  const [recordingSec, setRecordingSec] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);

  const canE2EE = Boolean(chat.isE2EE && myPrivateKey && peer?.publicKeyJwk);

  // Subscribe to messages for this chat
  useEffect(() => {
    const q = query(
      collection(db, 'chats', chat.chatId, 'messages'),
      where('participantIds', 'array-contains', currentUid)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs
          .map((d) => d.data() as MessageDoc)
          .sort((a, b) => a.messageId.localeCompare(b.messageId));
        setMessages(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, `chats/${chat.chatId}/messages`)
    );
    return () => unsub();
  }, [chat.chatId, currentUid]);

  // Decrypt E2EE messages locally when keys are present
  useEffect(() => {
    if (!myPrivateKey || !peer?.publicKeyJwk) return;
    let active = true;
    (async () => {
      const updates: Record<string, string> = {};
      for (const msg of messages) {
        if (msg.isEncrypted && msg.ciphertext && msg.iv && !decryptedMap[msg.messageId] && !msg.deletedForEveryone) {
          try {
            const plain = await decryptMessageText(
              msg.ciphertext,
              msg.iv,
              myPrivateKey,
              peer.publicKeyJwk!
            );
            updates[msg.messageId] = plain;
          } catch {
            updates[msg.messageId] = '[Encrypted with a previous device key]';
          }
        }
      }
      if (active && Object.keys(updates).length > 0) {
        setDecryptedMap((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      active = false;
    };
  }, [decryptedMap, messages, myPrivateKey, peer?.publicKeyJwk]);

  // Mark incoming messages as read & reset unread count
  useEffect(() => {
    const myUnread = isParticipantA ? chat.unreadA : chat.unreadB;
    if (myUnread > 0) {
      void updateDoc(doc(db, 'chats', chat.chatId), {
        unreadA: isParticipantA ? 0 : chat.unreadA,
        unreadB: isParticipantA ? chat.unreadB : 0,
        updatedAt: serverTimestamp(),
      });
    }

    if (!currentUserProfile.readReceipts) return;
    const unreadMsgs = messages.filter(
      (m) => m.receiverId === currentUid && !m.readStatus
    );
    for (const m of unreadMsgs) {
      void updateDoc(doc(db, 'chats', chat.chatId, 'messages', m.messageId), {
        deliveryStatus: 'read',
        readStatus: true,
        updatedAt: serverTimestamp(),
      });
    }
  }, [
    chat.chatId,
    chat.unreadA,
    chat.unreadB,
    currentUid,
    currentUserProfile.readReceipts,
    isParticipantA,
    messages,
  ]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const visibleMessages = useMemo(() => {
    if (messages.length <= pageLimit) return messages;
    return messages.slice(messages.length - pageLimit);
  }, [messages, pageLimit]);

  const getDisplayText = (msg: MessageDoc): string => {
    if (msg.deletedForEveryone) return 'This message was deleted';
    if (msg.isEncrypted && msg.ciphertext) {
      return decryptedMap[msg.messageId] || 'Decrypting...';
    }
    return msg.messageText;
  };

  const notifyTyping = (typing: boolean) => {
    sendWsTyping?.(peerUid, chat.chatId, typing);
    void updateDoc(doc(db, 'chats', chat.chatId), {
      typingA: isParticipantA ? typing : chat.typingA,
      typingB: isParticipantA ? chat.typingB : typing,
      updatedAt: serverTimestamp(),
    });
  };

  const handleComposerChange = (val: string) => {
    setComposerText(val);
    notifyTyping(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = window.setTimeout(() => notifyTyping(false), 1800);
  };

  const sendMessageRecord = async (params: {
    type: MessageType;
    text: string;
    attachmentUrl?: string;
    attachmentName?: string;
    attachmentSize?: number;
    attachmentMime?: string;
    forwardedFrom?: string;
  }) => {
    if (isBlocked) return;
    const trimmed = params.text.slice(0, VALIDATION_LIMITS.MESSAGE_MAX);
    const messageId = `${String(Date.now()).padStart(15, '0')}_${Math.random().toString(36).slice(2, 8)}`;

    let isEncrypted = false;
    let ciphertext = '';
    let iv = '';
    let storedPlain = trimmed;

    if (canE2EE && trimmed && !params.forwardedFrom && params.type === 'text') {
      try {
        const enc = await encryptMessageText(trimmed, myPrivateKey!, peer!.publicKeyJwk!);
        isEncrypted = true;
        ciphertext = enc.ciphertext;
        iv = enc.iv;
        storedPlain = '[Encrypted message]';
        setDecryptedMap((prev) => ({ ...prev, [messageId]: trimmed }));
      } catch {
        isEncrypted = false;
      }
    }

    const payload: Record<string, unknown> = {
      messageId,
      chatId: chat.chatId,
      senderId: currentUid,
      receiverId: peerUid,
      participantIds: [currentUid, peerUid],
      messageType: params.type,
      messageText: storedPlain,
      isEncrypted,
      deliveryStatus: 'sent',
      readStatus: false,
      edited: false,
      deletedForEveryone: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (isEncrypted) {
      payload.ciphertext = ciphertext;
      payload.iv = iv;
    }
    if (params.attachmentUrl) payload.attachmentUrl = params.attachmentUrl;
    if (params.attachmentName) payload.attachmentName = params.attachmentName;
    if (typeof params.attachmentSize === 'number') payload.attachmentSize = params.attachmentSize;
    if (params.attachmentMime) payload.attachmentMime = params.attachmentMime;
    if (replyTarget) {
      payload.replyToId = replyTarget.messageId;
      payload.replyPreview = getDisplayText(replyTarget).slice(0, 220);
    }
    if (params.forwardedFrom) {
      payload.forwardedFrom = params.forwardedFrom;
    }

    try {
      await setDoc(doc(db, 'chats', chat.chatId, 'messages', messageId), payload);

      const previewSummary =
        params.type === 'text'
          ? isEncrypted
            ? 'Encrypted message'
            : trimmed.slice(0, VALIDATION_LIMITS.LAST_MESSAGE_MAX)
          : `${params.type.charAt(0).toUpperCase() + params.type.slice(1)} attachment`;

      await updateDoc(doc(db, 'chats', chat.chatId), {
        lastMessage: previewSummary,
        lastMessageType: params.type,
        lastMessageSenderId: currentUid,
        lastMessageTime: serverTimestamp(),
        unreadA: isParticipantA ? chat.unreadA : chat.unreadA + 1,
        unreadB: isParticipantA ? chat.unreadB + 1 : chat.unreadB,
        isE2EE: chat.isE2EE,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `chats/${chat.chatId}/messages/${messageId}`);
    }
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = composerText.trim();
    if (!clean || isBlocked) return;

    if (editingMsg) {
      try {
        let updatePayload: Record<string, unknown> = {
          messageText: clean.slice(0, VALIDATION_LIMITS.MESSAGE_MAX),
          edited: true,
          deletedForEveryone: editingMsg.deletedForEveryone,
          updatedAt: serverTimestamp(),
        };
        if (editingMsg.isEncrypted && canE2EE) {
          const enc = await encryptMessageText(clean, myPrivateKey!, peer!.publicKeyJwk!);
          updatePayload = {
            messageText: '[Encrypted message]',
            ciphertext: enc.ciphertext,
            iv: enc.iv,
            edited: true,
            deletedForEveryone: false,
            updatedAt: serverTimestamp(),
          };
          setDecryptedMap((prev) => ({ ...prev, [editingMsg.messageId]: clean }));
        }
        await updateDoc(
          doc(db, 'chats', chat.chatId, 'messages', editingMsg.messageId),
          updatePayload
        );
        setEditingMsg(null);
        setComposerText('');
      } catch (err) {
        handleFirestoreError(
          err,
          OperationType.UPDATE,
          `chats/${chat.chatId}/messages/${editingMsg.messageId}`
        );
      }
      return;
    }

    setComposerText('');
    setReplyTarget(null);
    notifyTyping(false);
    await sendMessageRecord({ type: 'text', text: clean });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploadError(null);
    setUploading(true);
    try {
      let uploadBlob: Blob = file;
      let uploadName = file.name;
      let uploadMime = file.type || 'application/octet-stream';

      let msgType: MessageType = 'document';
      if (uploadMime.startsWith('image/')) {
        msgType = 'image';
        const compressed = await compressImageFile(file, currentUserProfile.lowDataMode);
        uploadBlob = compressed.blob;
        uploadName = compressed.name;
        uploadMime = compressed.mime;
      } else if (uploadMime.startsWith('video/')) {
        msgType = 'video';
      } else if (uploadMime.startsWith('audio/')) {
        msgType = 'audio';
      }

      const uploaded = await uploadAttachment(uploadBlob, uploadName, uploadMime);
      await sendMessageRecord({
        type: msgType,
        text: uploadName,
        attachmentUrl: uploaded.url,
        attachmentName: uploaded.name,
        attachmentSize: uploaded.size,
        attachmentMime: uploaded.mime,
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'File upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const startVoiceRecording = async () => {
    setUploadError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) audioChunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size < 200) return;
        setUploading(true);
        try {
          const uploaded = await uploadAttachment(
            blob,
            `voice_${Date.now()}.weba`,
            blob.type.split(';')[0] || 'audio/webm'
          );
          await sendMessageRecord({
            type: 'voice',
            text: `Voice note (${recordingSec}s)`,
            attachmentUrl: uploaded.url,
            attachmentName: uploaded.name,
            attachmentSize: uploaded.size,
            attachmentMime: uploaded.mime,
          });
        } catch (err) {
          setUploadError(err instanceof Error ? err.message : 'Could not upload voice message.');
        } finally {
          setUploading(false);
          setRecordingSec(0);
        }
      };

      recorder.start();
      setRecording(true);
      setRecordingSec(0);
      recordTimerRef.current = window.setInterval(() => {
        setRecordingSec((s) => s + 1);
      }, 1000);
    } catch {
      setUploadError('Microphone permission is required for voice messages.');
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      setRecording(false);
    }
  };

  const handleCopy = async (msg: MessageDoc) => {
    await navigator.clipboard.writeText(getDisplayText(msg));
    setCopiedId(msg.messageId);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleDeleteForEveryone = async (msg: MessageDoc) => {
    try {
      await updateDoc(doc(db, 'chats', chat.chatId, 'messages', msg.messageId), {
        messageText: 'This message was deleted',
        ciphertext: '',
        iv: '',
        edited: false,
        deletedForEveryone: true,
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `chats/${chat.chatId}/messages/${msg.messageId}`);
    }
  };

  const handleForwardTo = async (targetPeer: UserDirectoryEntry) => {
    if (!forwardingMsg) return;
    const targetChatId = [currentUid, targetPeer.uid].sort().join('_');
    const [pA, pB] = [currentUid, targetPeer.uid].sort();
    const messageId = `${String(Date.now()).padStart(15, '0')}_${Math.random().toString(36).slice(2, 8)}`;
    const bodyText = getDisplayText(forwardingMsg);

    try {
      await setDoc(
        doc(db, 'chats', targetChatId),
        {
          chatId: targetChatId,
          participantIds: [pA, pB],
          participantA: pA,
          participantB: pB,
          unreadA: 0,
          unreadB: 0,
          typingA: false,
          typingB: false,
          isE2EE: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      await setDoc(doc(db, 'chats', targetChatId, 'messages', messageId), {
        messageId,
        chatId: targetChatId,
        senderId: currentUid,
        receiverId: targetPeer.uid,
        participantIds: [currentUid, targetPeer.uid],
        messageType: forwardingMsg.messageType,
        messageText: bodyText.slice(0, VALIDATION_LIMITS.MESSAGE_MAX),
        isEncrypted: false,
        ...(forwardingMsg.attachmentUrl ? { attachmentUrl: forwardingMsg.attachmentUrl } : {}),
        ...(forwardingMsg.attachmentName ? { attachmentName: forwardingMsg.attachmentName } : {}),
        ...(typeof forwardingMsg.attachmentSize === 'number'
          ? { attachmentSize: forwardingMsg.attachmentSize }
          : {}),
        ...(forwardingMsg.attachmentMime ? { attachmentMime: forwardingMsg.attachmentMime } : {}),
        forwardedFrom: peer?.fullName || 'Forwarded',
        deliveryStatus: 'sent',
        readStatus: false,
        edited: false,
        deletedForEveryone: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      setForwardingMsg(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `chats/${targetChatId}/messages/${messageId}`);
    }
  };

  const peerIsTyping = wsPeerTyping || (isParticipantA ? chat.typingB : chat.typingA);

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-[#0B1120] relative">
      {/* Chat Header */}
      <div className="h-16 px-4 sm:px-6 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3 bg-white dark:bg-slate-900 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBackMobile}
            aria-label="Back to chats"
            className="lg:hidden w-10 h-10 -ml-2 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={() => setShowProfileDrawer(true)}
            className="flex items-center gap-3 text-left min-w-0 hover:opacity-85 transition-opacity"
          >
            <Avatar
              name={peer?.fullName || 'Contact'}
              src={peer?.profilePicture}
              size="md"
              onlineStatus={peer?.onlineStatus}
              showPresence
            />
            <div className="min-w-0">
              <div className="font-semibold text-sm text-slate-900 dark:text-white truncate">
                {peer?.fullName || 'Private Contact'}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5 truncate">
                {peerIsTyping ? (
                  <span className="text-blue-600 dark:text-blue-400 font-medium">Typing...</span>
                ) : (
                  <>
                    <span>{peer?.onlineStatus === 'online' ? 'Online' : 'Offline'}</span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1">
                      {canE2EE ? (
                        <>
                          <Lock className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                          <span>End-to-end encrypted</span>
                        </>
                      ) : (
                        <>
                          <Shield className="w-3 h-3 text-slate-400" />
                          <span>Protected in transit</span>
                        </>
                      )}
                    </span>
                  </>
                )}
              </div>
            </div>
          </button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={!peer || isBlocked}
            onClick={() => peer && onStartCall(peer, 'audio')}
            aria-label="Start HD audio call"
            title="Start HD Audio Call"
            className="h-9 px-2.5 sm:px-3 rounded-xl border border-slate-200 dark:border-slate-700 flex items-center justify-center gap-1.5 text-slate-700 dark:text-slate-200 hover:bg-blue-50 dark:hover:bg-blue-950/50 hover:text-blue-600 dark:hover:text-blue-400 text-xs font-medium transition-colors disabled:opacity-40"
          >
            <Phone className="w-4 h-4" />
            <span className="hidden sm:inline">Audio</span>
          </button>
          <button
            type="button"
            disabled={!peer || isBlocked || dataMode === 'text_only'}
            onClick={() => peer && onStartCall(peer, 'video')}
            aria-label="Start HD video call"
            title={
              dataMode === 'text_only'
                ? 'Video calls paused in Text-Only (Zero-MB) Mode'
                : 'Start HD Video Call'
            }
            className="h-9 px-2.5 sm:px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center gap-1.5 text-xs font-medium transition-colors disabled:opacity-40"
          >
            <Video className="w-4 h-4" />
            <span className="hidden sm:inline">Video</span>
          </button>
        </div>
      </div>

      {dataMode === 'text_only' && (
        <div className="px-4 sm:px-6 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-900/50 text-xs text-amber-800 dark:text-amber-300 flex items-center justify-between gap-2 shrink-0">
          <span>
            Text-Only Mode active: Heavy media auto-download &amp; video calls are paused to save MB. Text messages continue syncing.
          </span>
        </div>
      )}

      {/* Messages Viewport */}
      <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5 space-y-3 bg-slate-50/60 dark:bg-[#0B1120]">
        {messages.length > pageLimit && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => setPageLimit((p) => p + 50)}
              className="px-4 py-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50"
            >
              Load earlier messages
            </button>
          </div>
        )}

        {visibleMessages.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center py-12">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Private conversation started
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 max-w-xs">
              {canE2EE
                ? 'Messages in this conversation are end-to-end encrypted using ECDH P-256 and AES-GCM device keys.'
                : 'Messages are protected in transit over HTTPS/TLS.'}
            </p>
          </div>
        )}

        {visibleMessages.map((msg) => {
          const mine = msg.senderId === currentUid;
          const displayBody = getDisplayText(msg);
          const timeLabel = msg.createdAt?.toDate
            ? msg.createdAt.toDate().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';

          return (
            <div
              key={msg.messageId}
              className={`group flex flex-col ${mine ? 'items-end' : 'items-start'}`}
            >
              <div className="flex items-end gap-2 max-w-[82%] sm:max-w-[68%]">
                {/* Quick hover actions (for mine on left) */}
                {mine && !msg.deletedForEveryone && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 mb-1">
                    <button
                      type="button"
                      onClick={() => setReplyTarget(msg)}
                      aria-label="Reply"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                    >
                      <Reply className="w-3.5 h-3.5" />
                    </button>
                    {msg.messageType === 'text' && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingMsg(msg);
                          setComposerText(displayBody);
                        }}
                        aria-label="Edit"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDeleteForEveryone(msg)}
                      aria-label="Delete"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm shadow-xs ${
                    mine
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800 rounded-bl-md'
                  } ${msg.deletedForEveryone ? 'italic opacity-70' : ''}`}
                >
                  {msg.forwardedFrom && (
                    <div
                      className={`text-[11px] mb-1 flex items-center gap-1 ${
                        mine ? 'text-blue-100' : 'text-slate-400'
                      }`}
                    >
                      <Forward className="w-3 h-3" />
                      <span>Forwarded</span>
                    </div>
                  )}

                  {msg.replyPreview && !msg.deletedForEveryone && (
                    <div
                      className={`text-xs px-2.5 py-1.5 rounded-lg mb-2 truncate max-w-xs ${
                        mine
                          ? 'bg-blue-700/60 text-blue-50'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {msg.replyPreview}
                    </div>
                  )}

                  {/* Attachment rendering */}
                  {!msg.deletedForEveryone && msg.attachmentUrl && isSafeMediaUrl(msg.attachmentUrl) && (
                    <div className="mb-2">
                      {dataMode === 'text_only' &&
                      (msg.messageType === 'image' || msg.messageType === 'video') &&
                      !loadedMediaIds[msg.messageId] ? (
                        <button
                          type="button"
                          onClick={() =>
                            setLoadedMediaIds((prev) => ({ ...prev, [msg.messageId]: true }))
                          }
                          className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium ${
                            mine
                              ? 'border-blue-400/50 bg-blue-700/40 text-white hover:bg-blue-700/60'
                              : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          {msg.messageType === 'image' ? (
                            <ImageIcon className="w-4 h-4 shrink-0" />
                          ) : (
                            <Film className="w-4 h-4 shrink-0" />
                          )}
                          <span>
                            Tap to load {msg.messageType}{' '}
                            {msg.attachmentSize ? `(${formatBytes(msg.attachmentSize)})` : ''}
                          </span>
                        </button>
                      ) : (
                        <>
                          {msg.messageType === 'image' && (
                            <a href={msg.attachmentUrl} target="_blank" rel="noreferrer">
                              <img
                                src={msg.attachmentUrl}
                                alt={msg.attachmentName || 'Shared image'}
                                className="max-h-64 rounded-xl object-cover"
                              />
                            </a>
                          )}
                          {msg.messageType === 'video' && (
                            <video
                              src={msg.attachmentUrl}
                              controls
                              preload={dataMode === 'saver' ? 'metadata' : 'auto'}
                              className="max-h-64 rounded-xl w-full"
                            />
                          )}
                        </>
                      )}
                      {(msg.messageType === 'audio' || msg.messageType === 'voice') && (
                        <audio src={msg.attachmentUrl} controls className="max-w-full h-9" />
                      )}
                      {msg.messageType === 'document' && (
                        <a
                          href={msg.attachmentUrl}
                          download={msg.attachmentName || 'document'}
                          className={`flex items-center gap-2.5 p-2.5 rounded-xl border ${
                            mine
                              ? 'border-blue-400/40 bg-blue-700/40 text-white'
                              : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-800 dark:text-slate-100'
                          }`}
                        >
                          <FileText className="w-5 h-5 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-xs font-medium truncate">
                              {msg.attachmentName || 'Document'}
                            </div>
                            <div className="text-[11px] opacity-75">
                              {formatBytes(msg.attachmentSize)}
                            </div>
                          </div>
                        </a>
                      )}
                    </div>
                  )}

                  {(msg.messageType === 'text' || msg.deletedForEveryone) && (
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{displayBody}</p>
                  )}

                  {/* Metadata line */}
                  <div
                    className={`mt-1 flex items-center justify-end gap-1.5 text-[11px] tabular-nums ${
                      mine ? 'text-blue-100' : 'text-slate-400'
                    }`}
                  >
                    {msg.isEncrypted && !msg.deletedForEveryone && (
                      <Lock className="w-2.5 h-2.5 opacity-80" aria-label="End-to-end encrypted" />
                    )}
                    {msg.edited && !msg.deletedForEveryone && <span>Edited</span>}
                    <span>{timeLabel}</span>
                    {mine && (
                      <span>
                        {msg.readStatus ? (
                          <CheckCheck className="w-3.5 h-3.5 text-white" aria-label="Read" />
                        ) : msg.deliveryStatus === 'delivered' ? (
                          <CheckCheck className="w-3.5 h-3.5 opacity-75" aria-label="Delivered" />
                        ) : (
                          <Check className="w-3.5 h-3.5 opacity-75" aria-label="Sent" />
                        )}
                      </span>
                    )}
                  </div>
                </div>

                {/* Quick hover actions (for received or copy/forward) */}
                {!msg.deletedForEveryone && (
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5 mb-1">
                    {!mine && (
                      <button
                        type="button"
                        onClick={() => setReplyTarget(msg)}
                        aria-label="Reply"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                      >
                        <Reply className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleCopy(msg)}
                      aria-label="Copy"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                    >
                      {copiedId === msg.messageId ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setForwardingMsg(msg)}
                      aria-label="Forward"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-800"
                    >
                      <Forward className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 sm:px-6 sm:py-3.5 shrink-0">
        {uploadError && (
          <div className="mb-2 text-xs text-rose-600 dark:text-rose-400 flex items-center justify-between">
            <span>{uploadError}</span>
            <button type="button" onClick={() => setUploadError(null)}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {(replyTarget || editingMsg) && (
          <div className="mb-2.5 flex items-center justify-between rounded-xl bg-slate-100 dark:bg-slate-800 px-3.5 py-2 text-xs">
            <div className="min-w-0">
              <span className="font-semibold text-blue-600 dark:text-blue-400">
                {editingMsg ? 'Editing message' : 'Replying'}
              </span>
              <p className="text-slate-600 dark:text-slate-300 truncate">
                {editingMsg ? getDisplayText(editingMsg) : getDisplayText(replyTarget!)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setReplyTarget(null);
                setEditingMsg(null);
                setComposerText('');
              }}
              className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {isBlocked ? (
          <div className="flex items-center justify-between py-2 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
            <span>You blocked this contact. Unblock to resume messaging.</span>
            <button
              type="button"
              onClick={() => peer && void onToggleBlock(peer.uid, true)}
              className="font-semibold text-blue-600 dark:text-blue-400 hover:underline"
            >
              Unblock
            </button>
          </div>
        ) : (
          <form onSubmit={handleSendText} className="flex items-center gap-1.5 sm:gap-2 relative">
            <input
              ref={photoInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              className="hidden"
            />
            <input
              ref={videoInputRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              onChange={handleFileChange}
              className="hidden"
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.pdf,.txt,.docx,image/*,video/mp4,video/webm"
              onChange={handleFileChange}
              className="hidden"
            />

            <button
              type="button"
              disabled={uploading}
              onClick={() => {
                if (dataMode === 'text_only') {
                  setUploadError('Photo sending is paused in Text-Only Mode. Switch to Saver or Standard HD in Settings.');
                  return;
                }
                photoInputRef.current?.click();
              }}
              aria-label="Send photo"
              title="Send Photo"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 disabled:opacity-40"
            >
              <ImageIcon className="w-5 h-5" />
            </button>

            <button
              type="button"
              disabled={uploading}
              onClick={() => {
                if (dataMode === 'text_only') {
                  setUploadError('Video sending is paused in Text-Only Mode. Switch to Saver or Standard HD in Settings.');
                  return;
                }
                videoInputRef.current?.click();
              }}
              aria-label="Send video"
              title="Send Video"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-slate-600 dark:text-slate-300 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 disabled:opacity-40"
            >
              <Film className="w-5 h-5" />
            </button>

            <button
              type="button"
              disabled={uploading}
              onClick={() => {
                if (dataMode === 'text_only') {
                  setUploadError('File attachments are paused in Text-Only Mode. Switch to Saver or Standard HD in Settings.');
                  return;
                }
                fileInputRef.current?.click();
              }}
              aria-label="Attach audio or document"
              title="Attach Audio or Document"
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0 disabled:opacity-40"
            >
              <Paperclip className="w-5 h-5" />
            </button>

            <div className="relative">
              <button
                type="button"
                onClick={() => setShowEmojiPicker((s) => !s)}
                aria-label="Insert emoji"
                className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center text-slate-500 hover:text-blue-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              >
                <Smile className="w-5 h-5" />
              </button>
              {showEmojiPicker && (
                <div className="absolute bottom-12 left-0 z-30 w-56 p-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-lg grid grid-cols-4 gap-1">
                  {EMOJI_GRID.map((em) => (
                    <button
                      key={em}
                      type="button"
                      onClick={() => {
                        setComposerText((prev) => prev + em);
                        setShowEmojiPicker(false);
                      }}
                      className="h-10 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-lg flex items-center justify-center"
                    >
                      {em}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {recording ? (
              <div className="flex-1 flex items-center justify-between px-4 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-300">
                <span className="font-mono font-medium tabular-nums">
                  Recording voice note · {recordingSec}s
                </span>
                <button
                  type="button"
                  onClick={stopVoiceRecording}
                  className="px-3 py-1 rounded-lg bg-rose-600 text-white font-medium flex items-center gap-1.5"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Send</span>
                </button>
              </div>
            ) : (
              <input
                type="text"
                maxLength={VALIDATION_LIMITS.MESSAGE_MAX}
                value={composerText}
                onChange={(e) => handleComposerChange(e.target.value)}
                placeholder={
                  uploading
                    ? 'Uploading attachment...'
                    : dataMode === 'text_only'
                      ? 'Text-Only Mode: Write a message...'
                      : 'Write a private message...'
                }
                className="flex-1 min-w-0 px-3.5 sm:px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/70 text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}

            {!recording && composerText.trim().length === 0 ? (
              <button
                type="button"
                disabled={uploading}
                onClick={() => {
                  if (dataMode === 'text_only') {
                    setUploadError('Voice messages are paused in Text-Only Mode.');
                    return;
                  }
                  void startVoiceRecording();
                }}
                aria-label="Record voice message"
                className="w-10 h-10 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-blue-50 dark:hover:bg-blue-950/50 hover:text-blue-600 flex items-center justify-center transition-colors shrink-0"
              >
                <Mic className="w-5 h-5" />
              </button>
            ) : (
              !recording && (
                <button
                  type="submit"
                  aria-label="Send message"
                  className="w-10 h-10 rounded-xl bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center transition-colors shrink-0"
                >
                  <Send className="w-4 h-4" />
                </button>
              )
            )}
          </form>
        )}
      </div>

      {/* Contact Profile & Safety Drawer */}
      {showProfileDrawer && peer && (
        <div className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-xs flex justify-end">
          <div className="w-full max-w-sm bg-white dark:bg-slate-900 h-full border-l border-slate-200 dark:border-slate-800 p-6 flex flex-col justify-between overflow-y-auto">
            <div>
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-display font-semibold text-base text-slate-900 dark:text-white">
                  Contact Info
                </h3>
                <button
                  type="button"
                  onClick={() => setShowProfileDrawer(false)}
                  className="w-9 h-9 rounded-xl flex items-center justify-center text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex flex-col items-center text-center pb-6 border-b border-slate-200 dark:border-slate-800">
                <Avatar
                  name={peer.fullName}
                  src={peer.profilePicture}
                  size="xl"
                  onlineStatus={peer.onlineStatus}
                  showPresence
                />
                <h4 className="font-display font-bold text-lg text-slate-900 dark:text-white mt-3">
                  {peer.fullName}
                </h4>
                <p className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  @{peer.username}
                </p>
                {peer.about && (
                  <p className="text-sm text-slate-600 dark:text-slate-300 mt-3">{peer.about}</p>
                )}
              </div>

              <div className="py-5 space-y-3 text-sm border-b border-slate-200 dark:border-slate-800">
                <div>
                  <span className="text-xs text-slate-400 block">Encryption</span>
                  <span className="text-slate-800 dark:text-slate-200 font-medium">
                    {canE2EE
                      ? 'ECDH P-256 + AES-GCM End-to-End'
                      : 'HTTPS / TLS Protected in Transit'}
                  </span>
                </div>
                {peer.discoverableEmail && (
                  <div>
                    <span className="text-xs text-slate-400 block">Email</span>
                    <span className="text-slate-800 dark:text-slate-200">{peer.discoverableEmail}</span>
                  </div>
                )}
                {peer.discoverablePhone && (
                  <div>
                    <span className="text-xs text-slate-400 block">Phone</span>
                    <span className="text-slate-800 dark:text-slate-200 font-mono">{peer.discoverablePhone}</span>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2.5 pt-6">
              <button
                type="button"
                onClick={async () => {
                  await onToggleBlock(peer.uid, isBlocked);
                  setShowProfileDrawer(false);
                }}
                className="w-full py-2.5 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center justify-center gap-2"
              >
                {isBlocked ? <UserCheck className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
                <span>{isBlocked ? 'Unblock Contact' : 'Block Contact'}</span>
              </button>

              <button
                type="button"
                onClick={() => setShowReportModal(true)}
                className="w-full py-2.5 px-4 rounded-xl border border-rose-200 dark:border-rose-900/60 text-sm font-medium text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 flex items-center justify-center gap-2"
              >
                <Flag className="w-4 h-4" />
                <span>Report Abusive User</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forward Message Picker Modal */}
      {forwardingMsg && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                Forward message to
              </h3>
              <button type="button" onClick={() => setForwardingMsg(null)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {allContacts
                .filter((c) => c.uid !== currentUid)
                .map((c) => (
                  <button
                    key={c.uid}
                    type="button"
                    onClick={() => void handleForwardTo(c)}
                    className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-left"
                  >
                    <Avatar name={c.fullName} src={c.profilePicture} size="sm" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-slate-900 dark:text-white truncate">
                        {c.fullName}
                      </div>
                      <div className="text-xs text-slate-500 truncate">@{c.username}</div>
                    </div>
                  </button>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* Report User Modal */}
      {showReportModal && peer && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await onSubmitReport(peer.uid, reportReason, reportDetails);
              setShowReportModal(false);
              setShowProfileDrawer(false);
              setReportDetails('');
            }}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-base text-slate-900 dark:text-white">
                Report {peer.fullName}
              </h3>
              <button type="button" onClick={() => setShowReportModal(false)}>
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
                Reason
              </label>
              <select
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
              >
                <option value="Harassment or abuse">Harassment or abuse</option>
                <option value="Spam or unwanted solicitation">Spam or unwanted solicitation</option>
                <option value="Impersonation">Impersonation</option>
                <option value="Illegal or harmful content">Illegal or harmful content</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
                Additional context
              </label>
              <textarea
                rows={3}
                maxLength={VALIDATION_LIMITS.REPORT_DETAILS_MAX}
                value={reportDetails}
                onChange={(e) => setReportDetails(e.target.value)}
                placeholder="Describe what happened..."
                className="w-full px-3 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowReportModal(false)}
                className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-rose-600 text-white text-sm font-medium hover:bg-rose-700"
              >
                Submit Report
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
