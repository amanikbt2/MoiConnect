import { Router } from 'express';
import { authenticate, optionalAuthenticate, requireRole, requireLandlordVerified } from '../middleware/auth';
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
import * as communityController from '../controllers/communityController';
import * as liveController from '../controllers/liveController';
import { tempUpload } from '../middleware/upload';

const router = Router();

// Community Real-Time Chat API Routes
router.get('/community/messages', communityController.getCommunityMessages);
router.get('/community/mention-users', communityController.getMentionUsers);
router.post('/community/messages', optionalAuthenticate, communityController.postCommunityMessage);
router.post('/community/messages/:id/reaction', optionalAuthenticate, communityController.toggleCommunityReaction);
router.delete('/community/messages/:id', authenticate, communityController.deleteCommunityMessage);
router.post('/community/upload-media', tempUpload.single('file'), communityController.uploadCommunityMedia);
router.get('/community/live/token', optionalAuthenticate, liveController.createCommunityLiveToken);

// App Settings API Routes
router.get('/settings', dashboardController.getAppSettings);
router.get('/dashboard/settings', dashboardController.getAppSettings);
router.post('/dashboard/settings', dashboardController.updateDashboardSettings);
router.get('/dashboard/backup', dashboardController.backupDatabase);
router.post('/dashboard/restore', tempUpload.single('backup'), dashboardController.restoreDatabase);

// Web Dashboard API Routes
router.get('/dashboard/overview', dashboardController.getDashboardOverview);
router.get('/dashboard/user-emails.csv', dashboardController.downloadUserEmailsCsv);
router.get('/dashboard/ai-overages', dashboardController.getAiOverages);
router.delete('/dashboard/ai-overages', dashboardController.clearAiOverages);
router.get('/dashboard/ai-context', dashboardController.getAiContextSettings);
router.put('/dashboard/ai-context', dashboardController.updateAiContextSettings);
router.get('/dashboard/materials', dashboardController.getDashboardMaterials);
router.post('/dashboard/materials/publish', tempUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'ttsFile', maxCount: 1 }]), dashboardController.publishAdminMaterial);
router.patch('/dashboard/materials/visibility', dashboardController.updateDashboardMaterialsVisibility);
router.patch('/dashboard/materials/:id/visibility', dashboardController.updateDashboardMaterialVisibility);
router.delete('/dashboard/materials', dashboardController.deleteDashboardMaterials);
router.get('/dashboard/papers/:id/download-file', dashboardController.downloadPaperFile);
router.post('/dashboard/papers/:id/upload-thumbnail', tempUpload.single('file'), dashboardController.uploadPaperThumbnail);
router.post('/dashboard/papers/:id/approve', tempUpload.single('ttsFile'), dashboardController.quickApprovePaper);
router.post('/dashboard/papers/:id/reject', dashboardController.quickRejectPaper);
router.patch('/dashboard/papers/:id', dashboardController.quickEditPaper);
router.post('/dashboard/papers/:id/smart-edit', tempUpload.fields([{ name: 'file', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }, { name: 'ttsFile', maxCount: 1 }]), dashboardController.smartEditMaterial);
router.post('/dashboard/papers/:id/replace-file', tempUpload.single('file'), dashboardController.quickReplacePaperFile);
router.get('/dashboard/temp-files', dashboardController.getDashboardTempFiles);
router.delete('/dashboard/temp-files/:filename', dashboardController.deleteDashboardTempFile);
router.post('/dashboard/temp-files/delete-batch', dashboardController.deleteDashboardBatchTempFiles);
router.get('/dashboard/community-messages', dashboardController.getDashboardCommunityMessages);
router.delete('/dashboard/community-messages', dashboardController.deleteDashboardCommunityMessages);

// Push Notification & Bell Inbox Routes
router.post('/notifications/register-token', optionalAuthenticate, notificationController.registerDeviceToken);
router.get('/notifications', authenticate, notificationController.getNotifications);
router.post('/notifications/read-all', authenticate, notificationController.markAllNotificationsRead);
router.post('/notifications/:id/read', authenticate, notificationController.markNotificationRead);
router.post('/admin/push-notify', notificationController.sendAdminPushNotification);
router.get('/admin/push-history', notificationController.getAdminNotificationHistory);
router.delete('/admin/push-history', notificationController.deleteAllAdminNotifications);
router.delete('/admin/push-history/:id', notificationController.deleteAdminNotification);
router.get('/admin/registered-devices', notificationController.getRegisteredDeviceCount);

// Notify & Popup API Routes
router.post('/notify/upload-media', tempUpload.single('file'), popupController.uploadPopupMedia);
router.get('/notify/popups', popupController.getAdminPopups);
router.post('/notify/popups', popupController.createPopup);
router.delete('/notify/popups', popupController.deleteAllPopups);
router.delete('/notify/popups/:id', popupController.deletePopup);
router.post('/notify/check-popup', optionalAuthenticate, popupController.checkClientPopup);
router.post('/notify/popups/:id/responses', optionalAuthenticate, popupController.submitPopupResponse);
router.get('/notify/popups/:id/responses', popupController.getPopupResponses);

// Auth Routes
router.post('/auth/register', validateBody(registerSchema), authController.register);
router.post('/auth/login', validateBody(loginSchema), authController.login);
router.post('/auth/google', authController.googleAuth);
router.post('/auth/refresh', validateBody(refreshTokenSchema), authController.refresh);
router.post('/auth/logout', authenticate, authController.logout);
router.get('/auth/me', authenticate, authController.me);
router.patch('/auth/profile', authenticate, authController.updateProfile);
router.post('/auth/request-landlord', authenticate, validateBody(requestLandlordSchema), authController.requestLandlord);
router.delete('/auth/delete-account', authenticate, authController.deleteAccount);

// Academic Resources Routes
router.post('/papers/upload', optionalAuthenticate, tempUpload.single('file'), paperController.uploadPaperFile);
router.get('/papers', paperController.getPapers);
router.get('/papers/my-submissions', authenticate, paperController.getMySubmissions);
router.get('/papers/stream-url', paperController.streamPaperPdfByUrl);
router.get('/papers/:id/view', paperController.viewPaperPdf);
router.get('/papers/:id/view-pdf', paperController.viewPaperPdf);
router.get('/papers/:id', paperController.getPaperById);
router.post('/papers', optionalAuthenticate, validateBody(createPaperSchema), paperController.createPaper);
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
router.patch('/admin/papers/:id', adminController.updateAdminPaper);
router.post('/admin/papers/:id/replace-file', tempUpload.single('file'), adminController.replacePaperFile);
router.get('/admin/temp-files', adminController.getTempFiles);
router.delete('/admin/temp-files/:filename', adminController.deleteSingleTempFile);
router.post('/admin/temp-files/delete-batch', adminController.deleteBatchTempFiles);
router.get('/admin/houses', adminController.getAdminHouses);
router.patch('/admin/houses/:id/review', validateBody(reviewHouseSchema), adminController.reviewHouse);
router.get('/admin/landlords', adminController.getPendingLandlords);
router.patch('/admin/landlords/:id/verify', adminController.verifyLandlord);
router.get('/admin/reports', adminController.getAdminReports);
router.patch('/admin/reports/:id', adminController.reviewReport);
router.delete('/admin/reports/:id/delete-target', adminController.deleteReportedItem);

export default router;
