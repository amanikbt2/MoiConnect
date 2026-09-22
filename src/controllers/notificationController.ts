import { Request, Response } from 'express';
import { DeviceToken } from '../models/DeviceToken';
import { Notification } from '../models/Notification';
import { dispatchPushNotification, IPushNotificationPayload, resolveMagicPlaceholders } from '../services/pushNotificationService';

// 1. Register or update device push token
export const registerDeviceToken = async (req: Request, res: Response): Promise<void> => {
  try {
    const { token, platform = 'android' } = req.body;
    if (!token) {
      res.status(400).json({ success: false, error: 'Push token is required.' });
      return;
    }

    const userId = (req as any).user?._id || null;
    const email = (req as any).user?.email || null;

    const deviceToken = await DeviceToken.findOneAndUpdate(
      { token },
      {
        token,
        userId,
        email,
        platform,
        lastActive: new Date()
      },
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

    // Query notifications that are broadcasted to 'all' OR targeted to user's email
    let query: any = {
      $or: [
        { target: 'all' },
        ...(userEmail ? [{ target: 'emails', recipientEmails: userEmail }] : [])
      ]
    };

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(50);

    const userObj = (req as any).user;

    // Resolve magic placeholders for this specific user in response
    const formatted = notifications.map((n) => {
      const isRead = userId ? n.readBy.includes(userId) : false;
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
      message: `Push notification dispatched! Target: ${target}, Sent to ${result.sentCount} devices.`,
      result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Push dispatch failed' });
  }
};

// 5. Get admin notification broadcast history
export const getAdminNotificationHistory = async (_req: Request, res: Response): Promise<void> => {
  try {
    const history = await Notification.find().sort({ createdAt: -1 }).limit(30);
    res.json({ success: true, history });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch history' });
  }
};
