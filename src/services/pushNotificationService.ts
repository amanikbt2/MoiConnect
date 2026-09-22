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

  // 1. Save Notification record to MongoDB so it's stored for offline & in-app bell inbox
  const notificationRecord = await Notification.create({
    title,
    subtitle,
    body,
    icon,
    target,
    recipientEmails: target === 'emails' ? recipientEmails.map(e => e.trim().toLowerCase()) : [],
    data,
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
        notificationId: notificationRecord._id,
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
      if (resData && resData.data) {
        sentCount += chunk.length;
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
