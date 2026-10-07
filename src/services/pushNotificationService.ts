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

  const deviceTokens = await DeviceToken.find(query).populate('userId', 'name email course admissionNumber');

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
      channelId: data?.channelId || 'default',
      _displayInForeground: true,
    });
  }

  // 4. Send Expo Push Notification batches in chunks of 100 asynchronously
  let sentCount = 0;
  const CHUNK_SIZE = 100;

  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk)
      });
      const resData = await res.json();
      const tickets = Array.isArray(resData?.data) ? resData.data : [];
      if (!res.ok || tickets.length !== chunk.length) {
        console.error('[Push Notification]: Expo rejected the batch.', {
          status: res.status,
          response: resData
        });
      }
      const invalidTokens: string[] = [];
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'ok') {
          sentCount += 1;
          return;
        }

        const errorCode = ticket?.details?.error;
        if (errorCode === 'DeviceNotRegistered' || errorCode === 'InvalidCredentials') {
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
  const { categoryId, ...notificationData } = data as any;
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data: notificationData,
    ...(categoryId ? { categoryId } : {}),
    priority: 'high',
    channelId: notificationData?.channelId || 'community_chat' || 'default',
    _displayInForeground: true,
  }));

  const CHUNK_SIZE = 100;
  let sentCount = 0;
  let failedCount = 0;
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk)
      });
      const responseBody = await response.json().catch(() => null);
      const tickets = Array.isArray(responseBody?.data) ? responseBody.data : [];
      if (!response.ok || tickets.length !== chunk.length) {
        failedCount += chunk.length;
        console.error('[Push Notification]: Expo rejected push batch.', { status: response.status, response: responseBody });
        continue;
      }
      const invalidTokens: string[] = [];
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'ok') {
          sentCount += 1;
        } else {
          failedCount += 1;
          const errorCode = ticket?.details?.error;
          if (errorCode === 'DeviceNotRegistered' || errorCode === 'InvalidCredentials') {
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
    } catch (err) {
      failedCount += chunk.length;
      console.error('[Push Notification Error]:', err);
    }
  }
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
    const senderObjId = /^[a-f\d]{24}$/i.test(senderIdStr) ? new Types.ObjectId(senderIdStr) : null;

    // Send only to other students' registered Android/iOS devices.
    const excludeConditions: any[] = [];
    if (senderObjId) excludeConditions.push({ userId: { $ne: senderObjId } });
    if (senderIdStr) excludeConditions.push({ userId: { $ne: senderIdStr } });
    if (senderEmailStr) excludeConditions.push({ email: { $ne: senderEmailStr } });

    const recipientTokens = await DeviceToken.find(
      excludeConditions.length > 0 ? { $and: excludeConditions } : {}
    ).distinct('token');

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

    if (bodyText.length > 120) bodyText = bodyText.slice(0, 117) + '...';

    const result = await sendPushToTokens(
      recipientTokens,
      messagePayload.senderName || 'Moi Student',
      bodyText,
      {
        screen: 'community',
        channelId: 'community_chat',
        categoryId: 'community_message',
        senderId: senderIdStr,
        senderName: messagePayload.senderName || 'Moi Student',
        avatarUrl: messagePayload.senderAvatarUrl || null,
        messageId: messagePayload._id,
        messagePreview: bodyText
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
  sender: { _id?: any; name?: string; email?: string },
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

    await sendPushToTokens(recipientTokens, title, bodyText, {
      screen: 'chat',
      conversationId: String(conversation._id),
      senderId: senderIdStr
    });
  } catch (err) {
    console.error('[Direct Message Push Notification Error]:', err);
  }
};
