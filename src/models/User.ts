import mongoose, { Schema, Document } from 'mongoose';
import { UserRole, LandlordStatus, AccountStatus } from '@moi/shared';

export interface IUserDocument extends Document {
  name: string;
  email: string;
  passwordHash: string;
  phone?: string;
  avatarUrl?: string;
  roles: UserRole[];
  activeRole: UserRole;
  landlordStatus: LandlordStatus;
  accountStatus: AccountStatus;
  landlordRequestDetails?: {
    idNumber: string;
    proofDetails: string;
    requestedAt: Date;
  };
  refreshTokens: string[];
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUserDocument>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: { type: String, trim: true },
    avatarUrl: { type: String },
    roles: {
      type: [String],
      enum: ['student', 'landlord', 'admin'],
      default: ['student']
    },
    activeRole: {
      type: String,
      enum: ['student', 'landlord', 'admin'],
      default: 'student'
    },
    landlordStatus: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none'
    },
    accountStatus: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active'
    },
    landlordRequestDetails: {
      idNumber: String,
      proofDetails: String,
      requestedAt: Date
    },
    refreshTokens: [{ type: String }]
  },
  { timestamps: true }
);

userSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    delete ret.passwordHash;
    delete ret.refreshTokens;
    return ret;
  }
});

export const User = mongoose.model<IUserDocument>('User', userSchema);
