import { Server as SocketIOServer, Socket } from 'socket.io';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { CommunityMessage } from '../models/CommunityMessage';
import { getCampusBotsGeneration, isBotStopCommand, runCampusBotConversation, shouldCampusBotRespond, stopCampusBots } from '../services/campusBotService';

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
const processedClientMsgIds = new Map<string, string>();
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

    const broadcastOnlineCount = () => {
      io.to('community_room').emit('community:online_count', getOnlineStats());
    };

    socket.on('community:request_online_count', () => {
      socket.emit('community:online_count', getOnlineStats());
    });

    // Join personal notification room if authenticated
    if (userId) {
      socket.join(`user:${userId}`);
    }

    // Auto-join open community broadcast room
    socket.join('community_room');
    broadcastOnlineCount();

    // Broadcast system connection pill notice if user is authenticated
    if (userId) {
      User.findById(userId).select('name').then(u => {
        if (u) {
          socket.to('community_room').emit('community:system_event', {
            id: `sys_conn_${socket.id}_${Date.now()}`,
            event: 'user_connected',
            userName: u.name,
            text: `${u.name} logged into MoiConnect`,
            timestamp: new Date().toISOString()
          });
        }
      }).catch(() => {});
    }

    socket.on('join_community', () => {
      socket.join('community_room');
      broadcastOnlineCount();
    });

    // Typing Indicator Socket Handlers (Zero-DB In-Memory Sub-1ms Broadcast)
    socket.on('community:start_typing', (data: { userName?: string; userId?: string }) => {
      socket.to('community_room').emit('community:user_typing', {
        userId: userId || data?.userId || socket.id,
        userName: data?.userName || 'Moi Student',
        socketId: socket.id
      });
    });

    socket.on('community:stop_typing', (data: { userName?: string; userId?: string }) => {
      socket.to('community_room').emit('community:user_stop_typing', {
        userId: userId || data?.userId || socket.id,
        userName: data?.userName || 'Moi Student',
        socketId: socket.id
      });
    });

    // Real-Time Community Chat Socket Handler (Sub-5ms Lightning Speed Broadcast)
    socket.on('community:send_message', (data: {
      clientMsgId?: string;
      senderId?: string;
      text: string;
      fileAttachment?: any;
      stickerId?: string;
      replyTo?: any;
      senderName?: string;
      senderEmail?: string;
      senderFaculty?: string;
      senderCourse?: string;
      senderPhone?: string;
      senderAvatarUrl?: string;
      avatarBg?: string;
    }, ack?: (result: { success: boolean; id?: string; error?: string }) => void) => {
      try {
        const { clientMsgId, text, fileAttachment, stickerId, replyTo, senderName, senderEmail, senderFaculty, senderCourse, senderPhone, senderAvatarUrl, avatarBg } = data;
        if (!text?.trim() && !fileAttachment && !stickerId) return;

        if (clientMsgId && processedClientMsgIds.has(clientMsgId)) {
          const existingId = processedClientMsgIds.get(clientMsgId);
          ack?.({ success: true, id: existingId });
          return;
        }

        const stopBots = isBotStopCommand(text);
        if (stopBots) {
          stopCampusBots();
          io.to('community_room').emit('community:user_stop_typing', { userId: 'campus-bot' });
          io.to('community_room').emit('community:user_stop_typing', { userId: 'campus-ai' });
        }
        const botGeneration = getCampusBotsGeneration();

        const sId = (userId && Types.ObjectId.isValid(userId))
          ? userId
          : ((data.senderId && Types.ObjectId.isValid(data.senderId)) ? data.senderId : new Types.ObjectId().toString());

        const sEmail = (socket as any).user?.email || senderEmail || '';
        const isCampusBot = sEmail.trim().toLowerCase() === 'dev@gmail.com';
        const effectiveSenderName = isCampusBot ? 'Campus bot' : (senderName || 'Moi Student');
        const generatedId = new Types.ObjectId().toString();
        const nowISO = new Date().toISOString();

        if (clientMsgId) {
          processedClientMsgIds.set(clientMsgId, generatedId);
          if (processedClientMsgIds.size > 2000) {
            const firstKey = processedClientMsgIds.keys().next().value;
            if (firstKey) processedClientMsgIds.delete(firstKey);
          }
        }

        const messagePayload = {
          _id: generatedId,
          clientMsgId,
          senderId: sId,
          senderName: effectiveSenderName,
          senderEmail: sEmail,
          senderFaculty: senderFaculty || 'School of Science & Computing',
          senderCourse,
          senderPhone,
          senderAvatarUrl,
          avatarBg: avatarBg || '#15803d',
          text: text?.trim() || '',
          waitForBot: !stopBots && shouldCampusBotRespond(text, replyTo),
          stickerId,
          fileAttachment,
          replyTo,
          reactions: {},
          createdAt: nowISO,
          updatedAt: nowISO
        };

        // 1. INSTANT BROADCAST TO ALL CONNECTED CLIENTS (<5ms ZERO BLOCKING)
        socket.to('community_room').emit('community:receive_message', messagePayload);
        socket.emit('community:receive_message', messagePayload);

        // Instantly stop typing indicator for sender
        socket.to('community_room').emit('community:user_stop_typing', {
          userId: sId,
          userName: messagePayload.senderName
        });

        // 2. NON-BLOCKING BACKGROUND MONGODB PERSISTENCE
        setImmediate(async () => {
          try {
            if (clientMsgId) {
              const existing = await CommunityMessage.findOne({ clientMsgId }).lean();
              if (existing) {
                ack?.({ success: true, id: String(existing._id) });
                return;
              }
            }

            const savedMessage = await CommunityMessage.create({
              _id: generatedId,
              clientMsgId,
              senderId: sId,
              senderName: messagePayload.senderName,
              senderEmail: messagePayload.senderEmail,
              senderFaculty: messagePayload.senderFaculty,
              senderCourse: messagePayload.senderCourse,
              senderPhone: messagePayload.senderPhone,
              senderAvatarUrl: messagePayload.senderAvatarUrl,
              avatarBg: messagePayload.avatarBg,
              text: messagePayload.text,
              stickerId: messagePayload.stickerId,
              fileAttachment,
              replyTo,
              reactions: {}
            });
            ack?.({ success: true, id: generatedId });
            if (!stopBots && shouldCampusBotRespond(messagePayload.text, messagePayload.replyTo)) {
              void runCampusBotConversation(savedMessage, {
                onTyping: (assistant, typing) => io.to('community_room').emit(
                  typing ? 'community:user_typing' : 'community:user_stop_typing',
                  { userId: assistant.kind === 'bot' ? 'campus-bot' : 'campus-ai', userName: assistant.name }
                ),
                onReply: (assistantMessage) => io.to('community_room').emit('community:receive_message', assistantMessage)
              }, botGeneration).catch((botError) => console.error('[Campus assistants] Reply error:', botError));
            }
          } catch (dbErr) {
            console.error('[Async DB Save Error]:', dbErr);
          }
        });
      } catch (err: any) {
        console.error('[Socket Community Message Error]:', err);
      }
    });

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
      broadcastOnlineCount();
      console.log(`[Socket Disconnected]: ${isGuest ? 'Guest (Unknown)' : `User ${userId}`} (Active: ${activeSockets.size})`);
      if (userId) {
        User.findById(userId).select('name').then(u => {
          if (u) {
            socket.to('community_room').emit('community:system_event', {
              id: `sys_disc_${socket.id}_${Date.now()}`,
              event: 'user_disconnected',
              userName: u.name,
              text: `${u.name} went offline`,
              timestamp: new Date().toISOString()
            });
          }
        }).catch(() => {});
      }
    });
  });
};
