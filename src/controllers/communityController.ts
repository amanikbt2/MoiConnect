import { Request, Response } from 'express';
import { CommunityMessage } from '../models/CommunityMessage';
import { User } from '../models/User';
import { getSocketIO } from '../socket';
import { dispatchPushNotification } from '../services/pushNotificationService';
import { uploadTempFileToCloudinary } from '../services/tempFileService';
import { getCampusBotsGeneration, isBotStopCommand, runCampusBotConversation, shouldCampusBotRespond, stopCampusBots } from '../services/campusBotService';

// 1. Get Community Messages (Support Incremental Delta Sync via ?since=)
export const getCommunityMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { since, limit } = req.query;
    const query: any = {};
    let isDeltaSync = false;

    if (since) {
      const sinceDate = new Date(since as string);
      if (!isNaN(sinceDate.getTime())) {
        query.updatedAt = { $gt: sinceDate };
        isDeltaSync = true;
      }
    }

    const maxLimit = Math.min(parseInt(limit as string, 10) || 100, 200);

    let messages = await CommunityMessage.find(query).select('-reactionUsers')
      .sort(isDeltaSync ? { updatedAt: 1 } : { createdAt: -1 })
      .limit(maxLimit);

    if (!isDeltaSync) messages = messages.reverse();

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

// Lightweight directory used by the mobile mention picker. The client caches this
// locally and only sends a search request when its cached directory cannot match.
export const getMentionUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const query = String(req.query.q || '').trim();
    const filter: Record<string, any> = { accountStatus: { $ne: 'suspended' } };
    if (query) {
      const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.name = { $regex: safeQuery, $options: 'i' };
    }

    const users = await User.find(filter)
      .select('_id name avatarUrl')
      .sort({ name: 1 })
      .limit(query ? 25 : 5000)
      .lean();

    res.json({
      success: true,
      data: users.map((user: any) => ({ id: String(user._id), name: user.name, avatarUrl: user.avatarUrl }))
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load mention users' });
  }
};

// 2. Post Community Message via HTTP Fallback (Fast Non-Blocking Endpoint)
export const postCommunityMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { clientMsgId, text, fileAttachment, stickerId, replyTo, senderName, senderEmail, senderFaculty, senderCourse, senderPhone, senderAvatarUrl, avatarBg, senderId } = req.body;
    const user = (req as any).user;

    if (isBotStopCommand(text)) {
      stopCampusBots();
      getSocketIO()?.to('community_room').emit('community:user_stop_typing', { userId: 'campus-bot' });
      getSocketIO()?.to('community_room').emit('community:user_stop_typing', { userId: 'campus-ai' });
    }
    const botGeneration = getCampusBotsGeneration();

    if (!text?.trim() && !fileAttachment && !stickerId) {
      res.status(400).json({ success: false, error: 'Message text or attachment is required.' });
      return;
    }

    let message: any = null;
    if (clientMsgId) {
      message = await CommunityMessage.findOne({ clientMsgId }).lean();
    }

    if (!message) {
      const isCampusBot = (user?.email || senderEmail || '').trim().toLowerCase() === 'dev@gmail.com';
      const effectiveSenderName = isCampusBot ? 'Campus bot' : (senderName || user?.name || 'Moi Student');
      message = await CommunityMessage.create({
        clientMsgId,
        senderId: user?._id || senderId || '60d0fe4f5311236168a109ca',
        senderName: effectiveSenderName,
        senderEmail: senderEmail || user?.email || '',
        senderFaculty: senderFaculty || 'School of Science & Computing',
        senderCourse,
        senderPhone,
        senderAvatarUrl,
        avatarBg: avatarBg || '#15803d',
        text: text?.trim() || '',
        stickerId,
        fileAttachment,
        replyTo,
        reactions: {}
      });

      // Broadcast via Socket.IO real-time channel
      const io = getSocketIO();
      if (io) {
        io.to('community_room').emit('community:receive_message', message);
        io.to('community_room').emit('community:user_stop_typing', {
          userId: message.senderId,
          userName: message.senderName
        });
      }

      // Asynchronous Push Notifications to offline devices (Non-blocking)
      setImmediate(() => {
        dispatchPushNotification({
          title: `Ã°Å¸â€™Â¬ ${message.senderName}`,
          body: message.text ? message.text.slice(0, 100) : `Ã°Å¸â€œÅ½ Sent a file: ${message.fileAttachment?.name || 'Attachment'}`,
          target: 'all',
          data: { screen: 'community', channelId: 'community_chat' }
        }).catch(() => {});
      });
    }

    if (message && !isBotStopCommand(message.text) && shouldCampusBotRespond(message.text, message.replyTo)) {
      setImmediate(() => {
        void runCampusBotConversation(message, {
          onTyping: (assistant, typing) => getSocketIO()?.to('community_room').emit(
            typing ? 'community:user_typing' : 'community:user_stop_typing',
            { userId: assistant.kind === 'bot' ? 'campus-bot' : 'campus-ai', userName: assistant.name }
          ),
          onReply: (assistantMessage) => getSocketIO()?.to('community_room').emit('community:receive_message', assistantMessage)
        }, botGeneration).catch((botError) => console.error('[Campus assistants] Reply error:', botError));
      });
    }
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
    const { emoji, reactorId } = req.body;
    const user = (req as any).user;
    const actorId = user?._id?.toString() || (typeof reactorId === 'string' ? reactorId.trim() : '');

    if (!emoji || !actorId) {
      res.status(400).json({ success: false, error: 'Emoji and reactor identity are required.' });
      return;
    }

    const message = await CommunityMessage.findById(id);
    if (!message) {
      res.status(404).json({ success: false, error: 'Message not found.' });
      return;
    }

    if (!message.reactions) message.reactions = new Map();
    if (!message.reactionUsers) message.reactionUsers = new Map();

    let previousEmoji: string | undefined;
    for (const [reactionEmoji, users] of message.reactionUsers.entries()) {
      if (users.includes(actorId)) {
        previousEmoji = reactionEmoji;
        break;
      }
    }

    const removeUserFromReaction = (reactionEmoji: string) => {
      const users = message.reactionUsers!.get(reactionEmoji) || [];
      const nextUsers = users.filter((id) => id !== actorId);
      if (nextUsers.length === 0) {
        message.reactionUsers!.delete(reactionEmoji);
        message.reactions!.delete(reactionEmoji);
      } else {
        message.reactionUsers!.set(reactionEmoji, nextUsers);
        message.reactions!.set(reactionEmoji, nextUsers.length);
      }
    };

    let myReaction: string | undefined;
    if (previousEmoji === emoji) {
      removeUserFromReaction(emoji);
    } else {
      if (previousEmoji) removeUserFromReaction(previousEmoji);
      const users = message.reactionUsers.get(emoji) || [];
      if (!users.includes(actorId)) users.push(actorId);
      message.reactionUsers.set(emoji, users);
      message.reactions.set(emoji, users.length);
      myReaction = emoji;
    }

    await message.save();
    const reactions = Object.fromEntries(message.reactions);
    const io = getSocketIO();
    if (io) {
      io.to('community_room').emit('community:reaction_updated', {
        messageId: id,
        reactions,
        actorId,
        myReaction
      });
    }

    res.json({ success: true, data: { messageId: id, reactions, myReaction } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to react to message' });
  }
};
// 4. Upload Community Chat Media File to Cloudinary (folder: moiconnect/chat_media)
export const uploadCommunityMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No media file provided.' });
      return;
    }

    const file = req.file;
    const mime = file.mimetype || '';
    let fileType: 'pdf' | 'doc' | 'image' | 'video' = 'pdf';
    if (mime.includes('image')) {
      fileType = 'image';
    } else if (mime.includes('video')) {
      fileType = 'video';
    } else if (mime.includes('word') || file.originalname.endsWith('.doc') || file.originalname.endsWith('.docx')) {
      fileType = 'doc';
    }

    const formattedSize = file.size
      ? file.size > 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.round(file.size / 1024)} KB`
      : '1.0 MB';

    // Upload to Cloudinary under folder 'moiconnect/chat_media'
    const cloudinaryResourceType = fileType === 'image' ? 'image' : fileType === 'video' ? 'video' : 'raw';
    const result = await uploadTempFileToCloudinary(file.filename, 'moiconnect/chat_media', cloudinaryResourceType);

    res.json({
      success: true,
      data: {
        name: file.originalname,
        url: result.secure_url,
        size: formattedSize,
        type: fileType,
        publicId: result.public_id
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Media upload failed' });
  }
};
