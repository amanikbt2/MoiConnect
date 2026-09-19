import mongoose, { Schema, Document } from 'mongoose';

export interface IFavoriteDocument extends Document {
  userId: mongoose.Types.ObjectId;
  targetType: 'paper' | 'house';
  targetId: mongoose.Types.ObjectId;
  createdAt: Date;
}

const favoriteSchema = new Schema<IFavoriteDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetType: { type: String, enum: ['paper', 'house'], required: true },
    targetId: { type: Schema.Types.ObjectId, required: true }
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

favoriteSchema.index({ userId: 1, targetType: 1, targetId: 1 }, { unique: true });

export const Favorite = mongoose.model<IFavoriteDocument>('Favorite', favoriteSchema);
