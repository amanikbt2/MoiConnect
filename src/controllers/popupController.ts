import { Request, Response } from 'express';
import { Popup } from '../models/Popup';

// Helper to format incrementing popupId e.g. POPUP-0001
const getNextPopupId = async (): Promise<string> => {
  const count = await Popup.countDocuments();
  const nextNum = count + 1;
  return `POPUP-${String(nextNum).padStart(4, '0')}`;
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

    const popupId = await getNextPopupId();

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
    await Popup.findOneAndDelete({ $or: [{ _id: id }, { popupId: id }] });
    res.json({
      success: true,
      message: 'Popup removed successfully'
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete popup' });
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
      if (item.minAppVersion && isVersionLower(version, item.minAppVersion)) {
        res.json({
          hasPopup: true,
          type: 'update',
          popup: item
        });
        return;
      }
    }

    // Check 2: Active Normal Popups
    const now = new Date();
    const normalPopups = await Popup.find({
      type: 'normal',
      $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }]
    }).sort({ createdAt: -1 });

    for (const item of normalPopups) {
      if (dismissedList.includes(item.popupId)) {
        continue;
      }

      // Check audience targeting
      if (item.targetAudience === 'all') {
        res.json({ hasPopup: true, type: 'normal', popup: item });
        return;
      }

      if (item.targetAudience === 'unauthenticated' && !userEmail) {
        res.json({ hasPopup: true, type: 'normal', popup: item });
        return;
      }

      if (
        item.targetAudience === 'emails' &&
        userEmail &&
        item.targetEmails &&
        item.targetEmails.includes(userEmail)
      ) {
        res.json({ hasPopup: true, type: 'normal', popup: item });
        return;
      }
    }

    res.json({ hasPopup: false });
  } catch (error: any) {
    // Zero-lag fallback: return hasPopup false so app continues without error
    res.json({ hasPopup: false });
  }
};
