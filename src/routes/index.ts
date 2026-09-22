import { Router } from 'express';
import { authenticate, requireRole, requireLandlordVerified } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import {
  registerSchema,
  loginSchema,
  requestLandlordSchema,
  refreshTokenSchema,
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
} from '@moi/shared';

import * as authController from '../controllers/authController';
import * as paperController from '../controllers/paperController';
import * as houseController from '../controllers/houseController';
import * as bookingController from '../controllers/bookingController';
import * as chatController from '../controllers/chatController';
import * as favoriteController from '../controllers/favoriteController';
import * as reportController from '../controllers/reportController';
import * as adminController from '../controllers/adminController';
import * as dashboardController from '../controllers/dashboardController';
import * as popupController from '../controllers/popupController';
import * as notificationController from '../controllers/notificationController';

const router = Router();

// Web Dashboard API Routes
router.get('/dashboard/overview', dashboardController.getDashboardOverview);
router.post('/dashboard/papers/:id/approve', dashboardController.quickApprovePaper);
router.post('/dashboard/papers/:id/reject', dashboardController.quickRejectPaper);

// Push Notification & Bell Inbox Routes
router.post('/notifications/register-token', notificationController.registerDeviceToken);
router.get('/notifications', notificationController.getNotifications);
router.post('/notifications/:id/read', notificationController.markNotificationRead);
router.post('/admin/push-notify', notificationController.sendAdminPushNotification);
router.get('/admin/push-history', notificationController.getAdminNotificationHistory);

// Notify & Popup API Routes
router.get('/notify/popups', popupController.getAdminPopups);
router.post('/notify/popups', popupController.createPopup);
router.delete('/notify/popups/:id', popupController.deletePopup);
router.post('/notify/check-popup', popupController.checkClientPopup);

// Auth Routes
router.post('/auth/register', validateBody(registerSchema), authController.register);
router.post('/auth/login', validateBody(loginSchema), authController.login);
router.post('/auth/google', authController.googleAuth);
router.post('/auth/refresh', validateBody(refreshTokenSchema), authController.refresh);
router.post('/auth/logout', authenticate, authController.logout);
router.get('/auth/me', authenticate, authController.me);
router.post('/auth/request-landlord', authenticate, validateBody(requestLandlordSchema), authController.requestLandlord);
router.delete('/auth/delete-account', authenticate, authController.deleteAccount);

// Academic Resources Routes
router.get('/papers', paperController.getPapers);
router.get('/papers/my-submissions', authenticate, paperController.getMySubmissions);
router.get('/papers/:id', paperController.getPaperById);
router.post('/papers', authenticate, validateBody(createPaperSchema), paperController.createPaper);
router.post('/papers/:id/download', paperController.downloadPaper);

// Rental Marketplace Routes
router.get('/houses', houseController.getHouses);
router.get('/houses/my-listings', authenticate, requireRole('landlord', 'admin'), houseController.getMyListings);
router.get('/houses/:id', houseController.getHouseById);
router.post('/houses', authenticate, requireLandlordVerified, validateBody(createHouseSchema), houseController.createHouse);
router.patch('/houses/:id', authenticate, validateBody(updateHouseSchema), houseController.updateHouse);

// Booking Routes
router.post('/bookings', authenticate, validateBody(createBookingSchema), bookingController.createBooking);
router.get('/bookings', authenticate, bookingController.getBookings);
router.get('/bookings/:id', authenticate, bookingController.getBookingById);
router.patch('/bookings/:id', authenticate, validateBody(updateBookingStatusSchema), bookingController.updateBookingStatus);

// Chat Routes
router.get('/conversations', authenticate, chatController.getConversations);
router.get('/conversations/:id/messages', authenticate, chatController.getMessages);
router.post('/conversations/messages', authenticate, validateBody(sendMessageSchema), chatController.sendMessage);

// Favorite Routes
router.get('/favorites', authenticate, favoriteController.getFavorites);
router.post('/favorites', authenticate, validateBody(createFavoriteSchema), favoriteController.addFavorite);
router.delete('/favorites/:id', authenticate, favoriteController.removeFavorite);

// Report Routes
router.post('/reports', authenticate, validateBody(createReportSchema), reportController.createReport);

// Admin Routes (All protected by requireRole('admin'))
router.use('/admin', authenticate, requireRole('admin'));
router.get('/admin/stats', adminController.getStats);
router.get('/admin/papers', adminController.getAdminPapers);
router.patch('/admin/papers/:id/review', validateBody(reviewPaperSchema), adminController.reviewPaper);
router.get('/admin/houses', adminController.getAdminHouses);
router.patch('/admin/houses/:id/review', validateBody(reviewHouseSchema), adminController.reviewHouse);
router.get('/admin/landlords', adminController.getPendingLandlords);
router.patch('/admin/landlords/:id/verify', adminController.verifyLandlord);
router.get('/admin/reports', adminController.getAdminReports);
router.patch('/admin/reports/:id', adminController.reviewReport);

export default router;
