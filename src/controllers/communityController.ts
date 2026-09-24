import { Request, Response } from 'express';
import { CommunityMessage } from '../models/CommunityMessage';
import { getSocketIO } from '../socket';
import { dispatchPushNotification } from '../services/pushNotificationService';

// 1. Get Community Messages (Support Incremental Delta Sync via ?since=)
export const getCommunityMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { since, limit } = req.query;
    const query: any = {};

    if (since) {
      const sinceDate = new Date(since as string);
      if (!isNaN(sinceDate.getTime())) {
        query.createdAt = { $gt: sinceDate };
      }
    }

    const maxLimit = Math.min(parseInt(limit as string, 10) || 100, 200);

    const messages = await CommunityMessage.find(query)
      .sort({ createdAt: 1 }) // Chronological order
      .limit(maxLimit);

    res.json({
      success: true,
      data: messages,
      count: messages.length,
      syncedAt: new Date().toISOString()
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch community messages' });
  }
};

// 2. Post Community Message via HTTP Fallback
export const postCommunityMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, fileAttachment, replyTo, senderName, senderFaculty, avatarBg } = req.body;
    const user = (req as any).user;

    if (!text?.trim() && !fileAttachment) {
      res.status(400).json({ success: false, error: 'Message text or attachment is required.' });
      return;
    }

    const message = await CommunityMessage.create({
      senderId: user?._id || '60d0fe4f5311236168a109ca',
      senderName: senderName || user?.name || 'Moi Student',
      senderFaculty: senderFaculty || 'School of Science & Computing',
      avatarBg: avatarBg || '#15803d',
      text: text?.trim() || '',
      fileAttachment,
      replyTo,
      reactions: {}
    });

    // Broadcast via Socket.IO real-time channel
    const io = getSocketIO();
    if (io) {
      io.to('community_room').emit('community:receive_message', message);
    }

    // Trigger Background Push Notifications to offline devices
    dispatchPushNotification({
      title: `💬 ${message.senderName}`,
      body: message.text ? message.text.slice(0, 100) : `📎 Sent a file: ${message.fileAttachment?.name || 'Attachment'}`,
      target: 'all',
      data: { screen: 'community', channelId: 'community_chat' }
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Message sent successfully',
      data: message
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to post message' });
  }
};

// 3. Toggle Emoji Reaction on a Community Message
export const toggleCommunityReaction = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { emoji } = req.body;

    if (!emoji) {
      res.status(400).json({ success: false, error: 'Emoji is required.' });
      return;
    }

    const message = await CommunityMessage.findById(id);
    if (!message) {
      res.status(404).json({ success: false, error: 'Message not found.' });
      return;
    }

    if (!message.reactions) {
      message.reactions = new Map();
    }

    const currentCount = message.reactions.get(emoji) || 0;
    message.reactions.set(emoji, currentCount + 1);

    await message.save();

    // Broadcast reaction update live via sockets
    const io = getSocketIO();
    if (io) {
      io.to('community_room').emit('community:reaction_updated', {
        messageId: id,
        reactions: Object.fromEntries(message.reactions)
      });
    }

    res.json({
      success: true,
      data: message
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to react to message' });
  }
};
