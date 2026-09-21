import { z } from 'zod';
import {
  registerSchema,
  loginSchema,
  requestLandlordSchema,
  createPaperSchema,
  reviewPaperSchema,
  createHouseSchema,
  updateHouseSchema,
  reviewHouseSchema,
  createBookingSchema,
  updateBookingStatusSchema,
  sendMessageSchema,
  createFavoriteSchema,
  createReportSchema
} from '../schemas';

export type UserRole = 'student' | 'landlord' | 'admin';
export type LandlordStatus = 'none' | 'pending' | 'approved' | 'rejected';
export type AccountStatus = 'active' | 'suspended';

export interface IUser {
  _id: string;
  name: string;
  email: string;
  phone?: string;
  avatarUrl?: string;
  roles: UserRole[];
  activeRole: UserRole;
  landlordStatus: LandlordStatus;
  accountStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export type PaperType = 'past_paper' | 'cat' | 'revision' | 'notes';
export type PaperStatus = 'pending' | 'approved' | 'rejected';

export interface IPaper {
  _id: string;
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
  fileType: string;
  fileSize?: number;
  submittedBy: IUser | string;
  status: PaperStatus;
  rejectionReason?: string;
  reviewedBy?: IUser | string;
  reviewedAt?: string;
  downloads: number;
  createdAt: string;
  updatedAt: string;
}

export type PropertyType = 'bedsetter' | 'single_room' | 'hostel' | 'apartment' | 'other';
export type HouseStatus = 'pending' | 'approved' | 'rejected';
export type OccupancyStatus = 'available' | 'occupied';

export interface IHouse {
  _id: string;
  title: string;
  description: string;
  landlordId: IUser | string;
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
  createdAt: string;
  updatedAt: string;
}

export type BookingStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface IBooking {
  _id: string;
  houseId: IHouse | string;
  studentId: IUser | string;
  landlordId: IUser | string;
  requestedMoveIn: string;
  message?: string;
  status: BookingStatus;
  respondedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IConversation {
  _id: string;
  participants: (IUser | string)[];
  houseId?: IHouse | string;
  lastMessage?: IMessage;
  lastMessageAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface IMessage {
  _id: string;
  conversationId: string;
  senderId: IUser | string;
  type: 'text';
  text: string;
  readBy: string[];
  createdAt: string;
  updatedAt: string;
}

export interface IFavorite {
  _id: string;
  userId: string;
  targetType: 'paper' | 'house';
  targetId: string;
  createdAt: string;
}

export interface IReport {
  _id: string;
  reporterId: IUser | string;
  targetType: 'paper' | 'house';
  targetId: string;
  reason: string;
  details: string;
  status: 'pending' | 'reviewed' | 'dismissed';
  reviewedBy?: IUser | string;
  reviewedAt?: string;
  createdAt: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse {
  user: IUser;
  tokens: AuthTokens;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    pages: number;
  };
}

// Infer Zod types
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type RequestLandlordInput = z.infer<typeof requestLandlordSchema>;
export type CreatePaperInput = z.infer<typeof createPaperSchema>;
export type ReviewPaperInput = z.infer<typeof reviewPaperSchema>;
export type CreateHouseInput = z.infer<typeof createHouseSchema>;
export type UpdateHouseInput = z.infer<typeof updateHouseSchema>;
export type ReviewHouseInput = z.infer<typeof reviewHouseSchema>;
export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type UpdateBookingStatusInput = z.infer<typeof updateBookingStatusSchema>;
export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type CreateFavoriteInput = z.infer<typeof createFavoriteSchema>;
export type CreateReportInput = z.infer<typeof createReportSchema>;
