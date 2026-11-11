import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { ScheduledForumMessage } from '../models/ScheduledForumMessage';
import { getSocketIO } from '../socket';
import { processDueForumMessages } from '../services/forumSchedulerService';

const toClientJob = (job: any) => ({
  id: String(job._id),
  assistant: job.assistant,
  text: job.text,
  fileAttachment: job.fileAttachment,
  scheduledAt: job.scheduledAt,
  status: job.status,
  error: job.error || '',
  sentAt: job.sentAt,
  createdAt: job.createdAt
});

export const list = async (_req: Request, res: Response): Promise<void> => {
  try {
    await processDueForumMessages();
    const jobs = await ScheduledForumMessage.find({}).sort({ scheduledAt: -1 }).limit(200).lean();
    res.json({ success: true, data: jobs.map(toClientJob) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Could not load scheduled messages.' });
  }
};

export const create = async (req: Request, res: Response): Promise<void> => {
  try {
    const assistant = req.body?.assistant === 'bot' ? 'bot' : req.body?.assistant === 'ai' ? 'ai' : '';
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const scheduledAt = new Date(req.body?.scheduledAt);
    const attachment = req.body?.fileAttachment;
    if (!assistant) { res.status(400).json({ success: false, error: 'Choose Campus AI or Campus Bot.' }); return; }
    if (!text && !attachment?.url) { res.status(400).json({ success: false, error: 'Add a message or attachment.' }); return; }
    if (text.length > 4000) { res.status(400).json({ success: false, error: 'Message must be 4,000 characters or fewer.' }); return; }
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 30_000 || scheduledAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ success: false, error: 'Choose a time at least 30 seconds from now and within one year.' }); return;
    }
    let fileAttachment: any;
    if (attachment) {
      const type = ['pdf', 'doc', 'image', 'video'].includes(attachment.type) ? attachment.type : null;
      if (!type || typeof attachment.url !== 'string' || !/^https:\/\//i.test(attachment.url) || typeof attachment.name !== 'string') {
        res.status(400).json({ success: false, error: 'The attachment is invalid. Upload it again.' }); return;
      }
      fileAttachment = { name: attachment.name.slice(0, 255), url: attachment.url, publicId: String(attachment.publicId || '').slice(0, 255), size: String(attachment.size || '').slice(0, 40), type };
    }
    const job = await ScheduledForumMessage.create({ assistant, text, fileAttachment, scheduledAt, createdBy: (req as any).user?._id });
    res.status(201).json({ success: true, data: toClientJob(job) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Could not schedule message.' });
  }
};

export const cancel = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!Types.ObjectId.isValid(req.params.id)) { res.status(400).json({ success: false, error: 'Invalid schedule ID.' }); return; }
    const job = await ScheduledForumMessage.findOneAndUpdate({ _id: req.params.id, status: 'pending' }, { $set: { status: 'cancelled' } }, { new: true });
    if (!job) { res.status(404).json({ success: false, error: 'Pending schedule not found; it may already have sent.' }); return; }
    res.json({ success: true, data: toClientJob(job) });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Could not cancel schedule.' });
  }
};
