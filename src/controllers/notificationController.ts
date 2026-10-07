import { Request, Response } from 'express';
import { DeviceToken } from '../models/DeviceToken';
import { Notification } from '../models/Notification';
import { dispatchPushNotification, IPushNotificationPayload, resolveMagicPlaceholders } from '../services/pushNotificationService';

const visibleNotificationQuery = (userEmail?: string) => ({
  $and: [
    {
      $or: [
        { target: 'all' },
        { target: { $in: [null, undefined] } },
        { target: { $exists: false } },
        ...(userEmail ? [{ target: 'emails', recipientEmails: userEmail }] : [])
      ]
    },
    {
      $nor: [
        { 'data.screen': 'community' },
        { 'data.channelId': 'community_chat' }
      ]
    }
  ]
});

// 1. Register or update device push token
export const registerDeviceToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, platform = 'android' } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: 'Push token is required.' });
      return;
    }

    const userId = (req as any).user?._id || null;
    const email = (req as any).user?.email ? (req as any).user.email.toLowerCase().trim() : null;

    const updateData: any = {
      token,
      platform,
      lastActive: new Date()
    };
    if (userId) updateData.userId = userId;
    if (email) updateData.email = email;

    const deviceToken = await DeviceToken.findOneAndUpdate(
      { token },
      { $set: updateData },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Device token registered successfully', data: deviceToken });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Token registration failed' });
  }
};

// 2. Fetch in-app notifications for bell icon inbox
export const getNotifications = async (req: Request, res: Response): Promise<void> => {
  try {
    const userEmail = (req as any).user?.email?.toLowerCase();
    const userId = (req as any).user?._id?.toString();

    const notifications = await Notification.find(visibleNotificationQuery(userEmail))
      .sort({ createdAt: -1 })
      .limit(50);

    const userObj = (req as any).user;

    // Resolve magic placeholders for this specific user in response
    const formatted = notifications.map((n) => {
      const isRead = userId && Array.isArray(n.readBy)
        ? n.readBy.some((id: any) => String(id) === String(userId))
        : false;
      return {
        _id: n._id,
        title: resolveMagicPlaceholders(n.title, userObj),
        subtitle: resolveMagicPlaceholders(n.subtitle || '', userObj),
        body: resolveMagicPlaceholders(n.body, userObj),
        icon: n.icon || 'bell',
        isRead,
        createdAt: n.createdAt,
        data: n.data
      };
    });

    const unreadCount = formatted.filter(n => !n.isRead).length;

    res.json({
      success: true,
      unreadCount,
      notifications: formatted
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch notifications' });
  }
};

// 3. Mark notification as read
export const markNotificationRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      res.json({ success: true, message: 'Marked read' });
      return;
    }

    await Notification.findByIdAndUpdate(id, {
      $addToSet: { readBy: userId }
    });

    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to mark notification' });
  }
};

// 4. Mark all notifications visible to the current user as read
export const markAllNotificationsRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userEmail = (req as any).user?.email?.toLowerCase();
    const userId = (req as any).user?._id?.toString();

    if (!userId) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }

    await Notification.updateMany(visibleNotificationQuery(userEmail), { $addToSet: { readBy: userId } });
    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to mark notifications as read' });
  }
};
// 4. Admin Push Notify Endpoint (called by Admin Web Portal)
export const sendAdminPushNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const { title, subtitle, body, icon = 'bell', target = 'all', recipientEmails } = req.body;

    if (!title || !body) {
      res.status(400).json({ success: false, error: 'Title and body are required for push notification.' });
      return;
    }

    let cleanEmails: string[] = [];
    if (target === 'emails') {
      if (Array.isArray(recipientEmails)) {
        cleanEmails = recipientEmails;
      } else if (typeof recipientEmails === 'string') {
        cleanEmails = recipientEmails.split(',').map(e => e.trim()).filter(Boolean);
      }
      if (cleanEmails.length === 0) {
        res.status(400).json({ success: false, error: 'Recipient email list cannot be empty when target is "emails".' });
        return;
      }
    }

    const result = await dispatchPushNotification({
      title: title.trim(),
      subtitle: subtitle ? subtitle.trim() : '',
      body: body.trim(),
      icon,
      target,
      recipientEmails: cleanEmails
    });

    res.json({
      success: true,
      message: `Push notification dispatched! Target: ${target}, delivered to ${result.sentCount} of ${result.totalTokens || 0} matched devices${result.totalTokens && result.sentCount < result.totalTokens ? ` (${result.totalTokens - result.sentCount} delivery failures).` : '.'}`,
      result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Push dispatch failed' });
  }
};

// 5. Get admin notification broadcast history
export const getRegisteredDeviceCount = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [total, android, ios, web] = await Promise.all([
      DeviceToken.countDocuments(),
      DeviceToken.countDocuments({ platform: 'android' }),
      DeviceToken.countDocuments({ platform: 'ios' }),
      DeviceToken.countDocuments({ platform: 'web' })
    ]);
    res.json({ success: true, total, byPlatform: { android, ios, web } });
  } catch (error: any) {
    console.error('Failed to count registered push devices:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to count registered devices' });
  }
};

export function fixMojibake(str: string): string {
  if (!str) return '';
  return str
    .replace(/Ã°Å¸â€™Â¬/g, '💬')
    .replace(/Ã°Å¸â€™/g, '💬')
    .replace(/Ã°Å¸ÂÂ/g, '💬')
    .replace(/Ã°Å¸/g, '💬')
    .replace(/â€™/g, "'")
    .replace(/â€"/g, '–')
    .replace(/â€\u009d/g, '"')
    .replace(/â€\u009c/g, '"');
}

export const getAdminNotificationHistory = async (_req: Request, res: Response): Promise<void> => {
  try {
    const rawHistory = await Notification.find().sort({ createdAt: -1 }).limit(30).lean();
    const history = rawHistory.map((item) => ({
      ...item,
      title: fixMojibake(item.title || ''),
      subtitle: fixMojibake(item.subtitle || ''),
      body: fixMojibake(item.body || '')
    }));
    res.json({ success: true, history });
  } catch (error: any) {
    console.error('Failed to load admin notification history:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch history' });
  }
};

// 6. Delete an in-app notification from the server inbox/history.
// This cannot retract a push already displayed by Android, but it prevents
// devices from fetching the notification again from the in-app inbox.
export const deleteAdminNotification = async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await Notification.findByIdAndDelete(req.params.id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Notification not found.' });
      return;
    }
    res.json({ success: true, message: 'Notification removed. Devices will no longer fetch it.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete notification' });
  }
};

export const deleteAllAdminNotifications = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await Notification.deleteMany({});
    res.json({
      success: true,
      deletedCount: result.deletedCount || 0,
      message: 'All push notification history has been deleted.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete notification history' });
  }
};
