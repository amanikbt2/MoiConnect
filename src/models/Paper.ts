import mongoose, { Schema, Document } from 'mongoose';
import { PaperType, PaperStatus } from '@moi/shared';

export interface IPaperDocument extends Document {
  mtid?: string;
  title: string;
  description?: string;
  type: PaperType;
  school: string;
  department: string;
  courseCode: string;
  unitCode: string;
  unitName: string;
  academicYear?: string;
  semester?: string;
  examYear?: number;
  fileUrl: string;
  publicId?: string;
  tempFilename?: string;
  fileType: string;
  fileSize?: number;
  submittedBy?: mongoose.Types.ObjectId;
  status: PaperStatus;
  rejectionReason?: string;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  downloads: number;
  createdAt: Date;
  updatedAt: Date;
}

const paperSchema = new Schema<IPaperDocument>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    type: {
      type: String,
      enum: ['past_paper', 'cat', 'revision', 'notes', 'solution', 'lecture_notes'],
      required: true
    },
    school: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    courseCode: { type: String, required: true, uppercase: true, trim: true },
    unitCode: { type: String, required: true, uppercase: true, trim: true },
    unitName: { type: String, required: true, trim: true },
    academicYear: { type: String, trim: true },
    semester: { type: String, trim: true },
    examYear: { type: Number },
    fileUrl: { type: String, required: true },
    publicId: { type: String },
    tempFilename: { type: String, trim: true },
    fileType: { type: String, default: 'pdf' },
    fileSize: { type: Number },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: false },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    rejectionReason: { type: String, trim: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    downloads: { type: Number, default: 0 },
    mtid: { type: String, trim: true, index: true }
  },
  { timestamps: true }
);

paperSchema.index({ title: 'text', unitCode: 'text', unitName: 'text', courseCode: 'text' });
paperSchema.index({ status: 1, school: 1, type: 1 });

export const Paper = mongoose.model<IPaperDocument>('Paper', paperSchema);
