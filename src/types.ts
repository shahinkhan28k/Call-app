import type { Timestamp } from 'firebase/firestore';

export const ADMIN_EMAIL = 'shahinkhan28ddd@gmail.com';

export const VALIDATION_LIMITS = {
  NAME_MAX: 100,
  USERNAME_MIN: 2,
  USERNAME_MAX: 40,
  USERNAME_REGEX: /^[a-zA-Z0-9_.]+$/,
  ABOUT_MAX: 240,
  MESSAGE_MAX: 4000,
  LAST_MESSAGE_MAX: 1000,
  REPORT_REASON_MAX: 120,
  REPORT_DETAILS_MAX: 1000,
  ID_REGEX: /^[a-zA-Z0-9_\-]+$/,
} as const;

export type OnlineStatus = 'online' | 'offline' | 'away';
export type AccountStatus = 'active' | 'suspended';
export type MessageType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'voice' | 'call_event';
export type DeliveryStatus = 'sent' | 'delivered' | 'read';
export type CallType = 'audio' | 'video';
export type CallStatus = 'ringing' | 'connected' | 'ended' | 'rejected' | 'missed';
export type ReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed';

export interface UserPrivate {
  uid: string;
  fullName: string;
  username: string;
  email?: string;
  phoneNumber?: string;
  profilePicture?: string;
  about?: string;
  onlineStatus?: OnlineStatus;
  lastSeen?: Timestamp;
  accountStatus: AccountStatus;
  showEmail?: boolean;
  showPhone?: boolean;
  showOnlineStatus?: boolean;
  readReceipts?: boolean;
  notificationsEnabled?: boolean;
  lowDataMode?: boolean;
  publicKeyJwk?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface UserDirectoryEntry {
  uid: string;
  fullName: string;
  username: string;
  usernameLower: string;
  profilePicture?: string;
  about?: string;
  onlineStatus?: OnlineStatus;
  lastSeen?: Timestamp;
  accountStatus: AccountStatus;
  discoverableEmail?: string;
  discoverablePhone?: string;
  publicKeyJwk?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ChatDoc {
  chatId: string;
  participantIds: [string, string];
  participantA: string;
  participantB: string;
  lastMessage?: string;
  lastMessageType?: MessageType;
  lastMessageSenderId?: string;
  lastMessageTime?: Timestamp;
  unreadA: number;
  unreadB: number;
  typingA: boolean;
  typingB: boolean;
  isE2EE: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface MessageDoc {
  messageId: string;
  chatId: string;
  senderId: string;
  receiverId: string;
  participantIds: [string, string];
  messageType: MessageType;
  messageText: string;
  ciphertext?: string;
  iv?: string;
  isEncrypted: boolean;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentSize?: number;
  attachmentMime?: string;
  replyToId?: string;
  replyPreview?: string;
  forwardedFrom?: string;
  deliveryStatus: DeliveryStatus;
  readStatus: boolean;
  edited: boolean;
  deletedForEveryone: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CallDoc {
  callId: string;
  callerId: string;
  receiverId: string;
  participantIds: [string, string];
  callType: CallType;
  callStatus: CallStatus;
  offerSdp?: string;
  answerSdp?: string;
  startedAt: Timestamp;
  endedAt?: Timestamp;
  duration: number;
  updatedAt: Timestamp;
}

export interface ContactDoc {
  userId: string;
  contactUserId: string;
  nickname?: string;
  createdAt: Timestamp;
}

export interface BlockedUserDoc {
  userId: string;
  blockedUserId: string;
  reason?: string;
  createdAt: Timestamp;
}

export interface ReportDoc {
  reportId: string;
  reporterId: string;
  reportedUserId: string;
  reason: string;
  details?: string;
  status: ReportStatus;
  adminNotes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface NotificationDoc {
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  type: 'message' | 'missed_call' | 'contact' | 'security' | 'system';
  relatedId?: string;
  readStatus: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SystemConfigDoc {
  maxFileSizeMb: number;
  stunServerUrl: string;
  turnServerUrl?: string;
  e2eeDefault: boolean;
  rateLimitPerMin: number;
  maintenanceMode: boolean;
  updatedAt: Timestamp;
  updatedBy: string;
}

export type ActiveTab = 'chats' | 'calls' | 'contacts' | 'settings';
export type DataMode = 'standard' | 'saver' | 'text_only';
