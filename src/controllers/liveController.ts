import { Request, Response } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { AuthenticatedRequest } from '../middleware/auth';
import { config } from '../config';

const LIVE_ROOM_NAME = 'moi-campus-community';

export const createCommunityLiveToken = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ success: false, error: 'Sign in to join a live room.' });
    return;
  }
  const role = req.query.role === 'host' ? 'host' : 'viewer';
  const userId = user._id.toString();
  const displayName = String(user.name || 'Moi Student').slice(0, 80);

  if (role === 'host') {
    if (!user.canGoLive) {
      res.status(403).json({ success: false, error: 'Go Live is not enabled for your account. Contact an administrator if you think this is a mistake.' });
      return;
    }
  }

  if (!config.livekit.url || !config.livekit.apiKey || !config.livekit.apiSecret) {
    res.status(503).json({ success: false, error: 'Live streaming is not configured on the server.' });
    return;
  }
  const token = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: userId,
    name: displayName,
    metadata: JSON.stringify({ avatarUrl: user.avatarUrl || '' }),
    ttl: '2h'
  });

  token.addGrant({
    room: LIVE_ROOM_NAME,
    roomJoin: true,
    // Viewers may temporarily publish mic/camera while holding the room controls.
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

