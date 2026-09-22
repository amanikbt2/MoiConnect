import mongoose, { Schema, Document } from 'mongoose';

export interface IPopup extends Document {
  popupId: string;
  type: 'normal' | 'update';
  title: string;
  subtitle?: string;
  body?: string;
  imageUrl?: string;
  hasCancelButton: boolean;
  actionTarget?: string;
  actionButtonText?: string;
  targetAudience: 'all' | 'unauthenticated' | 'emails';
  targetEmails?: string[];
  minAppVersion?: string;
  playStoreUrl?: string;
  isForceUpdate?: boolean;
  expiresAt?: Date;
  createdAt: Date;
}

const PopupSchema: Schema = new Schema(
  {
    popupId: { type: String, required: true, unique: true },
    type: { type: String, enum: ['normal', 'update'], default: 'normal', required: true },
    title: { type: String, required: true },
    subtitle: { type: String, default: '' },
    body: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    hasCancelButton: { type: Boolean, default: true },
    actionTarget: { type: String, default: '/community' },
    actionButtonText: { type: String, default: 'Explore' },
    targetAudience: { type: String, enum: ['all', 'unauthenticated', 'emails'], default: 'all' },
    targetEmails: [{ type: String }],
    minAppVersion: { type: String, default: '1.0.0' },
    playStoreUrl: { type: String, default: 'https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect' },
    isForceUpdate: { type: Boolean, default: false },
    expiresAt: { type: Date }
  },
  { timestamps: true }
);

export const Popup = mongoose.model<IPopup>('Popup', PopupSchema);
