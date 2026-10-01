import { Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { AuthenticatedRequest } from '../middleware/auth';
import { config } from '../config';

const LIVE_ROOM_NAME = 'moi-campus-community';

export const createCommunityLiveToken = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = req.user?._id?.toString() || (req.query.userId as string) || `student_${Date.now()}`;
  const displayName = String(req.user?.name || req.query.name || 'Moi Student').slice(0, 80);

  if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
    res.json({
      success: true,
      data: {
        url: '',
        token: 'socket_fallback_mode',
        roomName: LIVE_ROOM_NAME,
        participantName: displayName,
        isConfigured: false
      }
    });
    return;
  }
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: userId,
    name: displayName,
    ttl: '2h'
  });

  token.addGrant({
    room: LIVE_ROOM_NAME,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true
  });

  res.json({
    success: true,
    data: {
      url: config.livekit.url,
      token: await token.toJwt(),
      roomName: LIVE_ROOM_NAME,
      participantName: displayName
    }
  });
};

