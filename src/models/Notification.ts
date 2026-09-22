import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  title: string;
  subtitle?: string;
  body: string;
  icon: 'bell' | 'academic' | 'house' | 'alert';
  target: 'all' | 'emails';
  recipientEmails?: string[];
  readBy: string[]; // User IDs or Token IDs who read this notification
  data?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    title: { type: String, required: true },
    subtitle: { type: String, default: '' },
    body: { type: String, required: true },
    icon: {
      type: String,
      enum: ['bell', 'academic', 'house', 'alert'],
      default: 'bell'
    },
    target: { type: String, enum: ['all', 'emails'], default: 'all' },
    recipientEmails: [{ type: String, lowercase: true, trim: true }],
    readBy: [{ type: String }],
    data: { type: Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
