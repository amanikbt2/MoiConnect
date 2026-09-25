import { Schema, model, Document, Types } from 'mongoose';

export interface IFileAttachment {
  name: string;
  url: string;
  size: string;
  type: 'pdf' | 'doc' | 'image';
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
  senderId: Types.ObjectId;
  senderName: string;
  senderEmail?: string;
  senderFaculty: string;
  avatarBg: string;
  text: string;
  fileAttachment?: IFileAttachment;
  replyTo?: IReplyTo;
  reactions?: Map<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

const communityMessageSchema = new Schema<ICommunityMessage>(
  {
    clientMsgId: { type: String, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    senderName: { type: String, required: true },
    senderEmail: { type: String, index: true },
    senderFaculty: { type: String, default: 'Moi University Student' },
    avatarBg: { type: String, default: '#15803d' },
    text: { type: String, default: '' },
    fileAttachment: {
      name: { type: String },
      url: { type: String },
      size: { type: String },
      type: { type: String, enum: ['pdf', 'doc', 'image'] }
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
    }
  },
  {
    timestamps: true
  }
);

// High Performance Compound Index for 1ms Delta Sync Queries
communityMessageSchema.index({ createdAt: -1 });

export const CommunityMessage = model<ICommunityMessage>('CommunityMessage', communityMessageSchema);
