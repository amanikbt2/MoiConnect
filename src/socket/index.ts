import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';

export interface AuthenticatedSocket extends Socket {
  userId?: string;
}

export const setupSocketIO = (io: SocketIOServer): void => {
  // Connection Authentication Middleware
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) {
        return next(new Error('Authentication error: Token not provided'));
      }

      const decoded = jwt.verify(token, config.jwtAccessSecret) as { userId: string };
      const user = await User.findById(decoded.userId);
      if (!user || user.accountStatus === 'suspended') {
        return next(new Error('Authentication error: User invalid or suspended'));
      }

      socket.userId = user._id.toString();
      next();
    } catch (err) {
      next(new Error('Authentication error: Invalid token'));
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const userId = socket.userId!;
    console.log(`[Socket Connected]: User ${userId}`);

    // Join personal notification room
    socket.join(`user:${userId}`);

    // Join conversation room with security verification
    socket.on('join_conversation', async (conversationId: string) => {
      try {
        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        const isParticipant = conversation.participants.some(
          p => p.toString() === userId
        );

        if (!isParticipant) {
          socket.emit('error', { message: 'Not authorized to join this conversation' });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        console.log(`[Socket]: User ${userId} joined room conversation:${conversationId}`);
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // Real-time message handler
    socket.on('send_message', async (data: { conversationId: string; text: string }) => {
      try {
        const { conversationId, text } = data;
        if (!conversationId || !text || !text.trim()) return;

        const conversation = await Conversation.findById(conversationId);
        if (!conversation) {
          socket.emit('error', { message: 'Conversation not found' });
          return;
        }

        const isParticipant = conversation.participants.some(
          p => p.toString() === userId
        );

        if (!isParticipant) {
          socket.emit('error', { message: 'Not authorized to send message in this conversation' });
          return;
        }

        // Authenticated sender ID enforced on server side
        const message = await Message.create({
          conversationId,
          senderId: userId,
          type: 'text',
          text: text.trim(),
          readBy: [userId]
        });

        conversation.lastMessage = message._id as any;
        conversation.lastMessageAt = new Date();
        await conversation.save();

        const populatedMessage = await message.populate('senderId', 'name email avatarUrl');

        // Broadcast to conversation room
        io.to(`conversation:${conversationId}`).emit('receive_message', populatedMessage);

        // Notify other participants
        conversation.participants.forEach(participantId => {
          const pId = participantId.toString();
          if (pId !== userId) {
            io.to(`user:${pId}`).emit('conversation_updated', {
              conversationId,
              lastMessage: populatedMessage
            });
          }
        });
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`[Socket Disconnected]: User ${userId}`);
    });
  });
};
