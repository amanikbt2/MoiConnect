import mongoose, { Document, Schema } from 'mongoose';

export interface IPopupResponse extends Document {
  popupId: mongoose.Types.ObjectId;
  popupCode: string;
  userId?: mongoose.Types.ObjectId;
  email?: string;
  name?: string;
  responses: Record<string, string | boolean>;
  createdAt: Date;
}

const PopupResponseSchema = new Schema<IPopupResponse>(
  {
    popupId: { type: Schema.Types.ObjectId, ref: 'Popup', required: true },
    popupCode: { type: String, required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, default: '' },
    name: { type: String, default: '' },
    responses: { type: Schema.Types.Mixed, required: true }
  },
  { timestamps: true }
);

PopupResponseSchema.index({ popupId: 1, userId: 1 }, { unique: true, sparse: true });

export const PopupResponse = mongoose.model<IPopupResponse>('PopupResponse', PopupResponseSchema);