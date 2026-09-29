import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { Popup } from '../models/Popup';
import { PopupResponse } from '../models/PopupResponse';
import { uploadTempFileToCloudinary, deleteTempFile } from '../services/tempFileService';

// Helper to format incrementing popupId e.g. POPUP-0001
const getNextPopupId = async (): Promise<string> => {
  const count = await Popup.countDocuments();
  const nextNum = count + 1;
  return `POPUP-${String(nextNum).padStart(4, '0')}`;
};

// 1. Admin: Upload popup banner image to Cloudinary
export const uploadPopupMedia = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Please choose an image file.' });
      return;
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      deleteTempFile(req.file.filename);
      res.status(400).json({ success: false, error: 'Only JPG, PNG, WEBP, and GIF images are supported.' });
      return;
    }

    const upload = await uploadTempFileToCloudinary(req.file.filename, 'moiconnect/notify_media');
    res.status(201).json({
      success: true,
      message: 'Popup image uploaded successfully.',
      data: { imageUrl: upload.secure_url, publicId: upload.public_id }
    });
  } catch (error: any) {
    if (req.file) deleteTempFile(req.file.filename);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload popup image.' });
  }
};
// 1. Admin: Create a new Normal or Update Popup
export const createPopup = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      type = 'normal',
      title,
      subtitle = '',
      body = '',
      imageUrl = '',
      hasCancelButton = true,
      actionTarget = '/community',
      actionButtonText = 'Explore',
      actions = [],
      inputs = [],
      targetAudience = 'all',
      targetEmails = [],
      minAppVersion = '1.0.0',
      playStoreUrl = 'https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect',
      isForceUpdate = false,
      expiresAt
    } = req.body;

    if (!title) {
      res.status(400).json({ success: false, error: 'Title is required for popup.' });
      return;
    }

    const parsedActions = Array.isArray(actions)
      ? actions
          .map((action: any) => ({
            label: String(action?.label || '').trim(),
            target: String(action?.target || '').trim(),
            type: action?.type === 'external' ? 'external' : 'in_app'
          }))
          .filter((action: { label: string; target: string }) => action.label && action.target)
      : [];
    const normalizedActions = parsedActions.length
      ? parsedActions
      : title
        ? [{ label: actionButtonText || 'Explore', target: actionTarget || '/community', type: 'in_app' as const }]
        : [];
    const normalizedInputs = Array.isArray(inputs)
      ? inputs.map((input: any, index: number) => ({
          id: String(input?.id || `field_${index + 1}`).trim(),
          label: String(input?.label || '').trim(),
          type: ['text', 'radio', 'toggle', 'checkbox'].includes(input?.type) ? input.type : 'text',
          required: Boolean(input?.required),
          options: Array.isArray(input?.options) ? input.options.map((option: any) => String(option).trim()).filter(Boolean) : [],
          placeholder: String(input?.placeholder || '').trim()
        })).filter((input: any) => input.id && input.label)
      : [];
    if (type === 'interactive' && normalizedInputs.length === 0) {
      res.status(400).json({ success: false, error: 'Add at least one interactive input.' });
      return;
    }    const popupId = await getNextPopupId();

    let parsedEmails: string[] = [];
    if (Array.isArray(targetEmails)) {
      parsedEmails = targetEmails.map((e: string) => e.trim().toLowerCase()).filter(Boolean);
    } else if (typeof targetEmails === 'string') {
      parsedEmails = (targetEmails as string)
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean);
    }

    const newPopup = await Popup.create({
      popupId,
      type,
      title,
      subtitle,
      body,
      imageUrl,
      hasCancelButton: Boolean(hasCancelButton),
      actionTarget,
      actionButtonText,
      actions: normalizedActions,
      inputs: normalizedInputs,
      targetAudience,
      targetEmails: parsedEmails,
      minAppVersion,
      playStoreUrl,
      isForceUpdate: Boolean(isForceUpdate),
      expiresAt: expiresAt ? new Date(expiresAt) : undefined
    });

    res.status(201).json({
      success: true,
      message: `${type === 'update' ? 'Update' : 'Normal'} popup created successfully`,
      data: newPopup
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to create popup' });
  }
};

// 2. Admin: Get all popup history
export const getAdminPopups = async (_req: Request, res: Response): Promise<void> => {
  try {
    const popups = await Popup.find().sort({ createdAt: -1 });
    res.json({
      success: true,
      data: popups
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch popups' });
  }
};

// 3. Admin: Delete popup
export const deletePopup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const lookup = mongoose.isValidObjectId(id)
      ? { $or: [{ _id: id }, { popupId: id }] }
      : { popupId: id };
    const deleted = await Popup.findOneAndDelete(lookup);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Popup not found.' });
      return;
    }
    await PopupResponse.deleteMany({ popupId: deleted._id });
    res.json({
      success: true,
      message: 'Popup removed successfully. Devices will no longer receive it.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete popup' });
  }
};

export const deleteAllPopups = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await Popup.deleteMany({});
    await PopupResponse.deleteMany({});
    res.json({
      success: true,
      deletedCount: result.deletedCount || 0,
      message: 'All in-app popup history has been deleted.'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete popup history' });
  }
};

// Helper function to compare semver strings e.g. "1.0.4" vs "1.0.6"
const isVersionLower = (currentVer: string, targetVer: string): boolean => {
  const cParts = currentVer.split('.').map((n) => parseInt(n, 10) || 0);
  const tParts = targetVer.split('.').map((n) => parseInt(n, 10) || 0);

  for (let i = 0; i < Math.max(cParts.length, tParts.length); i++) {
    const c = cParts[i] || 0;
    const t = tParts[i] || 0;
    if (c < t) return true;
    if (c > t) return false;
  }
  return false;
};

// 4. Public Client Signal Check (Zero-Lag, Asynchronous, Non-Blocking)
export const checkClientPopup = async (req: Request, res: Response): Promise<void> => {
  try {
    const { version = '1.0.0', email, dismissedIds = [] } = req.body;
    const userEmail = (email || '').trim().toLowerCase();
    const dismissedList: string[] = Array.isArray(dismissedIds) ? dismissedIds : [];

    // Check 1: Update Popups
    const updatePopups = await Popup.find({ type: 'update' }).sort({ createdAt: -1 });
    for (const item of updatePopups) {
      if (dismissedList.includes(item.popupId)) {
        continue;
      }
      if (item.minAppVersion && isVersionLower(version, item.minAppVersion)) {
        res.json({
          success: true,
          data: { hasPopup: true, type: 'update', popup: item }
        });
        return;
      }
    }

    // Check 2: Active Normal Popups
    const now = new Date();
    const normalPopups = await Popup.find({
      type: { $in: ['normal', 'interactive'] },
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }]
    }).sort({ createdAt: -1 });

    for (const item of normalPopups) {
      if (dismissedList.includes(item.popupId)) {
        continue;
      }

      // Check audience targeting
      if (item.targetAudience === 'all') {
        res.json({ success: true, data: { hasPopup: true, type: item.type, popup: item } });
        return;
      }

      if (item.targetAudience === 'unauthenticated' && !userEmail) {
        res.json({ success: true, data: { hasPopup: true, type: item.type, popup: item } });
        return;
      }

      if (
        item.targetAudience === 'emails' &&
        userEmail &&
        item.targetEmails &&
        item.targetEmails.includes(userEmail)
      ) {
        res.json({ success: true, data: { hasPopup: true, type: item.type, popup: item } });
        return;
      }
    }

    res.json({ success: true, data: { hasPopup: false } });
  } catch (error: any) {
    // Zero-lag fallback: return hasPopup false so app continues without error
    res.json({ success: true, data: { hasPopup: false } });
  }
};
export const submitPopupResponse = async (req: any, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { responses } = req.body;
    if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
      res.status(400).json({ success: false, error: 'Responses are required.' });
      return;
    }
    const popupLookup = mongoose.isValidObjectId(id) ? { $or: [{ _id: id }, { popupId: id }] } : { popupId: id };
    const popup = await Popup.findOne({ ...popupLookup, type: 'interactive' });
    if (!popup) {
      res.status(404).json({ success: false, error: 'Interactive popup not found.' });
      return;
    }
    const user = req.user;
    const cleanResponses: Record<string, string | boolean> = {};
    for (const input of popup.inputs || []) {
      const value = responses[input.id];
      if (input.required && (value === undefined || value === null || value === '')) {
        res.status(400).json({ success: false, error: `${input.label} is required.` });
        return;
      }
      if (value !== undefined) {
        cleanResponses[input.id] = input.type === 'toggle' || input.type === 'checkbox' ? Boolean(value) : String(value).trim();
      }
    }
    const existingQuery = user?._id
      ? { popupId: popup._id, userId: user._id }
      : { popupId: popup._id, email: String(req.body.email || '').trim().toLowerCase(), userId: { $exists: false } };
    await PopupResponse.findOneAndUpdate(
      existingQuery,
      { popupId: popup._id, popupCode: popup.popupId, userId: user?._id, email: user?.email || req.body.email || '', name: user?.name || req.body.name || 'Guest', responses: cleanResponses },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, message: 'Response submitted successfully.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to submit response.' });
  }
};

export const getPopupResponses = async (req: Request, res: Response): Promise<void> => {
  try {
    const responseId = req.params.id;
    const popupLookup = mongoose.isValidObjectId(responseId) ? { $or: [{ _id: responseId }, { popupId: responseId }] } : { popupId: responseId };
    const popup = await Popup.findOne(popupLookup).select('_id popupId title type inputs');
    if (!popup) {
      res.status(404).json({ success: false, error: 'Popup not found.' });
      return;
    }
    const responses = await PopupResponse.find({ popupId: popup._id }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: { popup, responses } });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load popup responses.' });
  }
};
