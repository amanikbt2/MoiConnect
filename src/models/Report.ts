import mongoose, { Schema, Document } from 'mongoose';

export interface IReportDocument extends Document {
  reporterId: mongoose.Types.ObjectId;
  targetType: 'paper' | 'house';
  targetId: mongoose.Types.ObjectId;
  reason: string;
  details: string;
  status: 'pending' | 'reviewed' | 'dismissed';
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const reportSchema = new Schema<IReportDocument>(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['paper', 'house'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true },
    reason: {
      type: String,
      enum: ['scam_or_fraud', 'inappropriate_content', 'misleading_information', 'duplicate', 'other'],
      required: true
    },
    details: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'dismissed'],
      default: 'pending'
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date }
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, targetType: 1 });

export const Report = mongoose.model<IReportDocument>('Report', reportSchema);
