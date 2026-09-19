import mongoose, { Schema, Document } from 'mongoose';
import { BookingStatus } from '@moi/shared';

export interface IBookingDocument extends Document {
  houseId: mongoose.Types.ObjectId;
  studentId: mongoose.Types.ObjectId;
  landlordId: mongoose.Types.ObjectId;
  requestedMoveIn: string;
  message?: string;
  status: BookingStatus;
  respondedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const bookingSchema = new Schema<IBookingDocument>(
  {
    houseId: { type: Schema.Types.ObjectId, ref: 'House', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    landlordId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedMoveIn: { type: String, required: true },
    message: { type: String, trim: true },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'declined', 'cancelled'],
      default: 'pending'
    },
    respondedAt: { type: Date }
  },
  { timestamps: true }
);

bookingSchema.index({ houseId: 1, studentId: 1, status: 1 });
bookingSchema.index({ studentId: 1, status: 1 });
bookingSchema.index({ landlordId: 1, status: 1 });

export const Booking = mongoose.model<IBookingDocument>('Booking', bookingSchema);
