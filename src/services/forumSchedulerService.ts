import { Types } from 'mongoose';
import { CommunityMessage } from '../models/CommunityMessage';
import { ScheduledForumMessage } from '../models/ScheduledForumMessage';
import { getSocketIO } from '../socket';
import { sendCommunityMessagePush } from './pushNotificationService';

const ASSISTANTS = {
  ai: { id: new Types.ObjectId('000000000000000000000002'), name: 'Campus AI', email: 'campusai@moiconnect.app', avatarBg: '#d4a017' },
  bot: { id: new Types.ObjectId('000000000000000000000001'), name: 'Campus Bot', email: 'campusbot@moiconnect.app', avatarBg: '#6366f1' }
} as const;

let worker: NodeJS.Timeout | null = null;
let processing = false;

export const processDueForumMessages = async (): Promise<void> => {
  if (processing || ScheduledForumMessage.db.readyState !== 1) return;
  processing = true;
  try {
    for (let count = 0; count < 10; count += 1) {
      const now = new Date();
      const job = await ScheduledForumMessage.findOneAndUpdate(
        { status: 'pending', scheduledAt: { $lte: now } },
        { $set: { status: 'processing' } },
        { sort: { scheduledAt: 1 }, new: true }
      );
      if (!job) break;
      try {
        const assistant = ASSISTANTS[job.assistant];
        const message = await CommunityMessage.create({
          senderId: assistant.id,
          senderName: assistant.name,
          senderEmail: assistant.email,
          senderFaculty: 'AI assistant',
          senderCourse: 'AI assistant',
          senderYear: 'AI assistant',
          senderPhone: 'AI assistant',
          avatarBg: assistant.avatarBg,
          text: job.text,
          fileAttachment: job.fileAttachment,
          reactions: {}
        });
        const plain = message.toObject();
        getSocketIO()?.to('community_room').emit('community:receive_message', plain);
        void sendCommunityMessagePush({ ...plain, senderId: String(plain.senderId), _id: String(plain._id) }).catch(() => undefined);
        await ScheduledForumMessage.updateOne({ _id: job._id, status: 'processing' }, { $set: { status: 'sent', sentAt: new Date(), sentMessageId: message._id, error: '' } });
      } catch (error: any) {
        await ScheduledForumMessage.updateOne({ _id: job._id, status: 'processing' }, { $set: { status: 'failed', error: String(error?.message || error).slice(0, 500) } });
      }
    }
  } finally {
    processing = false;
  }
};

export const startForumScheduler = (): void => {
  if (worker) return;
  const processSafely = () => {
    void processDueForumMessages().catch((error: any) => {
      console.error('[Forum Scheduler]: Could not process due messages:', error?.message || error);
    });
  };
  worker = setInterval(processSafely, 15_000);
  worker.unref();
  if (ScheduledForumMessage.db.readyState === 1) {
    processSafely();
  } else {
    ScheduledForumMessage.db.once('connected', processSafely);
  }
};
