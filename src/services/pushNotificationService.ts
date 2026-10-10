import { Types } from 'mongoose';
import { DeviceToken } from '../models/DeviceToken';
import { Notification } from '../models/Notification';
import { User } from '../models/User';
import { getSocketIO } from '../socket';

export interface IPushNotificationPayload {
  title: string;
  subtitle?: string;
  body: string;
  icon?: 'bell' | 'academic' | 'house' | 'alert';
  target: 'all' | 'emails';
  recipientEmails?: string[];
  data?: Record<string, any>;
}

async function sendExpoChunk(chunk: any[]): Promise<{ ok: boolean; status: number; data: any } | null> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk),
        signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (response.ok || (response.status < 500 && response.status !== 429) || attempt === 3) {
        return { ok: response.ok, status: response.status, data };
      }
    } catch (error) {
      if (attempt === 3) {
        console.error('[Push Notification]: Expo request failed after retries.', error);
        return null;
      }
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** (attempt - 1))));
  }
  return null;
}

async function checkExpoReceipts(ticketIds: string[], tokenByTicket: Map<string, string>): Promise<void> {
  if (ticketIds.length === 0) return;
  // Expo tickets mean the request was accepted, not that FCM displayed it.
  // Check receipts shortly after dispatch so stale tokens and credential
  // failures become visible in Render logs and invalid tokens are removed.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ticketIds }),
        signal: controller.signal
      });
      const payload = await response.json().catch(() => null);
      const receipts = payload?.data || {};
      const invalidTokens: string[] = [];
      for (const ticketId of ticketIds) {
        const receipt = receipts[ticketId];
        if (!receipt) continue;
        if (receipt.status === 'ok') continue;
        const errorCode = receipt.details?.error || receipt.message || 'UnknownReceiptError';
        const token = tokenByTicket.get(ticketId);
        console.error('[Push Notification]: Expo delivery receipt failed.', {
          ticketId,
          token,
          error: errorCode,
          details: receipt.details
        });
        if (errorCode === 'DeviceNotRegistered' && token) invalidTokens.push(token);
      }
      if (invalidTokens.length > 0) {
        await DeviceToken.deleteMany({ token: { $in: invalidTokens } });
      }
      console.log('[Push Notification]: Expo receipts checked.', {
        requested: ticketIds.length,
        received: Object.keys(receipts).length,
        failed: Object.values(receipts).filter((receipt: any) => receipt?.status === 'error').length
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (error: any) {
    console.warn('[Push Notification]: Could not check Expo delivery receipts:', error?.message || error);
  }
}

const hasMixedProjectError = (response: { data: any } | null): boolean =>
  Array.isArray(response?.data?.errors) && response.data.errors.some((error: any) => error?.code === 'PUSH_TOO_MANY_EXPERIENCE_IDS');

const retryMixedProjectBatchIndividually = async (
  chunk: any[],
  response: { ok: boolean; status: number; data: any } | null
): Promise<{ ok: boolean; status: number; data: any } | null> => {
  if (!response || response.ok || !hasMixedProjectError(response)) return response;
  const individualResponses = await Promise.all(chunk.map((message) => sendExpoChunk([message])));
  const tickets = individualResponses.flatMap((item) => Array.isArray(item?.data?.data) ? item!.data.data : []);
  const errors = individualResponses.flatMap((item) => Array.isArray(item?.data?.errors) ? item!.data.errors : []);
  return { ok: individualResponses.every((item) => Boolean(item?.ok)), status: 200, data: { data: tickets, errors } };
};

const getPublicNotificationAvatar = async (
  userId: string | undefined,
  avatarUrl: string | undefined,
  name: string
): Promise<string> => {
  if (typeof avatarUrl === 'string' && /^https?:\/\//i.test(avatarUrl)) return avatarUrl;

  if (userId && Types.ObjectId.isValid(userId)) {
    const user = await User.findById(userId).select('avatarUrl').lean();
    if (typeof user?.avatarUrl === 'string' && /^https?:\/\//i.test(user.avatarUrl)) {
      return user.avatarUrl;
    }
  }

  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Student')}&background=15803d&color=ffffff&size=256&bold=true`;
};

// Magic Template Substitution Helper
export function resolveMagicPlaceholders(
  text: string,
  user?: { name?: string; email?: string; course?: string; admissionNumber?: string } | null
): string {
  if (!text) return '';
  const name = user?.name || 'Student';
  const course = user?.course || 'Campus Program';
  const admissionNumber = user?.admissionNumber || 'Moi Student';
  const email = user?.email || 'Student';

  return text
    .replace(/\{name\}/gi, name)
    .replace(/\{course\}/gi, course)
    .replace(/\{admissionNumber\}/gi, admissionNumber)
    .replace(/\{adm\}/gi, admissionNumber)
    .replace(/\{email\}/gi, email);
}

export const dispatchPushNotification = async (payload: IPushNotificationPayload) => {
  const { title, subtitle, body, icon = 'bell', target, recipientEmails = [], data = {} } = payload;

  let highestExistingNum = 0;
  try {
    const existing = await Notification.find().select('notificationCode data').lean();
    for (const n of existing) {
      const codeStr = n.notificationCode || n.data?.notificationCode || n.data?.code;
      if (codeStr) {
        const match = String(codeStr).match(/\d+/);
        if (match) {
          const num = parseInt(match[0], 10);
          if (num > highestExistingNum) highestExistingNum = num;
        }
      }
    }
  } catch (e) {}

  const { getNextSequenceValue } = require('../models/AppSetting');
  const nextNum = await getNextSequenceValue('notificationSequenceCounter', highestExistingNum);
  const notificationCode = `NOTIF-${String(nextNum).padStart(4, '0')}`;

  // 1. Save Notification record to MongoDB so it's stored for offline & in-app bell inbox
  const notificationRecord = await Notification.create({
    notificationCode,
    title,
    subtitle,
    body,
    icon,
    target,
    recipientEmails: target === 'emails' ? recipientEmails.map(e => e.trim().toLowerCase()) : [],
    data: {
      ...data,
      notificationCode,
      code: notificationCode
    },
    readBy: []
  });

  // 2. Query target DeviceTokens
  let query: any = {};
  if (target === 'emails' && recipientEmails.length > 0) {
    const cleanEmails = recipientEmails.map(e => e.trim().toLowerCase());
    const emailRegexes = cleanEmails.map(e => new RegExp('^' + e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
    const matchedUsers = await User.find({ email: { $in: emailRegexes } }).select('_id email');
    const matchedUserIds = matchedUsers.map(u => u._id);

    query = {
      $or: [
        { email: { $in: emailRegexes } },
        { userId: { $in: matchedUserIds } }
      ]
    };
  }

  const registeredTokens = await DeviceToken.find(query).populate('userId', 'name email course admissionNumber');
  // Defensive deduplication in case old database records contain the same
  // token more than once after an account/project migration.
  const deviceTokens = Array.from(
    new Map(registeredTokens.map((device) => [device.token, device])).values()
  );

  if (deviceTokens.length === 0) {
    console.log(`[Push Notification]: Stored in DB (ID: ${notificationRecord._id}), but no device tokens matched target.`);
    // Broadcast socket event anyway so connected web/app clients receive in-app bell badge
    try {
      const io = getSocketIO();
      if (io) {
        io.emit('new_notification', { notification: notificationRecord });
      }
    } catch (e) {}

    return {
      success: true,
      sentCount: 0,
      storedNotificationId: notificationRecord._id
    };
  }

  // 3. Build Expo push messages with magic variable substitution per user
  const messages: any[] = [];
  for (const dt of deviceTokens) {
    const userObj = dt.userId as any;
    const resolvedTitle = resolveMagicPlaceholders(title, userObj);
    const resolvedSubtitle = resolveMagicPlaceholders(subtitle || '', userObj);
    const resolvedBody = resolveMagicPlaceholders(body, userObj);

    messages.push({
      to: dt.token,
      sound: 'default',
      title: resolvedTitle,
      subtitle: resolvedSubtitle,
      body: resolvedBody,
      data: {
        ...data,
        notificationId: notificationRecord._id.toString(),
        icon
      },
      priority: 'high',
      channelId: data?.channelId || 'mconnect_general_v2',
      ttl: 60 * 60 * 24 * 7,
      _displayInForeground: true,
    });
  }

  // 4. Send Expo Push Notification batches in chunks of 100 asynchronously
  let sentCount = 0;
  const failureReasons: Record<string, number> = {};
  const addFailure = (reason: string, count = 1) => {
    const key = reason || 'UnknownExpoError';
    failureReasons[key] = (failureReasons[key] || 0) + count;
  };
  const CHUNK_SIZE = 100;

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const initialResponse = await sendExpoChunk(chunk);
      const expoResponse = await retryMixedProjectBatchIndividually(chunk, initialResponse);
      if (!expoResponse) {
        addFailure('ExpoRequestFailed', chunk.length);
        continue;
      }
      const resData = expoResponse.data;
      const tickets = Array.isArray(resData?.data) ? resData.data : [];
      if (!expoResponse.ok || tickets.length !== chunk.length) {
        console.error('[Push Notification]: Expo rejected the batch.', {
          status: expoResponse.status,
          response: resData
        });
        const batchErrors = Array.isArray(resData?.errors) ? resData.errors : [];
        if (batchErrors.length) {
          batchErrors.forEach((error: any) => addFailure(error?.code || error?.message || 'ExpoBatchRejected', chunk.length));
        } else if (tickets.length !== chunk.length) {
          addFailure('ExpoBatchRejected', chunk.length - tickets.length || chunk.length);
        }
      }
      const invalidTokens: string[] = [];
      const receiptIds: string[] = [];
      const tokenByReceipt = new Map<string, string>();
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'ok') {
          sentCount += 1;
          if (ticket.id) {
            receiptIds.push(ticket.id);
            tokenByReceipt.set(ticket.id, chunk[index]?.to);
          }
          return;
        }

        const errorCode = ticket?.details?.error;
        addFailure(errorCode || ticket?.message || 'UnknownExpoError');
        if (errorCode === 'DeviceNotRegistered') {
          invalidTokens.push(chunk[index]?.to);
        }

        console.error('[Push Notification]: Expo ticket failed.', {
          token: chunk[index]?.to,
          error: errorCode || ticket?.message || 'Unknown Expo push error'
        });
      });

      if (invalidTokens.length > 0) {
        await DeviceToken.deleteMany({ token: { $in: invalidTokens.filter(Boolean) } }).catch((cleanupError) => {
          console.warn('[Push Notification]: Could not remove invalid device tokens:', cleanupError);
        });
      }
      void checkExpoReceipts(receiptIds, tokenByReceipt);
    } catch (err) {
      console.error(`[Push Notification Batch Error]:`, err);
    }
  }

  // 5. Broadcast real-time Socket.IO event for instant bell badge update
  try {
    const io = getSocketIO();
    if (io) {
      io.emit('new_notification', { notification: notificationRecord });
    }
  } catch (e) {}

  return {
    success: true,
    sentCount,
    totalTokens: deviceTokens.length,
    failedCount: Math.max(0, deviceTokens.length - sentCount),
    failureReasons,
    storedNotificationId: notificationRecord._id
  };
};

export const sendPushToTokens = async (
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, any> = {}
): Promise<{ totalTokens: number; sentCount: number; failedCount: number }> => {
  if (!tokens || tokens.length === 0) return { totalTokens: 0, sentCount: 0, failedCount: 0 };
  const { categoryId, richContent, ...notificationData } = data as any;
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data: notificationData,
    ...(categoryId ? { categoryId } : {}),
    ...(richContent ? { richContent } : {}),
    priority: 'high',
    channelId: notificationData?.channelId || 'mconnect_messages_v2',
    ttl: 60 * 60 * 24 * 7,
    _displayInForeground: true,
  }));

  const CHUNK_SIZE = 100;
  let sentCount = 0;
  let failedCount = 0;
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const initialResponse = await sendExpoChunk(chunk);
      const expoResponse = await retryMixedProjectBatchIndividually(chunk, initialResponse);
      if (!expoResponse) {
        failedCount += chunk.length;
        continue;
      }
      const responseBody = expoResponse.data;
      const tickets = Array.isArray(responseBody?.data) ? responseBody.data : [];
      if (!expoResponse.ok || tickets.length !== chunk.length) {
        failedCount += chunk.length;
        console.error('[Push Notification]: Expo rejected push batch.', { status: expoResponse.status, response: responseBody });
        continue;
      }
      const invalidTokens: string[] = [];
      const receiptIds: string[] = [];
      const tokenByReceipt = new Map<string, string>();
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'ok') {
          sentCount += 1;
          if (ticket.id) {
            receiptIds.push(ticket.id);
            tokenByReceipt.set(ticket.id, chunk[index]?.to);
          }
        } else {
          failedCount += 1;
          const errorCode = ticket?.details?.error;
          if (errorCode === 'DeviceNotRegistered') {
            invalidTokens.push(chunk[index].to);
          }
          console.error('[Push Notification]: Expo ticket failed.', { token: chunk[index]?.to, error: errorCode || ticket?.message || 'Unknown Expo push error' });
        }
      });
      if (invalidTokens.length > 0) {
        await DeviceToken.deleteMany({ token: { $in: invalidTokens } }).catch((cleanupError) => {
          console.warn('[Push Notification]: Could not remove invalid device tokens:', cleanupError);
        });
      }
      void checkExpoReceipts(receiptIds, tokenByReceipt);
    } catch (err) {
      failedCount += chunk.length;
      console.error('[Push Notification Error]:', err);
    }
  }
  console.log('[Push Notification]: Expo accepted push tickets.', {
    totalTokens: tokens.length,
    acceptedTickets: sentCount,
    ticketFailures: failedCount
  });
  return { totalTokens: tokens.length, sentCount, failedCount };
};

export const sendCommunityMessagePush = async (messagePayload: {
  senderId?: string;
  senderName?: string;
  senderEmail?: string;
  text?: string;
  fileAttachment?: any;
  stickerId?: string;
  _id?: string;
  senderAvatarUrl?: string;
}): Promise<void> => {
  try {
    const senderIdStr = messagePayload.senderId ? String(messagePayload.senderId) : '';
    const senderEmailStr = (messagePayload.senderEmail || '').trim().toLowerCase();
    // Resolve all registered devices first, then exclude only the sender in
    // code. Older tokens may have no userId/email populated, so a Mongo `$ne`
    // query can accidentally omit valid recipients.
    const registeredDevices = await DeviceToken.find({}).select('token userId email').lean();
    const recipientTokens = registeredDevices
      .filter((device: any) => {
        const deviceUserId = device.userId ? String(device.userId) : '';
        const deviceEmail = String(device.email || '').trim().toLowerCase();
        const isSender = (senderIdStr && deviceUserId === senderIdStr) ||
          (senderEmailStr && deviceEmail === senderEmailStr);
        return !isSender;
      })
      .map((device: any) => String(device.token))
      .filter(Boolean)
      .filter((token: string, index: number, all: string[]) => all.indexOf(token) === index);

    console.log(`[Community Push]: ${recipientTokens.length} recipient device(s) resolved for ${messagePayload.senderName || 'student'}.`);

    if (!recipientTokens || recipientTokens.length === 0) return;

    let bodyText = messagePayload.text?.trim() || '';
    if (!bodyText) {
      if (messagePayload.fileAttachment?.name || messagePayload.fileAttachment?.url) {
        bodyText = `\u{1F4CE} Sent a file: ${messagePayload.fileAttachment.name || 'Attachment'}`;
      } else if (messagePayload.stickerId) {
        bodyText = '\u{1F3A8} Sent a sticker';
      } else {
        bodyText = 'New message in Community';
      }
    }

    if (bodyText.length > 240) bodyText = bodyText.slice(0, 237) + '...';

    const senderName = messagePayload.senderName || 'Moi Student';
    const avatarUrl = await getPublicNotificationAvatar(
      senderIdStr,
      messagePayload.senderAvatarUrl,
      senderName
    );

    const result = await sendPushToTokens(
      recipientTokens,
      senderName,
      bodyText,
      {
        screen: 'community',
        channelId: 'mconnect_messages_v2',
        categoryId: 'community_message',
        senderId: senderIdStr,
        senderName,
        avatarUrl,
        senderAvatarUrl: avatarUrl,
        messageId: messagePayload._id,
        messagePreview: bodyText,
        notificationSubtitle: bodyText,
        notificationType: 'community_message',
        richContent: { image: avatarUrl }
      }
    );
    if (result.failedCount > 0) {
      console.warn('[Community Push Notification]: Delivery summary:', result);
    }
  } catch (err) {
    console.error('[Community Push Notification Error]:', err);
  }
};

export const sendDirectMessagePush = async (
  conversation: { _id: any; participants: any[] },
  sender: { _id?: any; name?: string; email?: string; avatarUrl?: string },
  text: string
): Promise<void> => {
  try {
    const senderIdStr = sender._id ? String(sender._id) : '';

    // Get recipient participant IDs (all participants except sender)
    const recipientUserIds = (conversation.participants || [])
      .map((p) => String(p))
      .filter((pId) => pId && pId !== senderIdStr);

    if (recipientUserIds.length === 0) return;

    const recipientTokens = await DeviceToken.find({
      userId: { $in: recipientUserIds }
    }).distinct('token');

    if (!recipientTokens || recipientTokens.length === 0) return;

    let bodyText = text?.trim() || 'Sent a private message';
    if (bodyText.length > 120) {
      bodyText = bodyText.slice(0, 117) + '...';
    }

    const title = `\u{1F4AC} ${sender.name || 'Direct Message'}`;
    const avatarUrl = await getPublicNotificationAvatar(
      senderIdStr,
      sender.avatarUrl,
      sender.name || 'Direct Message'
    );

    await sendPushToTokens(recipientTokens, title, bodyText, {
      screen: 'chat',
      conversationId: String(conversation._id),
      channelId: 'mconnect_messages_v2',
      senderId: senderIdStr,
      avatarUrl,
      messagePreview: bodyText,
      notificationSubtitle: bodyText
    });
  } catch (err) {
    console.error('[Direct Message Push Notification Error]:', err);
  }
};
