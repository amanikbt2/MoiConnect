import { Response } from 'express';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { AuthenticatedRequest } from '../middleware/auth';
import { SendMessageInput } from '@moi/shared';

export const getConversations = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const conversations = await Conversation.find({
      participants: user._id
    })
      .populate('participants', 'name email phone avatarUrl roles activeRole')
      .populate('houseId', 'title location monthlyRent photos')
      .populate('lastMessage')
      .sort({ lastMessageAt: -1 });

    res.json({
      success: true,
      data: conversations
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch conversations' });
  }
};

export const getMessages = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id: conversationId } = req.params;
    const user = req.user!;
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '50', 10);
    const skip = (page - 1) * limit;

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      res.status(404).json({ success: false, error: 'Conversation not found.' });
      return;
    }

    // Verify conversation membership
    const isParticipant = conversation.participants.some(
      p => p.toString() === user._id.toString()
    );
    if (!isParticipant) {
      res.status(403).json({ success: false, error: 'Forbidden: You are not a participant in this conversation.' });
      return;
    }

    const total = await Message.countDocuments({ conversationId });
    const messages = await Message.find({ conversationId })
      .populate('senderId', 'name email avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Mark messages as read by current user
    await Message.updateMany(
      { conversationId, senderId: { $ne: user._id }, readBy: { $ne: user._id } },
      { $addToSet: { readBy: user._id } }
    );

    res.json({
      success: true,
      data: messages.reverse(),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch messages' });
  }
};

export const sendMessage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { conversationId, recipientId, houseId, text }: SendMessageInput = req.body;
    const sender = req.user!;

    let conversation;

    if (conversationId) {
      conversation = await Conversation.findById(conversationId);
      if (!conversation) {
        res.status(404).json({ success: false, error: 'Conversation not found.' });
        return;
      }
      const isParticipant = conversation.participants.some(
        p => p.toString() === sender._id.toString()
      );
      if (!isParticipant) {
        res.status(403).json({ success: false, error: 'Forbidden: You are not a participant in this conversation.' });
        return;
      }
    } else if (recipientId) {
      if (recipientId === sender._id.toString()) {
        res.status(400).json({ success: false, error: 'Cannot start a conversation with yourself.' });
        return;
      }

      conversation = await Conversation.findOne({
        participants: { $all: [sender._id, recipientId] }
      });

      if (!conversation) {
        conversation = await Conversation.create({
          participants: [sender._id, recipientId],
          houseId,
          lastMessageAt: new Date()
        });
      }
    } else {
      res.status(400).json({ success: false, error: 'Either conversationId or recipientId is required.' });
      return;
    }

    const message = await Message.create({
      conversationId: conversation._id,
      senderId: sender._id,
      type: 'text',
      text,
      readBy: [sender._id]
    });

    conversation.lastMessage = message._id as any;
    conversation.lastMessageAt = new Date();
    await conversation.save();

    const populated = await message.populate('senderId', 'name email avatarUrl');

    res.status(201).json({
      success: true,
      data: {
        message: populated,
        conversationId: conversation._id
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to send message' });
  }
};
