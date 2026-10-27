import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { CommunityMessage } from '../models/CommunityMessage';
import { User } from '../models/User';
import { getSocketIO } from '../socket';
import { sendCommunityMessagePush, sendPrivateCommunityMessagePush } from '../services/pushNotificationService';
import { uploadTempFileToCloudinary } from '../services/tempFileService';
import { getCampusBotsGeneration, isBotStopCommand, runCampusBotConversation, shouldCampusBotRespond, stopCampusBots } from '../services/campusBotService';
import { getAppSettingValue } from '../models/AppSetting';
import { getForumAccessPolicy, isForumParticipationAllowed } from '../services/forumAccessService';

const getPublicAvatarUrl = (value?: string): string | undefined => {
  const normalized = String(value || '').trim();
  return /^https?:\/\//i.test(normalized) ? normalized : undefined;
};

// 1. Get Community Messages (Support Incremental Delta Sync via ?since=)
export const getCommunityMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const syncWatermark = new Date();
    const { since, before, limit } = req.query;
    const forumPolicy = await getForumAccessPolicy();
    const forumAccessAllowed = isForumParticipationAllowed((req as any).user?.email, forumPolicy);
    const allowCommunityChat = await getAppSettingValue('allowCommunityChat', true);
    if (!forumAccessAllowed) {
      res.json({
        success: true,
        data: [],
        count: 0,
        hasMore: false,
        allowCommunityChat,
        forumAccessAllowed: false,
        syncedAt: syncWatermark.toISOString()
      });
      return;
    }
    const query: any = {};
    const userId = (req as any).user?._id;
    if (userId) query.hiddenForUserIds = { $ne: userId };
    let isDeltaSync = false;
    let isOlderPage = false;

    if (before) {
      const beforeDate = new Date(before as string);
      if (!isNaN(beforeDate.getTime())) {
        query.createdAt = { $lt: beforeDate };
        isOlderPage = true;
      }
    } else if (since) {
      const sinceDate = new Date(since as string);
      if (!isNaN(sinceDate.getTime())) {
        const requestedUntil = new Date(String(req.query.until || ''));
        const untilDate = !Number.isNaN(requestedUntil.getTime()) ? requestedUntil : syncWatermark;
        const requestedSinceId = String(req.query.sinceId || '');
        const sinceId = /^[a-f\d]{24}$/i.test(requestedSinceId) ? requestedSinceId : '';
        query.$and = [
          sinceId
            ? { $or: [{ updatedAt: { $gt: sinceDate } }, { updatedAt: sinceDate, _id: { $gt: sinceId } }] }
            // Inclusive fallback prevents messages sharing the cursor's
            // millisecond from being skipped when the client has no saved ID.
            : { updatedAt: { $gte: sinceDate } },
          { updatedAt: { $lte: untilDate } }
        ];
        isDeltaSync = true;
      }
    }

    const maxLimit = Math.min(parseInt(limit as string, 10) || 30, 50);
    const matchingCount = isDeltaSync ? await CommunityMessage.countDocuments(query) : 0;

    let messages = await CommunityMessage.find(query).select('-reactionUsers')
      .sort(isDeltaSync ? { updatedAt: 1, _id: 1 } : { createdAt: -1 })
      .limit(maxLimit)
      .lean();

    if (!isDeltaSync) messages = messages.reverse();

    const senderIds = Array.from(new Set(messages.map((message: any) => String(message.senderId || '')).filter(Boolean)));
    const badgeUsers = senderIds.length > 0
      ? await User.find({ _id: { $in: senderIds } }).select('_id badge avatarUrl').lean()
      : [];
    const badgeByUserId = new Map(badgeUsers.map((user: any) => [String(user._id), user.badge]));
    const avatarByUserId = new Map(badgeUsers.map((user: any) => [String(user._id), user.avatarUrl]));
    const requesterId = userId ? String(userId) : '';
    const responseMessages = messages.map((message: any) => {
      const isPrivate = Boolean(message.isPrivate);
      const canViewPrivateText = isPrivate && requesterId.length > 0 && (
        String(message.senderId || '') === requesterId || String(message.recipientId || '') === requesterId
      );
      const redactPrivateText = isPrivate && !canViewPrivateText;
      return {
        ...message,
        text: redactPrivateText ? '' : message.text,
        fileAttachment: redactPrivateText ? undefined : message.fileAttachment,
        stickerId: redactPrivateText ? undefined : message.stickerId,
        replyTo: redactPrivateText ? undefined : message.replyTo,
        reactions: redactPrivateText ? {} : message.reactions,
        readBy: redactPrivateText ? [] : message.readBy,
        privateNotice: redactPrivateText,
        senderBadge: badgeByUserId.get(String(message.senderId || '')) || undefined,
        senderAvatarUrl: getPublicAvatarUrl(avatarByUserId.get(String(message.senderId || '')) || message.senderAvatarUrl)
      };
    });

    res.json({
      success: true,
      data: responseMessages,
      count: responseMessages.length,
      hasMore: isDeltaSync
        ? matchingCount > responseMessages.length
        : (isOlderPage ? responseMessages.length === maxLimit : undefined),
      allowCommunityChat,
      forumAccessAllowed: true,
      syncedAt: syncWatermark.toISOString()
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch community messages' });
  }
};

export const postPrivateCommunityMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const sender = (req as any).user;
    if (!sender?._id) {
      res.status(401).json({ success: false, error: 'Sign in to send a private message.' });
      return;
    }

    const allowChat = await getAppSettingValue('allowCommunityChat', true);
    if (!allowChat) {
      res.status(403).json({ success: false, error: 'Community chat disabled by administrator.' });
      return;
    }

    const recipientId = String(req.body?.recipientId || '').trim();
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!Types.ObjectId.isValid(recipientId)) {
      res.status(400).json({ success: false, error: 'Choose a valid recipient.' });
      return;
    }
    if (!text || text.length > 2000) {
      res.status(400).json({ success: false, error: 'Enter a message of 1 to 2,000 characters.' });
      return;
    }
    if (String(sender._id) === recipientId) {
      res.status(400).json({ success: false, error: 'Choose someone else to receive the private message.' });
      return;
    }

    const recipient = await User.findById(recipientId).select('_id name email accountStatus');
    if (!recipient || recipient.accountStatus === 'suspended') {
      res.status(404).json({ success: false, error: 'That user could not be found.' });
      return;
    }

    const forumPolicy = await getForumAccessPolicy();
    if (!isForumParticipationAllowed(sender.email, forumPolicy) || !isForumParticipationAllowed(recipient.email, forumPolicy)) {
      res.status(403).json({ success: false, error: 'Both users must be eligible for forum participation.' });
      return;
    }

    const savedMessage = await CommunityMessage.create({
      senderId: sender._id,
      senderName: sender.name || 'Moi Student',
      senderEmail: sender.email || '',
      senderFaculty: 'Moi Student',
      senderCourse: sender.course,
      senderYear: sender.yearOfStudy,
      senderAvatarUrl: getPublicAvatarUrl(sender.avatarUrl),
      senderBadge: sender.badge,
      avatarBg: '#15803d',
      text,
      isPrivate: true,
      recipientId: recipient._id,
      recipientName: recipient.name || 'a student',
      readBy: [sender._id]
    });

    const message = savedMessage.toObject();
    const publicNotice = {
      ...message,
      text: '',
      fileAttachment: undefined,
      stickerId: undefined,
      replyTo: undefined,
      privateNotice: true
    };
    const io = getSocketIO();
    // Keep the redacted public notice out of the sender's and recipient's feeds.
    // They receive the full private message through their personal rooms below.
    io?.to('community_room')
      .except([`user:${String(sender._id)}`, `user:${String(recipient._id)}`])
      .emit('community:receive_message', publicNotice);
    io?.to(`user:${String(sender._id)}`).to(`user:${String(recipient._id)}`).emit('community:private_message', message);

    void sendPrivateCommunityMessagePush(String(recipient._id), String(savedMessage._id));

    res.status(201).json({ success: true, message: 'Private message sent.', data: message });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to send private message.' });
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
    const allowChat = await getAppSettingValue('allowCommunityChat', true);
    if (!allowChat) {
      res.status(403).json({ success: false, error: 'Community chat disabled by administrator' });
      return;
    }
    const { clientMsgId, text, fileAttachment, stickerId, replyTo, senderName, senderEmail, senderFaculty, senderCourse, senderYear, senderPhone, senderAvatarUrl, senderBadge, avatarBg, senderId, mentions } = req.body;
    const user = (req as any).user;
    const forumPolicy = await getForumAccessPolicy();
    if (!isForumParticipationAllowed(user?.email, forumPolicy)) {
      res.status(403).json({ success: false, error: 'You are not eligible for forum participation.' });
      return;
    }

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

    const mentionedUserIds = Array.isArray(mentions)
      ? Array.from(new Set(mentions.map(String).filter((id: string) => Types.ObjectId.isValid(id)))).slice(0, 25)
      : [];

    let message: any = null;
    if (clientMsgId) {
      message = await CommunityMessage.findOne({ clientMsgId }).lean();
    }

    if (!message) {
      const effectiveSenderName = user?.name || senderName || 'Moi Student';
      message = await CommunityMessage.create({
        clientMsgId,
        senderId: user?._id || senderId || '60d0fe4f5311236168a109ca',
        senderName: effectiveSenderName,
        senderEmail: user?.email || senderEmail || '',
        senderFaculty: senderFaculty || 'Moi Student',
        senderCourse: senderCourse || (user?.course && user.course.toLowerCase() !== 'unset' ? user.course : undefined),
        senderYear: senderYear || (user?.yearOfStudy && user.yearOfStudy.toLowerCase() !== 'unset' ? user.yearOfStudy : undefined),
        senderPhone,
        senderAvatarUrl: getPublicAvatarUrl(user?.avatarUrl) || getPublicAvatarUrl(senderAvatarUrl),
        senderBadge: user?.badge || senderBadge,
        avatarBg: avatarBg || '#15803d',
        text: text?.trim() || '',
        mentions: mentionedUserIds,
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

      // Keep community message alerts as device pushes; the in-app bell is filtered separately.
      setImmediate(() => {
        void sendCommunityMessagePush(message).catch(() => {});
      });

    }

    if (message && !isBotStopCommand(message.text) && shouldCampusBotRespond(message.text, message.replyTo, message)) {
      setImmediate(() => {
        void runCampusBotConversation(message, {
          onTyping: (assistant, typing) => getSocketIO()?.to('community_room').emit(
            typing ? 'community:user_typing' : 'community:user_stop_typing',
            { userId: assistant.kind === 'bot' ? 'campus-bot' : 'campus-ai', userName: assistant.name }
          ),
          onReply: (assistantMessage) => {
            getSocketIO()?.to('community_room').emit('community:receive_message', assistantMessage);
            void sendCommunityMessagePush(assistantMessage);
          }
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
    const forumPolicy = await getForumAccessPolicy();
    if (!isForumParticipationAllowed(user?.email, forumPolicy)) {
      res.status(403).json({ success: false, error: 'You are not eligible for forum participation.' });
      return;
    }
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
    if (message.isPrivate) {
      const userId = String(user?._id || '');
      if (userId !== String(message.senderId) && userId !== String(message.recipientId || '')) {
        res.status(404).json({ success: false, error: 'Message not found.' });
        return;
      }
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
      const reactionEvent = {
        messageId: id,
        reactions,
        actorId,
        myReaction
      };
      if (message.isPrivate) {
        io.to(`user:${String(message.senderId)}`).to(`user:${String(message.recipientId)}`).emit('community:reaction_updated', reactionEvent);
      } else {
        io.to('community_room').emit('community:reaction_updated', reactionEvent);
      }
    }

    res.json({ success: true, data: { messageId: id, reactions, myReaction } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to react to message' });
  }
};

export const markCommunityMessageRead = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Authentication required.' });
      return;
    }
    const message = await CommunityMessage.findById(req.params.id).select('_id isPrivate senderId recipientId');
    if (!message) {
      res.status(404).json({ success: false, error: 'Message not found.' });
      return;
    }
    if (message.isPrivate && String(userId) !== String(message.senderId) && String(userId) !== String(message.recipientId || '')) {
      res.status(404).json({ success: false, error: 'Message not found.' });
      return;
    }
    await CommunityMessage.updateOne({ _id: message._id }, { $addToSet: { readBy: userId } });
    res.json({ success: true, message: 'Community message marked as read.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to mark message as read.' });
  }
};
// 4. Upload Community Chat Media File to Cloudinary (folder: moiconnect/chat_media)
export const uploadCommunityMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    const allowChat = await getAppSettingValue('allowCommunityChat', true);
    if (!allowChat) {
      res.status(403).json({ success: false, error: 'Community chat disabled by administrator' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No media file provided.' });
      return;
    }

    const file = req.file;
    const mime = (file.mimetype || '').toLowerCase();
    const origName = (file.originalname || '').toLowerCase();
    let fileType: 'pdf' | 'doc' | 'image' | 'video' = 'pdf';
    if (mime.includes('image') || origName.match(/\.(jpg|jpeg|png|gif|webp|bmp|heic|svg)$/i)) {
      fileType = 'image';
    } else if (mime.includes('video') || origName.match(/\.(mp4|mov|m4v|webm|mkv|avi|3gp|flv|wmv)$/i)) {
      fileType = 'video';
    } else if (mime.includes('word') || origName.endsWith('.doc') || origName.endsWith('.docx')) {
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

// 4. Delete Community Message (For Everyone)
export const deleteCommunityMessage = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = (req as any).user?._id?.toString();
    const userRole = (req as any).user?.role;

    const msg = await CommunityMessage.findById(id);
    if (!msg) {
      res.status(404).json({ success: false, error: 'Message not found' });
      return;
    }

    const isSender = msg.senderId && msg.senderId.toString() === userId;
    const isAdmin = userRole === 'admin';

    if (!isSender && !isAdmin) {
      res.status(403).json({ success: false, error: 'You can only delete your own messages.' });
      return;
    }

    await CommunityMessage.findByIdAndDelete(id);

    try {
      const io = getSocketIO();
      io?.emit('community:message_deleted', { messageId: id });
    } catch {}

    res.json({ success: true, messageId: id });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to delete message' });
  }
};

// Hide a community message for the signed-in user without deleting it for everyone.
// This is persisted server-side so an uninstall/reinstall cannot make it reappear.
export const deleteCommunityMessageForMe = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req as any).user?._id;
    const { id } = req.params;
    if (!userId) {
      res.status(401).json({ success: false, error: 'Sign in to delete messages for your account.' });
      return;
    }
    const message = await CommunityMessage.findByIdAndUpdate(
      id,
      { $addToSet: { hiddenForUserIds: userId } },
      { new: true }
    ).select('_id');
    if (!message) {
      res.status(404).json({ success: false, error: 'Message not found.' });
      return;
    }
    res.json({ success: true, message: 'Message removed for you.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to remove message for you.' });
  }
};

