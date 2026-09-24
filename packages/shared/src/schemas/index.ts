import { z } from 'zod';
import { PAPER_TYPES, PROPERTY_TYPES } from '../constants';

// Auth Schemas
export const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  phone: z.string().optional()
});

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required')
});

export const requestLandlordSchema = z.object({
  idNumber: z.string().min(4, 'ID / Registration number is required'),
  proofDetails: z.string().min(10, 'Provide details about your property ownership or agency')
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required')
});

// Academic Paper Schemas
export const createPaperSchema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  description: z.string().optional(),
  type: z.enum(PAPER_TYPES),
  school: z.string().min(2, 'School is required'),
  department: z.string().min(2, 'Department is required'),
  courseCode: z.string().min(2, 'Course code is required'),
  unitCode: z.string().min(2, 'Unit code is required'),
  unitName: z.string().min(2, 'Unit name is required'),
  academicYear: z.string().optional(),
  semester: z.string().optional(),
  examYear: z.union([z.number(), z.string()]).optional().transform((val) => typeof val === 'string' ? parseInt(val, 10) || 2025 : val),
  fileUrl: z.string().min(1, 'Valid file URL is required'),
  publicId: z.string().optional(),
  tempFilename: z.string().optional(),
  fileType: z.string().default('pdf'),
  fileSize: z.union([z.number(), z.string()]).optional()
});

export const updatePaperSchema = z.object({
  title: z.string().min(2).optional(),
  type: z.enum(PAPER_TYPES).optional(),
  school: z.string().min(2).optional(),
  department: z.string().min(2).optional(),
  courseCode: z.string().min(2).optional(),
  unitCode: z.string().min(2).optional(),
  unitName: z.string().min(2).optional(),
  academicYear: z.string().optional(),
  semester: z.string().optional(),
  examYear: z.union([z.number(), z.string()]).optional().transform((val) => typeof val === 'string' ? parseInt(val, 10) || 2025 : val),
  fileUrl: z.string().optional(),
  publicId: z.string().optional(),
  tempFilename: z.string().optional(),
  fileType: z.string().optional(),
  fileSize: z.union([z.number(), z.string()]).optional()
});

export type UpdatePaperInput = z.infer<typeof updatePaperSchema>;

export const reviewPaperSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().optional()
}).refine(data => data.status !== 'rejected' || (data.rejectionReason && data.rejectionReason.trim().length > 0), {
  message: 'Rejection reason is required when rejecting a submission',
  path: ['rejectionReason']
});

// Rental Listing Schemas
export const createHouseSchema = z.object({
  title: z.string().min(5, 'Title must be at least 5 characters'),
  description: z.string().min(10, 'Description must be at least 10 characters'),
  propertyType: z.enum(PROPERTY_TYPES),
  location: z.string().min(2, 'Location is required'),
  monthlyRent: z.number().int().positive('Monthly rent must be a positive integer (KES)'),
  deposit: z.number().int().nonnegative().optional().default(0),
  amenities: z.array(z.string()).default([]),
  photos: z.array(z.string().url()).min(1, 'At least one photo is required'),
  availableFrom: z.string().optional()
});

export const updateHouseSchema = createHouseSchema.partial().extend({
  occupancyStatus: z.enum(['available', 'occupied']).optional()
});

export const reviewHouseSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionReason: z.string().optional()
});

// Booking Schemas
export const createBookingSchema = z.object({
  houseId: z.string().min(1, 'House ID is required'),
  requestedMoveIn: z.string().min(1, 'Requested move-in date is required'),
  message: z.string().optional()
});

export const updateBookingStatusSchema = z.object({
  status: z.enum(['accepted', 'declined', 'cancelled'])
});

// Chat Schemas
export const sendMessageSchema = z.object({
  conversationId: z.string().optional(),
  recipientId: z.string().optional(),
  houseId: z.string().optional(),
  text: z.string().min(1, 'Message text cannot be empty')
});

// Favorite & Report Schemas
export const createFavoriteSchema = z.object({
  targetType: z.enum(['paper', 'house']),
  targetId: z.string().min(1, 'Target ID is required')
});

export const createReportSchema = z.object({
  targetType: z.enum(['paper', 'house']),
  targetId: z.string().min(1, 'Target ID is required'),
  reason: z.enum(['scam_or_fraud', 'inappropriate_content', 'misleading_information', 'duplicate', 'other']),
  details: z.string().min(5, 'Please provide details for the report')
});
