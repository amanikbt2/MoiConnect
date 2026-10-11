import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISearchReportDocument extends Document {
  userId?: Types.ObjectId;
  name: string;
  email: string;
  query: string;
  source: string;
  found: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}

const searchReportSchema = new Schema<ISearchReportDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
    query: { type: String, required: true, trim: true, maxlength: 240 },
    source: { type: String, required: true, trim: true, maxlength: 40 },
    found: { type: Boolean, default: null }
  },
  { timestamps: true }
);

searchReportSchema.index({ createdAt: -1 });

export const SearchReport = mongoose.model<ISearchReportDocument>('SearchReport', searchReportSchema);
