import { Server as SocketIOServer, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';

export interface AuthenticatedSocket extends Socket {
  userId?: string;
  isGuest?: boolean;
}

interface OnlineSession {
  socketId: string;
  userId?: string;
  isGuest: boolean;
  connectedAt: Date;
}

// In-memory zero-polling active sockets registry for maximum speed (O(1) lookups)
const activeSockets = new Map<string, OnlineSession>();
let ioInstance: SocketIOServer | null = null;

export const getSocketIO = (): SocketIOServer | null => {
  return ioInstance;
};

export const getOnlineStats = () => {
  let authenticatedCount = 0;
  let guestCount = 0;
  const onlineUserIdsSet = new Set<string>();

  activeSockets.forEach(session => {
    if (session.userId) {
      authenticatedCount++;
      onlineUserIdsSet.add(session.userId);
    } else {
      guestCount++;
    }
  });

  return {
    totalOnline: activeSockets.size,
    authenticatedCount,
    guestCount,
    onlineUserIds: Array.from(onlineUserIdsSet)
  };
};

export const setupSocketIO = (io: SocketIOServer): void => {
  ioInstance = io;
  // Connection Authentication Middleware (Supports both Authenticated users & Anonymous/Guest users)
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) {
        // Guest user (not signed in / unknown)
        socket.userId = undefined;
        socket.isGuest = true;
        return next();
      }

      const decoded = jwt.verify(token, config.jwtAccessSecret) as { userId: string };
      const user = await User.findById(decoded.userId);
      if (user && user.accountStatus !== 'suspended') {
        socket.userId = user._id.toString();
        socket.isGuest = false;
      } else {
        socket.userId = undefined;
        socket.isGuest = true;
      }
      next();
    } catch (err) {
      // Fallback to guest session on token verification error
      socket.userId = undefined;
      socket.isGuest = true;
      next();
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const isGuest = !socket.userId;
    const userId = socket.userId;

    // Record socket connection instantly in memory
    activeSockets.set(socket.id, {
      socketId: socket.id,
      userId,
      isGuest,
      connectedAt: new Date()
    });

    console.log(`[Socket Connected]: ${isGuest ? 'Guest (Unknown)' : `User ${userId}`} (Active: ${activeSockets.size})`);

    // Join personal notification room if authenticated
    if (userId) {
      socket.join(`user:${userId}`);
    }

    // Join conversation room with security verification
    socket.on('join_conversation', async (conversationId: string) => {
      try {
        if (!userId) {
          socket.emit('error', { message: 'Must be logged in to join chat' });
          return;
        }

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
      } catch (err: any) {
        socket.emit('error', { message: err.message });
      }
    });

    // Real-time message handler
    socket.on('send_message', async (data: { conversationId: string; text: string }) => {
      try {
        if (!userId) {
          socket.emit('error', { message: 'Must be logged in to send messages' });
          return;
        }

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

        io.to(`conversation:${conversationId}`).emit('receive_message', populatedMessage);

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

    // Clean up on disconnect instantly with zero delay or intervals
    socket.on('disconnect', () => {
      activeSockets.delete(socket.id);
      console.log(`[Socket Disconnected]: ${isGuest ? 'Guest (Unknown)' : `User ${userId}`} (Active: ${activeSockets.size})`);
    });
  });
};
