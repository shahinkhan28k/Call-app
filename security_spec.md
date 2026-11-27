# Security Specification & Payload-First TDD

## 1. Data Invariants
1. **Identity Integrity**: Every user-created record (`users`, `userDirectory`, `messages`, `contacts`, `blockedUsers`, `reports`, `calls`) binds its ownership/sender UID strictly to `request.auth.uid`.
2. **PII Isolation**: Private `email` and `phoneNumber` fields reside in `/users/{userId}`, readable ONLY by the owner or verified admin. `/userDirectory/{userId}` omits PII unless the owner explicitly sets `discoverableEmail` / `discoverablePhone`.
3. **Chat Membership Gate**: Messages inside `/chats/{chatId}/messages/{messageId}` require parent `/chats/{chatId}` membership (`participantA` or `participantB`) and forbid arbitrary third-party injection.
4. **Immutable Audit & Ownership Fields**: `uid`, `chatId`, `participantA`, `participantB`, `senderId`, `createdAt`, and `reporterId` cannot be mutated after creation.
5. **Terminal State Locking**: Calls reaching `ended`, `rejected`, or `missed` and reports reaching `resolved` or `dismissed` cannot be reopened by non-admins.
6. **Temporal Integrity**: `createdAt` and `updatedAt` must equal `request.time`.
7. **Admin Privilege Protection**: Non-admin users cannot set `accountStatus: 'suspended'`, cannot write to `/admins`, and cannot write to `/systemConfig`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Self-Assigned Admin**: `users/{uid}` create with `accountStatus: 'active'` + ghost key `isAdmin: true` -> DENIED (`hasOnly` check).
2. **Privilege Escalation**: `admins/{uid}` create by non-admin -> DENIED (`isAdmin()`).
3. **PII Scraping**: `users` list or `users/{otherUid}` get by another signed-in user -> DENIED (`isOwner` / `isAdmin`).
4. **Blanket List Scraping**: `chats` list without participant filter -> DENIED (`resource.data.participantA` / `participantB` rule).
5. **Identity Spoofing**: `chats/{chatId}/messages/{msgId}` create with `senderId: victimUid` -> DENIED (`senderId == request.auth.uid`).
6. **Orphan Message Injection**: `chats/nonExistent/messages/m1` create -> DENIED (`exists(chats/nonExistent)`).
7. **Resource Poisoning (1MB ID)**: `users/{1500_char_id}` create -> DENIED (`isValidId`).
8. **Value Poisoning**: `chats/{chatId}` update with `lastMessage` = 5000 chars -> DENIED (`isValidChat`).
9. **Timestamp Backdating**: `messages/{msgId}` create with `createdAt` = yesterday -> DENIED (`createdAt == request.time`).
10. **State Reopening**: `calls/{callId}` update from `ended` back to `connected` by participant -> DENIED (terminal state lock).
11. **Unverified Email Spoof**: Request where `email == 'shahinkhan28ddd@gmail.com'` and `email_verified == false` -> DENIED (`email_verified == true`).
12. **Shadow Field Update**: `users/{uid}` update injecting `role: 'superadmin'` -> DENIED (`affectedKeys().hasOnly(...)`).
