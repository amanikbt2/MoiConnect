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
    const matchedUsers = await User.find({ email: { $in: cleanEmails } }).select('_id email');
    const matchedUserIds = matchedUsers.map(u => u._id);

    query = {
      $or: [
        { email: { $in: cleanEmails } },
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
      channelId: 'default'
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
      tickets.forEach((ticket: any, index: number) => {
        if (ticket?.status === 'ok') {
          sentCount += 1;
          return;
        }

        console.error('[Push Notification]: Expo ticket failed.', {
          token: chunk[index]?.to,
          error: ticket?.details?.error || ticket?.message || 'Unknown Expo push error'
        });
      });
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
): Promise<void> => {
  if (!tokens || tokens.length === 0) return;
  const messages = tokens.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data,
    priority: 'high',
    channelId: 'default'
  }));

  const CHUNK_SIZE = 100;
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(chunk)
      });
    } catch (err) {
      console.error('[Push Notification Error]:', err);
    }
  }
};

export const sendCommunityMessagePush = async (messagePayload: {
  senderId?: string;
  senderName?: string;
  senderEmail?: string;
  text?: string;
  fileAttachment?: any;
  stickerId?: string;
  _id?: string;
}): Promise<void> => {
  try {
    const senderIdStr = messagePayload.senderId ? String(messagePayload.senderId) : '';
    const senderEmailStr = (messagePayload.senderEmail || '').trim().toLowerCase();

    // Query all device tokens except the sender's own tokens
    const recipientTokens = await DeviceToken.find({
      $and: [
        ...(senderIdStr ? [{ userId: { $ne: senderIdStr } }] : []),
        ...(senderEmailStr ? [{ email: { $ne: senderEmailStr } }] : [])
      ]
    }).distinct('token');

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

    if (bodyText.length > 120) {
      bodyText = bodyText.slice(0, 117) + '...';
    }

    const title = `\u{1F4AC} ${messagePayload.senderName || 'Moi Student'}`;

    await sendPushToTokens(recipientTokens, title, bodyText, {
      screen: 'community',
      channelId: 'community_chat',
      senderId: senderIdStr,
      messageId: messagePayload._id
    });
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
