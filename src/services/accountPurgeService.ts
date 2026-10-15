import mongoose from 'mongoose';
import { User, IUserDocument } from '../models/User';
import { Paper } from '../models/Paper';
import { RewardPayout } from '../models/RewardPayout';
import { House } from '../models/House';
import { Report } from '../models/Report';
import { CommunityMessage } from '../models/CommunityMessage';
import { DeviceToken } from '../models/DeviceToken';
import { Favorite } from '../models/Favorite';
import { Booking } from '../models/Booking';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { Notification } from '../models/Notification';
import { PopupResponse } from '../models/PopupResponse';
import cloudinary from '../config/cloudinary';
import { getSocketIO } from '../socket';
import { deleteTempFile, extractPublicIdFromCloudinaryUrl } from './tempFileService';

export const extractCloudinaryPublicId = (url: string): string | null => {
  if (!url || !url.includes('res.cloudinary.com')) return null;
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    let pathStr = parts[1];
    if (/^v\d+\//.test(pathStr)) {
      pathStr = pathStr.replace(/^v\d+\//, '');
    }
    const lastDot = pathStr.lastIndexOf('.');
    if (lastDot !== -1) {
      pathStr = pathStr.substring(0, lastDot);
    }
    return decodeURIComponent(pathStr);
  } catch (e) {
    return null;
  }
};

export const destroyCloudinaryAsset = async (publicId: string, fileType?: string, fileUrl?: string): Promise<boolean> => {
  if (!publicId) return false;
  const resourceTypes = ['image', 'raw', 'video'];
  if (fileType === 'video' || fileUrl?.includes('/video/upload/')) {
    resourceTypes.unshift('video');
  } else if (fileType === 'image' || fileUrl?.includes('/image/upload/')) {
    resourceTypes.unshift('image');
  } else if (fileType === 'raw' || fileType === 'pdf' || fileType === 'text') {
    resourceTypes.unshift('raw');
  }

  for (const resourceType of Array.from(new Set(resourceTypes))) {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType as any,
        type: 'upload',
        invalidate: true
      });
      if (result.result === 'ok') return true;
    } catch (error) {
      // Best-effort cleanup
    }
  }
  return false;
};

export const purgeUserAccountAndData = async (
  userId: string | mongoose.Types.ObjectId,
  options?: { reason?: string }
): Promise<{ success: boolean; user: IUserDocument | null; message: string }> => {
  const user = await User.findById(userId);
  if (!user) {
    return { success: false, user: null, message: 'User not found or already deleted.' };
  }

  const uId = user._id;
  const userEmail = user.email;

  // 1. Delete user profile avatar from Cloudinary
  if (user.avatarUrl) {
    const avatarPid = extractCloudinaryPublicId(user.avatarUrl) || extractPublicIdFromCloudinaryUrl(user.avatarUrl);
    if (avatarPid) {
      await destroyCloudinaryAsset(avatarPid, 'image', user.avatarUrl);
    }
  }

  // 2. Community chat messages: PRESERVED so campus discussion history and shared files remain intact.

  // 3. Delete landlord houses & their photos from Cloudinary
  const userHouses = await House.find({ landlordId: uId });
  for (const house of userHouses) {
    if (Array.isArray(house.photos)) {
      for (const imgUrl of house.photos) {
        const publicId = extractCloudinaryPublicId(imgUrl) || extractPublicIdFromCloudinaryUrl(imgUrl);
        if (publicId) {
          await destroyCloudinaryAsset(publicId, 'image', imgUrl);
        }
      }
    }
  }
  await House.deleteMany({ landlordId: uId });

  // 4. Academic submissions: PRESERVED so past papers, CATs, and revision notes remain available to all students.

  // 5. Delete direct messages and conversations
  const userConversations = await Conversation.find({ participants: uId }).select('_id');
  const convIds = userConversations.map(c => c._id);
  if (convIds.length > 0) {
    await Message.deleteMany({ conversationId: { $in: convIds } });
    await Conversation.deleteMany({ _id: { $in: convIds } });
  }
  await Message.deleteMany({ senderId: uId });

  // 6. Delete related personal records
  await Booking.deleteMany({ $or: [{ studentId: uId }, { landlordId: uId }] });
  await Favorite.deleteMany({ userId: uId });
  await Report.deleteMany({ $or: [{ reporterId: uId }, { reviewedBy: uId }] });
  await RewardPayout.deleteMany({ userId: uId });
  await DeviceToken.deleteMany({ $or: [{ userId: uId }, { email: userEmail }] });
  await PopupResponse.deleteMany({ $or: [{ userId: uId }, { email: userEmail }] });

  // 7. Notifications: PRESERVED so campus announcements and notification records remain intact.

  // 8. Instant Real-Time Ejection & Auto-Logout via Socket.io
  const io = getSocketIO();
  if (io) {
    const logoutMsg = options?.reason || 'Your account and personal data have been completely deleted.';
    io.to(`user:${uId}`).emit('auth:force_logout', {
      reason: 'account_deleted',
      message: logoutMsg
    });
    io.to(`user:${uId}`).emit('force_logout', { reason: 'account_deleted' });
    io.to(`user:${uId}`).emit('account:deleted', { userId: String(uId) });

    io.sockets.sockets.forEach((s) => {
      if ((s as any).userId === String(uId)) {
        s.emit('auth:force_logout', {
          reason: 'account_deleted',
          message: logoutMsg
        });
        s.disconnect(true);
      }
    });

    io.to('community_room').emit('community:user_deleted', {
      userId: String(uId),
      email: userEmail
    });
  }

  // 9. Permanently delete User document from database
  await User.findByIdAndDelete(uId);

  return {
    success: true,
    user,
    message: `Account for "${user.name}" (${userEmail}) has been permanently deleted. Community chats, academic submissions, and notifications remain preserved.`
  };
};
