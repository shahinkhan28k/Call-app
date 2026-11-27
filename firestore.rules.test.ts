/**
 * Payload-First Security Rule Verification Matrix (Dirty Dozen)
 * Documents expected PERMISSION_DENIED outcomes for adversarial payloads.
 */
export interface SecurityTestCase {
  id: number;
  name: string;
  collection: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expectedOutcome: 'PERMISSION_DENIED';
  enforcingGuard: string;
}

export const DIRTY_DOZEN_CASES: SecurityTestCase[] = [
  { id: 1, name: 'Ghost isAdmin field on user create', collection: 'users', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'isValidUser data.keys().hasOnly(...)' },
  { id: 2, name: 'Non-admin writes to admins collection', collection: 'admins', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'isAdmin()' },
  { id: 3, name: 'Non-owner reads private user PII', collection: 'users', operation: 'get', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'isOwner(userId) || isAdmin()' },
  { id: 4, name: 'Unscoped list on chats collection', collection: 'chats', operation: 'list', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'resource.data.participantA == uid || participantB == uid' },
  { id: 5, name: 'Sender UID spoofing in message create', collection: 'chats/messages', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'incoming().senderId == request.auth.uid' },
  { id: 6, name: 'Orphan message in nonexistent chat', collection: 'chats/messages', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'exists(/databases/.../chats/$(chatId))' },
  { id: 7, name: 'Oversized document ID poisoning', collection: 'users', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'isValidId(userId)' },
  { id: 8, name: 'Oversized string in lastMessage update', collection: 'chats', operation: 'update', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'isValidChat(incoming())' },
  { id: 9, name: 'Backdated createdAt timestamp', collection: 'chats/messages', operation: 'create', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'incoming().createdAt == request.time' },
  { id: 10, name: 'Reopening ended call status', collection: 'calls', operation: 'update', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: '!(existing().callStatus in ["ended", "rejected", "missed"])' },
  { id: 11, name: 'Unverified email admin spoof', collection: 'systemConfig', operation: 'update', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'request.auth.token.email_verified == true' },
  { id: 12, name: 'Shadow field update on user profile', collection: 'users', operation: 'update', expectedOutcome: 'PERMISSION_DENIED', enforcingGuard: 'affectedKeys().hasOnly(...)' },
];
