import mongoose, { Schema, Document } from 'mongoose';
import { PropertyType, HouseStatus, OccupancyStatus } from '@moi/shared';

export interface IHouseDocument extends Document {
  title: string;
  description: string;
  landlordId: mongoose.Types.ObjectId;
  propertyType: PropertyType;
  location: string;
  locationName?: string;
  monthlyRent: number;
  pricePerMonth?: number;
  deposit: number;
  totalRooms?: number;
  availableRooms?: number;
  phoneContact?: string;
  whatsappContact?: string;
  amenities: string[];
  photos: string[];
  availableFrom?: string;
  status: HouseStatus;
  occupancyStatus: OccupancyStatus;
  isVerified?: boolean;
  rejectionReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const houseSchema = new Schema<IHouseDocument>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    landlordId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    propertyType: {
      type: String,
      enum: ['bedsetter', 'single_room', 'hostel', 'apartment', 'other'],
      required: true
    },
    location: { type: String, required: true, trim: true },
    locationName: { type: String, trim: true },
    monthlyRent: { type: Number, required: true, min: 0 },
    pricePerMonth: { type: Number, min: 0 },
    deposit: { type: Number, default: 0, min: 0 },
    totalRooms: { type: Number, default: 10, min: 0 },
    availableRooms: { type: Number, default: 10, min: 0 },
    phoneContact: { type: String, trim: true },
    whatsappContact: { type: String, trim: true },
    amenities: [{ type: String }],
    photos: [{ type: String, required: true }],
    availableFrom: { type: String },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending'
    },
    occupancyStatus: {
      type: String,
      enum: ['available', 'occupied'],
      default: 'available'
    },
    isVerified: { type: Boolean, default: true },
    rejectionReason: { type: String, trim: true }
  },
  { timestamps: true }
);

houseSchema.index({ title: 'text', description: 'text', location: 'text' });
houseSchema.index({ status: 1, occupancyStatus: 1, monthlyRent: 1 });

export const House = mongoose.model<IHouseDocument>('House', houseSchema);
