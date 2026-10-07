import mongoose, { Document, Model, Schema } from 'mongoose';

export const ADMIN2_ROLES = [
  'Material manager',
  'System Analyst',
  'Security supervisor',
  'General administrator',
  'API manager',
  'Payment analyst',
] as const;

export type Admin2Role = typeof ADMIN2_ROLES[number];

export interface IAdmin2Credential extends Document {
  role: Admin2Role;
  adminCode: string;
  email?: string;
  secretHash: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const admin2CredentialSchema = new Schema<IAdmin2Credential>({
  role: { type: String, enum: ADMIN2_ROLES, required: true, trim: true },
  adminCode: { type: String, required: true, trim: true, uppercase: true, minlength: 3, maxlength: 80 },
  email: { type: String, trim: true, lowercase: true, default: '' },
  secretHash: { type: String, required: true, select: false },
  active: { type: Boolean, default: true },
}, { timestamps: true });

admin2CredentialSchema.index({ role: 1, adminCode: 1 }, { unique: true });

export const Admin2Credential: Model<IAdmin2Credential> = mongoose.models.Admin2Credential || mongoose.model<IAdmin2Credential>('Admin2Credential', admin2CredentialSchema);
