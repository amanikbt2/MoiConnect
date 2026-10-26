import { Server as SocketIOServer, Socket } from 'socket.io';
import { Types } from 'mongoose';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { CommunityMessage } from '../models/CommunityMessage';
import { getCampusBotsGeneration, isAssistantSender, isBotStopCommand, runCampusBotConversation, shouldCampusBotRespond, stopCampusBots } from '../services/campusBotService';
import { sendCommunityMessagePush, sendDirectMessagePush } from '../services/pushNotificationService';
import { getAppSettingValue } from '../models/AppSetting';
import { ForumAccessPolicy, getForumAccessPolicy, isForumParticipationAllowed } from '../services/forumAccessService';

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

interface LiveParticipant {
  id: string;
  name: string;
  avatar?: string;
  socketId: string;
}

interface ActiveLiveBroadcast {
  hostId: string;
  hostSocketId: string;
  hostName: string;
  hostAvatar?: string;
  participants: Map<string, LiveParticipant>;
}

// In-memory zero-polling active sockets registry for maximum speed (O(1) lookups)
const activeSockets = new Map<string, OnlineSession>();
const processedClientMsgIds = new Map<string, string>();
let activeLiveBroadcast: ActiveLiveBroadcast | null = null;
let hostDisconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
let ioInstance: SocketIOServer | null = null;

export const getSocketIO = (): SocketIOServer | null => {
  return ioInstance;
};

export const refreshCommunityForumAccess = async (policy?: ForumAccessPolicy): Promise<void> => {
  if (!ioInstance) return;
  const activePolicy = policy || await getForumAccessPolicy();
  const sockets = await ioInstance.fetchSockets();
  await Promise.all(sockets.map(async (socket) => {
    const allowed = isForumParticipationAllowed(socket.data.forumEmail, activePolicy);
    socket.data.forumAccessAllowed = allowed;
    if (allowed) await socket.join('community_room');
    else await socket.leave('community_room');
    socket.emit('community:forum_access', {
      allowed,
      message: allowed ? '' : 'You are not eligible for forum participation.'
    });
  }));
  ioInstance.to('community_room').emit('community:online_count', getOnlineStats());
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
    const resolveForumAccess = async () => {
      try {
        const policy = await getForumAccessPolicy();
        socket.data.forumAccessAllowed = isForumParticipationAllowed(socket.data.forumEmail, policy);
      } catch {
        socket.data.forumAccessAllowed = false;
      }
    };
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) {
        // Guest user (not signed in / unknown)
        socket.userId = undefined;
        socket.isGuest = true;
        await resolveForumAccess();
        return next();
      }

      const decoded = jwt.verify(token, config.jwtAccessSecret, { ignoreExpiration: true }) as { userId: string };
      const user = await User.findById(decoded.userId);
      if (user && user.accountStatus !== 'suspended') {
        socket.userId = user._id.toString();
        socket.isGuest = false;
        socket.data.forumEmail = user.email;
        socket.data.userEmail = user.email;
        socket.data.user = {
          name: user.name,
          email: user.email,
          badge: user.badge,
          avatarUrl: user.avatarUrl,
          course: user.course,
          yearOfStudy: user.yearOfStudy,
          school: user.school,
          phone: user.phone
        };
      } else {
        socket.userId = undefined;
        socket.isGuest = true;
      }
    await resolveForumAccess();
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

    socket.on('community:request_live_status', () => {
      socket.emit('community:live_status', activeLiveBroadcast ? {
        active: true,
          hostName: activeLiveBroadcast.hostName,
          hostAvatar: activeLiveBroadcast.hostAvatar,
          hostId: activeLiveBroadcast.hostId
      } : { active: false });
    });

    // Join personal notification room if authenticated
    if (userId) {
      socket.join(`user:${userId}`);
    }

    // Only eligible users receive community room broadcasts.
    const forumAccessAllowed = socket.data.forumAccessAllowed !== false;
    if (forumAccessAllowed) socket.join('community_room');
    socket.emit('community:forum_access', {
      allowed: forumAccessAllowed,
      message: forumAccessAllowed ? '' : 'You are not eligible for forum participation.'
    });
    broadcastOnlineCount();

    if (activeLiveBroadcast) {
      socket.emit('community:live_start', {
        hostName: activeLiveBroadcast.hostName,
        hostAvatar: activeLiveBroadcast.hostAvatar,
        hostId: activeLiveBroadcast.hostId
      });
      activeLiveBroadcast.participants.forEach((participant) => {
        socket.emit('community:live_join', {
          id: participant.id,
          name: participant.name,
          avatar: participant.avatar
        });
      });
    }

    // Broadcast system connection pill notice if user is authenticated
    if (userId) {
      User.findById(userId).select('name').then(u => {
        if (u) {
          socket.to('community_room').emit('community:system_event', {
            id: `sys_conn_${socket.id}_${Date.now()}`,
            event: 'user_connected',
            userId,
            userName: u.name,
            text: `${u.name} logged into MConnect`,
            timestamp: new Date().toISOString()
          });
        }
      }).catch(() => {});
    }

    socket.on('join_community', async () => {
      const policy = await getForumAccessPolicy();
      const allowed = isForumParticipationAllowed(socket.data.forumEmail, policy);
      socket.data.forumAccessAllowed = allowed;
      if (!allowed) {
        socket.leave('community_room');
        socket.emit('community:forum_access', { allowed: false, message: 'You are not eligible for forum participation.' });
        return;
      }
      socket.join('community_room');
      socket.emit('community:forum_access', { allowed: true, message: '' });
      broadcastOnlineCount();
    });

    socket.on('community:live_start', async () => {
      if (!userId) return;
      if (activeLiveBroadcast) {
        if (activeLiveBroadcast.hostId === userId) {
          if (hostDisconnectGraceTimer) {
            clearTimeout(hostDisconnectGraceTimer);
            hostDisconnectGraceTimer = null;
          }
          activeLiveBroadcast.hostSocketId = socket.id;
        }
        return;
      }
      if (hostDisconnectGraceTimer) {
        clearTimeout(hostDisconnectGraceTimer);
        hostDisconnectGraceTimer = null;
      }
      const host = await User.findById(userId).select('name avatarUrl canGoLive').lean();
      if (!host?.canGoLive) return;

      activeLiveBroadcast = {
        hostId: userId,
        hostSocketId: socket.id,
        hostName: host.name || 'Moi Student',
        hostAvatar: host.avatarUrl,
        participants: new Map()
      };

      io.to('community_room').emit('community:live_start', {
        hostName: activeLiveBroadcast.hostName,
        hostAvatar: activeLiveBroadcast.hostAvatar,
        hostId: activeLiveBroadcast.hostId
      });
    });

    socket.on('community:live_join', (data: { id?: string; name?: string; avatar?: string }) => {
      if (!userId || !activeLiveBroadcast || !data?.id) return;

      const participant: LiveParticipant = {
        id: socket.id,
        name: (socket as any).user?.name || data.name || 'Moi Student',
        avatar: (socket as any).user?.avatarUrl || data.avatar,
        socketId: socket.id
      };
      activeLiveBroadcast.participants.set(participant.id, participant);
      io.to('community_room').emit('community:live_join', {
        id: participant.id,
        name: participant.name,
        avatar: participant.avatar
      });
    });

    socket.on('community:live_leave', (data: { id?: string }) => {
      if (!activeLiveBroadcast || !data?.id) return;
      activeLiveBroadcast.participants.delete(data.id);
      io.to('community_room').emit('community:live_leave', { id: data.id });
    });

    socket.on('community:live_end', () => {
      if (!activeLiveBroadcast) return;
      if (activeLiveBroadcast.hostSocketId !== socket.id && activeLiveBroadcast.hostId !== userId) return;
      if (hostDisconnectGraceTimer) {
        clearTimeout(hostDisconnectGraceTimer);
        hostDisconnectGraceTimer = null;
      }
      const hostName = activeLiveBroadcast.hostName;
      activeLiveBroadcast = null;
      io.to('community_room').emit('community:live_end', { hostName });
    });

    // Typing Indicator Socket Handlers (Zero-DB In-Memory Sub-1ms Broadcast)
    socket.on('community:start_typing', (data: { userName?: string; userId?: string; avatarUrl?: string; avatarBg?: string }) => {
      socket.to('community_room').emit('community:user_typing', {
        userId: userId || data?.userId || socket.id,
        userName: data?.userName || 'Moi Student',
        avatarUrl: data?.avatarUrl,
        avatarBg: data?.avatarBg,
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

    socket.on('community:start_deleting', (data: { userName?: string; userId?: string; avatarUrl?: string; avatarBg?: string }) => {
      socket.to('community_room').emit('community:user_deleting', {
        userId: userId || data?.userId || socket.id,
        userName: data?.userName || 'Moi Student',
        avatarUrl: data?.avatarUrl,
        avatarBg: data?.avatarBg,
        socketId: socket.id
      });
    });

    socket.on('community:stop_deleting', (data: { userName?: string; userId?: string }) => {
      socket.to('community_room').emit('community:user_stop_deleting', {
        userId: userId || data?.userId || socket.id,
        userName: data?.userName || 'Moi Student',
        socketId: socket.id
      });
    });

    // Real-Time Community Chat Socket Handler (Sub-5ms Lightning Speed Broadcast)
    socket.on('community:send_message', async (data: {
      clientMsgId?: string;
      senderId?: string;
      text: string;
      mentions?: string[];
      fileAttachment?: any;
      stickerId?: string;
      replyTo?: any;
      senderName?: string;
      senderEmail?: string;
      senderFaculty?: string;
      senderCourse?: string;
      senderYear?: string;
      senderPhone?: string;
      senderAvatarUrl?: string;
      senderBadge?: 'blue' | 'red' | 'green';
      avatarBg?: string;
    }, ack?: (result: { success: boolean; id?: string; error?: string }) => void) => {
      try {
        const allowChat = await getAppSettingValue('allowCommunityChat', true);
        if (!allowChat) {
          ack?.({ success: false, error: 'Community chat disabled by administrator' });
          return;
        }
        const { clientMsgId, text, fileAttachment, stickerId, replyTo, senderName, senderEmail, senderFaculty, senderCourse, senderYear, senderPhone, senderAvatarUrl, senderBadge, avatarBg } = data;
        if (!text?.trim() && !fileAttachment && !stickerId) return;
        const mentions = Array.isArray(data.mentions)
          ? Array.from(new Set(data.mentions.map(String).filter((id) => Types.ObjectId.isValid(id)))).slice(0, 25)
          : [];

        const forumPolicy = await getForumAccessPolicy();
        const forumAccessAllowed = isForumParticipationAllowed(socket.data.forumEmail, forumPolicy);
        if (!forumAccessAllowed) {
          socket.data.forumAccessAllowed = false;
          socket.leave('community_room');
          socket.emit('community:forum_access', { allowed: false, message: 'You are not eligible for forum participation.' });
          ack?.({ success: false, error: 'You are not eligible for forum participation.' });
          return;
        }

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

        const sEmail = socket.data.userEmail || senderEmail || '';
        const senderUser = socket.data.user || (userId && Types.ObjectId.isValid(userId)
          ? await User.findById(userId).select('name email badge avatarUrl course yearOfStudy').lean()
          : null);
        const effectiveSenderName = senderUser?.name || senderName || 'Moi Student';
        const effectiveSenderAvatarUrl = /^https?:\/\//i.test(String(senderUser?.avatarUrl || ''))
          ? senderUser?.avatarUrl
          : (/^https?:\/\//i.test(String(senderAvatarUrl || '')) ? senderAvatarUrl : undefined);
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
          senderFaculty: senderFaculty || 'Moi Student',
          senderCourse: senderCourse || (senderUser?.course && senderUser.course.toLowerCase() !== 'unset' ? senderUser.course : undefined),
          senderYear: senderYear || (senderUser?.yearOfStudy && senderUser.yearOfStudy.toLowerCase() !== 'unset' ? senderUser.yearOfStudy : undefined),
          senderPhone,
          senderAvatarUrl: effectiveSenderAvatarUrl,
          senderBadge: senderUser?.badge || senderBadge,
          avatarBg: avatarBg || '#15803d',
          text: text?.trim() || '',
          mentions,
          waitForBot: !stopBots && shouldCampusBotRespond(text, replyTo, { senderId: sId, senderName: effectiveSenderName, senderEmail: sEmail }),
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
              senderYear: messagePayload.senderYear,
              senderPhone: messagePayload.senderPhone,
              senderAvatarUrl: messagePayload.senderAvatarUrl,
              senderBadge: messagePayload.senderBadge,
              avatarBg: messagePayload.avatarBg,
              text: messagePayload.text,
              mentions: messagePayload.mentions,
              stickerId: messagePayload.stickerId,
              fileAttachment,
              replyTo,
              reactions: {}
            });
            ack?.({ success: true, id: generatedId });
            void sendCommunityMessagePush(messagePayload).catch(() => {});
            if (!stopBots && !isAssistantSender(messagePayload) && shouldCampusBotRespond(messagePayload.text, messagePayload.replyTo, messagePayload)) {
              void runCampusBotConversation(savedMessage, {
                onTyping: (assistant, typing) => io.to('community_room').emit(
                  typing ? 'community:user_typing' : 'community:user_stop_typing',
                  { userId: assistant.kind === 'bot' ? 'campus-bot' : 'campus-ai', userName: assistant.name }
                ),
                onReply: (assistantMessage) => {
                  io.to('community_room').emit('community:receive_message', assistantMessage);
                  void sendCommunityMessagePush(assistantMessage);
                }
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

        const senderObj = populatedMessage.senderId as any;
        const senderInfo = {
          _id: senderObj?._id || userId,
          name: senderObj?.name || 'Moi Student',
          email: senderObj?.email || ''
        };
        void sendDirectMessagePush(conversation, senderInfo, text.trim()).catch(() => {});

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
      if (activeLiveBroadcast?.hostSocketId === socket.id) {
        const hostName = activeLiveBroadcast.hostName;
        const hostId = activeLiveBroadcast.hostId;
        // Do not instantly terminate the live broadcast on transient mobile socket drops.
        // Provide a 45-second grace window to allow the host to reconnect smoothly.
        if (hostDisconnectGraceTimer) clearTimeout(hostDisconnectGraceTimer);
        hostDisconnectGraceTimer = setTimeout(() => {
          if (activeLiveBroadcast && activeLiveBroadcast.hostId === hostId) {
            activeLiveBroadcast = null;
            io.to('community_room').emit('community:live_end', { hostName });
          }
          hostDisconnectGraceTimer = null;
        }, 45000);
      } else if (activeLiveBroadcast) {
        const participant = Array.from(activeLiveBroadcast.participants.values()).find((entry) => entry.socketId === socket.id);
        if (participant) {
          activeLiveBroadcast.participants.delete(participant.id);
          socket.to('community_room').emit('community:live_leave', { id: participant.id });
        }
      }
      activeSockets.delete(socket.id);
      broadcastOnlineCount();
      console.log(`[Socket Disconnected]: ${isGuest ? 'Guest (Unknown)' : `User ${userId}`} (Active: ${activeSockets.size})`);
      if (userId) {
        const stillConnected = Array.from(activeSockets.values()).some((session) => session.userId === userId);
        const userLookup = stillConnected
          ? User.findById(userId).select('name')
          : User.findByIdAndUpdate(userId, { $set: { lastOnlineAt: new Date() } }, { new: true }).select('name');
        userLookup.then(u => {
          if (u) {
            socket.to('community_room').emit('community:system_event', {
              id: `sys_disc_${socket.id}_${Date.now()}`,
              event: 'user_disconnected',
              userId,
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

