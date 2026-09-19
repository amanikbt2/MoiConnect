import mongoose, { Schema, Document } from 'mongoose';

export interface IConversationDocument extends Document {
  participants: mongoose.Types.ObjectId[];
  houseId?: mongoose.Types.ObjectId;
  lastMessage?: mongoose.Types.ObjectId;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const conversationSchema = new Schema<IConversationDocument>(
  {
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    houseId: { type: Schema.Types.ObjectId, ref: 'House' },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message' },
    lastMessageAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

conversationSchema.index({ participants: 1 });

export const Conversation = mongoose.model<IConversationDocument>('Conversation', conversationSchema);
