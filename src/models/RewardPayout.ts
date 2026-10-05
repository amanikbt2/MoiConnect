import mongoose, { Document, Schema } from 'mongoose';

export type RewardPayoutStatus = 'pending' | 'submitted' | 'success' | 'failed';

export interface IRewardPayoutDocument extends Document {
  userId: mongoose.Types.ObjectId;
  milestonePoints: number;
  amount: number;
  payoutType: 'milestone' | 'manual';
  phone: string;
  status: RewardPayoutStatus;
  originatorConversationId: string;
  conversationId?: string;
  transactionId?: string;
  resultCode?: string;
  resultDescription?: string;
  createdAt: Date;
  updatedAt: Date;
}

const rewardPayoutSchema = new Schema<IRewardPayoutDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    milestonePoints: { type: Number, required: true, min: 1 },
    amount: { type: Number, required: true, min: 1 },
    payoutType: { type: String, enum: ['milestone', 'manual'], default: 'milestone', index: true },
    phone: { type: String, required: true, trim: true },
    status: { type: String, enum: ['pending', 'submitted', 'success', 'failed'], default: 'pending', index: true },
    originatorConversationId: { type: String, required: true, unique: true, index: true },
    conversationId: String,
    transactionId: String,
    resultCode: String,
    resultDescription: String
  },
  { timestamps: true }
);

rewardPayoutSchema.index({ userId: 1, milestonePoints: 1 }, { unique: true });

export const RewardPayout = mongoose.model<IRewardPayoutDocument>('RewardPayout', rewardPayoutSchema);
