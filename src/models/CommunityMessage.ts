import { Schema, model, Document, Types } from 'mongoose';

export interface IFileAttachment {
  name: string;
  url: string;
  publicId?: string;
  size: string;
  type: 'pdf' | 'doc' | 'image' | 'video';
}

export interface IReplyTo {
  id: string;
  senderName: string;
  senderEmail?: string;
  text: string;
  fileAttachment?: IFileAttachment;
}

export interface ICommunityMessage extends Document {
  clientMsgId?: string;
  botReplyFor?: string;
  senderId: Types.ObjectId;
  senderName: string;
  senderEmail?: string;
  senderFaculty: string;
  senderCourse?: string;
  senderYear?: string;
  senderPhone?: string;
  senderAvatarUrl?: string;
  senderBadge?: 'blue' | 'red' | 'green';
  avatarBg: string;
  text: string;
  isPrivate?: boolean;
  recipientId?: Types.ObjectId;
  recipientName?: string;
  stickerId?: string;
  fileAttachment?: IFileAttachment;
  replyTo?: IReplyTo;
  reactions?: Map<string, number>;
  reactionUsers?: Map<string, string[]>;
  readBy?: Types.ObjectId[];
  hiddenForUserIds?: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const communityMessageSchema = new Schema<ICommunityMessage>(
  {
    clientMsgId: { type: String, index: true },
    botReplyFor: { type: String, unique: true, sparse: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    senderName: { type: String, required: true },
    senderEmail: { type: String, index: true },
    senderFaculty: { type: String, default: 'Moi Student' },
    senderCourse: { type: String, trim: true },
    senderYear: { type: String, trim: true },
    senderPhone: { type: String, trim: true },
    senderAvatarUrl: { type: String, trim: true },
    senderBadge: { type: String, enum: ['blue', 'red', 'green'] },
    avatarBg: { type: String, default: '#15803d' },
    text: { type: String, default: '' },
    isPrivate: { type: Boolean, default: false, index: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    recipientName: { type: String, trim: true },
    stickerId: { type: String, trim: true },
    fileAttachment: {
      name: { type: String },
      url: { type: String },
      publicId: { type: String, trim: true },
      size: { type: String },
      type: { type: String, enum: ['pdf', 'doc', 'image', 'video'] }
    },
    replyTo: {
      id: { type: String },
      senderName: { type: String },
      senderEmail: { type: String },
      text: { type: String },
      fileAttachment: Schema.Types.Mixed
    },
    reactions: {
      type: Map,
      of: Number,
      default: {}
    },
    reactionUsers: {
      type: Map,
      of: [String],
      default: {}
    },
    readBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    hiddenForUserIds: [{ type: Schema.Types.ObjectId, ref: 'User', index: true }]
  },
  {
    timestamps: true
  }
);

// High Performance Compound Index for 1ms Delta Sync Queries
communityMessageSchema.index({ updatedAt: -1 });
communityMessageSchema.index({ createdAt: -1 });

export const CommunityMessage = model<ICommunityMessage>('CommunityMessage', communityMessageSchema);
