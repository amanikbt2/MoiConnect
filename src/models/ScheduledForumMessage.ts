import { Document, Model, Schema, Types, model, models } from 'mongoose';
import { IFileAttachment } from './CommunityMessage';

export type ScheduledForumStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export interface IScheduledForumMessage extends Document {
  assistant: 'ai' | 'bot';
  text: string;
  fileAttachment?: IFileAttachment;
  scheduledAt: Date;
  status: ScheduledForumStatus;
  createdBy?: Types.ObjectId;
  sentMessageId?: Types.ObjectId;
  error?: string;
  sentAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const scheduledForumMessageSchema = new Schema<IScheduledForumMessage>({
  assistant: { type: String, enum: ['ai', 'bot'], required: true },
  text: { type: String, default: '', maxlength: 4000 },
  fileAttachment: {
    name: String,
    url: String,
    publicId: String,
    size: String,
    type: { type: String, enum: ['pdf', 'doc', 'image', 'video'] }
  },
  scheduledAt: { type: Date, required: true, index: true },
  status: { type: String, enum: ['pending', 'sent', 'failed', 'cancelled'], default: 'pending', index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  sentMessageId: { type: Schema.Types.ObjectId, ref: 'CommunityMessage' },
  error: { type: String, default: '' },
  sentAt: Date
}, { timestamps: true });

scheduledForumMessageSchema.index({ status: 1, scheduledAt: 1 });

export const ScheduledForumMessage: Model<IScheduledForumMessage> = models.ScheduledForumMessage || model<IScheduledForumMessage>('ScheduledForumMessage', scheduledForumMessageSchema);
