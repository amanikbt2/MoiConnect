import mongoose, { Schema, Document } from 'mongoose';

export interface IDeviceToken extends Document {
  token: string;
  userId?: mongoose.Types.ObjectId;
  email?: string;
  platform?: 'android' | 'ios' | 'web';
  lastActive: Date;
  createdAt: Date;
  updatedAt: Date;
}

const DeviceTokenSchema = new Schema<IDeviceToken>(
  {
    token: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', index: true, default: null },
    email: { type: String, lowercase: true, trim: true, index: true },
    platform: { type: String, enum: ['android', 'ios', 'web'], default: 'android' },
    lastActive: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export const DeviceToken = mongoose.model<IDeviceToken>('DeviceToken', DeviceTokenSchema);
