import mongoose, { Schema, Document } from 'mongoose';
import { UserRole, LandlordStatus, AccountStatus } from '@moi/shared';
import { createReferralCode } from '../utils/referralCode';

export interface IUserDocument extends Document {
  name: string;
  email: string;
  passwordHash: string;
  phone?: string;
  school: string;
  university?: string;
  course: string;
  yearOfStudy: string;
  avatarUrl?: string;
  roles: UserRole[];
  activeRole: UserRole;
  landlordStatus: LandlordStatus;
  accountStatus: AccountStatus;
  points: number;
  referralCode?: string;
  referredBy?: mongoose.Types.ObjectId;
  creditedReferralIds: mongoose.Types.ObjectId[];
  badge?: 'blue' | 'red' | 'green';
  paymentBlacklisted: boolean;
  canGoLive: boolean;
  landlordRequestDetails?: {
    idNumber: string;
    proofDetails: string;
    requestedAt: Date;
  };
  refreshTokens: string[];
  lastOnlineAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUserDocument>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    phone: { type: String, trim: true, default: '' },
    school: { type: String, trim: true, default: 'Unset' },
    university: { type: String, trim: true, default: '' },
    course: { type: String, trim: true, default: 'Unset' },
    yearOfStudy: { type: String, trim: true, default: 'Unset' },
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
    points: {
      type: Number,
      default: 5,
      min: 0
    },
    referralCode: { type: String, uppercase: true, trim: true, unique: true, sparse: true, index: true },
    referredBy: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    creditedReferralIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    badge: {
      type: String,
      enum: ['blue', 'red', 'green']
    },
    paymentBlacklisted: {
      type: Boolean,
      default: false,
      index: true
    },
    canGoLive: {
      type: Boolean,
      default: false,
      index: true
    },
    landlordRequestDetails: {
      idNumber: String,
      proofDetails: String,
      requestedAt: Date
    },
    lastOnlineAt: { type: Date },
    refreshTokens: [{ type: String }]
  },
  { timestamps: true }
);

userSchema.pre('validate', async function () {
  if (this.referralCode) return;

  const UserModel = this.constructor as mongoose.Model<IUserDocument>;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = createReferralCode();
    if (!(await UserModel.exists({ referralCode: candidate }))) {
      this.referralCode = candidate;
      return;
    }
  }
  throw new Error('Could not generate a unique referral code. Please retry.');
});

userSchema.set('toJSON', {
  transform: (_doc, ret: any) => {
    delete ret.passwordHash;
    delete ret.refreshTokens;
    delete ret.referredBy;
    delete ret.creditedReferralIds;
    return ret;
  }
});

export const User = mongoose.model<IUserDocument>('User', userSchema);
