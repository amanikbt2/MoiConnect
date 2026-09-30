import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { EJSON } from 'bson';
import path from 'path';
import fs from 'fs';
import { User } from '../models/User';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { Report } from '../models/Report';
import { CommunityMessage } from '../models/CommunityMessage';
import { getAppSettingValue, setAppSettingValue } from '../models/AppSetting';
import cloudinary from '../config/cloudinary';
import { getOnlineStats } from '../socket';
import {
  listTempFiles,
  deleteTempFile,
  deleteBatchTempFiles,
  uploadTempFileToCloudinary
} from '../services/tempFileService';
import { dispatchPushNotification } from '../services/pushNotificationService';
import { awardPaperApprovalPoints } from '../services/rewardService';
import { randomDownloadCount, randomRatingScore } from '../utils/materialStats';
import { clearAiTelemetry, getAiPromptSettings, getAiTelemetry, saveAiPromptSettings } from '../services/campusBotService';

// Secret-safe AI pool telemetry for the admin dashboard. API keys themselves are never returned.
export const getAiOverages = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await getAiTelemetry() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load AI telemetry.' });
  }
};

export const clearAiOverages = async (_req: Request, res: Response): Promise<void> => {
  try {
    await clearAiTelemetry();
    res.json({ success: true, message: 'AI overages, counters, cooldowns, and logs cleared.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to clear AI telemetry.' });
  }
};

export const getAiContextSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ success: true, data: await getAiPromptSettings() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to load AI context.' });
  }
};

export const updateAiContextSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const context = typeof body.context === 'string' ? body.context : '';
    const persona = typeof body.persona === 'string' ? body.persona : '';
    const responseRules = typeof body.responseRules === 'string' ? body.responseRules : '';
    const safetyRules = typeof body.safetyRules === 'string' ? body.safetyRules : '';
    if (!context.trim() && !persona.trim() && !responseRules.trim() && !safetyRules.trim()) {
      res.status(400).json({ success: false, error: 'At least one AI instruction is required.' });
      return;
    }
    const saved = await saveAiPromptSettings({ context, persona, responseRules, safetyRules });
    res.json({ success: true, data: saved, message: 'AI instructions saved.' });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to save AI context.' });
  }
};

// 1. JSON API: Get full dashboard data
export const getDashboardOverview = async (_req: Request, res: Response): Promise<void> => {
  try {
    const totalUsers = await User.countDocuments();
    const pendingLandlords = await User.countDocuments({ landlordStatus: 'pending' });
    const pendingPapers = await Paper.countDocuments({ status: 'pending' });
    const approvedPapers = await Paper.countDocuments({ status: 'approved' });
    const rejectedPapers = await Paper.countDocuments({ status: 'rejected' });
    const pendingHouses = await House.countDocuments({ status: 'pending' });
    const approvedHouses = await House.countDocuments({ status: 'approved' });
    const pendingReports = await Report.countDocuments({ status: 'pending' });
    const departmentsList = await Paper.distinct('department');
    const totalDepartments = departmentsList.filter(Boolean).length;

    // Fast zero-polling in-memory online statistics
    const onlineStats = getOnlineStats();

    const pendingPaperList = await Paper.find({ status: 'pending' })
      .populate('submittedBy', 'name email')
      .sort({ createdAt: -1 });

    const approvedPaperList = await Paper.find({ status: 'approved' })
      .populate('submittedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(30);

    const userList = await User.find()
      .select('-passwordHash -refreshTokens')
      .sort({ createdAt: -1 })
      .limit(50);

    const houseList = await House.find()
      .populate('landlordId', 'name email phone')
      .sort({ createdAt: -1 })
      .limit(30);

    const tempFilesSummary = await listTempFiles();
    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);

    res.json({
      success: true,
      stats: {
        totalUsers,
        pendingLandlords,
        pendingPapers,
        approvedPapers,
        rejectedPapers,
        pendingHouses,
        approvedHouses,
        pendingReports,
        totalDepartments,
        showDemoMaterials,
        totalOnline: onlineStats.totalOnline,
        authenticatedOnline: onlineStats.authenticatedCount,
        guestOnline: onlineStats.guestCount,
        onlineUserIds: onlineStats.onlineUserIds,
        totalTempFiles: tempFilesSummary.totalFiles,
        totalTempSizeBytes: tempFilesSummary.totalSizeBytes,
        totalTempSizeFormatted: tempFilesSummary.totalSizeFormatted
      },
      settings: {
        showDemoMaterials
      },
      pendingPapers: pendingPaperList,
      approvedPapers: approvedPaperList,
      users: userList,
      houses: houseList
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch dashboard data' });
  }
};

// 1b. JSON API: Get & Update App Settings
export const getAppSettings = async (_req: Request, res: Response): Promise<void> => {
  try {
    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);
    res.json({
      success: true,
      settings: { showDemoMaterials }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateDashboardSettings = async (req: Request, res: Response): Promise<void> => {
  try {
    const { key, value, showDemoMaterials } = req.body;
    let targetKey = key || 'showDemoMaterials';
    let targetVal = value !== undefined ? value : showDemoMaterials;

    if (typeof targetVal !== 'boolean') {
      res.status(400).json({ success: false, message: 'Setting value must be a boolean.' });
      return;
    }

    const updatedVal = await setAppSettingValue(targetKey, targetVal, (req as any).user?._id);
    const currentShowDemo = await getAppSettingValue('showDemoMaterials', false);

    res.json({
      success: true,
      message: `Demo materials ${currentShowDemo ? 'enabled' : 'disabled'} successfully.`,
      settings: { showDemoMaterials: currentShowDemo }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// Full database backup and restore tools for the admin dashboard.
export const backupDatabase = async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = mongoose.connection.db;
    if (!db) {
      res.status(503).json({ success: false, error: 'Database connection is not ready.' });
      return;
    }

    const collections: Record<string, unknown[]> = {};
    const collectionInfos = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const info of collectionInfos) {
      collections[info.name] = await db.collection(info.name).find({}).toArray();
    }

    const backup = {
      format: 'moiconnect-database-backup',
      version: 1,
      database: db.databaseName,
      exportedAt: new Date().toISOString(),
      collections
    };

    const filename = `moiconnect-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(EJSON.stringify(backup, undefined, 2));
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to create database backup.' });
  }
};

export const restoreDatabase = async (req: Request, res: Response): Promise<void> => {
  const uploadedPath = req.file?.path;
  try {
    if (req.body?.confirmRestore !== 'RESTORE_DATABASE') {
      res.status(400).json({ success: false, error: 'Restore confirmation is required.' });
      return;
    }
    if (!uploadedPath) {
      res.status(400).json({ success: false, error: 'Please select a backup JSON file.' });
      return;
    }

    const db = mongoose.connection.db;
    if (!db) {
      res.status(503).json({ success: false, error: 'Database connection is not ready.' });
      return;
    }

    const parsed = EJSON.parse(fs.readFileSync(uploadedPath, 'utf8')) as any;
    if (parsed?.format !== 'moiconnect-database-backup' || parsed?.version !== 1 || !parsed?.collections || typeof parsed.collections !== 'object') {
      res.status(400).json({ success: false, error: 'Invalid MoiConnect backup file.' });
      return;
    }

    const collectionNames = Object.keys(parsed.collections);
    if (collectionNames.length === 0 || collectionNames.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name) || name.startsWith('system.'))) {
      res.status(400).json({ success: false, error: 'Backup contains invalid collection names.' });
      return;
    }

    const restored: Record<string, number> = {};
        const existingCollections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const existing of existingCollections) {
      if (!collectionNames.includes(existing.name) && !existing.name.startsWith('system.')) {
        await db.collection(existing.name).drop();
      }
    }

    for (const name of collectionNames) {
      const documents = parsed.collections[name];
      if (!Array.isArray(documents)) {
        res.status(400).json({ success: false, error: `Collection "${name}" is not a valid document list.` });
        return;
      }
      const collection = db.collection(name);
      await collection.deleteMany({});
      if (documents.length > 0) {
        await collection.insertMany(documents, { ordered: false });
      }
      restored[name] = documents.length;
    }

    res.json({
      success: true,
      message: `Database restored successfully across ${collectionNames.length} collections.`,
      restored
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to restore database backup.' });
  } finally {
    if (uploadedPath) {
      try { fs.unlinkSync(uploadedPath); } catch { /* temporary file cleanup is best effort */ }
    }
  }
};
// Material management is loaded only when the admin opens the tab.
export const getDashboardMaterials = async (_req: Request, res: Response): Promise<void> => {
  try {
    const materials = await Paper.find()
      .populate('submittedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean();

    res.json({ success: true, count: materials.length, data: materials });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch materials' });
  }
};

const getMaterialIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string' && /^[a-f\d]{24}$/i.test(id));
};

export const updateDashboardMaterialVisibility = async (req: Request, res: Response): Promise<void> => {
  try {
    const isHidden = req.body?.isHidden;
    if (typeof isHidden !== 'boolean') {
      res.status(400).json({ success: false, error: 'isHidden must be a boolean.' });
      return;
    }

    const paper = await Paper.findByIdAndUpdate(req.params.id, { isHidden }, { new: true });
    if (!paper) {
      res.status(404).json({ success: false, error: 'Material not found.' });
      return;
    }

    res.json({ success: true, message: isHidden ? 'Material hidden from students.' : 'Material visible to students.', data: paper });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update material visibility' });
  }
};

export const updateDashboardMaterialsVisibility = async (req: Request, res: Response): Promise<void> => {
  try {
    const ids = getMaterialIds(req.body?.ids);
    const isHidden = req.body?.isHidden;
    if (!ids.length || typeof isHidden !== 'boolean') {
      res.status(400).json({ success: false, error: 'Provide material ids and an isHidden boolean.' });
      return;
    }

    const result = await Paper.updateMany({ _id: { $in: ids } }, { $set: { isHidden } });
    res.json({ success: true, message: `${result.modifiedCount} material(s) updated.`, updatedCount: result.modifiedCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update material visibility' });
  }
};

const getCloudinaryResourceTypes = (fileType?: string, fileUrl?: string): string[] => {
  if (fileType === 'video' || fileUrl?.includes('/video/upload/')) return ['video', 'raw', 'image'];
  if (fileType === 'image' || fileUrl?.includes('/image/upload/')) return ['image', 'raw', 'video'];
  return ['raw', 'image', 'video'];
};

const destroyCloudinaryAsset = async (publicId: string, fileType?: string, fileUrl?: string): Promise<boolean> => {
  if (!publicId) return false;
  for (const resourceType of getCloudinaryResourceTypes(fileType, fileUrl)) {
    try {
      const result = await cloudinary.uploader.destroy(publicId, {
        resource_type: resourceType,
        type: 'upload',
        invalidate: true
      });
      if (result.result === 'ok') return true;
    } catch (error) {
      console.warn(`[Dashboard Materials] Cloudinary ${resourceType} cleanup skipped for ${publicId}:`, error);
    }
  }
  return false;
};

const destroyMaterialCloudinaryAssets = async (paper: any): Promise<number> => {
  const assets = new Map<string, { fileType?: string; fileUrl?: string }>();
  const addAsset = (publicId?: string | null, fileType?: string, fileUrl?: string) => {
    if (publicId) assets.set(publicId, { fileType, fileUrl });
  };

  addAsset(paper.publicId || extractCloudinaryPublicId(paper.fileUrl), paper.fileType, paper.fileUrl);
  addAsset(extractCloudinaryPublicId(paper.thumbnail), 'image', paper.thumbnail);
  for (const attachment of paper.attachments || []) {
    addAsset(attachment.publicId || extractCloudinaryPublicId(attachment.fileUrl), attachment.fileType, attachment.fileUrl);
  }

  let deletedCount = 0;
  for (const [publicId, metadata] of assets) {
    if (await destroyCloudinaryAsset(publicId, metadata.fileType, metadata.fileUrl)) deletedCount += 1;
  }
  return deletedCount;
};

export const deleteDashboardMaterials = async (req: Request, res: Response): Promise<void> => {
  try {
    const ids = getMaterialIds(req.body?.ids);
    if (!ids.length) {
      res.status(400).json({ success: false, error: 'Select at least one material.' });
      return;
    }

    const materials = await Paper.find({ _id: { $in: ids } });
    let cloudinaryDeleted = 0;
    for (const paper of materials) {
      cloudinaryDeleted += await destroyMaterialCloudinaryAssets(paper);
      if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
        deleteTempFile(paper.tempFilename || paper.fileUrl);
      }
      for (const attachment of paper.attachments || []) {
        if (attachment.tempFilename || attachment.fileUrl?.includes('/uploads/temp/')) {
          deleteTempFile(attachment.tempFilename || attachment.fileUrl);
        }
      }
    }

    const deleted = await Paper.deleteMany({ _id: { $in: materials.map(material => material._id) } });
    res.json({
      success: true,
      message: `Permanently deleted ${deleted.deletedCount} material(s) from the database and cleaned Cloudinary assets.`,
      deletedCount: deleted.deletedCount,
      cloudinaryDeleted
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete materials' });
  }
};

const DEFAULT_MATERIAL_THUMBNAILS: Record<string, string> = {
  past_paper: 'https://images.unsplash.com/photo-1434030216411-0b793f4b4173?auto=format&fit=crop&w=800&q=80',
  cat: 'https://images.unsplash.com/photo-1509228468518-180dd4864904?auto=format&fit=crop&w=800&q=80',
  revision: 'https://images.unsplash.com/photo-1456513080510-7bf3a84b82f8?auto=format&fit=crop&w=800&q=80',
  notes: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=800&q=80'
};

export const publishAdminMaterial = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      title,
      type,
      school,
      department,
      courseCode,
      unitCode,
      unitName,
      academicYear,
      semester,
      examYear,
      description
    } = req.body;

    if (!title || !type || !school || !department || !unitCode || !unitName) {
      res.status(400).json({
        success: false,
        error: 'Missing required fields. Title, Type, School, Department, Unit Code, and Unit Name are required.'
      });
      return;
    }

    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
    const documentFile = files?.['file']?.[0] || (req as any).file;
    const thumbnailFile = files?.['thumbnail']?.[0];

    if (!documentFile) {
      res.status(400).json({ success: false, error: 'Please attach a document file (PDF, Word, or Image).' });
      return;
    }

    // 1. Upload main document directly to Cloudinary
    const cloudRes = await uploadTempFileToCloudinary(documentFile.filename, 'MoiConnect/pdf');

    // 2. Upload thumbnail to Cloudinary if provided
    let thumbnailUrl: string | undefined;
    if (thumbnailFile) {
      try {
        const thumbRes = await uploadTempFileToCloudinary(thumbnailFile.filename, 'MoiConnect/thumbnails');
        thumbnailUrl = thumbRes.secure_url;
      } catch (thumbErr) {
        console.warn('[Admin Publish Material] Thumbnail upload warning:', thumbErr);
      }
    }

    if (!thumbnailUrl) {
      thumbnailUrl = DEFAULT_MATERIAL_THUMBNAILS[type] || DEFAULT_MATERIAL_THUMBNAILS['notes'];
    }

    // 3. Detect file type
    const cleanOrig = documentFile.originalname.toLowerCase();
    const ext = path.extname(cleanOrig).replace('.', '');
    let detectedType = 'pdf';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) {
      detectedType = 'image';
    } else if (['doc', 'docx', 'odt'].includes(ext)) {
      detectedType = 'doc';
    } else if (['txt', 'text', 'md', 'csv', 'json'].includes(ext)) {
      detectedType = 'text';
    } else {
      detectedType = ext || 'pdf';
    }

    // 4. Auto-generate MTID (N0001 for notes/revision, C0001 for cat, P0001 for past_paper)
    let prefix = 'N';
    let typesToCount = ['notes', 'revision'];
    if (type === 'cat') {
      prefix = 'C';
      typesToCount = ['cat'];
    } else if (type === 'past_paper') {
      prefix = 'P';
      typesToCount = ['past_paper'];
    }

    const approvedCount = await Paper.countDocuments({
      status: 'approved',
      type: { $in: typesToCount }
    });
    const mtid = `${prefix}${String(approvedCount + 1).padStart(4, '0')}`;

    // 5. Create Paper record in MongoDB directly with approved status
    const newPaper = await Paper.create({
      title: title.trim(),
      description: description ? description.trim() : undefined,
      type,
      school: school.trim(),
      department: department.trim(),
      courseCode: (courseCode || unitCode).trim().toUpperCase(),
      unitCode: unitCode.trim().toUpperCase(),
      unitName: unitName.trim(),
      academicYear: academicYear ? academicYear.trim() : undefined,
      semester: semester ? semester.trim() : undefined,
      examYear: examYear ? parseInt(examYear, 10) : undefined,
      fileUrl: cloudRes.secure_url,
      publicId: cloudRes.public_id,
      thumbnail: thumbnailUrl,
      fileType: detectedType,
      fileSize: documentFile.size,
      status: 'approved',
      isHidden: false,
      downloads: randomDownloadCount(),
      ratingScore: randomRatingScore(),
      mtid,
      reviewedAt: new Date()
    });

    res.status(201).json({
      success: true,
      message: `Material "${newPaper.title}" (${newPaper.unitCode}) published directly to Cloudinary & Database!`,
      data: newPaper
    });
  } catch (error: any) {
    console.error('[Admin Direct Publish Material Error]:', error);
    res.status(500).json({ success: false, error: error.message || 'Failed to publish material' });
  }
};

// Admin: Upload an optional material thumbnail to Cloudinary
export const uploadPaperThumbnail = async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'Please choose a thumbnail image.' });
      return;
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(req.file.mimetype)) {
      deleteTempFile(req.file.filename);
      res.status(400).json({ success: false, error: 'Only JPG, PNG, WEBP, and GIF images are supported.' });
      return;
    }

    const paper = await Paper.findById(req.params.id);
    if (!paper) {
      deleteTempFile(req.file.filename);
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    const upload = await uploadTempFileToCloudinary(req.file.filename, 'MoiConnect/material_thumbnails');
    paper.thumbnail = upload.secure_url;
    await paper.save();
    res.status(201).json({
      success: true,
      message: 'Material thumbnail uploaded successfully.',
      data: { thumbnail: paper.thumbnail, publicId: upload.public_id }
    });
  } catch (error: any) {
    if (req.file) deleteTempFile(req.file.filename);
    res.status(500).json({ success: false, error: error.message || 'Failed to upload thumbnail.' });
  }
};
// 2. Quick Approve Paper Endpoint for Web Dashboard
export const quickApprovePaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = 'approved';
    paper.rejectionReason = undefined;

    // Cloudinary Upload Pipeline: If document is stored in server temp, upload to Cloudinary under MoiConnect/pdf
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      try {
        const fileTarget = paper.tempFilename || paper.fileUrl;
        const uploadResult = await uploadTempFileToCloudinary(fileTarget, 'MoiConnect/pdf');
        paper.fileUrl = uploadResult.secure_url;
        paper.publicId = uploadResult.public_id;
        paper.tempFilename = undefined;
      } catch (cloudErr: any) {
        console.error('[Dashboard Quick Approve] Cloudinary upload notice:', cloudErr);
        // If upload failed because file was 0 bytes or missing, set fallback sample URL so approval completes smoothly
        if (!paper.fileUrl || paper.fileUrl.includes('/uploads/temp/')) {
          paper.fileUrl = 'https://res.cloudinary.com/demo/image/upload/sample.pdf';
        }
        paper.tempFilename = undefined;
      }
    }

    // Cloudinary upload pipeline for attached documents
    if (Array.isArray(paper.attachments)) {
      for (let i = 0; i < paper.attachments.length; i++) {
        const att = paper.attachments[i];
        if (att.tempFilename || att.fileUrl?.includes('/uploads/temp/')) {
          try {
            const fileTarget = att.tempFilename || att.fileUrl;
            const folder = att.fileType === 'image' ? 'MoiConnect/images' : 'MoiConnect/pdf';
            const uploadRes = await uploadTempFileToCloudinary(fileTarget, folder);
            att.fileUrl = uploadRes.secure_url;
            att.publicId = uploadRes.public_id;
            att.tempFilename = undefined;
          } catch (attErr: any) {
            console.error('[Dashboard Quick Approve] Attachment Cloudinary notice:', attErr);
            att.tempFilename = undefined;
          }
        }
      }
    }

    if (!paper.thumbnail) {
      if (paper.fileType === 'image' || paper.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        paper.thumbnail = paper.fileUrl;
      } else if (Array.isArray(paper.attachments)) {
        const imgAtt = paper.attachments.find(att => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
        if (imgAtt && imgAtt.fileUrl) {
          paper.thumbnail = imgAtt.fileUrl;
        }
      }
    }

    if (!paper.mtid) {
      let prefix = 'N';
      let typesToCount = ['notes', 'revision'];
      if (paper.type === 'cat') {
        prefix = 'C';
        typesToCount = ['cat'];
      } else if (paper.type === 'past_paper') {
        prefix = 'P';
        typesToCount = ['past_paper'];
      }

      const approvedCount = await Paper.countDocuments({
        status: 'approved',
        type: { $in: typesToCount }
      });
      paper.mtid = `${prefix}${String(approvedCount + 1).padStart(4, '0')}`;
    }

    paper.reviewedAt = new Date();
    await paper.save();

    const awardedPoints = await awardPaperApprovalPoints(paper);

    // Send in-app and push notification to the student submitter
    if (paper.submittedBy) {
      try {
        const submitter = await User.findById(paper.submittedBy);
        if (submitter && submitter.email) {
          await dispatchPushNotification({
            title: 'Paper Submission Approved 🎉',
            subtitle: 'Resource Published',
            body: `Your paper submission "${paper.title}" (${paper.unitCode}) has been approved and published to MoiConnect! You earned +${awardedPoints} reward points.`,
            icon: 'academic',
            target: 'emails',
            recipientEmails: [submitter.email],
            data: { paperId: paper._id, status: 'approved' }
          });
        }
      } catch (notifErr) {
        console.error('[Dashboard Quick Approve] Notification error:', notifErr);
      }
    }

    res.json({
      success: true,
      message: `Approved "${paper.title}" with MTID ${paper.mtid}.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Approval failed' });
  }
};

// 3. Quick Reject Paper Endpoint for Web Dashboard
export const quickRejectPaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = 'rejected';
    paper.rejectionReason = reason || 'Does not meet document upload guidelines.';

    // Clean up temporary server storage if file was stored locally
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      deleteTempFile(paper.tempFilename || paper.fileUrl);
      paper.tempFilename = undefined;
    }
    if (Array.isArray(paper.attachments)) {
      for (const att of paper.attachments) {
        if (att.tempFilename || att.fileUrl?.includes('/uploads/temp/')) {
          deleteTempFile(att.tempFilename || att.fileUrl);
          att.tempFilename = undefined;
        }
      }
    }

    paper.reviewedAt = new Date();
    await paper.save();

    // Send in-app and push notification to the student submitter with rejection reason
    if (paper.submittedBy) {
      try {
        const submitter = await User.findById(paper.submittedBy);
        if (submitter && submitter.email) {
          await dispatchPushNotification({
            title: 'Paper Submission Update',
            subtitle: 'Submission Rejected',
            body: `Your paper submission "${paper.title}" (${paper.unitCode}) was rejected due to: ${paper.rejectionReason}`,
            icon: 'alert',
            target: 'emails',
            recipientEmails: [submitter.email],
            data: { paperId: paper._id, status: 'rejected', rejectionReason: paper.rejectionReason }
          });
        }
      } catch (notifErr) {
        console.error('[Dashboard Quick Reject] Notification error:', notifErr);
      }
    }

    res.json({
      success: true,
      message: `Rejected "${paper.title}". Rejection reason notification sent to student.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Rejection failed' });
  }
};

// 4. Quick Edit Paper Metadata
export const quickEditPaper = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    if (updates.title !== undefined) paper.title = updates.title;
    if (updates.courseCode !== undefined) paper.courseCode = updates.courseCode.toUpperCase();
    if (updates.unitCode !== undefined) paper.unitCode = updates.unitCode.toUpperCase();
    if (updates.unitName !== undefined) paper.unitName = updates.unitName;
    if (updates.school !== undefined) paper.school = updates.school;
    if (updates.department !== undefined) paper.department = updates.department;
    if (updates.type !== undefined) paper.type = updates.type;
    if (updates.examYear !== undefined) paper.examYear = updates.examYear;
    if (updates.academicYear !== undefined) paper.academicYear = updates.academicYear;
    if (updates.semester !== undefined) paper.semester = updates.semester;
    if (updates.description !== undefined) paper.description = updates.description;

    await paper.save();

    res.json({
      success: true,
      message: `Updated "${paper.title}" metadata successfully.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update paper' });
  }
};

// 5. Quick Replace Paper File with Clean Media
export const quickReplacePaperFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No replacement file provided.' });
      return;
    }

    const paper = await Paper.findById(id);
    if (!paper) {
      deleteTempFile(req.file.filename);
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    // Delete old temp file if it was on server
    if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
      deleteTempFile(paper.tempFilename || paper.fileUrl);
    }

    const host = req.get('host') || 'localhost:5000';
    const protocol = req.protocol || 'http';
    const relativeUrl = `/uploads/temp/${req.file.filename}`;
    const fullUrl = `${protocol}://${host}${relativeUrl}`;
    const cleanOrig = req.file.originalname.toLowerCase();
    const ext = path.extname(cleanOrig).replace('.', '');
    let detectedType = 'pdf';
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) {
      detectedType = 'image';
    } else if (['doc', 'docx', 'dotx', 'odt'].includes(ext)) {
      detectedType = 'doc';
    } else if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].includes(ext)) {
      detectedType = 'text';
    } else if (ext === 'pdf') {
      detectedType = 'pdf';
    } else {
      detectedType = ext || 'pdf';
    }

    paper.tempFilename = req.file.filename;
    paper.fileUrl = fullUrl;
    paper.fileSize = req.file.size;
    paper.fileType = detectedType;

    await paper.save();

    res.json({
      success: true,
      message: `Clean document uploaded! Previous temporary file replaced.`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'File replacement failed' });
  }
};

// Helper to compute mime type and clean extension
const getMimeTypeAndExt = (url: string, fileType?: string) => {
  const clean = (url || '').split('?')[0].toLowerCase();
  const parts = clean.split('.');
  const urlExt = parts.length > 1 ? parts.pop()! : '';

  let ext = 'pdf';
  if (['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'docx', 'doc', 'txt', 'csv'].includes(urlExt)) {
    ext = urlExt === 'jpeg' ? 'jpg' : urlExt;
  } else {
    const t = (fileType || '').toLowerCase();
    if (t === 'image' || t === 'jpeg' || t === 'jpg' || t.includes('image')) ext = 'jpg';
    else if (t === 'png') ext = 'png';
    else if (t === 'webp') ext = 'webp';
    else if (t === 'docx' || t === 'doc' || t.includes('word')) ext = 'docx';
    else if (t === 'txt' || t === 'text') ext = 'txt';
  }

  let mimeType = 'application/pdf';
  if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg';
  else if (ext === 'png') mimeType = 'image/png';
  else if (ext === 'webp') mimeType = 'image/webp';
  else if (ext === 'gif') mimeType = 'image/gif';
  else if (['docx', 'doc'].includes(ext)) mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  else if (['txt', 'csv'].includes(ext)) mimeType = 'text/plain';

  return { ext, mimeType };
};

// Download Paper File with exact headers and extension (.jpg, .pdf, .docx, .png)
export const downloadPaperFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findById(id);
    if (!paper || !paper.fileUrl) {
      res.status(404).send('File not found');
      return;
    }

    const { ext, mimeType } = getMimeTypeAndExt(paper.fileUrl, paper.fileType);
    const cleanTitle = (paper.title || 'academic_file').replace(/[^a-zA-Z0-9_-]/g, '_');
    const unitCode = (paper.unitCode || 'Paper').replace(/[^a-zA-Z0-9_-]/g, '_');
    const downloadFilename = `${unitCode}_${cleanTitle}.${ext}`;

    // Increment downloads count asynchronously
    Paper.findByIdAndUpdate(id, { $inc: { downloads: 1 } }).exec();

    // Check if local temp file exists
    let localPath = '';
    if (paper.tempFilename) {
      localPath = path.join(process.cwd(), 'uploads', 'temp', paper.tempFilename);
    } else if (paper.fileUrl.includes('/uploads/temp/')) {
      const fn = paper.fileUrl.split('/uploads/temp/')[1]?.split('?')[0];
      if (fn) localPath = path.join(process.cwd(), 'uploads', 'temp', fn);
    } else if (paper.fileUrl.startsWith('/uploads/')) {
      localPath = path.join(process.cwd(), paper.fileUrl.startsWith('/') ? paper.fileUrl.slice(1) : paper.fileUrl);
    }

    if (localPath && fs.existsSync(localPath)) {
      res.setHeader('Content-Type', mimeType);
      res.download(localPath, downloadFilename);
      return;
    }

    // Remote URL (Cloudinary or HTTP)
    if (paper.fileUrl.startsWith('http://') || paper.fileUrl.startsWith('https://')) {
      const remoteRes = await fetch(paper.fileUrl);
      if (remoteRes.ok) {
        const remoteBuffer = Buffer.from(await remoteRes.arrayBuffer());
        res.setHeader('Content-Type', remoteRes.headers.get('content-type') || mimeType);
        res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
        res.send(remoteBuffer);
        return;
      }
    }

    res.redirect(paper.fileUrl);
  } catch (error: any) {
    res.status(500).send('Download error: ' + error.message);
  }
};

// Helper to extract Cloudinary Public ID from URL
const extractCloudinaryPublicId = (url: string): string | null => {
  if (!url || !url.includes('res.cloudinary.com')) return null;
  try {
    const parts = url.split('/upload/');
    if (parts.length < 2) return null;
    let pathStr = parts[1];
    if (/^v\d+\//.test(pathStr)) {
      pathStr = pathStr.replace(/^v\d+\//, '');
    }
    const lastDot = pathStr.lastIndexOf('.');
    if (lastDot !== -1) {
      pathStr = pathStr.substring(0, lastDot);
    }
    return decodeURIComponent(pathStr);
  } catch (e) {
    return null;
  }
};

// JSON API: Fetch all community messages for admin management
export const getDashboardCommunityMessages = async (_req: Request, res: Response): Promise<void> => {
  try {
    const messages = await CommunityMessage.find().sort({ createdAt: -1 }).limit(500);
    const mediaCount = messages.filter(m => !!m.fileAttachment?.url).length;

    res.json({
      success: true,
      count: messages.length,
      mediaCount,
      data: messages
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch community messages' });
  }
};

// JSON API: Delete single or batch community messages (wipes MongoDB + Cloudinary media)
export const deleteDashboardCommunityMessages = async (req: Request, res: Response): Promise<void> => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ success: false, error: 'No message IDs provided for deletion.' });
      return;
    }

    const messages = await CommunityMessage.find({ _id: { $in: ids } });
    let deletedMediaCount = 0;

    // Wipe associated media attachments from Cloudinary storage
    for (const msg of messages) {
      if (msg.fileAttachment?.url) {
        const publicId = extractCloudinaryPublicId(msg.fileAttachment.url);
        if (publicId) {
          try {
            await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
            await cloudinary.uploader.destroy(publicId, { resource_type: 'image' });
            await cloudinary.uploader.destroy(publicId, { resource_type: 'video' });
            deletedMediaCount++;
          } catch (cloudErr) {
            console.error(`[Admin Community Delete] Cloudinary destroy failed for ${publicId}:`, cloudErr);
          }
        }
      }
    }

    // Delete from MongoDB database completely with no trace
    await CommunityMessage.deleteMany({ _id: { $in: ids } });

    res.json({
      success: true,
      message: `Successfully deleted ${messages.length} message(s) and wiped ${deletedMediaCount} Cloudinary media file(s) with zero trace!`,
      deletedCount: messages.length,
      deletedMediaCount
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete community messages' });
  }
};

// 6. Get Server Media Temp Files
export const getDashboardTempFiles = async (_req: Request, res: Response): Promise<void> => {
  try {
    const data = await listTempFiles();
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list temp files' });
  }
};

// 7. Delete Single Temp File
export const deleteDashboardTempFile = async (req: Request, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    const deleted = deleteTempFile(filename);
    if (!deleted) {
      res.status(404).json({ success: false, error: `File "${filename}" not found on server.` });
      return;
    }
    res.json({ success: true, message: `File "${filename}" deleted from server temporary storage.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete temp file' });
  }
};

// 8. Delete Batch Temp Files
export const deleteDashboardBatchTempFiles = async (req: Request, res: Response): Promise<void> => {
  try {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      res.status(400).json({ success: false, error: 'No filenames specified for batch cleanup.' });
      return;
    }

    const result = deleteBatchTempFiles(filenames);
    res.json({
      success: true,
      message: `Cleaned ${result.deletedCount} files from server temporary storage.`,
      ...result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to batch delete temp files' });
  }
};

// 9. Render Public Temporary Storage Folder Page (GET /mydomain_admin/temp_files/)
export const renderPublicTempFolder = async (_req: Request, res: Response): Promise<void> => {
  try {
    const tempSummary = await listTempFiles();
    const files = tempSummary.files;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoiConnect • Public Server Temp Storage</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f8fafc; color: #1e293b; min-height: 100vh; display: flex; flex-direction: column; }
    header { background-color: #064e3b; color: #ffffff; padding: 16px 24px; border-bottom: 2px solid #047857; }
    .header-container { max-width: 1200px; margin: 0 auto; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
    .brand-title { font-size: 18px; font-weight: 800; display: flex; align-items: center; gap: 10px; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; }
    .btn-green { background-color: #10b981; color: #ffffff; }
    .btn-green:hover { background-color: #059669; }
    .btn-dark { background-color: #1e293b; color: #ffffff; }
    .btn-dark:hover { background-color: #0f172a; }
    .btn-view { background-color: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .btn-view:hover { background-color: #bae6fd; }
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 24px 16px; flex: 1; }
    .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .stat-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
    .stat-label { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 4px; }
    .stat-val { font-size: 24px; font-weight: 800; color: #15803d; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { background: #f1f5f9; padding: 12px 14px; font-weight: 700; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 12px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
    tr:hover td { background-color: #f8fafc; }
    .tag { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 700; }
    .tag-img { background: #fdf2f8; color: #9d174d; border: 1px solid #fbcfe8; }
    .tag-pdf { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
    .tag-doc { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
    .tag-txt { background: #fef3c7; color: #92400e; border: 1px solid #fde68a; }
    .search-bar { width: 100%; max-width: 320px; padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; }
    #toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; background: #15803d; color: #ffffff; font-weight: 700; font-size: 13px; z-index: 9999; display: none; }
  </style>
</head>
<body>
  <div id="toast"></div>
  <header>
    <div class="header-container">
      <div class="brand-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        <span>MoiConnect Server • Public Temporary Storage</span>
      </div>
      <div style="display: flex; gap: 10px; align-items: center;">
        <a href="/admin" class="btn btn-green">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
          Back to Admin Dashboard
        </a>
        <button onclick="location.reload()" class="btn btn-dark">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Refresh
        </button>
      </div>
    </div>
  </header>

  <main>
    <div class="card">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px;">
        <div>
          <h2 style="font-size: 20px; font-weight: 800; color: #0f172a;">Server Media (Temp) Public Directory</h2>
          <p style="font-size: 12px; color: #64748b; margin-top: 2px;">Assessed URL: <code>/mydomain_admin/temp_files/</code> • Local Directory: <code>backend/uploads/temp/</code></p>
        </div>
        <input type="text" id="file-search" oninput="filterFiles()" class="search-bar" placeholder="Search files by name..." />
      </div>

      <div class="stats-row">
        <div class="stat-box">
          <div class="stat-label">Total Files in Storage</div>
          <div class="stat-val">${tempSummary.totalFiles}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Disk Space</div>
          <div class="stat-val" style="color: #0284c7;">${tempSummary.totalSizeFormatted}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Public Access Mount</div>
          <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #15803d; margin-top: 6px;">/mydomain_admin/temp_files/</div>
        </div>
      </div>

      <div style="overflow-x: auto;">
        <table id="temp-table">
          <thead>
            <tr>
              <th>File Name</th>
              <th>Format</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Public URL</th>
              <th style="text-align: right;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${files.length === 0 ? `<tr><td colspan="6" style="text-align: center; padding: 48px; color: #94a3b8;">No temporary files in storage. Server is completely clean!</td></tr>` : files.map(f => {
              const ext = (path.extname(f.filename) || '').toLowerCase().replace('.', '');
              let tagClass = 'tag-pdf';
              let tagIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
              let tagText = 'PDF';
              if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(ext)) {
                tagClass = 'tag-img';
                tagIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
                tagText = ext.toUpperCase() + ' IMAGE';
              } else if (['docx', 'doc'].includes(ext)) {
                tagClass = 'tag-doc';
                tagIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
                tagText = ext.toUpperCase() + ' WORD';
              } else if (['txt', 'md', 'csv', 'json'].includes(ext)) {
                tagClass = 'tag-txt';
                tagIcon = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;
                tagText = ext.toUpperCase() + ' TEXT';
              }
              const publicUrl = `/mydomain_admin/temp_files/${encodeURIComponent(f.filename)}`;
              const previewUrl = `/admin/preview?url=${encodeURIComponent(publicUrl)}&title=${encodeURIComponent(f.filename)}&type=${encodeURIComponent(ext)}`;

              return `
              <tr class="file-row" data-name="${f.filename.toLowerCase()}">
                <td>
                  <a href="${publicUrl}" target="_blank" style="font-weight: 700; color: #0284c7; text-decoration: none;">
                    ${f.filename}
                  </a>
                </td>
                <td><span class="tag ${tagClass}">${tagIcon} ${tagText}</span></td>
                <td style="font-weight: 600;">${f.sizeFormatted}</td>
                <td style="color: #64748b;">${new Date(f.modifiedAt).toLocaleString()}</td>
                <td>
                  <button onclick="copyUrl('${publicUrl}')" class="btn btn-view" style="font-size: 11px; padding: 4px 8px;">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copy Link
                  </button>
                </td>
                <td style="text-align: right;">
                  <div style="display: inline-flex; gap: 6px;">
                    <a href="${previewUrl}" target="_blank" class="btn btn-view" style="font-size: 11px; padding: 4px 10px;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                      Smart Preview
                    </a>
                    <a href="${publicUrl}" download class="btn btn-dark" style="font-size: 11px; padding: 4px 10px;">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      Download
                    </a>
                  </div>
                </td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </main>

  <script>
    function copyUrl(rel) {
      var full = window.location.origin + rel;
      navigator.clipboard.writeText(full).then(function() {
        showToast('Copied to clipboard: ' + full);
      });
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 3000);
    }

    function filterFiles() {
      var q = document.getElementById('file-search').value.toLowerCase().trim();
      var rows = document.querySelectorAll('.file-row');
      for (var i = 0; i < rows.length; i++) {
        var name = rows[i].getAttribute('data-name') || '';
        rows[i].style.display = (!q || name.indexOf(q) !== -1) ? '' : 'none';
      }
    }
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error: any) {
    res.status(500).send('Error rendering public temp folder: ' + error.message);
  }
};

// 10. Render Smart Document & Media Preview Page (GET /admin/preview) for PDF, Word DOCX/DOC, Images, and Text
export const renderSmartPreviewPage = (req: Request, res: Response): void => {
  const fileUrl = (req.query.url as string) || '';
  const title = (req.query.title as string) || 'Document Preview';
  const rawType = ((req.query.type as string) || '').toLowerCase();

  const cleanUrl = fileUrl.split('?')[0];
  const ext = (path.extname(cleanUrl) || '').toLowerCase().replace('.', '') || rawType;

  let category = 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) {
    category = 'image';
  } else if (['docx', 'doc', 'dotx', 'odt'].includes(ext)) {
    category = 'docx';
  } else if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].includes(ext)) {
    category = 'text';
  } else {
    category = 'pdf';
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} • Smart Preview</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <!-- Mammoth.js for offline Word DOCX document parsing -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #0f172a; color: #f8fafc; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
    
    /* Top Toolbar */
    .toolbar { height: 60px; background-color: #1e293b; border-bottom: 1px solid #334155; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; gap: 12px; z-index: 100; }
    .toolbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .toolbar-title { font-size: 15px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 450px; }
    .badge { font-size: 11px; font-weight: 800; padding: 3px 8px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-image { background: #ec4899; color: #ffffff; }
    .badge-pdf { background: #10b981; color: #ffffff; }
    .badge-docx { background: #0284c7; color: #ffffff; }
    .badge-text { background: #f59e0b; color: #ffffff; }
    
    .toolbar-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border-radius: 8px; font-size: 12px; font-weight: 700; text-decoration: none; cursor: pointer; border: none; transition: all 0.2s; color: #ffffff; }
    .btn-back { background: #334155; }
    .btn-back:hover { background: #475569; }
    .btn-primary { background: #15803d; }
    .btn-primary:hover { background: #16a34a; }
    .btn-sub { background: #0284c7; }
    .btn-sub:hover { background: #0369a1; }
    .btn-tool { background: #334155; padding: 6px 10px; font-size: 12px; border-radius: 6px; color: #ffffff; text-decoration: none; display: inline-flex; align-items: center; gap: 4px; border: none; cursor: pointer; }
    .btn-tool:hover { background: #475569; }
    
    /* Main Preview Container */
    .viewport { flex: 1; position: relative; overflow: auto; display: flex; justify-content: center; align-items: center; background: #0b0f19; }
    
    /* Image Viewer */
    .image-wrapper { position: relative; display: flex; justify-content: center; align-items: center; width: 100%; height: 100%; overflow: auto; padding: 20px; }
    .image-element { max-width: 90%; max-height: 90%; object-fit: contain; transition: transform 0.2s ease; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    .floating-controls { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(8px); padding: 8px 14px; border-radius: 30px; display: flex; gap: 8px; border: 1px solid #475569; z-index: 10; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }

    /* PDF Viewer */
    .pdf-frame { width: 100%; height: 100%; border: none; }

    /* Word DOCX Viewer */
    .docx-viewport { width: 100%; height: 100%; overflow-y: auto; padding: 32px 16px; background: #334155; display: flex; flex-direction: column; align-items: center; }
    .docx-paper { background: #ffffff; color: #1e293b; width: 100%; max-width: 860px; min-height: 800px; padding: 50px 40px; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.25); line-height: 1.7; font-size: 14px; }
    .docx-paper h1, .docx-paper h2, .docx-paper h3 { color: #0f172a; margin-top: 18px; margin-bottom: 8px; }
    .docx-paper p { margin-bottom: 12px; }
    .docx-paper table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 13px; }
    .docx-paper th, .docx-paper td { border: 1px solid #cbd5e1; padding: 8px 12px; }
    .docx-paper th { background: #f8fafc; font-weight: 700; }
    .docx-paper img { max-width: 100%; height: auto; border-radius: 4px; margin: 10px 0; }
    .docx-external-bar { background: #1e293b; padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; width: 100%; max-width: 860px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; border: 1px solid #475569; font-size: 12px; }

    /* Text Viewer */
    .text-viewport { width: 100%; height: 100%; overflow: auto; padding: 30px; background: #0f172a; }
    .text-box { max-width: 960px; margin: 0 auto; background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 24px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.6; color: #e2e8f0; white-space: pre-wrap; word-break: break-word; user-select: text; }

    /* Loader */
    .spinner { border: 4px solid rgba(255, 255, 255, 0.1); width: 44px; height: 44px; border-radius: 50%; border-left-color: #10b981; animation: spin 1s linear infinite; margin-bottom: 14px; }
    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <!-- Top Toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <button onclick="window.history.length > 1 ? window.history.back() : window.close()" class="btn btn-back">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>
        Back
      </button>
      <span class="badge badge-${category}">${category.toUpperCase()} • ${ext.toUpperCase()}</span>
      <span class="toolbar-title" title="${title}">${title}</span>
    </div>

    <div class="toolbar-actions">
      <a href="${fileUrl}" download class="btn btn-primary">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download File
      </a>
      <a href="${fileUrl}" target="_blank" class="btn btn-sub">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        Raw URL
      </a>
    </div>
  </div>

  <!-- Viewport Content -->
  <div class="viewport">
    ${category === 'image' ? `
      <div class="image-wrapper" id="img-container">
        <img id="preview-image" src="${fileUrl}" alt="${title}" class="image-element" />
        <div class="floating-controls">
          <button class="btn btn-tool" onclick="zoomIn()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            Zoom +
          </button>
          <button class="btn btn-tool" onclick="zoomOut()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            Zoom -
          </button>
          <button class="btn btn-tool" onclick="resetZoom()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="2"/></svg>
            100%
          </button>
          <button class="btn btn-tool" onclick="rotateImage()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
            Rotate
          </button>
          <button class="btn btn-tool" onclick="toggleBackground()">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20z"/></svg>
            Backdrop
          </button>
        </div>
      </div>
      <script>
        var currentScale = 1;
        var currentRotation = 0;
        var isLightBg = false;
        var img = document.getElementById('preview-image');
        var container = document.getElementById('img-container');

        function updateTransform() {
          img.style.transform = 'scale(' + currentScale + ') rotate(' + currentRotation + 'deg)';
        }
        function zoomIn() { currentScale = Math.min(currentScale + 0.25, 4); updateTransform(); }
        function zoomOut() { currentScale = Math.max(currentScale - 0.25, 0.25); updateTransform(); }
        function resetZoom() { currentScale = 1; currentRotation = 0; updateTransform(); }
        function rotateImage() { currentRotation = (currentRotation + 90) % 360; updateTransform(); }
        function toggleBackground() {
          isLightBg = !isLightBg;
          container.style.background = isLightBg ? '#ffffff' : '#0b0f19';
        }
      </script>
    ` : category === 'pdf' ? `
      <iframe src="${fileUrl}#toolbar=1" class="pdf-frame"></iframe>
    ` : category === 'docx' ? `
      <div class="docx-viewport">
        <div class="docx-external-bar">
          <span style="color: #94a3b8;">Formatted live with client-side document renderer</span>
          <div style="display: flex; gap: 8px;">
            <a href="https://view.officeapps.live.com/op/view.aspx?src=${encodeURIComponent(fileUrl)}" target="_blank" class="btn btn-tool">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              Office Online
            </a>
            <a href="https://docs.google.com/viewer?url=${encodeURIComponent(fileUrl)}&embedded=true" target="_blank" class="btn btn-tool">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
              Google Docs Viewer
            </a>
          </div>
        </div>
        <div id="docx-loading" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px;">
          <div class="spinner"></div>
          <div style="color: #cbd5e1; font-size: 14px; font-weight: 600;">Parsing Word (.docx) document...</div>
        </div>
        <div id="docx-content" class="docx-paper" style="display: none;"></div>
      </div>
      <script>
        fetch('${fileUrl}')
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.arrayBuffer();
          })
          .then(function(buffer) {
            return mammoth.convertToHtml({ arrayBuffer: buffer });
          })
          .then(function(result) {
            document.getElementById('docx-loading').style.display = 'none';
            var paper = document.getElementById('docx-content');
            paper.innerHTML = result.value || '<p style="color: #94a3b8; font-style: italic;">(Empty or unreadable document body)</p>';
            paper.style.display = 'block';
          })
          .catch(function(err) {
            document.getElementById('docx-loading').innerHTML = '<div style="color: #f87171; text-align: center;"><b>Could not parse document in browser.</b><br><span style="font-size: 12px; color: #94a3b8;">' + err.message + '</span><br><br><a href="${fileUrl}" download class="btn btn-primary">Download Word File</a></div>';
          });
      </script>
    ` : `
      <div class="text-viewport">
        <div id="text-loading" style="text-align: center; padding: 60px;">
          <div class="spinner" style="margin: 0 auto 12px;"></div>
          <div style="color: #94a3b8;">Loading text file content...</div>
        </div>
        <div id="text-wrapper" style="display: none;">
          <div style="max-width: 960px; margin: 0 auto 12px; display: flex; justify-content: flex-end;">
            <button onclick="copyTextContent()" class="btn btn-tool">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Text
            </button>
          </div>
          <pre id="text-content" class="text-box"></pre>
        </div>
      </div>
      <script>
        var rawText = '';
        fetch('${fileUrl}')
          .then(function(res) { return res.text(); })
          .then(function(t) {
            rawText = t;
            document.getElementById('text-loading').style.display = 'none';
            document.getElementById('text-wrapper').style.display = 'block';
            document.getElementById('text-content').textContent = t;
          })
          .catch(function(err) {
            document.getElementById('text-loading').innerHTML = '<div style="color: #f87171;">Failed to load text file: ' + err.message + '</div>';
          });

        function copyTextContent() {
          navigator.clipboard.writeText(rawText).then(function() {
            showToast('Text copied to clipboard!');
          });
        }
      </script>
    `}
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};

// 4. Render HTML Admin Dashboard Page for GET / and GET /admin
export const renderAdminDashboard = async (_req: Request, res: Response): Promise<void> => {
  const initialShowDemo = await getAppSettingValue('showDemoMaterials', false);
  const isCheckedAttr = initialShowDemo ? 'checked' : '';
  const badgeText = initialShowDemo ? 'ENABLED' : 'DISABLED';
  const badgeBg = initialShowDemo ? '#dcfce7' : '#f1f5f9';
  const badgeColor = initialShowDemo ? '#15803d' : '#64748b';
  const sliderBg = initialShowDemo ? '#22c55e' : '#cbd5e1';
  const knobLeft = initialShowDemo ? '29px' : '3px';
  const labelText = initialShowDemo
    ? 'Saved in Database (Showing Demo & Real)'
    : 'Saved in Database (Real Materials Only)';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MoiConnect Admin Control Center</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="shortcut icon" href="/favicon.ico">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; min-height: 100vh; display: flex; flex-direction: column; }
    
    /* Header Banner */
    header { background-color: #064e3b; color: #ffffff; padding: 16px 24px; border-bottom: 2px solid #047857; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }
    .header-container { max-width: 1200px; margin: 0 auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; }
    .brand-box { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 44px; height: 44px; background-color: #047857; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 24px; font-weight: 800; color: #ffffff; border: 1px solid #10b981; }
    .brand-title { font-size: 20px; font-weight: 800; color: #ffffff; display: flex; align-items: center; gap: 8px; }
    .brand-badge { background-color: #059669; color: #ecfdf5; font-size: 11px; padding: 2px 8px; border-radius: 12px; font-weight: 700; border: 1px solid #34d399; }
    .brand-sub { font-size: 12px; color: #a7f3d0; margin-top: 2px; }
    
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .status-pill { display: inline-flex; align-items: center; gap: 6px; background-color: #065f46; color: #a7f3d0; font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; border: 1px solid #047857; }
    .status-dot { width: 8px; height: 8px; background-color: #34d399; border-radius: 50%; }
    .btn-refresh { background-color: #047857; color: #ffffff; font-size: 12px; font-weight: 700; padding: 8px 16px; border-radius: 8px; border: none; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    .btn-refresh:hover { background-color: #059669; }

    /* Main Container */
    main { max-width: 1200px; width: 100%; margin: 0 auto; padding: 24px 16px; flex: 1; }

    /* Tabs Bar */
    .tab-bar { display: flex; flex-wrap: wrap; gap: 8px; background-color: #e2e8f0; padding: 6px; border-radius: 14px; margin-bottom: 24px; border: 1px solid #cbd5e1; }
    .tab-btn { padding: 10px 18px; border-radius: 10px; font-size: 14px; font-weight: 700; color: #475569; border: none; background: transparent; cursor: pointer; transition: all 0.2s; display: flex; align-items: center; gap: 8px; }
    .tab-btn:hover { background-color: #cbd5e1; color: #0f172a; }
    .tab-btn.active { background-color: #15803d; color: #ffffff; box-shadow: 0 4px 12px rgba(21, 128, 61, 0.25); }
    .tab-badge { background-color: #f59e0b; color: #ffffff; font-size: 11px; padding: 2px 7px; border-radius: 10px; font-weight: 800; }

    /* SVG Icon Helpers */
    .svg-icon { display: inline-flex; align-items: center; justify-content: center; }

    /* Cards & Sections */
    .card { background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .card-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid #f1f5f9; }
    .card-title { font-size: 18px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 8px; }
    .card-sub { font-size: 12px; color: #64748b; margin-top: 2px; }

    /* Stats Grid */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background-color: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
    .stat-label { font-size: 11px; font-weight: 800; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; display: flex; items-center; justify-content: space-between; }
    .stat-val { font-size: 28px; font-weight: 800; color: #15803d; }
    .stat-sub { font-size: 11px; color: #94a3b8; margin-top: 4px; }

    /* Item Cards (Pending Materials) */
    .item-list { display: flex; flex-direction: column; gap: 12px; }
    .item-card { background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; transition: all 0.2s; }
    .item-card:hover { border-color: #cbd5e1; background-color: #f1f5f9; }
    .badge-tag { display: inline-block; font-size: 10px; font-weight: 800; text-transform: uppercase; padding: 3px 8px; border-radius: 6px; background-color: #dcfce7; color: #166534; border: 1px solid #bbf7d0; margin-right: 6px; }
    .mtid-tag { font-family: monospace; font-size: 11px; font-weight: 700; background-color: #0f172a; color: #ffffff; padding: 2px 6px; border-radius: 4px; margin-right: 6px; }
    .item-title { font-size: 15px; font-weight: 800; color: #0f172a; margin: 4px 0; }
    .item-meta { font-size: 12px; color: #475569; }
    .item-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }

    .materials-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; margin-bottom: 18px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; }
    .materials-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
    .material-card { position: relative; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; box-shadow: 0 3px 10px rgba(15,23,42,0.04); transition: transform .2s, box-shadow .2s; }
    .material-card:hover { transform: translateY(-2px); box-shadow: 0 8px 18px rgba(15,23,42,0.08); }
    .material-card.hidden-material { border-color: #f59e0b; background: #fffbeb; }
    .material-cover { height: 84px; display: flex; align-items: center; justify-content: space-between; padding: 16px; background: linear-gradient(135deg, #064e3b, #15803d); color: #ffffff; }
    .material-cover.pdf { background: linear-gradient(135deg, #1e293b, #475569); }
    .material-cover-icon { font-size: 28px; font-weight: 900; opacity: .9; }
    .material-check { width: 18px; height: 18px; accent-color: #15803d; cursor: pointer; }
    .material-body { padding: 14px; }
    .material-title { font-size: 15px; font-weight: 800; color: #0f172a; min-height: 38px; margin-bottom: 8px; }
    .material-meta { color: #64748b; font-size: 11px; line-height: 1.6; }
    .material-status { display: inline-flex; align-items: center; gap: 4px; margin-top: 10px; font-size: 10px; font-weight: 800; text-transform: uppercase; padding: 3px 7px; border-radius: 6px; background: #dcfce7; color: #166534; }
    .material-status.hidden-status { background: #fef3c7; color: #92400e; }
    .material-actions { display: flex; gap: 8px; padding: 0 14px 14px; }
    .material-actions .btn { flex: 1; padding: 7px 8px; font-size: 11px; }
    .fetch-start-card { text-align: center; padding: 48px 24px; border: 2px dashed #cbd5e1; border-radius: 14px; background: linear-gradient(180deg, #f8fafc, #ffffff); }
    .fetch-start-icon { width: 54px; height: 54px; margin: 0 auto 14px; display: flex; align-items: center; justify-content: center; border-radius: 16px; background: #dcfce7; color: #15803d; font-size: 26px; }    /* Action Buttons */
    .btn-group { display: flex; align-items: center; gap: 8px; }
    .btn { padding: 8px 14px; border-radius: 8px; font-size: 12px; font-weight: 800; border: none; cursor: pointer; text-decoration: none; transition: all 0.2s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
    .btn-view { background-color: #ffffff; color: #334155; border: 1px solid #cbd5e1; }
    .btn-view:hover { background-color: #e2e8f0; }
    .btn-approve { background-color: #15803d; color: #ffffff; box-shadow: 0 2px 4px rgba(21, 128, 61, 0.2); }
    .btn-approve:hover { background-color: #166534; }
    .btn-reject { background-color: #dc2626; color: #ffffff; box-shadow: 0 2px 4px rgba(220, 38, 38, 0.2); }
    .btn-reject:hover { background-color: #b91c1c; }

    /* Search input with icon */
    .search-input-wrapper { position: relative; display: flex; align-items: center; }
    .search-input-icon { position: absolute; left: 10px; color: #94a3b8; pointer-events: none; }
    .search-input { padding-left: 32px !important; }

    /* Table */
    .table-responsive { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th { background-color: #f8fafc; color: #64748b; font-size: 11px; font-weight: 800; text-transform: uppercase; padding: 12px 16px; border-bottom: 2px solid #e2e8f0; }
    td { padding: 12px 16px; border-bottom: 1px solid #f1f5f9; color: #334155; }
    tr:hover td { background-color: #f8fafc; }

    /* Toast Notification */
    #toast { margin-bottom: 16px; padding: 14px 18px; border-radius: 12px; font-size: 14px; font-weight: 700; display: none; }
    #toast.success { background-color: #dcfce7; color: #14532d; border: 1px solid #bbf7d0; display: block; }
    #toast.error { background-color: #fee2e2; color: #991b1b; border: 1px solid #fecaca; display: block; }

    /* Modal Backdrop & Modern Approval Dialog */
    .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(15, 23, 42, 0.7); backdrop-filter: blur(4px); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 16px; }
    .modal-content { background-color: #ffffff; border-radius: 18px; width: 100%; max-width: 680px; max-height: 92vh; overflow-y: auto; padding: 24px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); border: 1px solid #e2e8f0; }
    
    /* Tiny List Row for Pending Approvals */
    .tiny-paper-row { background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px 14px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; transition: all 0.15s ease-in-out; }
    .tiny-paper-row:hover { background-color: #f8fafc; border-color: #10b981; box-shadow: 0 2px 6px rgba(0,0,0,0.04); transform: translateY(-1px); }
    .size-pill { font-size: 11px; font-weight: 700; color: #475569; background-color: #f1f5f9; padding: 2px 8px; border-radius: 6px; border: 1px solid #e2e8f0; white-space: nowrap; }
    .btn-tiny { padding: 5px 12px; font-size: 11px; font-weight: 800; border-radius: 6px; border: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }

    /* Media Choice Radio Cards */
    .choice-radio-card { display: block; padding: 12px; background: #ffffff; border: 2px solid #e2e8f0; border-radius: 10px; cursor: pointer; transition: all 0.2s; user-select: none; }
    .choice-radio-card:hover { border-color: #cbd5e1; background: #f8fafc; }
    .choice-radio-card.active { border-color: #15803d; background: #f0fdf4; box-shadow: 0 2px 6px rgba(21, 128, 61, 0.1); }
    .choice-radio-card.active.upload-active { border-color: #d97706; background: #fffbeb; box-shadow: 0 2px 6px rgba(217, 119, 6, 0.1); }

    /* Utilities */
    .hidden { display: none !important; }
    .flex-1 { flex: 1; }
    .form-control { padding: 8px 12px; border-radius: 8px; border: 1px solid #cbd5e1; font-size: 13px; outline: none; }
    .form-control:focus { border-color: #15803d; }
    
    footer { background-color: #ffffff; border-top: 1px solid #e2e8f0; padding: 16px; text-align: center; font-size: 12px; color: #64748b; margin-top: auto; }
  </style>
</head>
<body>

  <!-- Header Banner -->
  <header>
    <div class="header-container">
      <div class="brand-box">
        <div class="brand-logo" style="background: transparent; border: none; padding: 0;">
          <img src="/favicon.png" alt="MC Logo" style="width: 44px; height: 44px; border-radius: 10px; object-fit: cover;" />
        </div>
        <div>
          <div class="brand-title">
            MoiConnect <span class="brand-badge">Admin Hub</span>
          </div>
          <div class="brand-sub">Official Control Panel for Revision Materials, Users & Hostels</div>
        </div>
      </div>
      <div class="header-actions">
        <div class="status-pill">
          <div class="status-dot"></div>
          Backend API Live (Port 5000)
        </div>
        <button onclick="loadDashboardData()" class="btn-refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          Refresh
        </button>
      </div>
    </div>
  </header>

  <!-- Main Content -->
  <main>

    <!-- Top Navigation Tabs -->
    <div class="tab-bar">
      <button id="tab-btn-pending" onclick="switchTab('pending')" class="tab-btn active">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
        Pending Approvals
        <span id="badge-pending-count" class="tab-badge hidden">0</span>
      </button>

      <button id="tab-btn-materials" onclick="switchTab('materials')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        Manage Materials
      </button>

      <button id="tab-btn-publish" onclick="switchTab('publish')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        Upload Admin Materials
      </button>
      <button id="tab-btn-temp" onclick="switchTab('temp')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        Server Media (Temp)
        <span id="badge-temp-count" class="tab-badge hidden">0</span>
      </button>

      <button id="tab-btn-community" onclick="switchTab('community')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Community Chat
        <span id="badge-community-count" class="tab-badge hidden">0</span>
      </button>

      <button id="tab-btn-stats" onclick="switchTab('stats')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
        Stats & Registered Users
      </button>

      <button id="tab-btn-houses" onclick="switchTab('houses')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 10h6"/><path d="M9 14h6"/></svg>
        Rental Hostels
      </button>

      <button id="tab-btn-system" onclick="switchTab('system')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        System Health & API
      </button>

      <button id="tab-btn-push" onclick="switchTab('push')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        Notify (In-App & Push)
      </button>

      <button id="tab-btn-ai-overages" onclick="switchTab('ai-overages')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/><path d="M8 8h8v8H8z"/></svg>
        AI Overages
      </button>

      <button id="tab-btn-settings" onclick="switchTab('settings')" class="tab-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        App Settings
      </button>
    </div>

    <!-- Notification Toast -->
    <div id="toast"></div>

    <!-- TAB 1: PENDING APPROVALS -->
    <section id="tab-content-pending" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              Revision Materials Approval Panel
            </h2>
            <p class="card-sub">Simple compact view. Click any material to inspect, download, edit, replace file, and approve directly to Cloudinary.</p>
          </div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div class="search-input-wrapper">
              <svg class="search-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" id="paper-search-input" oninput="filterPapersList()" placeholder="Filter by title, code or school..." class="form-control search-input" style="width: 220px;" />
            </div>
            <select id="paper-filter" onchange="loadDashboardData()" class="form-control" style="font-weight: 700;">
              <option value="pending">Pending Only</option>
              <option value="approved">Approved Materials</option>
            </select>
          </div>
        </div>

        <div id="pending-papers-container" style="display: flex; flex-direction: column; gap: 8px;">
          <div style="text-align: center; padding: 48px; color: #94a3b8; font-size: 14px;">Loading revision materials...</div>
        </div>
      </div>
    </section>

    <!-- TAB: MANAGE MATERIALS -->
    <section id="tab-content-materials" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
              Manage Materials
            </h2>
            <p class="card-sub">Fetch the catalogue only when needed. Hide materials from students or permanently remove their database and Cloudinary records.</p>
          </div>
          <button onclick="fetchMaterialsForManagement()" class="btn btn-view">↻ Refresh Materials</button>
        </div>
        <div id="materials-management-container">
          <div class="fetch-start-card">
            <div class="fetch-start-icon">↻</div>
            <h3 style="font-size: 18px; color: #0f172a; margin-bottom: 6px;">Start fetch</h3>
            <p style="font-size: 13px; color: #64748b; max-width: 460px; margin: 0 auto 18px;">Materials are not loaded while the dashboard opens. Fetch the catalogue when you are ready to manage it.</p>
            <button onclick="fetchMaterialsForManagement()" class="btn btn-approve">Fetch available materials</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB: UPLOAD ADMIN MATERIALS (DIRECT PUBLISH) -->
    <section id="tab-content-publish" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Upload & Publish Admin Materials
            </h2>
            <p class="card-sub">Direct Admin Publisher. Upload academic revision papers, CATs, and modules straight to Cloudinary & Database with instant approval.</p>
          </div>
          <span class="brand-badge" style="font-size: 12px; padding: 4px 10px;">Direct Cloudinary + DB</span>
        </div>

        <form id="admin-publish-form" onsubmit="publishAdminMaterialDirect(event)" style="display: flex; flex-direction: column; gap: 20px;">
          
          <!-- Grid section for form fields -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
            
            <!-- Title -->
            <div style="grid-column: 1 / -1;">
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Material Title <span style="color: #dc2626;">*</span></label>
              <input type="text" id="pub-title" name="title" class="form-control" style="width: 100%; font-size: 14px; padding: 10px 14px;" placeholder="e.g., COM 310 Data Structures & Algorithms Complete Revision Pack" required />
            </div>

            <!-- Material Type -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Material Category / Type <span style="color: #dc2626;">*</span></label>
              <select id="pub-type" name="type" class="form-control" style="width: 100%; font-size: 14px; padding: 10px 14px; font-weight: 600;" required>
                <option value="past_paper">📄 Past Paper</option>
                <option value="cat">📝 Continuous Assessment Test (CAT)</option>
                <option value="revision">📚 Revision Pack / Exam Prep</option>
                <option value="notes">📖 Lecture Notes / Summary</option>
                <option value="solution">✅ Marking Scheme / Solution</option>
                <option value="lecture_notes">🎓 Module / Course Material</option>
              </select>
            </div>

            <!-- School / Faculty -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">School / Faculty <span style="color: #dc2626;">*</span></label>
              <select id="pub-school-select" name="school" onchange="handleSchoolSelectChange(this)" class="form-control" style="width: 100%; font-size: 14px; padding: 10px 14px;" required>
                <option value="School of Information Sciences">School of Information Sciences</option>
                <option value="School of Science & Aerospace Studies">School of Science & Aerospace Studies</option>
                <option value="School of Business & Economics">School of Business & Economics</option>
                <option value="School of Engineering">School of Engineering</option>
                <option value="School of Education">School of Education</option>
                <option value="School of Law">School of Law</option>
                <option value="School of Medicine">School of Medicine</option>
                <option value="School of Arts & Social Sciences">School of Arts & Social Sciences</option>
                <option value="School of Nursing">School of Nursing</option>
                <option value="School of Public Health">School of Public Health</option>
                <option value="School of Agriculture & Natural Resources">School of Agriculture & Natural Resources</option>
                <option value="custom">✍️ Other / Custom School...</option>
              </select>
              <input type="text" id="pub-school-custom" class="form-control hidden" placeholder="Enter custom school name..." style="width: 100%; margin-top: 8px;" />
            </div>

            <!-- Department -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Department <span style="color: #dc2626;">*</span></label>
              <input type="text" id="pub-department" name="department" class="form-control" style="width: 100%;" placeholder="e.g., Computer Science, IT, Mathematics" required />
            </div>
<!-- Unit Code -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Unit Code <span style="color: #dc2626;">*</span></label>
              <input type="text" id="pub-unitCode" name="unitCode" class="form-control" style="width: 100%; text-transform: uppercase;" placeholder="e.g., COM 310" required />
            </div>

            <!-- Unit Name -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Unit Name <span style="color: #dc2626;">*</span></label>
              <input type="text" id="pub-unitName" name="unitName" class="form-control" style="width: 100%;" placeholder="e.g., Data Structures & Algorithms" required />
            </div>

            <!-- Academic Year -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Academic Level / Year</label>
              <input type="text" id="pub-academicYear" name="academicYear" class="form-control" style="width: 100%;" placeholder="e.g., Year 3 or 2024/2025" />
            </div>

            <!-- Semester -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Semester</label>
              <select id="pub-semester" name="semester" class="form-control" style="width: 100%;">
                <option value="">Select Semester (Optional)</option>
                <option value="Semester 1">Semester 1</option>
                <option value="Semester 2">Semester 2</option>
                <option value="Trimester 1">Trimester 1</option>
                <option value="Trimester 2">Trimester 2</option>
              </select>
            </div>

            <!-- Exam / Resource Year -->
            <div>
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Exam / Resource Year</label>
              <input type="number" id="pub-examYear" name="examYear" class="form-control" style="width: 100%;" placeholder="e.g., 2024" value="2024" />
            </div>

            <!-- Description -->
            <div style="grid-column: 1 / -1;">
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Description / Overview (Optional)</label>
              <textarea id="pub-description" name="description" class="form-control" style="width: 100%; font-family: inherit;" rows="3" placeholder="Provide topic outlines, lecturer notes, or extra instructions for students..."></textarea>
            </div>

            <!-- Main File Upload Dropzone -->
            <div style="grid-column: 1 / -1;">
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Main Document File <span style="color: #dc2626;">*</span></label>
              <div id="pub-file-dropzone" style="border: 2px dashed #cbd5e1; background-color: #f8fafc; border-radius: 14px; padding: 24px; text-align: center; cursor: pointer; transition: all 0.2s;" onclick="document.getElementById('pub-file-input').click()">
                <input type="file" id="pub-file-input" name="file" onchange="handleAdminPubFileSelect(this)" accept=".pdf,.doc,.docx,.png,.jpg,.jpeg,.webp,.txt" style="display: none;" required />
                <div style="width: 48px; height: 48px; border-radius: 50%; background-color: #dcfce7; color: #15803d; display: flex; align-items: center; justify-content: center; margin: 0 auto 12px;">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                </div>
                <div id="pub-file-label" style="font-size: 15px; font-weight: 800; color: #0f172a;">Click to select or drop document file</div>
                <div id="pub-file-sub" style="font-size: 12px; color: #64748b; margin-top: 4px;">Supports PDF, Word (.doc/.docx), Images (.png/.jpg), Text files up to 50MB</div>
              </div>
            </div>

            <!-- Thumbnail Upload (Optional) -->
            <div style="grid-column: 1 / -1;">
              <label style="display: block; font-size: 13px; font-weight: 700; color: #334155; margin-bottom: 6px;">Custom Cover Thumbnail (Optional)</label>
              <input type="file" id="pub-thumbnail-input" name="thumbnail" accept="image/*" class="form-control" style="width: 100%;" />
              <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">If omitted, a high-quality default thumbnail based on material type will be automatically assigned.</div>
            </div>

          </div>

          <!-- Progress / Upload Message -->
          <div id="pub-status-box" class="hidden" style="padding: 14px 18px; border-radius: 12px; font-size: 14px; font-weight: 700;"></div>

          <!-- Buttons -->
          <div style="display: flex; gap: 12px; align-items: center; margin-top: 8px;">
            <button type="submit" id="btn-pub-submit" class="btn btn-approve" style="padding: 12px 24px; font-size: 14px; gap: 8px;">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Publish Material Now (Cloudinary + DB)
            </button>
            <button type="button" id="btn-pub-clear" onclick="resetAdminPublishForm()" class="btn btn-view" style="padding: 12px 18px; font-size: 14px;">Clear Form</button>
          </div>
        </form>
      </div>
    </section>

    <!-- TAB: SERVER MEDIA (TEMP) -->
    <section id="tab-content-temp" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
              Server Media Temporary Storage
            </h2>
            <p class="card-sub">Files uploaded by students and stored in <code>backend/uploads/temp/</code> waiting for approval or rejection.</p>
          </div>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button onclick="loadTempFiles()" class="btn btn-view">
              🔄 Refresh Storage
            </button>
            <button onclick="deleteSelectedTempFiles()" class="btn btn-reject">
              🗑️ Delete Selected
            </button>
          </div>
        </div>

        <!-- Temp KPI Cards -->
        <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 20px;">
          <div class="stat-card">
            <div class="stat-label">Pending Temp Files</div>
            <div id="temp-stat-count" class="stat-val">0</div>
            <div class="stat-sub">Stored locally in uploads/temp</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Total Disk Space</div>
            <div id="temp-stat-size" class="stat-val" style="color: #0284c7;">0 Bytes</div>
            <div class="stat-sub">Clean anytime to free up server space</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Server Folder Path</div>
            <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #15803d; margin-top: 6px;">backend/uploads/temp</div>
            <div class="stat-sub">Served at /uploads/temp/*</div>
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 36px;"><input type="checkbox" id="temp-select-all" onchange="toggleSelectAllTemp(this)" /></th>
                <th>File Name</th>
                <th>Size</th>
                <th>Uploaded</th>
                <th>Linked Material Status</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody id="temp-files-table-body">
              <tr><td colspan="6" style="text-align: center; padding: 32px; color: #94a3b8;">Loading temporary server files...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB: COMMUNITY CHAT MESSAGES -->
    <section id="tab-content-community" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Community Chat Messages Management
            </h2>
            <p class="card-sub">Inspect all community chat messages, search, and completely wipe unwanted messages and Cloudinary media attachments with zero trace.</p>
          </div>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <div class="search-input-wrapper">
              <svg class="search-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input type="text" id="community-search-input" oninput="filterCommunityMessages()" placeholder="Search sender, message, media..." class="form-control search-input" style="width: 220px;" />
            </div>
            <button onclick="loadCommunityMessagesAdmin()" class="btn btn-view">
              🔄 Refresh Chat
            </button>
            <button onclick="deleteSelectedCommunityMessages()" class="btn btn-reject">
              🗑️ Delete Selected Messages
            </button>
          </div>
        </div>

        <!-- Community KPI Stats Grid -->
        <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 20px;">
          <div class="stat-card">
            <div class="stat-label">Total Messages</div>
            <div id="community-stat-total" class="stat-val">0</div>
            <div class="stat-sub">Stored in MongoDB CommunityMessages</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Media Attachments</div>
            <div id="community-stat-media" class="stat-val" style="color: #0284c7;">0</div>
            <div class="stat-sub">Photos, PDFs, Docs on Cloudinary</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Cloudinary Media Folder</div>
            <div style="font-family: monospace; font-size: 13px; font-weight: 700; color: #15803d; margin-top: 6px;">moiconnect/chat_media</div>
            <div class="stat-sub">Zero-trace complete wipe option</div>
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th style="width: 36px;"><input type="checkbox" id="community-select-all" onchange="toggleSelectAllCommunity(this)" /></th>
                <th>Sender</th>
                <th>Message Content / System Notice</th>
                <th>Attachment / Media</th>
                <th>Sent Date & Time</th>
                <th style="text-align: right;">Action</th>
              </tr>
            </thead>
            <tbody id="community-messages-table-body">
              <tr><td colspan="6" style="text-align: center; padding: 32px; color: #94a3b8;">Loading community messages...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 2: STATS & REGISTERED USERS -->
    <section id="tab-content-stats" class="tab-content hidden">
      <!-- KPI Cards -->
      <div class="stats-grid">
        <div class="stat-card" style="border-left: 4px solid #166534;">
          <div class="stat-label">
            Online Users
            <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 800; color: #166534; background: #dcfce7; padding: 2px 7px; border-radius: 10px; border: 1px solid #bbf7d0;">
              <span style="width: 6px; height: 6px; background-color: #22c55e; border-radius: 50%; display: inline-block;"></span> LIVE
            </span>
          </div>
          <div id="stat-online-users" class="stat-val" style="color: #166534;">--</div>
          <div id="stat-online-sub" class="stat-sub">Active Socket Connections</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Total Users
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <div id="stat-users" class="stat-val">--</div>
          <div class="stat-sub">Registered Moi Students & Staff</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Approved Papers
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </div>
          <div id="stat-approved-papers" class="stat-val" style="color: #2563eb;">--</div>
          <div class="stat-sub">Past Papers & Revision Notes</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Pending Papers
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <div id="stat-pending-papers" class="stat-val" style="color: #d97706;">--</div>
          <div class="stat-sub">Awaiting Admin Verification</div>
        </div>

        <div class="stat-card">
          <div class="stat-label">
            Active Departments
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </div>
          <div id="stat-departments" class="stat-val" style="color: #7c3aed;">--</div>
          <div class="stat-sub">Academic Faculties & Departments</div>
        </div>
      </div>

      <!-- Users Table -->
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
              Registered Platform Users
            </h2>
            <p class="card-sub">Students, Landlords, and Admin accounts</p>
          </div>
          <div class="search-input-wrapper">
            <svg class="search-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="text"
              id="user-search"
              oninput="filterUsers()"
              placeholder="Search user by name or email..."
              class="form-control search-input"
              style="width: 260px;"
            />
          </div>
        </div>

        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Landlord Status</th>
                <th>Presence</th>
                <th>Joined Date</th>
              </tr>
            </thead>
            <tbody id="users-table-body">
              <tr><td colspan="5" style="text-align: center; padding: 32px; color: #94a3b8;">Loading user database...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: RENTAL HOUSES -->
    <section id="tab-content-houses" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 10h6"/><path d="M9 14h6"/></svg>
              Student Rental Marketplace Listings
            </h2>
            <p class="card-sub">Houses, Single Rooms & Bedsitters around Moi University Main Campus</p>
          </div>
        </div>

        <div id="houses-container" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px;">
          <div style="text-align: center; padding: 48px; color: #94a3b8; font-size: 14px;">Loading rental listings...</div>
        </div>
      </div>
    </section>

    <!-- TAB 4: SYSTEM HEALTH -->
    <section id="tab-content-system" class="tab-content hidden">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;">
        <div class="card">
          <h3 style="font-size: 16px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; color: #0f172a;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            Backend Service Status
          </h3>
          <div style="font-size: 13px;">
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">Service Name</span>
              <span style="font-weight: 700;">MoiConnect Node.js API</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">MongoDB Database</span>
              <span style="font-weight: 700; color: #15803d; background: #dcfce7; padding: 2px 8px; border-radius: 6px;">Connected</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f1f5f9;">
              <span style="color: #64748b;">Real-Time WebSockets</span>
              <span style="font-weight: 700; color: #4338ca; background: #e0e7ff; padding: 2px 8px; border-radius: 6px;">Socket.IO Ready</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0;">
              <span style="color: #64748b;">API Base URL</span>
              <span style="font-family: monospace; font-weight: 700; color: #15803d;">/api/v1</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 style="font-size: 16px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; color: #0f172a;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563eb" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            Key REST API Endpoints
          </h3>
          <ul style="display: flex; flex-direction: column; gap: 8px; font-family: monospace; font-size: 12px; list-style: none;">
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/papers</span>
              <span style="color: #15803d; font-weight: 700;">Public Papers</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>POST /api/v1/papers</span>
              <span style="color: #15803d; font-weight: 700;">Submit Document</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/houses</span>
              <span style="color: #15803d; font-weight: 700;">Rental Houses</span>
            </li>
            <li style="background: #f8fafc; padding: 10px 14px; border-radius: 8px; border: 1px solid #e2e8f0; display: flex; justify-content: space-between;">
              <span>GET /api/v1/admin/stats</span>
              <span style="color: #d97706; font-weight: 700;">Admin Only</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <!-- TAB 5: NOTIFY (IN-APP POPUPS & PUSH NOTIFICATIONS) -->
    <section id="tab-content-push" class="tab-content hidden">
      <!-- Sub-Tab Switcher -->
      <div style="display: flex; gap: 12px; margin-bottom: 20px; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px;">
        <button id="sub-btn-popups" type="button" onclick="switchNotifySubTab('popups')" class="btn" style="background: #15803d; color: #ffffff; font-weight: 800; border-radius: 10px; padding: 10px 18px; font-size: 13px;">
          💬 In-App Popups (Modal Overlay)
        </button>
        <button id="sub-btn-push" type="button" onclick="switchNotifySubTab('push')" class="btn" style="background: #f1f5f9; color: #475569; font-weight: 800; border-radius: 10px; padding: 10px 18px; font-size: 13px;">
          🔔 Android Push Notifications & History
        </button>
      </div>

      <!-- SUB-SECTION 1: IN-APP POPUPS -->
      <div id="notify-sub-popups">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px;">
          
          <!-- In-App Popup Form Card -->
          <div class="card">
            <div class="card-header">
              <div>
                <h2 class="card-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  Broadcast In-App Popup
                </h2>
                <p class="card-sub">Create normal announcement popups or version update popups for mobile app users.</p>
              </div>
            </div>

            <!-- Toggle Popup Type (Normal vs Update) -->
            <div style="display: flex; background: #f1f5f9; padding: 4px; border-radius: 10px; margin-bottom: 16px;">
              <button type="button" id="pop-type-btn-normal" onclick="setPopupType('normal')" style="flex: 1; padding: 8px; font-weight: 800; border-radius: 8px; border: none; background: #ffffff; color: #15803d; cursor: pointer; font-size: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.1);">
                📢 Normal Popup
              </button>
                            <button type="button" id="pop-type-btn-interactive" onclick="setPopupType('interactive')" style="flex: 1; padding: 8px; font-weight: 800; border-radius: 8px; border: none; background: transparent; color: #64748b; cursor: pointer; font-size: 12px;">Interactive Popup</button><button type="button" id="pop-type-btn-update" onclick="setPopupType('update')" style="flex: 1; padding: 8px; font-weight: 800; border-radius: 8px; border: none; background: transparent; color: #64748b; cursor: pointer; font-size: 12px;">
                🚀 App Update Popup
              </button>
            </div>

            <!-- Normal Popup Form -->
            <form id="popup-normal-form" onsubmit="handleCreateNormalPopup(event)" style="display: flex; flex-direction: column; gap: 14px;">
              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <label style="font-size: 12px; font-weight: 700; color: #334155;">Popup Title *</label>
                  <span style="font-size: 11px; color: #15803d; font-weight: 700;">Magic Tags:</span>
                </div>
                <div style="display: flex; gap: 6px; margin-bottom: 6px;">
                  <button type="button" onclick="insertPopVar('{name}', 'pop-normal-title')" style="background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {name}</button>
                  <button type="button" onclick="insertPopVar('{course}', 'pop-normal-title')" style="background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {course}</button>
                </div>
                <input type="text" id="pop-normal-title" class="form-control" placeholder="e.g. Welcome back, {name}! 🎉" required style="width: 100%; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Subtitle</label>
                <input type="text" id="pop-normal-subtitle" class="form-control" placeholder="e.g. Check out the latest exam revision materials for {course}" style="width: 100%;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Body / Detailed Message</label>
                <textarea id="pop-normal-body" class="form-control" rows="3" placeholder="Popup body message..." style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Banner Image (Optional)</label>
                <input type="file" id="pop-normal-image" class="form-control" accept="image/png,image/jpeg,image/webp,image/gif" style="width: 100%; padding: 8px;" />
                <div style="font-size: 11px; color: #64748b; margin-top: 5px;">Choose an image from your computer. It will be stored in Cloudinary under <b>moiconnect/notify_media</b>.</div>
              </div>

              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <label style="font-size: 12px; font-weight: 700; color: #334155;">Popup Actions</label>
                  <button type="button" onclick="addPopupAction()" style="border: 1px solid #bae6fd; background: #f0f9ff; color: #0369a1; border-radius: 8px; padding: 6px 10px; font-size: 11px; font-weight: 800; cursor: pointer;">+ Add action</button>
                </div>
                <div id="pop-normal-actions" style="display: flex; flex-direction: column; gap: 10px;">
                  <div class="popup-action-row" style="border: 1px solid #dbeafe; background: #f8fdff; border-radius: 12px; padding: 10px;">
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                      <input type="text" class="form-control pop-action-label" placeholder="Button text e.g. Open Community" style="width: 100%;" value="Explore Now" />
                      <div style="display: flex; align-items: center; gap: 10px; font-size: 11px; font-weight: 700; color: #475569;">
                        <label><input type="radio" class="pop-action-kind" name="pop-action-kind-0" value="in_app" checked onchange="togglePopupActionTarget(this)" /> In-app</label>
                        <label><input type="radio" class="pop-action-kind" name="pop-action-kind-0" value="external" onchange="togglePopupActionTarget(this)" /> External</label>
                      </div>
                    </div>
                    <select class="form-control pop-action-target" style="width: 100%; margin-top: 8px; font-weight: 700;">
                      <option value="/community">🌐 Community Chat</option>
                      <option value="/academics">📚 Notes / PDF Section</option>
                      <option value="/past-papers">📄 Past Papers</option>
                      <option value="/cat-papers">📝 CAT Papers</option>
                      <option value="/rentals">🏠 Rental Hostels</option>
                      <option value="/contribute">📤 Contribute Materials</option>
                      <option value="/(auth)/login">🔐 Sign In</option>
                    </select>
                    <input type="url" class="form-control pop-action-external" placeholder="https://example.com/page" style="width: 100%; margin-top: 8px; display: none;" />
                    <button type="button" class="pop-action-remove" onclick="removePopupAction(this)" style="margin-top: 8px; border: 0; background: transparent; color: #dc2626; font-size: 11px; font-weight: 800; cursor: pointer;">Remove action</button>
                  </div>
                </div>
                <div style="font-size: 11px; color: #64748b; margin-top: 6px;">Add as many buttons as needed. Each action can open an in-app section or an external URL.</div>
              </div>
              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Target Audience</label>
                <select id="pop-normal-audience" onchange="togglePopAudienceBox()" class="form-control" style="width: 100%; font-weight: 700;">
                  <option value="all">🌐 All Users & Guests</option>
                  <option value="unauthenticated">👤 Guests Only (Unauthenticated)</option>
                  <option value="emails">📧 Specific Email List</option>
                </select>
              </div>

              <div id="pop-audience-emails-box" class="hidden">
                <textarea id="pop-normal-emails" class="form-control" rows="2" placeholder="student1@moi.ac.ke, student2@gmail.com" style="width: 100%; font-family: monospace; font-size: 12px;"></textarea>
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: #334155; cursor: pointer;">
                <input type="checkbox" id="pop-normal-cancel" checked /> Include Cancel / Dismiss Button
              </label>

              <button type="submit" id="btn-submit-pop-normal" class="btn btn-approve" style="padding: 12px; font-size: 14px; justify-content: center; width: 100%;">
                ✨ Broadcast Normal Popup
              </button>
            </form>

            <form id="popup-interactive-form" onsubmit="handleCreateInteractivePopup(event)" class="hidden" style="display: flex; flex-direction: column; gap: 14px;">
              <div><label>Popup Title *</label><input type="text" id="pop-interactive-title" class="form-control" required /></div>
              <div><label>Banner Image</label><input type="file" id="pop-interactive-image" accept="image/jpeg,image/png,image/webp,image/gif" class="form-control" /></div>
              <div><label>Subtitle</label><input type="text" id="pop-interactive-subtitle" class="form-control" /></div>
              <div><label>Body</label><textarea id="pop-interactive-body" class="form-control" rows="3"></textarea></div>
              <div><label>Questions / Inputs</label><div id="interactive-inputs"></div><button type="button" onclick="addInteractiveInput()">+ Add input</button></div>
              <div><label>Target Audience</label><select id="pop-interactive-audience" class="form-control"><option value="all">All Users and Guests</option><option value="unauthenticated">Guests Only</option><option value="emails">Specific Email List</option></select></div>
              <textarea id="pop-interactive-emails" class="form-control" rows="2" placeholder="student@example.com, ..." style="display: none;"></textarea>
              <label><input type="checkbox" id="pop-interactive-cancel" checked /> Allow dismissing without submitting</label>
              <button type="submit" id="btn-submit-pop-interactive" class="btn btn-approve">Broadcast Interactive Popup</button>
            </form>
            <!-- Update Popup Form -->
            <form id="popup-update-form" onsubmit="handleCreateUpdatePopup(event)" class="hidden" style="display: flex; flex-direction: column; gap: 14px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Minimum Required Version *</label>
                <input type="text" id="pop-update-minver" class="form-control" placeholder="e.g. 1.0.7" required style="width: 100%; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Update Title *</label>
                <input type="text" id="pop-update-title" class="form-control" placeholder="e.g. MoiConnect Version 1.0.7 is Ready!" required style="width: 100%; font-weight: 700;" value="New App Update Available" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Update Subtitle / Release Notes</label>
                <textarea id="pop-update-sub" class="form-control" rows="3" placeholder="e.g. Includes faster past paper downloads and new chat features." style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 4px;">Google Play Store Link</label>
                <input type="url" id="pop-update-url" class="form-control" placeholder="https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect" style="width: 100%;" value="https://play.google.com/store/apps/details?id=com.amanikbt1.moiconnect" />
              </div>

              <label style="display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: #2563eb; cursor: pointer;">
                <input type="checkbox" id="pop-update-force" /> Mandatory Force Update (Non-dismissible)
              </label>

              <button type="submit" id="btn-submit-pop-update" class="btn" style="background: #2563eb; color: #ffffff; padding: 12px; font-size: 14px; font-weight: 800; border-radius: 8px; justify-content: center; width: 100%;">
                🚀 Broadcast Version Update Popup
              </button>
            </form>
          </div>

          <!-- Active Popups History Card -->
          <div class="card">
            <div class="card-header">
              <div>
                <h3 style="font-size: 16px; font-weight: 800; color: #0f172a;">Active In-App Popups History</h3>
                <p class="card-sub">Currently broadcasted popups · delete any item individually</p>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button onclick="loadPopupHistory()" class="btn btn-view" style="font-size: 11px;">Refresh Popups</button>
                <button onclick="deleteAllPopupHistory()" class="btn" style="font-size: 11px; background:#fee2e2; color:#dc2626; border:1px solid #fca5a5;">🗑️ Delete All</button>
              </div>
            </div>

            <div id="popups-history-container" style="display: flex; flex-direction: column; gap: 10px;">
              <div style="text-align: center; padding: 32px; color: #94a3b8; font-size: 13px;">Loading popups history...</div>
            </div>
          </div>

        </div>
      </div>

      <!-- SUB-SECTION 2: PUSH NOTIFICATIONS -->
      <div id="notify-sub-push" class="hidden">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 24px;">
          
          <!-- Registered Push Devices -->
          <div class="card" style="grid-column: 1 / -1; padding: 18px;">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
              <div style="display: flex; align-items: center; gap: 14px;">
                <div style="width: 48px; height: 48px; border-radius: 14px; background: #dcfce7; color: #15803d; display: grid; place-items: center; font-size: 24px;">📱</div>
                <div><div style="font-size: 12px; color: #64748b; font-weight: 700;">Registered Push Devices</div><div id="registered-push-device-count" style="font-size: 26px; color: #0f172a; font-weight: 900;">—</div><div id="registered-push-device-breakdown" style="font-size: 11px; color: #64748b;">Loading device tokens...</div></div>
              </div>
              <button type="button" onclick="loadRegisteredPushDevices()" class="btn btn-view" style="font-size: 11px;">Refresh Devices</button>
            </div>
          </div>

          <!-- Push Notify Form -->
          <div class="card">
            <div class="card-header">
              <div>
                <h2 class="card-title">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  Send Push Notification
                </h2>
                <p class="card-sub">Broadcast high-priority push notifications to android mobile devices & guest users.</p>
              </div>
            </div>

            <form id="push-form" onsubmit="handleSendPush(event)" style="display: flex; flex-direction: column; gap: 16px;">
              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Notification Title *</label>
                <input type="text" id="push-title" class="form-control" placeholder="e.g. 📢 End of Semester Exam Timetable Released" required style="width: 100%; font-size: 14px; font-weight: 700;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Notification Subtitle / Category Header</label>
                <input type="text" id="push-subtitle" class="form-control" placeholder="e.g. Academic Announcement • School of Information Sciences" style="width: 100%;" />
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Select Monochrome Icon (100% Android & Native Compatible)</label>
                <div style="display: flex; flex-wrap: wrap; gap: 10px;">
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="moiconnect" checked />
                    🟢 MoiConnect App
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="bell" />
                    🔔 General (Bell)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="academic" />
                    🎓 Academic (Cap)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="house" />
                    🏠 Rentals (House)
                  </label>
                  <label style="display: flex; align-items: center; gap: 6px; background: #f8fafc; border: 1px solid #cbd5e1; padding: 8px 12px; border-radius: 10px; cursor: pointer; font-size: 12px; font-weight: 700;">
                    <input type="radio" name="push-icon" value="alert" />
                    ⚡ Urgent (Alert)
                  </label>
                </div>
              </div>

              <div>
                <label style="display: block; font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px;">Recipient Audience Target *</label>
                <div style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px;">
                  <label style="font-size: 13px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="radio" name="push-target" value="all" checked onchange="toggleEmailBox()" />
                    🌐 All Users & Guest Devices (Broadcast)
                  </label>
                  <label style="font-size: 13px; font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 6px; cursor: pointer;">
                    <input type="radio" name="push-target" value="emails" onchange="toggleEmailBox()" />
                    ✉️ Specific Email List
                  </label>
                </div>

                <div id="email-recipients-box" class="hidden" style="margin-top: 6px;">
                  <textarea id="push-emails" class="form-control" rows="2" placeholder="e.g. student1@moi.ac.ke, student2@moi.ac.ke" style="width: 100%; font-family: monospace; font-size: 12px;"></textarea>
                  <span style="font-size: 11px; color: #64748b;">Enter comma-separated emails of recipient students.</span>
                </div>
              </div>

              <div>
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                  <label style="font-size: 12px; font-weight: 700; color: #334155;">Notification Body Content *</label>
                  <span style="font-size: 11px; font-weight: 700; color: #15803d;">Magic Template Tags:</span>
                </div>
                
                <!-- Magic variable tags helper -->
                <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px;">
                  <button type="button" onclick="insertMagicVar('{name}')" style="background: #e0e7ff; color: #3730a3; border: 1px solid #c7d2fe; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {name}</button>
                  <button type="button" onclick="insertMagicVar('{course}')" style="background: #dcfce7; color: #166534; border: 1px solid #bbf7d0; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {course}</button>
                  <button type="button" onclick="insertMagicVar('{admissionNumber}')" style="background: #fef3c7; color: #92400e; border: 1px solid #fde68a; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {admissionNumber}</button>
                  <button type="button" onclick="insertMagicVar('{email}')" style="background: #f1f5f9; color: #334155; border: 1px solid #cbd5e1; padding: 4px 8px; border-radius: 6px; font-size: 11px; font-weight: 800; cursor: pointer;">+ {email}</button>
                </div>

                <textarea id="push-body" class="form-control" rows="4" placeholder="Dear {name}, your official timetable for {course} is now live. Tap to open!" required style="width: 100%; font-size: 13px;"></textarea>
              </div>

              <button type="submit" id="btn-submit-push" class="btn btn-approve" style="padding: 12px 20px; font-size: 14px; width: 100%; justify-content: center;">
                🚀 Dispatch Android Push Notification
              </button>
            </form>
          </div>

          <!-- Push History -->
          <div class="card">
            <div class="card-header">
              <div>
                <h3 style="font-size: 16px; font-weight: 800; color: #0f172a;">Android Push Notification History</h3>
                <p class="card-sub">Recently dispatched push notifications · delete any item individually</p>
              </div>
              <div style="display:flex;align-items:center;gap:8px;">
                <button onclick="loadPushHistory()" class="btn btn-view" style="font-size: 11px;">Refresh History</button>
                <button onclick="deleteAllPushHistory()" class="btn" style="font-size: 11px; background:#fee2e2; color:#dc2626; border:1px solid #fca5a5;">🗑️ Delete All</button>
              </div>
            </div>

            <div id="push-history-container" style="display: flex; flex-direction: column; gap: 10px; height: 900px; max-height: 900px; overflow-y: auto; overscroll-behavior: contain; padding-right: 6px;">
              <div style="text-align: center; padding: 32px; color: #94a3b8; font-size: 13px;">Loading broadcast history...</div>
            </div>
          </div>

        </div>
      </div>
    </section>

    <!-- TAB: AI OVERAGES & DEBUG LOGS -->
    <section id="tab-content-ai-overages" class="tab-content hidden">
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">AI API Pool & Overages</h2>
            <p class="card-sub">Secret-safe runtime usage for Campus Bot and Campus AI. API keys are never shown.</p>
          </div>
          <div class="btn-group">
            <button onclick="toggleAiContextEditor()" class="btn btn-view">AI Context</button>
            <button onclick="loadAiOverages()" class="btn btn-view">Refresh AI Status</button>
            <button onclick="clearAiOverages()" class="btn btn-reject">Clear Overages Data</button>
          </div>
        </div>
        <div id="ai-context-editor" class="hidden" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:14px;margin-bottom:18px;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px;">
            <div>
              <div style="font-size:14px;font-weight:800;color:#0f172a;">AI Instruction Controls</div>
              <div style="font-size:12px;color:#64748b;margin-top:3px;">Control the assistant's role, personality, response rules, and safety behavior. The server always adds the student's name and current message automatically.</div>
            </div>
            <button onclick="loadAiContext()" class="btn btn-view" style="padding:6px 10px;font-size:11px;">Reload</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;">
            <label style="font-size:12px;font-weight:800;color:#334155;">Primary Context
              <textarea id="ai-context-input" rows="5" maxlength="5000" placeholder="What should the assistant know about its purpose?" style="display:block;width:100%;box-sizing:border-box;resize:vertical;margin-top:5px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;font-size:13px;color:#1e293b;background:#fff;"></textarea>
            </label>
            <label style="font-size:12px;font-weight:800;color:#334155;">Persona & Tone
              <textarea id="ai-persona-input" rows="5" maxlength="5000" placeholder="Friendly, formal, concise, funny..." style="display:block;width:100%;box-sizing:border-box;resize:vertical;margin-top:5px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;font-size:13px;color:#1e293b;background:#fff;"></textarea>
            </label>
            <label style="font-size:12px;font-weight:800;color:#334155;">Response Rules
              <textarea id="ai-rules-input" rows="5" maxlength="5000" placeholder="How should answers be structured? What should be avoided?" style="display:block;width:100%;box-sizing:border-box;resize:vertical;margin-top:5px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;font-size:13px;color:#1e293b;background:#fff;"></textarea>
            </label>
            <label style="font-size:12px;font-weight:800;color:#334155;">Safety & Privacy Rules
              <textarea id="ai-safety-input" rows="5" maxlength="5000" placeholder="Privacy, accuracy, and safety boundaries..." style="display:block;width:100%;box-sizing:border-box;resize:vertical;margin-top:5px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font:inherit;font-size:13px;color:#1e293b;background:#fff;"></textarea>
            </label>
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:8px;">
            <span id="ai-context-status" style="font-size:11px;color:#64748b;"></span>
            <button onclick="saveAiContext()" class="btn btn-approve">Save AI Instructions</button>
          </div>
        </div>
        <div id="ai-overages-summary" class="stats-grid" style="margin-bottom: 18px;"></div>
        <div class="table-responsive">
          <table>
            <thead><tr><th>API</th><th>Model</th><th>Used in pool</th><th>Configured limit</th><th>Remaining</th><th>Success</th><th>Failures</th><th>Cooldown</th></tr></thead>
            <tbody id="ai-overages-table-body"><tr><td colspan="8" style="text-align:center; padding:28px; color:#94a3b8;">Open this tab to load AI telemetry.</td></tr></tbody>
          </table>
        </div>
        <p id="ai-overages-note" style="font-size:11px; color:#64748b; margin-top:14px; line-height:1.5;"></p>
      </div>
      <div class="card">
        <div class="card-header">
          <div>
            <h2 class="card-title">Campus AI Failure Log</h2>
            <p class="card-sub">Recent in-memory request, quota, timeout, and fallback events.</p>
          </div>
          <button onclick="loadAiOverages()" class="btn btn-view">Refresh Logs</button>
        </div>
        <div id="ai-logs-container" style="display:flex; flex-direction:column; gap:8px; max-height:520px; overflow-y:auto;">
          <div style="text-align:center; padding:28px; color:#94a3b8;">No AI logs loaded.</div>
        </div>
      </div>
    </section>

    <!-- TAB 10: APP SETTINGS -->
    <section id="tab-content-settings" class="tab-content hidden">
      <div style="max-width: 850px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px;">
        <div class="card" style="padding: 24px; border-radius: 16px;">
          <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 16px; border-bottom: 1px solid #e2e8f0; margin-bottom: 24px;">
            <div>
              <h2 style="margin: 0; font-size: 20px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 10px;">
                <span>⚙️</span> Application Global Settings
              </h2>
              <p style="margin: 4px 0 0 0; font-size: 13px; color: #64748b;">Manage global system features & persistent database configurations.</p>
            </div>
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 700; color: #15803d; display: flex; align-items: center; gap: 6px;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #22c55e;"></span> MongoDB Synced
            </div>
          </div>

          <!-- Setting Card 1: Demo Materials Toggle -->
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 22px; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 280px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="font-size: 18px;">📚</span>
                <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: #0f172a;">Show Demo & Sample Materials</h3>
              </div>
              <p style="margin: 0; font-size: 13px; color: #475569; line-height: 1.5;">
                When <b>ON</b>, sample/demo academic materials are included in mobile app listings.<br/>
                When <b>OFF</b>, demo materials are hidden completely across the entire app so students only see real uploaded materials.
              </p>
            </div>

            <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 8px;">
              <div style="display: flex; align-items: center; gap: 12px;">
                <span id="demo-status-badge" style="font-size: 11px; font-weight: 800; padding: 4px 10px; border-radius: 20px; background: ${badgeBg}; color: ${badgeColor}; text-transform: uppercase;">${badgeText}</span>
                <label style="position: relative; display: inline-block; width: 54px; height: 28px; cursor: pointer;">
                  <input type="checkbox" id="toggle-demo-materials" ${isCheckedAttr} onchange="handleDemoMaterialsToggle(this.checked)" style="opacity: 0; width: 0; height: 0;">
                  <span id="toggle-slider" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background-color: ${sliderBg}; transition: .3s; border-radius: 34px;"></span>
                  <span id="toggle-knob" style="position: absolute; height: 22px; width: 22px; left: ${knobLeft}; bottom: 3px; background-color: white; transition: .3s; border-radius: 50%; box-shadow: 0 2px 4px rgba(0,0,0,0.2);"></span>
                </label>
              </div>
              <span id="demo-toggle-status-label" style="font-size: 11px; font-weight: 700; color: ${badgeColor};">${labelText}</span>
            </div>
          </div>
        </div>
      </div>
    
          <!-- Database Backup & Restore -->
          <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 14px; padding: 22px; display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 280px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
                <span style="font-size: 18px;">🗄️</span>
                <h3 style="margin: 0; font-size: 16px; font-weight: 800; color: #7c2d12;">Database Backup & Restore</h3>
              </div>
              <p style="margin: 0; font-size: 13px; color: #9a3412; line-height: 1.5;">Download every MongoDB collection as one complete JSON backup, or restore the database from a previous backup.</p>
            </div>
            <div style="display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px;">
              <button type="button" class="btn" onclick="downloadDatabaseBackup()" style="background: #0f766e; color: #ffffff;">Download Full Backup</button>
              <input type="file" id="database-backup-input" accept="application/json,.json" style="display: none;" onchange="restoreDatabaseBackup(this)" />
              <button type="button" class="btn" onclick="document.getElementById('database-backup-input').click()" style="background: #b45309; color: #ffffff;">Restore JSON Backup</button>
            </div>
            <div id="database-backup-status" style="width: 100%; font-size: 12px; color: #92400e;"></div>
          </div></section>

    <!-- MATERIAL REVIEW, EDIT & APPROVAL MODAL -->
    <div id="material-modal" class="modal-backdrop hidden" onclick="if(event.target === this) closeMaterialModal()">
      <div class="modal-content">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #e2e8f0; padding-bottom: 14px;">
          <div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <span id="modal-type-badge" class="badge-tag">PAST_PAPER</span>
              <span id="modal-mtid-badge" class="mtid-tag hidden">MTID</span>
              <span id="modal-status-badge" style="font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 6px; text-transform: uppercase;">STATUS</span>
            </div>
            <h3 id="modal-title-display" style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 6px;">Title</h3>
            <p id="modal-submitter-display" style="font-size: 12px; color: #64748b; margin-top: 2px;">Submitted by</p>
          </div>
          <button onclick="closeMaterialModal()" style="background: none; border: none; font-size: 26px; color: #64748b; cursor: pointer; line-height: 1;">&times;</button>
        </div>

        <!-- 1. Media Operations Box -->
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; margin-bottom: 20px;">
          <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <span style="display: flex; align-items: center; gap: 6px;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              Document Media Management
            </span>
            <div style="display: flex; align-items: center; gap: 6px;">
              <span id="modal-format-badge" style="font-size: 11px; font-weight: 800; background: #e2e8f0; color: #1e293b; padding: 2px 8px; border-radius: 6px;">PDF</span>
              <span id="modal-media-storage-tag" style="font-size: 11px; font-weight: 700; background: #e0f2fe; color: #0369a1; padding: 2px 8px; border-radius: 6px;">Server Temp</span>
            </div>
          </div>

          <!-- Action buttons: Download, Smart Tab Preview & Copy Public Temp Link -->
          <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <a id="modal-download-btn" href="#" download class="btn" style="background: #0284c7; color: #ffffff;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download Media File
            </a>
            <a id="modal-preview-btn" href="#" target="_blank" class="btn btn-view" style="font-weight: 800; color: #0f172a;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              Open & Preview in Tab
            </a>
            <button type="button" id="modal-copy-url-btn" onclick="copyModalFileUrl()" class="btn btn-view" style="font-size: 11px;">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Public Temp URL
            </button>
          </div>

          <!-- Inline Smart Live Preview Card -->
          <div id="modal-inline-preview-card" style="margin-bottom: 14px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 11px; font-weight: 800; color: #475569; text-transform: uppercase;" id="modal-inline-preview-label">Live Preview</span>
              <a id="modal-inline-open-link" href="#" target="_blank" style="font-size: 11px; color: #0284c7; text-decoration: none; font-weight: 700;">Open Full View ↗</a>
            </div>
            <div id="modal-inline-preview-body" style="display: flex; justify-content: center; align-items: center; min-height: 80px;">
              <!-- Dynamically populated -->
            </div>
          </div>

          <!-- Approval Document Media Choice (Radio Buttons) -->
          <div style="border-top: 1px dashed #cbd5e1; padding-top: 14px; margin-top: 12px;">
            <div style="font-size: 12px; font-weight: 800; color: #1e293b; margin-bottom: 8px;">
              Approval Document Media Choice:
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
              <!-- Option 1: Use Current Document -->
              <label id="choice-card-current" class="choice-radio-card active" onclick="setMediaChoice('current')">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                  <input type="radio" name="modal-media-choice" id="radio-choice-current" value="current" checked onchange="setMediaChoice('current')" style="margin-top: 3px; accent-color: #15803d; cursor: pointer;" />
                  <div>
                    <div style="font-weight: 800; font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#15803d" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                      Use Current Document
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 2px;">File is already clean & ready for approval.</div>
                  </div>
                </div>
              </label>

              <!-- Option 2: Upload Clean Document -->
              <label id="choice-card-upload" class="choice-radio-card" onclick="setMediaChoice('upload')">
                <div style="display: flex; align-items: flex-start; gap: 8px;">
                  <input type="radio" name="modal-media-choice" id="radio-choice-upload" value="upload" onchange="setMediaChoice('upload')" style="margin-top: 3px; accent-color: #d97706; cursor: pointer;" />
                  <div>
                    <div style="font-weight: 800; font-size: 12px; color: #0f172a; display: flex; align-items: center; gap: 4px;">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      Upload Clean Document
                    </div>
                    <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Replace with edited / cleaned copy.</div>
                  </div>
                </div>
              </label>
            </div>

            <!-- Status Box for Option 1 -->
            <div id="media-status-current-box" style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; gap: 8px; font-size: 12px; color: #166534; font-weight: 600;">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#166534" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Using current file. It will be uploaded to Cloudinary (folder: <code>MoiConnect/pdf</code>) upon approval.</span>
            </div>

            <!-- Box for Option 2 (Upload Clean) -->
            <div id="media-status-upload-box" class="hidden" style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px; font-size: 12px;">
              <div style="font-weight: 700; color: #92400e; margin-bottom: 6px;">
                Select clean replacement file (PDF, Word DOCX/DOC, Images, or Text):
              </div>
              <div style="display: flex; flex-wrap: wrap; gap: 8px; align-items: center;">
                <input type="file" id="modal-replace-input" accept=".pdf,.doc,.docx,.txt,.rtf,.md,image/*" onchange="onModalFileSelected()" style="font-size: 12px; flex: 1; min-width: 200px;" />
                <button type="button" id="btn-modal-replace" onclick="handleModalFileReplace()" class="btn" style="background: #d97706; color: #ffffff;">
                  Upload Clean Copy Now
                </button>
              </div>
              <div id="selected-clean-file-info" style="margin-top: 8px; font-size: 11px; color: #92400e; font-weight: 700; display: none;"></div>
            </div>
          </div>
        </div>

        <!-- 2. Metadata Editing Form -->
        <form id="modal-edit-form" onsubmit="handleSavePaperEdits(event)" style="display: flex; flex-direction: column; gap: 14px; margin-bottom: 20px;">
          <div style="font-size: 13px; font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
            Edit Metadata:
          </div>

          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Unit Title *</label>
            <input type="text" id="modal-input-title" class="form-control" style="width: 100%; font-weight: 700;" required />
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Unit Code *</label>
              <input type="text" id="modal-input-code" class="form-control" style="width: 100%; font-weight: 700; text-transform: uppercase;" required />
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Department</label>
              <input type="text" id="modal-input-department" class="form-control" style="width: 100%;" />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Academic Level / Year</label>
              <input type="text" id="modal-input-academic-year" class="form-control" style="width: 100%;" placeholder="e.g. Year 2" />
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">School / Faculty</label>
              <input type="text" id="modal-input-school" class="form-control" style="width: 100%;" />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Semester</label>
              <select id="modal-input-semester" class="form-control" style="width: 100%;">
                <option value="">Select semester</option>
                <option value="Semester 1">Semester 1</option>
                <option value="Semester 2">Semester 2</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Exam / Resource Year</label>
              <input type="number" id="modal-input-year" class="form-control" style="width: 100%;" />
            </div>
          </div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Material Type</label>
              <select id="modal-input-type" class="form-control" style="width: 100%; font-weight: 700;">
                <option value="past_paper">Past Paper</option>
                <option value="cat">CAT Paper</option>
                <option value="lecture_notes">Lecture Notes</option>
                <option value="notes">Study Notes</option>
                <option value="solution">Solutions</option>
                <option value="revision">Revision Material</option>
              </select>
            </div>
            <div>
              <label style="display: block; font-size: 11px; font-weight: 700; color: #475569; margin-bottom: 4px;">Description / Overview</label>
              <input type="text" id="modal-input-description" class="form-control" style="width: 100%;" placeholder="Optional details about this material" />
            </div>
          </div>

          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" id="btn-save-paper-edits" class="btn" style="background: #334155; color: #ffffff;">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
              Save Metadata Edits
            </button>
          </div>
        </form>

        <!-- 3. Final Decision Approval / Rejection Row -->
        <div style="border-top: 2px solid #f1f5f9; padding-top: 16px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 10px;">
          <button type="button" id="modal-btn-reject" onclick="rejectCurrentPaperFromModal()" class="btn btn-reject" style="padding: 10px 18px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            Reject
          </button>
          <button type="button" id="modal-btn-approve" onclick="approveCurrentPaperFromModal()" class="btn btn-approve" style="padding: 10px 22px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            Approve
          </button>
        </div>
      </div>
    </div>

  </main>

  <footer>
    MoiConnect Student Hub • Admin Panel v1.0.0 • Moi University
  </footer>

  <!-- Dashboard JavaScript Logic -->
  <script>
    let globalData = null;
    let adminPublishInFlight = false;

    const SVG_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    const SVG_CROSS = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const SVG_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

    let globalCommunityMessages = [];

    let materialsManagementData = [];

    function handleSchoolSelectChange(selectElem) {
      const customInput = document.getElementById('pub-school-custom');
      if (selectElem.value === 'custom') {
        customInput.classList.remove('hidden');
        customInput.required = true;
        customInput.focus();
      } else {
        customInput.classList.add('hidden');
        customInput.required = false;
        customInput.value = '';
      }
    }

    function handleAdminPubFileSelect(inputElem) {
      const dropzone = document.getElementById('pub-file-dropzone');
      const label = document.getElementById('pub-file-label');
      const sub = document.getElementById('pub-file-sub');

      if (inputElem.files && inputElem.files[0]) {
        const file = inputElem.files[0];
        const sizeFormatted = formatBytesJS(file.size);
        label.innerText = 'Selected: ' + file.name;
        sub.innerText = 'Size: ' + sizeFormatted + ' | Ready for direct Cloudinary upload';
        dropzone.style.borderColor = '#15803d';
        dropzone.style.backgroundColor = '#f0fdf4';
      } else {
        label.innerText = 'Click to select or drop document file';
        sub.innerText = 'Supports PDF, Word (.doc/.docx), Images (.png/.jpg), Text files up to 50MB';
        dropzone.style.borderColor = '#cbd5e1';
        dropzone.style.backgroundColor = '#f8fafc';
      }
    }

    function resetAdminPublishForm() {
      const form = document.getElementById('admin-publish-form');
      if (form) form.reset();
      const customInput = document.getElementById('pub-school-custom');
      if (customInput) { customInput.classList.add('hidden'); customInput.required = false; }
      handleAdminPubFileSelect(document.getElementById('pub-file-input'));
      const statusBox = document.getElementById('pub-status-box');
      if (statusBox) { statusBox.className = 'hidden'; statusBox.innerHTML = ''; }
      const btn = document.getElementById('btn-pub-submit');
      const clearBtn = document.getElementById('btn-pub-clear');
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Publish Material Now (Cloudinary + DB)'; }
      if (clearBtn) clearBtn.disabled = false;
      adminPublishInFlight = false;
    }

    function formatBytesJS(bytes) {
      if (!bytes || bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function publishAdminMaterialDirect(event) {
      event.preventDefault();
      if (adminPublishInFlight) return;
      const title = document.getElementById('pub-title').value.trim();
      const type = document.getElementById('pub-type').value;
      const schoolSelect = document.getElementById('pub-school-select').value;
      const schoolCustom = document.getElementById('pub-school-custom').value.trim();
      const school = schoolSelect === 'custom' ? schoolCustom : schoolSelect;
      const department = document.getElementById('pub-department').value.trim();
      const unitCode = document.getElementById('pub-unitCode').value.trim();
      const unitName = document.getElementById('pub-unitName').value.trim();
      const academicYear = document.getElementById('pub-academicYear').value.trim();
      const semester = document.getElementById('pub-semester').value;
      const examYear = document.getElementById('pub-examYear').value;
      const description = document.getElementById('pub-description').value.trim();
      const fileInput = document.getElementById('pub-file-input');
      const thumbnailInput = document.getElementById('pub-thumbnail-input');

      if (!title || !school || !department || !unitCode || !unitName) {
        showToast('Please fill out all required fields marked with *', true);
        return;
      }

      if (!fileInput.files || !fileInput.files[0]) {
        showToast('Please attach a document file (PDF/Word/Image)', true);
        return;
      }

      const btn = document.getElementById('btn-pub-submit');
      const clearBtn = document.getElementById('btn-pub-clear');
      const statusBox = document.getElementById('pub-status-box');

      adminPublishInFlight = true;
      btn.disabled = true;
      if (clearBtn) clearBtn.disabled = true;
      btn.innerHTML = '⏳ Uploading to Cloudinary...';

      statusBox.className = '';
      statusBox.style.backgroundColor = '#eff6ff';
      statusBox.style.color = '#1e40af';
      statusBox.style.border = '1px solid #bfdbfe';
      statusBox.innerHTML = '⏳ Uploading document directly to Cloudinary and registering database record... Please wait.';

      const formData = new FormData();
      formData.append('title', title);
      formData.append('type', type);
      formData.append('school', school);
      formData.append('department', department);
      formData.append('courseCode', unitCode);
      formData.append('unitCode', unitCode);
      formData.append('unitName', unitName);
      if (academicYear) formData.append('academicYear', academicYear);
      if (semester) formData.append('semester', semester);
      if (examYear) formData.append('examYear', examYear);
      if (description) formData.append('description', description);
      formData.append('file', fileInput.files[0]);
      if (thumbnailInput.files && thumbnailInput.files[0]) {
        formData.append('thumbnail', thumbnailInput.files[0]);
      }

      fetch('/api/v1/dashboard/materials/publish', {
        method: 'POST',
        body: formData
      })
      .then(res => res.json())
      .then(json => {
        if (!json.success) {
          throw new Error(json.error || 'Failed to publish material.');
        }

        statusBox.style.backgroundColor = '#dcfce7';
        statusBox.style.color = '#14532d';
        statusBox.style.border = '1px solid #bbf7d0';
        statusBox.innerHTML = '✅ <strong>Published!</strong> ' + json.message + (json.data && json.data.mtid ? ' (MTID: ' + json.data.mtid + ')' : '');

        showToast('Material published directly to Cloudinary & Database!');

        setTimeout(function() {
          resetAdminPublishForm();
          switchTab('materials');
          fetchMaterialsForManagement();
        }, 1800);
      })
      .catch(err => {
        console.error('Publish material error:', err);
        statusBox.style.backgroundColor = '#fee2e2';
        statusBox.style.color = '#991b1b';
        statusBox.style.border = '1px solid #fecaca';
        statusBox.innerHTML = '❌ <strong>Upload Failed:</strong> ' + err.message;
        showToast('Failed to publish material: ' + err.message, true);
        adminPublishInFlight = false;
        btn.disabled = false;
        if (clearBtn) clearBtn.disabled = false;
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg> Retry Direct Upload';
      });
    }

    function escapeMaterialHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>'"]/g, function(char) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char];
      });
    }

    async function fetchMaterialsForManagement() {
      const container = document.getElementById('materials-management-container');
      container.innerHTML = '<div style="text-align:center; padding:48px; color:#64748b;">Fetching materials catalogue...</div>';
      try {
        const res = await fetch('/api/v1/dashboard/materials');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Fetch failed');
        materialsManagementData = json.data || [];
        renderMaterialsManagement();
        showToast(materialsManagementData.length + ' material(s) fetched for management.');
      } catch (err) {
        container.innerHTML = '<div class="fetch-start-card"><p style="color:#b91c1c; font-weight:700;">Could not fetch materials.</p><button onclick="fetchMaterialsForManagement()" class="btn btn-view" style="margin-top:14px;">Try again</button></div>';
        showToast('Error fetching materials: ' + err.message, true);
      }
    }

    function renderMaterialsManagement() {
      const container = document.getElementById('materials-management-container');
      if (!materialsManagementData.length) {
        container.innerHTML = '<div class="fetch-start-card"><div class="fetch-start-icon">✓</div><h3 style="font-size:18px; color:#0f172a; margin-bottom:6px;">No materials found</h3><p style="font-size:13px; color:#64748b;">The material catalogue is empty.</p></div>';
        return;
      }

      const selectedCount = document.querySelectorAll('.material-select:checked').length;
      container.innerHTML = '<div class="materials-toolbar">' +
        '<label style="display:flex; align-items:center; gap:8px; font-size:13px; font-weight:800; color:#334155;"><input id="materials-select-all" type="checkbox" class="material-check" onchange="toggleAllMaterials(this.checked)"> Select all <span style="font-weight:600; color:#64748b;">(' + materialsManagementData.length + ')</span></label>' +
        '<div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;"><span id="materials-selected-count" style="font-size:12px; color:#64748b;">' + selectedCount + ' selected</span><button onclick="setSelectedMaterialsVisibility(false)" class="btn btn-view">Show selected</button><button onclick="setSelectedMaterialsVisibility(true)" class="btn btn-view">Hide selected</button><button onclick="deleteSelectedMaterials()" class="btn btn-reject">Delete selected</button></div>' +
        '</div><div class="materials-grid">' + materialsManagementData.map(function(material) {
          const hidden = material.isHidden === true;
          const type = escapeMaterialHtml((material.fileType || material.type || 'file').toUpperCase());
          const title = escapeMaterialHtml(material.title || 'Untitled material');
          const unit = escapeMaterialHtml(material.unitCode || 'No unit code');
          const school = escapeMaterialHtml(material.school || 'No school');
          const status = escapeMaterialHtml(material.status || 'unknown');
          const id = escapeMaterialHtml(material._id);
          return '<article class="material-card ' + (hidden ? 'hidden-material' : '') + '">' +
            '<div class="material-cover ' + (material.fileType === 'pdf' ? 'pdf' : '') + '"><span class="material-cover-icon">' + (material.fileType === 'pdf' ? 'PDF' : 'DOC') + '</span><input type="checkbox" class="material-check material-select" data-id="' + id + '" onchange="updateMaterialsSelection()" aria-label="Select ' + title + '"></div>' +
            '<div class="material-body"><div class="material-title">' + title + '</div><div class="material-meta"><strong>' + unit + '</strong> &middot; ' + school + '<br>' + type + ' &middot; ' + status + (material.mtid ? ' &middot; ' + escapeMaterialHtml(material.mtid) : '') + '</div><span class="material-status ' + (hidden ? 'hidden-status' : '') + '">' + (hidden ? 'Hidden from students' : 'Visible to students') + '</span></div>' +
            '<div class="material-actions"><button data-material-id="' + id + '" data-hidden="' + (!hidden) + '" onclick="toggleMaterialVisibility(this.dataset.materialId, this.dataset.hidden === &quot;true&quot;)" class="btn btn-view">' + (hidden ? 'Show' : 'Hide') + '</button><button onclick="deleteMaterials([&quot;' + id + '&quot;])" class="btn btn-reject">Delete</button></div>' +
          '</article>';
        }).join('') + '</div>';
    }

    function updateMaterialsSelection() {
      const selected = document.querySelectorAll('.material-select:checked').length;
      const count = document.getElementById('materials-selected-count');
      if (count) count.innerText = selected + ' selected';
      const all = document.getElementById('materials-select-all');
      if (all) all.checked = selected > 0 && selected === document.querySelectorAll('.material-select').length;
    }

    function toggleAllMaterials(checked) {
      document.querySelectorAll('.material-select').forEach(function(input) { input.checked = checked; });
      updateMaterialsSelection();
    }

    async function toggleMaterialVisibility(id, isHidden) {
      try {
        const res = await fetch('/api/v1/dashboard/materials/' + id + '/visibility', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isHidden: isHidden }) });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Update failed');
        const material = materialsManagementData.find(function(item) { return item._id === id; });
        if (material) material.isHidden = isHidden;
        renderMaterialsManagement();
        showToast(json.message);
      } catch (err) { showToast('Visibility update failed: ' + err.message, true); }
    }

    function setSelectedMaterialsVisibility(isHidden) {
      const ids = Array.from(document.querySelectorAll('.material-select:checked')).map(function(input) { return input.dataset.id; });
      if (!ids.length) { showToast('Select at least one material first.', true); return; }
      fetch('/api/v1/dashboard/materials/visibility', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids, isHidden: isHidden }) }).then(function(res) { return res.json(); }).then(function(json) {
        if (!json.success) throw new Error(json.error || 'Update failed');
        materialsManagementData.forEach(function(material) { if (ids.indexOf(material._id) !== -1) material.isHidden = isHidden; });
        renderMaterialsManagement(); showToast(json.message);
      }).catch(function(err) { showToast('Visibility update failed: ' + err.message, true); });
    }

    function deleteSelectedMaterials() {
      const ids = Array.from(document.querySelectorAll('.material-select:checked')).map(function(input) { return input.dataset.id; });
      deleteMaterials(ids);
    }

    function deleteMaterials(ids) {
      if (!ids.length) { showToast('Select at least one material first.', true); return; }
      if (!confirm('Permanently delete ' + ids.length + ' material(s) from the database and Cloudinary? This cannot be undone.')) return;
      fetch('/api/v1/dashboard/materials', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) }).then(function(res) { return res.json(); }).then(function(json) {
        if (!json.success) throw new Error(json.error || 'Delete failed');
        materialsManagementData = materialsManagementData.filter(function(material) { return ids.indexOf(material._id) === -1; });
        renderMaterialsManagement(); showToast(json.message);
      }).catch(function(err) { showToast('Delete failed: ' + err.message, true); });
    }
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.add('hidden'));

      document.getElementById('tab-btn-' + tabId).classList.add('active');
      document.getElementById('tab-content-' + tabId).classList.remove('hidden');

      if (tabId === 'push') {
        loadPopupHistory();
        loadPushHistory();
        loadRegisteredPushDevices();
      } else if (tabId === 'ai-overages') {
        loadAiOverages();
      } else if (tabId === 'community') {
        loadCommunityMessagesAdmin();
      } else if (tabId === 'temp') {
        loadTempFiles();
      }
    }

    let aiOveragesRefreshTimer = null;
    function toggleAiContextEditor() {
      const editor = document.getElementById('ai-context-editor');
      if (!editor) return;
      const opening = editor.classList.contains('hidden');
      editor.classList.toggle('hidden');
      if (opening) loadAiContext();
    }

    async function loadAiContext() {
      const contextInput = document.getElementById('ai-context-input');
      const personaInput = document.getElementById('ai-persona-input');
      const rulesInput = document.getElementById('ai-rules-input');
      const safetyInput = document.getElementById('ai-safety-input');
      const status = document.getElementById('ai-context-status');
      if (!contextInput) return;
      if (status) status.innerText = 'Loading saved AI instructions...';
      try {
        const response = await fetch('/api/v1/dashboard/ai-context');
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to load AI context');
        contextInput.value = json.data?.context || '';
        if (personaInput) personaInput.value = json.data?.persona || '';
        if (rulesInput) rulesInput.value = json.data?.responseRules || '';
        if (safetyInput) safetyInput.value = json.data?.safetyRules || '';
        if (status) status.innerText = 'Saved AI instructions loaded from MongoDB.';
      } catch (error) {
        if (status) status.innerText = 'Failed to load context: ' + error.message;
      }
    }

    async function saveAiContext() {
      const contextInput = document.getElementById('ai-context-input');
      const personaInput = document.getElementById('ai-persona-input');
      const rulesInput = document.getElementById('ai-rules-input');
      const safetyInput = document.getElementById('ai-safety-input');
      const status = document.getElementById('ai-context-status');
      const context = contextInput ? contextInput.value.trim() : '';
      const persona = personaInput ? personaInput.value.trim() : '';
      const responseRules = rulesInput ? rulesInput.value.trim() : '';
      const safetyRules = safetyInput ? safetyInput.value.trim() : '';
      if (!context && !persona && !responseRules && !safetyRules) {
        if (status) status.innerText = 'Enter at least one AI instruction.';
        return;
      }
      if (status) status.innerText = 'Saving...';
      try {
        const response = await fetch('/api/v1/dashboard/ai-context', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context, persona, responseRules, safetyRules }) });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to save AI context');
        if (contextInput) contextInput.value = json.data?.context || context;
        if (personaInput) personaInput.value = json.data?.persona || persona;
        if (rulesInput) rulesInput.value = json.data?.responseRules || responseRules;
        if (safetyInput) safetyInput.value = json.data?.safetyRules || safetyRules;
        if (status) status.innerText = 'Saved to MongoDB. New AI requests will use these instructions.';
        showToast(json.message || 'AI instructions saved.');
      } catch (error) {
        if (status) status.innerText = 'Failed to save context: ' + error.message;
        showToast('Failed to save AI instructions: ' + error.message, true);
      }
    }

    async function loadAiOverages() {
      const summary = document.getElementById('ai-overages-summary');
      const tbody = document.getElementById('ai-overages-table-body');
      const logs = document.getElementById('ai-logs-container');
      const note = document.getElementById('ai-overages-note');
      if (!summary || !tbody || !logs) return;
      summary.innerHTML = '<div style="color:#64748b; font-size:13px;">Loading AI pool telemetry...</div>';
      try {
        const response = await fetch('/api/v1/dashboard/ai-overages');
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to load AI telemetry');
        const data = json.data || {};
        const pool = data.pool || [];
        const totalUsed = pool.reduce((sum, item) => sum + Number(item.used || 0), 0);
        const totalSuccess = pool.reduce((sum, item) => sum + Number(item.successes || 0), 0);
        const totalFailures = pool.reduce((sum, item) => sum + Number(item.failures || 0), 0);
        const activeCooldowns = pool.filter(item => item.cooldownUntil).length;
        if (aiOveragesRefreshTimer) clearTimeout(aiOveragesRefreshTimer);
        if (activeCooldowns > 0 && document.getElementById('tab-content-ai-overages') && !document.getElementById('tab-content-ai-overages').classList.contains('hidden')) {
          aiOveragesRefreshTimer = setTimeout(loadAiOverages, 10000);
        }
        summary.innerHTML = [
          ['Configured APIs', pool.length, 'Keys detected in the server pool'],
          ['Requests attempted', totalUsed, 'Runtime attempts since restart'],
          ['Successful replies', totalSuccess, 'Gemini responses with text'],
          ['Failures / fallbacks', totalFailures, activeCooldowns + ' API(s) cooling down']
        ].map(item => '<div class="stat-card"><div class="stat-label">' + item[0] + '</div><div class="stat-val">' + item[1] + '</div><div class="stat-sub">' + item[2] + '</div></div>').join('');
        tbody.innerHTML = pool.length ? pool.map(item => {
          const remaining = item.configuredLimit === null ? 'Not exposed' : Math.max(0, Number(item.configuredLimit) - Number(item.used || 0));
          const cooldownMs = Number(item.cooldownRemainingMs || 0);
          const cooldownTotalMs = 60000;
          const cooldownPercent = Math.min(100, Math.max(0, ((cooldownTotalMs - cooldownMs) / cooldownTotalMs) * 100));
          const cooldownMinutes = Math.floor(cooldownMs / 60000);
          const cooldownSeconds = Math.ceil((cooldownMs % 60000) / 1000);
          const cooldownText = cooldownMinutes >= 60 ? Math.floor(cooldownMinutes / 60) + 'h ' + (cooldownMinutes % 60) + 'm' : cooldownMinutes + 'm ' + cooldownSeconds + 's';
          const cooldownCell = item.cooldownUntil ? '<div style="color:#b45309;font-weight:700;">Cooling down</div><div style="height:5px;background:#fef3c7;border-radius:5px;margin-top:6px;min-width:100px;"><div style="height:5px;width:' + cooldownPercent.toFixed(1) + '%;background:#f59e0b;border-radius:5px;"></div></div><div style="font-size:10px;color:#92400e;margin-top:3px;">' + cooldownText + ' remaining</div>' : '<span style="color:#15803d;font-weight:700;">Ready</span>';
          return '<tr><td><b>' + item.apiLabel + '</b></td><td><code>' + item.model + '</code></td><td>' + item.used + '</td><td>' + (item.configuredLimit === null ? 'Not configured' : item.configuredLimit) + '</td><td>' + remaining + '</td><td style="color:#15803d;font-weight:800;">' + item.successes + '</td><td style="color:#dc2626;font-weight:800;">' + item.failures + '</td><td>' + cooldownCell + '</td></tr>';
        }).join('') : '<tr><td colspan="8" style="text-align:center;padding:28px;color:#dc2626;">No Gemini API keys detected. Set GEMINI_API_KEYS to a comma-separated list of keys...</td></tr>';
        if (note) note.innerText = 'Models in rotation: ' + ((data.models || []).join(', ') || 'none') + '. Gemini does not provide a universal remaining-quota value through this request path. “Remaining” is calculated only when GEMINI_API_LIMIT_1, GEMINI_API_LIMIT_2, etc. are configured; otherwise the dashboard reports “Not exposed”. Usage counters reset when the backend restarts.';
        const recentLogs = data.logs || [];
        logs.innerHTML = recentLogs.length ? recentLogs.map(item => {
          const color = item.level === 'error' ? '#dc2626' : item.level === 'warn' ? '#b45309' : '#15803d';
          return '<div style="border:1px solid #e2e8f0;border-left:4px solid ' + color + ';border-radius:9px;padding:10px 12px;background:#f8fafc;"><div style="display:flex;justify-content:space-between;gap:12px;font-size:11px;color:#64748b;"><b style="color:' + color + ';text-transform:uppercase;">' + item.level + '</b><span>' + new Date(item.timestamp).toLocaleString() + '</span></div><div style="font-size:12px;font-weight:700;color:#334155;margin-top:4px;">' + (item.assistant || 'AI') + (item.apiLabel ? ' · ' + item.apiLabel : '') + (item.model ? ' · ' + item.model : '') + (item.status ? ' · HTTP ' + item.status : '') + '</div><div style="font-size:12px;color:#475569;margin-top:3px;">' + item.message + '</div></div>';
        }).join('') : '<div style="text-align:center;padding:28px;color:#94a3b8;">No AI failures recorded since the backend started.</div>';
      } catch (error) {
        summary.innerHTML = '<div style="color:#dc2626;font-size:13px;">Failed to load AI telemetry: ' + error.message + '</div>';
        tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:28px;color:#dc2626;">AI telemetry unavailable.</td></tr>';
        logs.innerHTML = '<div style="color:#dc2626;padding:18px;">' + error.message + '</div>';
      }
    }

    async function clearAiOverages() {
      if (!window.confirm('Clear all persistent AI usage counters, cooldowns, failures, and logs? This cannot be undone.')) return;
      try {
        const response = await fetch('/api/v1/dashboard/ai-overages', { method: 'DELETE' });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to clear AI telemetry');
        showToast(json.message || 'AI overages data cleared.');
        loadAiOverages();
      } catch (error) {
        showToast('Failed to clear AI overages: ' + error.message, true);
      }
    }

    function switchNotifySubTab(sub) {
      const popupsDiv = document.getElementById('notify-sub-popups');
      const pushDiv = document.getElementById('notify-sub-push');
      const popBtn = document.getElementById('sub-btn-popups');
      const pushBtn = document.getElementById('sub-btn-push');

      if (sub === 'popups') {
        popupsDiv.classList.remove('hidden');
        pushDiv.classList.add('hidden');
        popBtn.style.background = '#15803d';
        popBtn.style.color = '#ffffff';
        pushBtn.style.background = '#f1f5f9';
        pushBtn.style.color = '#475569';
        loadPopupHistory();
      } else {
        popupsDiv.classList.add('hidden');
        pushDiv.classList.remove('hidden');
        pushBtn.style.background = '#15803d';
        pushBtn.style.color = '#ffffff';
        popBtn.style.background = '#f1f5f9';
        popBtn.style.color = '#475569';
        loadPushHistory();
        loadRegisteredPushDevices();
      }
    }

    async function loadRegisteredPushDevices() {
      const count = document.getElementById('registered-push-device-count');
      const breakdown = document.getElementById('registered-push-device-breakdown');
      if (!count || !breakdown) return;
      try {
        const res = await fetch('/api/v1/admin/registered-devices');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Unable to load devices');
        count.textContent = String(json.total || 0);
        breakdown.textContent = 'Android: ' + (json.byPlatform?.android || 0) + ' • iOS: ' + (json.byPlatform?.ios || 0) + ' • Web: ' + (json.byPlatform?.web || 0);
      } catch (error) {
        count.textContent = '—';
        breakdown.textContent = 'Could not load registered device tokens';
      }
    }
    function setPopupType(type) {
      const normalForm = document.getElementById('popup-normal-form');
      const updateForm = document.getElementById('popup-update-form');
      const interactiveForm = document.getElementById('popup-interactive-form');
      const btnNormal = document.getElementById('pop-type-btn-normal');
      const btnUpdate = document.getElementById('pop-type-btn-update');
      const btnInteractive = document.getElementById('pop-type-btn-interactive');
      [normalForm, updateForm, interactiveForm].forEach(function(form) { if (form) form.classList.add('hidden'); });
      [btnNormal, btnUpdate, btnInteractive].forEach(function(button) { if (button) { button.style.background = 'transparent'; button.style.color = '#64748b'; } });
      const activeForm = type === 'update' ? updateForm : type === 'interactive' ? interactiveForm : normalForm;
      const activeButton = type === 'update' ? btnUpdate : type === 'interactive' ? btnInteractive : btnNormal;
      if (activeForm) activeForm.classList.remove('hidden');
      if (activeButton) { activeButton.style.background = '#ffffff'; activeButton.style.color = type === 'update' ? '#2563eb' : '#15803d'; }
      if (type === 'interactive' && !document.querySelector('#interactive-inputs .interactive-input-row')) addInteractiveInput();
    }
    function togglePopAudienceBox() {
      const val = document.getElementById('pop-normal-audience').value;
      const box = document.getElementById('pop-audience-emails-box');
      if (val === 'emails') {
        box.classList.remove('hidden');
      } else {
        box.classList.add('hidden');
      }
    }

    function insertPopVar(variable, elementId) {
      const input = document.getElementById(elementId);
      if (input) {
        input.value += ' ' + variable;
        input.focus();
      }
    }

    function togglePopupActionTarget(input) {
      const row = input.closest('.popup-action-row');
      if (!row) return;
      const external = row.querySelector('.pop-action-external');
      const target = row.querySelector('.pop-action-target');
      const isExternal = input.value === 'external' && input.checked;
      external.style.display = isExternal ? 'block' : 'none';
      target.style.display = isExternal ? 'none' : 'block';
    }

    function refreshPopupActionRows() {
      document.querySelectorAll('#pop-normal-actions .popup-action-row').forEach(function(row, index) {
        row.querySelectorAll('.pop-action-kind').forEach(function(input) {
          input.name = 'pop-action-kind-' + index;
        });
        row.querySelector('.pop-action-remove').style.display = index === 0 ? 'none' : 'block';
      });
    }

    function addPopupAction() {
      const container = document.getElementById('pop-normal-actions');
      const row = document.createElement('div');
      row.className = 'popup-action-row';
      row.style.cssText = 'border: 1px solid #dbeafe; background: #f8fdff; border-radius: 12px; padding: 10px;';
      row.innerHTML = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">' +
        '<input type="text" class="form-control pop-action-label" placeholder="Button text" style="width: 100%;" />' +
        '<div style="display: flex; align-items: center; gap: 10px; font-size: 11px; font-weight: 700; color: #475569;">' +
          '<label><input type="radio" class="pop-action-kind" value="in_app" checked onchange="togglePopupActionTarget(this)" /> In-app</label>' +
          '<label><input type="radio" class="pop-action-kind" value="external" onchange="togglePopupActionTarget(this)" /> External</label>' +
        '</div></div>' +
        '<select class="form-control pop-action-target" style="width: 100%; margin-top: 8px; font-weight: 700;">' +
          '<option value="/community">🌐 Community Chat</option><option value="/academics">📚 Notes / PDF Section</option>' +
          '<option value="/past-papers">📄 Past Papers</option><option value="/cat-papers">📝 CAT Papers</option>' +
          '<option value="/rentals">🏠 Rental Hostels</option><option value="/contribute">📤 Contribute Materials</option>' +
          '<option value="/(auth)/login">🔐 Sign In</option></select>' +
        '<input type="url" class="form-control pop-action-external" placeholder="https://example.com/page" style="width: 100%; margin-top: 8px; display: none;" />' +
        '<button type="button" class="pop-action-remove" onclick="removePopupAction(this)" style="margin-top: 8px; border: 0; background: transparent; color: #dc2626; font-size: 11px; font-weight: 800; cursor: pointer;">Remove action</button>';
      container.appendChild(row);
      refreshPopupActionRows();
    }

    function removePopupAction(button) {
      const rows = document.querySelectorAll('#pop-normal-actions .popup-action-row');
      if (rows.length <= 1) return;
      button.closest('.popup-action-row').remove();
      refreshPopupActionRows();
    }

    function collectPopupActions() {
      return Array.from(document.querySelectorAll('#pop-normal-actions .popup-action-row')).map(function(row) {
        const kind = row.querySelector('.pop-action-kind:checked')?.value || 'in_app';
        const target = kind === 'external'
          ? row.querySelector('.pop-action-external')?.value.trim()
          : row.querySelector('.pop-action-target')?.value;
        return {
          label: row.querySelector('.pop-action-label')?.value.trim(),
          target,
          type: kind
        };
      }).filter(function(action) { return action.label && action.target; });
    }
    async function handleCreateNormalPopup(e) {
      e.preventDefault();
      const title = document.getElementById('pop-normal-title').value;
      const subtitle = document.getElementById('pop-normal-subtitle').value;
      const body = document.getElementById('pop-normal-body').value;
      const imageFile = document.getElementById('pop-normal-image').files[0];
      let imageUrl = '';
      const actions = collectPopupActions();
      if (!actions.length) {
        showToast('Add at least one action with button text and a destination.', true);
        return;
      }
      const invalidExternal = actions.find(function(action) {
        return action.type === 'external' && !/^https?:\/\//i.test(action.target);
      });
      if (invalidExternal) {
        showToast('External actions must use a valid http:// or https:// URL.', true);
        return;
      }
      const actionTarget = actions[0].target;
      const actionButtonText = actions[0].label;
      const targetAudience = document.getElementById('pop-normal-audience').value;
      const targetEmails = document.getElementById('pop-normal-emails')?.value || '';
      const hasCancelButton = document.getElementById('pop-normal-cancel').checked;

      const btn = document.getElementById('btn-submit-pop-normal');
      btn.disabled = true;
      btn.innerText = '⏳ Broadcasting...';

      try {
        if (imageFile) {
          btn.innerText = '⏳ Uploading banner...';
          const imageForm = new FormData();
          imageForm.append('file', imageFile);
          const imageRes = await fetch('/api/v1/notify/upload-media', {
            method: 'POST',
            body: imageForm
          });
          const imageJson = await imageRes.json();
          if (!imageRes.ok || !imageJson.success) {
            throw new Error(imageJson.error || 'Failed to upload banner image.');
          }
          imageUrl = imageJson.data.imageUrl;
        }

        btn.innerText = '⏳ Broadcasting...';
        const res = await fetch('/api/v1/notify/popups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'normal',
            title,
            subtitle,
            body,
            imageUrl,
            actionTarget,
            actionButtonText,
            actions,
            targetAudience,
            targetEmails,
            hasCancelButton
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('✨ Normal Popup Created: ' + (json.data?.popupId || ''));
          document.getElementById('popup-normal-form').reset();
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to create popup.', true);
        }
      } catch (err) {
        showToast('Error creating popup: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '✨ Broadcast Normal Popup';
      }
    }

    function addInteractiveInput() {
      const container = document.getElementById('interactive-inputs');
      if (!container) return;
      const index = container.children.length + 1;
      const row = document.createElement('div');
      row.className = 'interactive-input-row';
      row.style.cssText = 'border: 1px solid #dbeafe; background: #f8fdff; border-radius: 10px; padding: 10px; display: grid; gap: 7px;';
      row.innerHTML = '<div style="display:grid;grid-template-columns:1fr 130px;gap:8px;">' +
        '<input class="form-control interactive-label" placeholder="Question label" required />' +
        '<select class="form-control interactive-type"><option value="text">Text box</option><option value="radio">Radio choices</option><option value="toggle">Toggle</option><option value="checkbox">Checkbox</option></select></div>' +
        '<input class="form-control interactive-options" placeholder="Choices separated by commas (for radio)" />' +
        '<label style="font-size:11px;font-weight:700;"><input type="checkbox" class="interactive-required" /> Required</label>' +
        '<button type="button" onclick="this.closest(&quot;.interactive-input-row&quot;).remove()" style="width:max-content;border:0;background:transparent;color:#dc2626;font-size:11px;font-weight:800;">Remove input</button>';
      container.appendChild(row);
    }

    document.getElementById('pop-interactive-audience')?.addEventListener('change', function() {
      const emails = document.getElementById('pop-interactive-emails');
      if (emails) emails.style.display = this.value === 'emails' ? 'block' : 'none';
    });

    function collectInteractiveInputs() {
      return Array.from(document.querySelectorAll('#interactive-inputs .interactive-input-row')).map(function(row, index) {
        const type = row.querySelector('.interactive-type').value;
        return { id: 'field_' + (index + 1), label: row.querySelector('.interactive-label').value.trim(), type: type, required: row.querySelector('.interactive-required').checked, options: row.querySelector('.interactive-options').value.split(',').map(function(value) { return value.trim(); }).filter(Boolean) };
      }).filter(function(input) { return input.label; });
    }

    async function handleCreateInteractivePopup(e) {
      e.preventDefault();
      const inputs = collectInteractiveInputs();
      if (!inputs.length) { showToast('Add at least one input.', true); return; }
      const btn = document.getElementById('btn-submit-pop-interactive');
      btn.disabled = true;
      try {
        let imageUrl = '';
        const imageFile = document.getElementById('pop-interactive-image').files[0];
        if (imageFile) {
          const form = new FormData(); form.append('file', imageFile);
          const upload = await fetch('/api/v1/notify/upload-media', { method: 'POST', body: form });
          const uploadJson = await upload.json();
          if (!upload.ok || !uploadJson.success) throw new Error(uploadJson.error || 'Banner upload failed.');
          imageUrl = uploadJson.data.imageUrl;
        }
        const response = await fetch('/api/v1/notify/popups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'interactive', title: document.getElementById('pop-interactive-title').value, subtitle: document.getElementById('pop-interactive-subtitle').value, body: document.getElementById('pop-interactive-body').value, imageUrl: imageUrl, inputs: inputs, targetAudience: document.getElementById('pop-interactive-audience').value, targetEmails: document.getElementById('pop-interactive-emails').value, hasCancelButton: document.getElementById('pop-interactive-cancel').checked }) });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Could not create popup.');
        showToast('Interactive popup created: ' + (json.data?.popupId || ''));
        document.getElementById('popup-interactive-form').reset();
        document.getElementById('interactive-inputs').innerHTML = '';
        addInteractiveInput();
        loadPopupHistory();
      } catch (error) { showToast('Error creating interactive popup: ' + error.message, true); }
      finally { btn.disabled = false; }
    }

    async function viewPopupResponses(id) {
      const response = await fetch('/api/v1/notify/popups/' + encodeURIComponent(id) + '/responses');
      const json = await response.json();
      if (!json.success) { showToast(json.error || 'Could not load responses.', true); return; }
      const rows = (json.data.responses || []).map(function(item) {
        return '<div style="border-bottom:1px solid #e2e8f0;padding:12px 0;"><strong>' + (item.name || 'Guest') + '</strong><div style="font-size:11px;color:#64748b;">' + (item.email || 'No email') + '</div><div style="margin-top:6px;white-space:pre-wrap;">' + Object.entries(item.responses || {}).map(function(entry) { return entry[0] + ': ' + entry[1]; }).join(' | ') + '</div></div>';
      }).join('');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:20px;z-index:9999;';
      overlay.innerHTML = '<div style="background:#fff;border-radius:14px;width:min(620px,100%);max-height:80vh;overflow:auto;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25);"><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:10px;"><div><h3 style="margin:0;color:#0f172a;">Popup responses</h3><p style="margin:4px 0 0;color:#64748b;font-size:12px;">' + (json.data.popup?.title || '') + '</p></div><button id="close-popup-responses" style="border:0;background:#f1f5f9;border-radius:8px;padding:7px 10px;cursor:pointer;">Close</button></div><div style="margin-top:8px;">' + (rows || '<div style="padding:20px;color:#64748b;text-align:center;">No responses yet.</div>') + '</div></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('#close-popup-responses').onclick = function() { overlay.remove(); };
      overlay.onclick = function(event) { if (event.target === overlay) overlay.remove(); };
    }
    async function handleCreateUpdatePopup(e) {
      e.preventDefault();
      const minAppVersion = document.getElementById('pop-update-minver').value;
      const title = document.getElementById('pop-update-title').value;
      const subtitle = document.getElementById('pop-update-sub').value;
      const playStoreUrl = document.getElementById('pop-update-url').value;
      const isForceUpdate = document.getElementById('pop-update-force').checked;
      const imageFile = document.getElementById('pop-update-image')?.files?.[0];
      let imageUrl = '';

      const btn = document.getElementById('btn-submit-pop-update');
      btn.disabled = true;
      btn.innerText = '⏳ Broadcasting...';

      try {
        if (imageFile) {
          btn.innerText = '⏳ Uploading banner...';
          const imageForm = new FormData();
          imageForm.append('file', imageFile);
          const imageRes = await fetch('/api/v1/notify/upload-media', {
            method: 'POST',
            body: imageForm
          });
          const imageJson = await imageRes.json();
          if (!imageRes.ok || !imageJson.success) {
            throw new Error(imageJson.error || 'Failed to upload banner image.');
          }
          imageUrl = imageJson.data.imageUrl;
        }

        btn.innerText = '⏳ Broadcasting...';
        const res = await fetch('/api/v1/notify/popups', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'update',
            minAppVersion,
            title,
            subtitle,
            playStoreUrl,
            isForceUpdate
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('🚀 Version Update Popup Broadcasted!');
          document.getElementById('popup-update-form').reset();
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to broadcast update popup.', true);
        }
      } catch (err) {
        showToast('Error broadcasting update: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '🚀 Broadcast Version Update Popup';
      }
    }

    async function loadPopupHistory() {
      const container = document.getElementById('popups-history-container');
      if (!container) return;

      try {
        const res = await fetch('/api/v1/notify/popups');
        const json = await res.json();
        if (!json.success || !json.data) return;

        if (json.data.length === 0) {
          container.innerHTML = '<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">No active popups created yet.</div>';
          return;
        }

        container.innerHTML = json.data.map(function(item) {
          return '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; font-size: 12px;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
              '<span style="font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">' +
                '<span style="background: #15803d; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 10px;">' + item.popupId + '</span>' +
                item.title +
              '</span>' +
              '<span style="display:flex;align-items:center;gap:6px;">' +
                (item.type === 'interactive' ? '<button type="button" data-popup-id="' + item._id + '" onclick="viewPopupResponses(this.dataset.popupId)" class="btn" style="background: #dcfce7; color: #15803d; padding: 3px 8px; font-size: 10px; font-weight: 800; border: 1px solid #86efac; border-radius: 6px;">View responses</button>' : '') +
                '<button type="button" data-id="' + item._id + '" onclick="handleDeletePopup(this.dataset.id)" class="btn" style="background: #fee2e2; color: #dc2626; padding: 3px 8px; font-size: 10px; font-weight: 800; border: 1px solid #fca5a5; border-radius: 6px; cursor: pointer;">🗑️ Delete</button>' +
              '</span>' +
            '</div>' +
            (item.subtitle ? '<div style="font-size: 11px; font-weight: 700; color: #15803d; margin-bottom: 4px;">' + item.subtitle + '</div>' : '') +
            '<div style="display: flex; gap: 8px; font-size: 11px; color: #64748b; margin-top: 6px;">' +
              '<span>Type: <strong style="color: #0f172a;">' + item.type + '</strong></span>' +
              (item.actionTarget ? '<span>Target: <strong style="color: #15803d;">' + item.actionTarget + '</strong></span>' : '') +
              (item.minAppVersion ? '<span>Min Ver: <strong style="color: #2563eb;">' + item.minAppVersion + '</strong></span>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        container.innerHTML = '<div style="text-align: center; padding: 24px; color: #ef4444; font-size: 13px;">Error loading popups history.</div>';
      }
    }

    async function handleDeletePopup(id) {
      if (!confirm('Are you sure you want to delete this popup? It will no longer show up to users.')) return;
      try {
        const res = await fetch('/api/v1/notify/popups/' + id, { method: 'DELETE' });
        const json = await res.json();
        if (json.success) {
          showToast('Popup removed successfully.');
          loadPopupHistory();
        } else {
          showToast(json.error || 'Failed to remove popup', true);
        }
      } catch (err) {
        showToast('Error deleting popup: ' + err.message, true);
      }
    }

    function showToast(message, isError = false) {
      const toast = document.getElementById('toast');
      toast.innerText = message;
      toast.className = isError ? 'error' : 'success';
      setTimeout(() => { toast.className = ''; }, 4000);
    }

    async function loadDashboardData() {
      try {
        const res = await fetch('/api/v1/dashboard/overview');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Fetch failed');

        globalData = json;
        renderStats(json.stats);
        renderPendingPapers(json.pendingPapers);
        renderUsers(json.users);
        renderHouses(json.houses);
        renderAppSettings(json.stats || json.settings);
      } catch (err) {
        showToast('Error loading dashboard: ' + err.message, true);
      }
    }

    function renderAppSettings(statsOrSettings) {
      const isDemoOn = statsOrSettings && statsOrSettings.showDemoMaterials !== undefined ? statsOrSettings.showDemoMaterials : true;
      const toggleInput = document.getElementById('toggle-demo-materials');
      const statusBadge = document.getElementById('demo-status-badge');
      const slider = document.getElementById('toggle-slider');
      const knob = document.getElementById('toggle-knob');
      const label = document.getElementById('demo-toggle-status-label');

      if (toggleInput) toggleInput.checked = isDemoOn;

      if (statusBadge) {
        statusBadge.innerText = isDemoOn ? 'ENABLED' : 'DISABLED';
        statusBadge.style.background = isDemoOn ? '#dcfce7' : '#f1f5f9';
        statusBadge.style.color = isDemoOn ? '#15803d' : '#64748b';
      }

      if (slider) {
        slider.style.backgroundColor = isDemoOn ? '#22c55e' : '#cbd5e1';
      }

      if (knob) {
        knob.style.left = isDemoOn ? '29px' : '3px';
      }

      if (label) {
        label.innerText = isDemoOn ? 'Saved in Database (Showing Demo & Real)' : 'Saved in Database (Real Materials Only)';
        label.style.color = isDemoOn ? '#15803d' : '#64748b';
      }
    }

    async function handleDemoMaterialsToggle(enabled) {
      const label = document.getElementById('demo-toggle-status-label');
      if (label) label.innerText = 'Saving setting to database...';

      try {
        const res = await fetch('/api/v1/dashboard/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'showDemoMaterials', value: enabled })
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.message || 'Update failed');

        showToast(json.message || ('Demo materials ' + (enabled ? 'enabled' : 'disabled') + '!'));
        renderAppSettings({ showDemoMaterials: enabled });
      } catch (err) {
        showToast('Setting update failed: ' + err.message, true);
        const toggleInput = document.getElementById('toggle-demo-materials');
        if (toggleInput) toggleInput.checked = !enabled;
        renderAppSettings({ showDemoMaterials: !enabled });
      }
    }

    async function downloadDatabaseBackup() {
      const status = document.getElementById('database-backup-status');
      if (status) status.innerText = 'Preparing complete database backup...';
      try {
        const response = await fetch('/api/v1/dashboard/backup');
        if (!response.ok) throw new Error('Backup request failed (' + response.status + ').');
        const blob = await response.blob();
        const disposition = response.headers.get('content-disposition') || '';
        const match = disposition.match(/filename="?([^";]+)"?/i);
        const filename = match ? match[1] : 'moiconnect-database-backup.json';
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        if (status) status.innerText = 'Full database backup downloaded successfully.';
        showToast('Full database backup downloaded.');
      } catch (err) {
        if (status) status.innerText = 'Backup failed: ' + err.message;
        showToast('Backup failed: ' + err.message, true);
      }
    }

    async function restoreDatabaseBackup(input) {
      const file = input.files && input.files[0];
      if (!file) return;
      const confirmed = window.confirm('This will replace the current database collections with the selected backup. Continue only if this is intentional.');
      if (!confirmed) {
        input.value = '';
        return;
      }
      const status = document.getElementById('database-backup-status');
      if (status) status.innerText = 'Restoring database. Please keep this page open...';
      try {
        const formData = new FormData();
        formData.append('backup', file);
        formData.append('confirmRestore', 'RESTORE_DATABASE');
        const response = await fetch('/api/v1/dashboard/restore', { method: 'POST', body: formData });
        const json = await response.json();
        if (!response.ok || !json.success) throw new Error(json.error || 'Restore failed.');
        if (status) status.innerText = json.message;
        showToast(json.message + ' Refreshing dashboard...');
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        if (status) status.innerText = 'Restore failed: ' + err.message;
        showToast('Restore failed: ' + err.message, true);
      } finally {
        input.value = '';
      }
    }
    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function renderStats(stats) {
      const onlineElem = document.getElementById('stat-online-users');
      if (onlineElem) onlineElem.innerText = stats.totalOnline || 0;

      const subElem = document.getElementById('stat-online-sub');
      if (subElem) {
        const authCount = stats.authenticatedOnline || 0;
        const guestCount = stats.guestOnline || 0;
        subElem.innerText = authCount + ' Logged In • ' + guestCount + (guestCount === 1 ? ' Guest' : ' Guests') + ' (Unknown)';
      }

      document.getElementById('stat-users').innerText = stats.totalUsers || 0;
      document.getElementById('stat-approved-papers').innerText = stats.approvedPapers || 0;
      document.getElementById('stat-pending-papers').innerText = stats.pendingPapers || 0;
      document.getElementById('stat-departments').innerText = stats.totalDepartments || 0;

      const pendingBadge = document.getElementById('badge-pending-count');
      if (stats.pendingPapers > 0) {
        pendingBadge.innerText = stats.pendingPapers;
        pendingBadge.classList.remove('hidden');
      } else {
        pendingBadge.classList.add('hidden');
      }

      // Temp files badge & stats
      const tempBadge = document.getElementById('badge-temp-count');
      if (stats.totalTempFiles > 0) {
        tempBadge.innerText = stats.totalTempFiles;
        tempBadge.classList.remove('hidden');
      } else {
        tempBadge.classList.add('hidden');
      }

      const tempCountElem = document.getElementById('temp-stat-count');
      if (tempCountElem) tempCountElem.innerText = stats.totalTempFiles || 0;
      const tempSizeElem = document.getElementById('temp-stat-size');
      if (tempSizeElem) tempSizeElem.innerText = stats.totalTempSizeFormatted || '0 Bytes';
    }

    function renderPendingPapers(papers) {
      const container = document.getElementById('pending-papers-container');
      const filter = document.getElementById('paper-filter')?.value || 'pending';

      const filtered = filter === 'approved' && globalData?.approvedPapers
        ? globalData.approvedPapers
        : papers;

      if (!filtered || filtered.length === 0) {
        container.innerHTML = '<div style="text-align: center; padding: 48px; background: #f8fafc; border-radius: 12px; border: 2px dashed #cbd5e1;">' +
          '<p style="color: #475569; font-weight: 700; font-size: 14px;">No ' + filter + ' revision materials right now.</p>' +
          '<p style="font-size: 12px; color: #94a3b8; margin-top: 4px;">All student submissions are processed.</p>' +
        '</div>';
        return;
      }

      container.innerHTML = filtered.map(function(paper) {
        const isApproved = paper.status === 'approved';
        const mtidBadge = paper.mtid
          ? '<span class="mtid-tag" style="font-size: 10px; padding: 2px 6px;">' + paper.mtid + '</span>'
          : '<span style="font-size: 10px; background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-weight: 800;">PENDING</span>';

        const schoolName = paper.school ? (paper.school.split('School of ')[1] || paper.school) : '';

        return '<div class="tiny-paper-row" data-id="' + paper._id + '" onclick="openPaperModal(this.dataset.id)">' +
          '<div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">' +
            '<span class="badge-tag" style="font-size: 10px; padding: 2px 6px;">' + ((paper.type || 'DOCUMENT').toUpperCase()) + '</span>' +
            mtidBadge +
            '<span style="font-weight: 800; color: #0f172a; font-size: 13px; font-family: monospace;">' + (paper.unitCode || 'UNIT') + '</span>' +
            '<span style="color: #cbd5e1;">•</span>' +
            '<span style="font-weight: 700; color: #1e293b; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' +
              paper.title +
            '</span>' +
          '</div>' +

          '<div style="display: flex; align-items: center; gap: 10px; font-size: 11px; color: #64748b;">' +
            '<span style="color: #64748b;">' + schoolName + '</span>' +
            '<span class="size-pill">' + formatBytes(paper.fileSize || 0) + '</span>' +
            '<span style="color: #94a3b8;">' + (paper.submittedBy ? paper.submittedBy.name : 'Student') + '</span>' +
            '<button class="btn btn-tiny" data-id="' + paper._id + '" onclick="event.stopPropagation(); openPaperModal(this.dataset.id)" style="background: ' + (isApproved ? '#0284c7' : '#15803d') + '; color: #ffffff;">' +
              (isApproved ? 'Inspect & Edit' : 'Review & Action ⚡') +
            '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function filterPapersList() {
      const q = (document.getElementById('paper-search-input')?.value || '').toLowerCase().trim();
      const filter = document.getElementById('paper-filter')?.value || 'pending';
      const sourceList = filter === 'approved' ? (globalData?.approvedPapers || []) : (globalData?.pendingPapers || []);

      if (!q) {
        renderPendingPapers(sourceList);
        return;
      }

      const filtered = sourceList.filter(p => 
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.unitCode && p.unitCode.toLowerCase().includes(q)) ||
        (p.courseCode && p.courseCode.toLowerCase().includes(q)) ||
        (p.school && p.school.toLowerCase().includes(q)) ||
        (p.unitName && p.unitName.toLowerCase().includes(q)) ||
        (p.department && p.department.toLowerCase().includes(q)) ||
        (p.semester && p.semester.toLowerCase().includes(q)) ||
        (p.academicYear && p.academicYear.toLowerCase().includes(q)) ||
        (p.type && p.type.toLowerCase().includes(q)) ||
        (p.mtid && p.mtid.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.examYear && String(p.examYear).includes(q))
      );
      renderPendingPapers(filtered);
    }

    function openPaperModal(id) {
      const allPapers = [...(globalData?.pendingPapers || []), ...(globalData?.approvedPapers || [])];
      const paper = allPapers.find(p => p._id === id);
      if (!paper) {
        showToast('Document not found in list.', true);
        return;
      }

      currentModalPaper = paper;

      // Header fields
      document.getElementById('modal-title-display').innerText = paper.title || 'Untitled Document';
      document.getElementById('modal-type-badge').innerText = (paper.type || 'DOCUMENT').toUpperCase();

      const mtidBadge = document.getElementById('modal-mtid-badge');
      if (paper.mtid) {
        mtidBadge.innerText = paper.mtid;
        mtidBadge.classList.remove('hidden');
      } else {
        mtidBadge.classList.add('hidden');
      }

      const statusBadge = document.getElementById('modal-status-badge');
      statusBadge.innerText = (paper.status || 'PENDING').toUpperCase();
      if (paper.status === 'approved') {
        statusBadge.style.background = '#dcfce7';
        statusBadge.style.color = '#15803d';
      } else if (paper.status === 'rejected') {
        statusBadge.style.background = '#fee2e2';
        statusBadge.style.color = '#dc2626';
      } else {
        statusBadge.style.background = '#fef3c7';
        statusBadge.style.color = '#b45309';
      }

      document.getElementById('modal-submitter-display').innerText = 
        'Submitted by ' + (paper.submittedBy?.name || 'Student') + 
        (paper.submittedBy?.email ? ' (' + paper.submittedBy.email + ')' : '') + 
        ' on ' + new Date(paper.createdAt).toLocaleString();

      // Media details & links
      const isTemp = paper.tempFilename || (paper.fileUrl && paper.fileUrl.indexOf('/uploads/temp/') !== -1);
      const storageTag = document.getElementById('modal-media-storage-tag');
      if (isTemp) {
        storageTag.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>Server Temp (/mydomain_admin/temp_files/)';
        storageTag.style.background = '#fef3c7';
        storageTag.style.color = '#b45309';
      } else {
        storageTag.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>Cloudinary CDN (MoiConnect/pdf)';
        storageTag.style.background = '#dcfce7';
        storageTag.style.color = '#15803d';
      }

      // Smart format detection
      const fmt = detectFormat(paper.fileUrl, paper.fileType);
      const formatBadge = document.getElementById('modal-format-badge');
      if (formatBadge) {
        formatBadge.innerHTML = fmt.icon + ' ' + fmt.label;
        if (fmt.category === 'image') {
          formatBadge.style.background = '#fdf2f8';
          formatBadge.style.color = '#9d174d';
        } else if (fmt.category === 'docx') {
          formatBadge.style.background = '#e0f2fe';
          formatBadge.style.color = '#0369a1';
        } else if (fmt.category === 'text') {
          formatBadge.style.background = '#fef3c7';
          formatBadge.style.color = '#92400e';
        } else {
          formatBadge.style.background = '#dcfce7';
          formatBadge.style.color = '#15803d';
        }
      }

      const realExt = getRealFileExt(paper.fileUrl, paper.fileType);
      const cleanDownloadName = (paper.unitCode || 'Paper') + '_' + (paper.title || 'file').replace(/[^a-zA-Z0-9_-]/g, '_') + '.' + realExt;
      const downloadBtn = document.getElementById('modal-download-btn');
      downloadBtn.href = '/api/v1/dashboard/papers/' + paper._id + '/download-file';
      downloadBtn.setAttribute('download', cleanDownloadName);

      // Smart preview URL in web tab
      const previewBtn = document.getElementById('modal-preview-btn');
      const smartPreviewUrl = '/admin/preview?url=' + encodeURIComponent(paper.fileUrl) + 
        '&title=' + encodeURIComponent(paper.title || 'Paper') + 
        '&type=' + encodeURIComponent(paper.fileType || fmt.category) + 
        '&id=' + encodeURIComponent(paper._id);
      previewBtn.href = smartPreviewUrl;

      // Inline Smart Preview Card
      const previewCard = document.getElementById('modal-inline-preview-card');
      const previewBody = document.getElementById('modal-inline-preview-body');
      const openLink = document.getElementById('modal-inline-open-link');
      if (openLink) openLink.href = smartPreviewUrl;

      if (previewCard && previewBody) {
        previewCard.style.display = 'block';
        if (Array.isArray(paper.attachments) && paper.attachments.length > 0) {
          let attachmentsHtml = '<div style="display: flex; flex-direction: column; gap: 10px; width: 100%;">';
          paper.attachments.forEach(function(att, idx) {
            const attFmt = detectFormat(att.fileUrl, att.fileType);
            const attName = att.originalName || ('Document ' + (idx + 1));
            const attPrevUrl = '/admin/preview?url=' + encodeURIComponent(att.fileUrl) + 
              '&title=' + encodeURIComponent(attName) + 
              '&type=' + encodeURIComponent(att.fileType || attFmt.category) + 
              '&id=' + encodeURIComponent(paper._id + '_' + idx);

            attachmentsHtml += '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px;">' +
              '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; flex-wrap: wrap; gap: 6px;">' +
                '<div style="display: flex; align-items: center; gap: 8px;">' +
                  '<span style="font-size: 11px; font-weight: 800; background: #0f172a; color: #ffffff; padding: 2px 6px; border-radius: 4px;">Doc #' + (idx + 1) + '</span>' +
                  '<strong style="font-size: 13px; color: #0f172a;">' + escapeMaterialHtml(attName) + '</strong>' +
                  '<span style="font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: #e2e8f0; color: #1e293b;">' + attFmt.label + '</span>' +
                '</div>' +
                '<div style="display: flex; gap: 6px;">' +
                  '<a href="' + attPrevUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px; padding: 4px 10px;">' +
                    'Smart Preview ↗' +
                  '</a>' +
                  '<a href="' + att.fileUrl + '" download class="btn btn-dark" style="font-size: 11px; padding: 4px 10px;">' +
                    'Download' +
                  '</a>' +
                '</div>' +
              '</div>';

            if (attFmt.category === 'image') {
              attachmentsHtml += '<div style="text-align: center; margin-top: 8px;">' +
                '<a href="' + attPrevUrl + '" target="_blank">' +
                  '<img src="' + att.fileUrl + '" alt="Thumbnail" style="max-height: 180px; max-width: 100%; border-radius: 6px; border: 1px solid #cbd5e1; object-fit: contain;" />' +
                '</a>' +
              '</div>';
            } else {
              attachmentsHtml += '<div style="font-size: 11px; color: #64748b; margin-top: 4px;">' + formatBytes(att.fileSize || 0) + ' &middot; Click Smart Preview to open document</div>';
            }

            attachmentsHtml += '</div>';
          });
          attachmentsHtml += '</div>';
          previewBody.innerHTML = attachmentsHtml;
        } else if (fmt.category === 'image') {
          previewBody.innerHTML = '<div style="text-align: center; width: 100%;">' +
            '<a href="' + smartPreviewUrl + '" target="_blank" title="Click to view full image in tab">' +
              '<img src="' + paper.fileUrl + '" alt="Preview" style="max-height: 220px; max-width: 100%; border-radius: 6px; object-fit: contain; box-shadow: 0 2px 8px rgba(0,0,0,0.1); border: 1px solid #e2e8f0;" />' +
            '</a>' +
            '<div style="font-size: 11px; color: #64748b; margin-top: 6px;">Click image or "Open & Preview in Tab" to zoom & rotate</div>' +
          '</div>';
        } else if (fmt.category === 'pdf') {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 20px; color: #15803d;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #0f172a;">PDF Academic Document</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Ready for viewing</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              'Launch PDF Viewer' +
            '</a>' +
          '</div>';
        } else if (fmt.category === 'docx') {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 20px; color: #0369a1;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #0369a1;">Microsoft Word Document (.docx)</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Viewable in Smart Viewer</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              'Launch Word Viewer' +
            '</a>' +
          '</div>';
        } else {
          previewBody.innerHTML = '<div style="display: flex; align-items: center; justify-content: space-between; width: 100%; background: #fefce8; border: 1px solid #fef08a; border-radius: 8px; padding: 12px;">' +
            '<div style="display: flex; align-items: center; gap: 10px;">' +
              '<span style="font-size: 20px; color: #92400e;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg></span>' +
              '<div>' +
                '<div style="font-weight: 800; font-size: 13px; color: #854d0e;">Plain Text / Notes File</div>' +
                '<div style="font-size: 11px; color: #64748b;">' + formatBytes(paper.fileSize || 0) + ' • Monospace text</div>' +
              '</div>' +
            '</div>' +
            '<a href="' + smartPreviewUrl + '" target="_blank" class="btn btn-view" style="font-size: 11px;">' +
              'Launch Text Reader' +
            '</a>' +
          '</div>';
        }
      }

      // Reset media choice to 'current'
      setMediaChoice('current');

      // Form fields
      document.getElementById('modal-input-title').value = paper.title || '';
      document.getElementById('modal-input-code').value = paper.unitCode || paper.courseCode || '';
      document.getElementById('modal-input-year').value = paper.examYear || 2025;
      document.getElementById('modal-input-type').value = paper.type || 'past_paper';
      document.getElementById('modal-input-school').value = paper.school || '';
      document.getElementById('modal-input-department').value = paper.department || '';
      document.getElementById('modal-input-academic-year').value = paper.academicYear || '';
      document.getElementById('modal-input-semester').value = paper.semester || '';
      document.getElementById('modal-input-description').value = paper.description || '';

      // Reset file input
      const replaceInput = document.getElementById('modal-replace-input');
      if (replaceInput) replaceInput.value = '';
      const cleanInfo = document.getElementById('selected-clean-file-info');
      if (cleanInfo) cleanInfo.style.display = 'none';

      // Action buttons state
      const approveBtn = document.getElementById('modal-btn-approve');
      const rejectBtn = document.getElementById('modal-btn-reject');
      if (paper.status === 'approved') {
        approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Already Approved';
        approveBtn.disabled = true;
      } else {
        approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Approve';
        approveBtn.disabled = false;
      }

      // Unhide modal
      document.getElementById('material-modal').classList.remove('hidden');
    }

    function getRealFileExt(url, fallbackType) {
      var clean = (url || '').split('?')[0].toLowerCase();
      var parts = clean.split('.');
      var urlExt = parts.length > 1 ? parts.pop() : '';
      if (['pdf', 'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'docx', 'doc', 'txt', 'csv'].indexOf(urlExt) !== -1) {
        return urlExt === 'jpeg' ? 'jpg' : urlExt;
      }
      var t = (fallbackType || '').toLowerCase();
      if (t === 'image' || t === 'jpeg' || t === 'jpg' || t.indexOf('image') !== -1) return 'jpg';
      if (t === 'png') return 'png';
      if (t === 'webp') return 'webp';
      if (t === 'pdf') return 'pdf';
      if (t === 'docx' || t === 'doc' || t.indexOf('word') !== -1) return 'docx';
      if (t === 'txt' || t === 'text') return 'txt';
      return 'pdf';
    }

    function detectFormat(url, fallbackType) {
      var clean = (url || '').split('?')[0].toLowerCase();
      var parts = clean.split('.');
      var ext = parts.length > 1 ? parts.pop() : '';
      const SVG_IMG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
      const SVG_PDF = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
      const SVG_DOC = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
      const SVG_TXT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

      if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico', 'tiff'].indexOf(ext) !== -1) {
        return { category: 'image', ext: ext.toUpperCase(), icon: SVG_IMG, label: ext.toUpperCase() + ' Image' };
      }
      if (ext === 'pdf') {
        return { category: 'pdf', ext: 'PDF', icon: SVG_PDF, label: 'Adobe PDF' };
      }
      if (['doc', 'docx', 'dotx', 'odt'].indexOf(ext) !== -1) {
        return { category: 'docx', ext: ext.toUpperCase(), icon: SVG_DOC, label: 'Word ' + ext.toUpperCase() };
      }
      if (['txt', 'text', 'md', 'csv', 'json', 'log', 'rtf'].indexOf(ext) !== -1) {
        return { category: 'text', ext: ext.toUpperCase(), icon: SVG_TXT, label: 'Text ' + ext.toUpperCase() };
      }
      if (fallbackType && fallbackType.toLowerCase().indexOf('image') !== -1) {
        return { category: 'image', ext: 'IMG', icon: SVG_IMG, label: 'Image' };
      }
      if (fallbackType && fallbackType.toLowerCase().indexOf('doc') !== -1) {
        return { category: 'docx', ext: 'DOC', icon: SVG_DOC, label: 'Word Document' };
      }
      return { category: 'pdf', ext: 'DOC', icon: SVG_PDF, label: 'Document' };
    }

    var currentMediaMode = 'current';

    function setMediaChoice(mode) {
      currentMediaMode = mode;
      var radioCurrent = document.getElementById('radio-choice-current');
      var radioUpload = document.getElementById('radio-choice-upload');
      var cardCurrent = document.getElementById('choice-card-current');
      var cardUpload = document.getElementById('choice-card-upload');
      var currentBox = document.getElementById('media-status-current-box');
      var uploadBox = document.getElementById('media-status-upload-box');
      var approveBtn = document.getElementById('modal-btn-approve');

      if (mode === 'current') {
        if (radioCurrent) radioCurrent.checked = true;
        if (cardCurrent) { cardCurrent.classList.add('active'); cardCurrent.classList.remove('upload-active'); }
        if (cardUpload) { cardUpload.classList.remove('active'); cardUpload.classList.remove('upload-active'); }
        if (currentBox) currentBox.classList.remove('hidden');
        if (uploadBox) uploadBox.classList.add('hidden');
        if (approveBtn && !approveBtn.disabled) {
          approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Approve';
        }
      } else {
        if (radioUpload) radioUpload.checked = true;
        if (cardUpload) { cardUpload.classList.add('active'); cardUpload.classList.add('upload-active'); }
        if (cardCurrent) { cardCurrent.classList.remove('active'); }
        if (uploadBox) uploadBox.classList.remove('hidden');
        if (currentBox) currentBox.classList.add('hidden');
        if (approveBtn && !approveBtn.disabled) {
          approveBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><polyline points="20 6 9 17 4 12"/></svg>Upload Clean Copy & Approve';
        }
      }
    }

    function onModalFileSelected() {
      var input = document.getElementById('modal-replace-input');
      var info = document.getElementById('selected-clean-file-info');
      if (!input || !input.files || input.files.length === 0) {
        if (info) info.style.display = 'none';
        return;
      }
      var file = input.files[0];
      var fmt = detectFormat(file.name, file.type);
      if (info) {
        info.innerHTML = 'Selected replacement: <b>' + file.name + '</b> (' + formatBytes(file.size) + ') • Format: <b>' + fmt.icon + ' ' + fmt.label + '</b>';
        info.style.display = 'block';
      }
    }

    function copyModalFileUrl() {
      if (!currentModalPaper) return;
      var url = currentModalPaper.fileUrl;
      if (currentModalPaper.tempFilename || (url && url.indexOf('/uploads/temp/') !== -1)) {
        var fn = currentModalPaper.tempFilename || url.split('/uploads/temp/')[1]?.split('?')[0];
        url = window.location.origin + '/mydomain_admin/temp_files/' + fn;
      }
      navigator.clipboard.writeText(url).then(function() {
        showToast('Copied public temp URL: ' + url);
      });
    }

    function closeMaterialModal() {
      document.getElementById('material-modal').classList.add('hidden');
      currentModalPaper = null;
    }

    async function handleSavePaperEdits(e) {
      e.preventDefault();
      if (!currentModalPaper) return;

      const title = document.getElementById('modal-input-title').value.trim();
      const unitCode = document.getElementById('modal-input-code').value.trim().toUpperCase();
      const examYear = parseInt(document.getElementById('modal-input-year').value.trim(), 10) || 2025;
      const type = document.getElementById('modal-input-type').value;
      const school = document.getElementById('modal-input-school').value.trim();
      const department = document.getElementById('modal-input-department').value.trim();
      const academicYear = document.getElementById('modal-input-academic-year').value.trim();
      const semester = document.getElementById('modal-input-semester').value;
      const description = document.getElementById('modal-input-description').value.trim();

      const btn = document.getElementById('btn-save-paper-edits');
      btn.disabled = true;
      btn.innerText = '⏳ Saving...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            courseCode: unitCode,
            unitCode,
            unitName: title,
            examYear,
            type,
            school,
            department: school
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('Saved metadata edits!');
          currentModalPaper = json.data;
          document.getElementById('modal-title-display').innerText = json.data.title;
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to save edits.', true);
        }
      } catch (err) {
        showToast('Error saving: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '💾 Save Metadata Edits';
      }
    }

    async function handleModalFileReplace() {
      if (!currentModalPaper) return;
      const fileInput = document.getElementById('modal-replace-input');
      if (!fileInput.files || fileInput.files.length === 0) {
        showToast('Please choose a replacement file (.pdf, .doc, image) from your device first.', true);
        return;
      }

      const file = fileInput.files[0];
      const formData = new FormData();
      formData.append('file', file);

      const btn = document.getElementById('btn-modal-replace');
      btn.disabled = true;
      btn.innerText = '⏳ Uploading Replacement...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/replace-file', {
          method: 'POST',
          body: formData
        });

        const json = await res.json();
        if (json.success) {
          showToast('Clean replacement file uploaded & old file replaced!');
          currentModalPaper = json.data;
          
          // Update download & preview links
          document.getElementById('modal-download-btn').href = json.data.fileUrl;
          const smartPreviewUrl = '/admin/preview?url=' + encodeURIComponent(json.data.fileUrl) + 
            '&title=' + encodeURIComponent(json.data.title || 'Paper') + 
            '&type=' + encodeURIComponent(json.data.fileType || '') + 
            '&id=' + encodeURIComponent(json.data._id);
          document.getElementById('modal-preview-btn').href = smartPreviewUrl;
          fileInput.value = '';
          const cleanInfo = document.getElementById('selected-clean-file-info');
          if (cleanInfo) cleanInfo.style.display = 'none';
          
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Failed to replace file.', true);
        }
      } catch (err) {
        showToast('Upload error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Upload Clean Copy Now';
      }
    }

    async function approveCurrentPaperFromModal() {
      if (!currentModalPaper) return;
      if (!confirm('Approve "' + currentModalPaper.title + '"? This will transfer the file to Cloudinary (folder: MoiConnect/pdf) and assign an MTID number.')) return;

      const btn = document.getElementById('modal-btn-approve');
      btn.disabled = true;

      // Smart upload if in upload mode and file selected
      if (currentMediaMode === 'upload') {
        const fileInput = document.getElementById('modal-replace-input');
        if (fileInput && fileInput.files && fileInput.files.length > 0) {
          btn.innerText = '⏳ Uploading Clean Replacement...';
          const file = fileInput.files[0];
          const formData = new FormData();
          formData.append('file', file);
          try {
            const replaceRes = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/replace-file', {
              method: 'POST',
              body: formData
            });
            const replaceJson = await replaceRes.json();
            if (!replaceJson.success) {
              showToast('Replacement upload failed: ' + replaceJson.error, true);
              btn.disabled = false;
              btn.innerText = 'Upload Clean Copy & Approve';
              return;
            }
            currentModalPaper = replaceJson.data;
            fileInput.value = '';
          } catch (rErr) {
            showToast('Replacement error: ' + rErr.message, true);
            btn.disabled = false;
            btn.innerText = 'Upload Clean Copy & Approve';
            return;
          }
        }
      }

      btn.innerText = '⏳ Approving...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/approve', {
          method: 'POST'
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          closeMaterialModal();
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Approval failed', true);
        }
      } catch (err) {
        showToast('Approval error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = currentMediaMode === 'upload' ? 'Upload Clean Copy & Approve' : 'Approve';
      }
    }

    async function rejectCurrentPaperFromModal() {
      if (!currentModalPaper) return;
      const reason = prompt('Reason for rejection (sent as notification to student):', 'Document scan quality is unclear or incomplete.');
      if (reason === null) return;

      const btn = document.getElementById('modal-btn-reject');
      btn.disabled = true;
      btn.innerText = '⏳ Rejecting...';

      try {
        const res = await fetch('/api/v1/dashboard/papers/' + currentModalPaper._id + '/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason })
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          closeMaterialModal();
          loadDashboardData();
          loadTempFiles();
        } else {
          showToast(json.error || 'Rejection failed', true);
        }
      } catch (err) {
        showToast('Rejection error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = 'Reject';
      }
    }

    // SERVER MEDIA TEMP MANAGEMENT FUNCTIONS
    async function loadTempFiles() {
      const tbody = document.getElementById('temp-files-table-body');
      if (!tbody) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files');
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to fetch temp files');

        tempFilesData = json.files || [];

        const countElem = document.getElementById('temp-stat-count');
        if (countElem) countElem.innerText = json.totalFiles || 0;
        const sizeElem = document.getElementById('temp-stat-size');
        if (sizeElem) sizeElem.innerText = json.totalSizeFormatted || '0 Bytes';

        const tempBadge = document.getElementById('badge-temp-count');
        if (json.totalFiles > 0) {
          tempBadge.innerText = json.totalFiles;
          tempBadge.classList.remove('hidden');
        } else {
          tempBadge.classList.add('hidden');
        }

        if (tempFilesData.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 36px; color: #94a3b8; font-size: 13px;">No temporary media files on server disk. Everything is clean!</td></tr>';
          return;
        }

        tbody.innerHTML = tempFilesData.map(function(f) {
          var linked = f.associatedPaper;
          var linkedHtml = linked
            ? '<span style="font-size: 11px; font-weight: 700; color: #15803d; background: #dcfce7; padding: 3px 8px; border-radius: 6px;">Linked ' + (linked.unitCode || 'Paper') + ': ' + (linked.title || '') + ' (' + (linked.status || '').toUpperCase() + ')</span>'
            : '<span style="font-size: 11px; font-weight: 700; color: #b45309; background: #fef3c7; padding: 3px 8px; border-radius: 6px;">Unlinked / Orphaned</span>';

          return '<tr>' +
            '<td><input type="checkbox" class="temp-file-cb" data-filename="' + f.filename + '" /></td>' +
            '<td style="font-family: monospace; font-size: 12px; font-weight: 700; color: #0f172a;">' +
              '<div style="display: flex; align-items: center; gap: 6px;">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
                '<span title="' + f.filename + '">' + f.filename + '</span>' +
              '</div>' +
            '</td>' +
            '<td style="font-weight: 700; color: #475569;">' + f.sizeFormatted + '</td>' +
            '<td style="color: #64748b; font-size: 12px;">' + new Date(f.modifiedAt).toLocaleString() + '</td>' +
            '<td>' + linkedHtml + '</td>' +
            '<td style="text-align: right;">' +
              '<div style="display: inline-flex; gap: 6px;">' +
                '<a href="' + f.fileUrl + '" download="' + f.filename + '" class="btn btn-tiny" style="background: #0284c7; color: #ffffff;">' +
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
                  ' Download' +
                '</a>' +
                '<button data-filename="' + f.filename + '" onclick="deleteSingleTemp(this.dataset.filename)" class="btn btn-tiny" style="background: #fee2e2; color: #dc2626; border: 1px solid #fecaca;">' +
                  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
                  ' Delete' +
                '</button>' +
              '</div>' +
            '</td>' +
          '</tr>';
        }).join('');
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #dc2626;">Error loading temporary files: ' + err.message + '</td></tr>';
      }
    }

    function toggleSelectAllTemp(masterCheckbox) {
      const checkboxes = document.querySelectorAll('.temp-file-cb');
      checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
    }

    async function deleteSelectedTempFiles() {
      const checkedBoxes = Array.from(document.querySelectorAll('.temp-file-cb:checked'));
      if (checkedBoxes.length === 0) {
        showToast('Please select at least one file to clean.', true);
        return;
      }

      const filenames = checkedBoxes.map(cb => cb.dataset.filename);
      if (!confirm('Are you sure you want to permanently delete ' + filenames.length + ' temporary file(s) from the server disk?')) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files/delete-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames })
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadTempFiles();
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to delete files', true);
        }
      } catch (err) {
        showToast('Error during cleanup: ' + err.message, true);
      }
    }

    async function deleteSingleTemp(filename) {
      if (!confirm('Permanently delete temporary file "' + filename + '" from server disk?')) return;

      try {
        const res = await fetch('/api/v1/dashboard/temp-files/' + encodeURIComponent(filename), {
          method: 'DELETE'
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadTempFiles();
          loadDashboardData();
        } else {
          showToast(json.error || 'Failed to delete file', true);
        }
      } catch (err) {
        showToast('Error deleting file: ' + err.message, true);
      }
    }

    function renderUsers(users) {
      const tbody = document.getElementById('users-table-body');
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 32px; color: #94a3b8;">No users found.</td></tr>';
        return;
      }

      const onlineIds = globalData?.stats?.onlineUserIds || [];

      tbody.innerHTML = users.map(function(u) {
        const isOnline = onlineIds.includes(u._id);
        const initial = (u.name || 'U')[0].toUpperCase();
        const roles = (u.roles || ['student']).join(', ');
        const landlordBadge = u.landlordStatus === 'approved'
          ? '<span style="font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 6px; background: #dcfce7; color: #166534;">approved</span>'
          : '<span style="font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 6px; background: #f1f5f9; color: #64748b;">' + (u.landlordStatus || 'none') + '</span>';

        const onlineBadge = isOnline
          ? '<span style="font-size: 10px; font-weight: 800; background: #dcfce7; color: #15803d; padding: 3px 8px; border-radius: 12px; border: 1px solid #bbf7d0; display: inline-flex; align-items: center; gap: 4px;"><span style="width: 6px; height: 6px; background-color: #22c55e; border-radius: 50%;"></span> Online</span>'
          : '<span style="font-size: 10px; font-weight: 600; color: #94a3b8; display: inline-flex; align-items: center; gap: 4px;"><span style="width: 6px; height: 6px; background-color: #cbd5e1; border-radius: 50%;"></span> Offline</span>';

        return '<tr>' +
          '<td style="font-weight: 700; color: #0f172a; display: flex; align-items: center; gap: 8px;">' +
            '<div style="position: relative; width: 28px; height: 28px; border-radius: 50%; background: #15803d; color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800;">' +
              initial +
              (isOnline ? '<span title="User Online Now" style="position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; background-color: #22c55e; border: 2px solid #ffffff; border-radius: 50%;"></span>' : '') +
            '</div>' +
            (u.name || 'Student') +
          '</td>' +
          '<td style="font-family: monospace; font-size: 12px;">' + u.email + '</td>' +
          '<td>' +
            '<span style="font-size: 10px; font-weight: 800; text-transform: uppercase; background: #f1f5f9; color: #334155; padding: 3px 8px; border-radius: 6px; border: 1px solid #cbd5e1;">' +
              roles +
            '</span>' +
          '</td>' +
          '<td>' + landlordBadge + '</td>' +
          '<td>' + onlineBadge + '</td>' +
          '<td style="color: #94a3b8; font-size: 12px;">' +
            new Date(u.createdAt).toLocaleDateString() +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function filterUsers() {
      const q = document.getElementById('user-search').value.toLowerCase();
      if (!globalData || !globalData.users) return;

      const filtered = globalData.users.filter(u =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q))
      );
      renderUsers(filtered);
    }

    function renderHouses(houses) {
      const container = document.getElementById('houses-container');
      if (!houses || houses.length === 0) {
        container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 48px; background: #f8fafc; border-radius: 12px; border: 2px dashed #cbd5e1; color: #94a3b8; font-size: 14px;">No rental houses posted yet.</div>';
        return;
      }

      container.innerHTML = houses.map(function(h) {
        return '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; display: flex; flex-direction: column; justify-content: space-between;">' +
          '<div>' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
              '<span style="font-size: 12px; font-weight: 800; color: #15803d; background: #dcfce7; padding: 3px 8px; border-radius: 6px;">' +
                'KSh ' + (h.price ? h.price.toLocaleString() : 0) + ' / mo' +
              '</span>' +
              '<span style="font-size: 10px; font-weight: 800; text-transform: uppercase; color: #64748b; background: #ffffff; padding: 2px 6px; border-radius: 4px; border: 1px solid #cbd5e1;">' +
                h.status +
              '</span>' +
            '</div>' +
            '<h4 style="font-size: 14px; font-weight: 800; color: #0f172a; margin-bottom: 4px;">' + h.title + '</h4>' +
            '<p style="font-size: 12px; color: #64748b;">' + h.location + ' • ' + h.type + '</p>' +
          '</div>' +
          '<div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; display: flex; justify-content: space-between;">' +
            '<span>Landlord: <strong>' + (h.landlordId ? h.landlordId.name : 'Owner') + '</strong></span>' +
            '<span>Phone: ' + (h.landlordId ? h.landlordId.phone : 'N/A') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function toggleEmailBox() {
      const isEmails = document.querySelector('input[name="push-target"]:checked')?.value === 'emails';
      const box = document.getElementById('email-recipients-box');
      if (box) {
        if (isEmails) {
          box.classList.remove('hidden');
        } else {
          box.classList.add('hidden');
        }
      }
    }

    function insertMagicVar(variable) {
      const textarea = document.getElementById('push-body');
      if (textarea) {
        textarea.value += variable;
        textarea.focus();
      }
    }

    async function handleSendPush(e) {
      e.preventDefault();
      const title = document.getElementById('push-title').value;
      const subtitle = document.getElementById('push-subtitle').value;
      const icon = document.querySelector('input[name="push-icon"]:checked')?.value || 'bell';
      const target = document.querySelector('input[name="push-target"]:checked')?.value || 'all';
      const recipientEmails = document.getElementById('push-emails')?.value || '';
      const body = document.getElementById('push-body').value;

      const btn = document.getElementById('btn-submit-push');
      btn.disabled = true;
      btn.innerText = '⏳ Dispatching Push Notification...';

      try {
        const res = await fetch('/api/v1/admin/push-notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            subtitle,
            icon,
            target,
            recipientEmails,
            body
          })
        });

        const json = await res.json();
        if (json.success) {
          showToast('🚀 ' + json.message);
          document.getElementById('push-form').reset();
          toggleEmailBox();
          loadPushHistory();
        loadRegisteredPushDevices();
        } else {
          showToast(json.error || 'Push dispatch failed.', true);
        }
      } catch (err) {
        showToast('Push dispatch error: ' + err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerText = '🚀 Dispatch Android Push Notification';
      }
    }

    async function loadPushHistory() {
      const container = document.getElementById('push-history-container');
      if (!container) return;

      try {
        const res = await fetch('/api/v1/admin/push-history');
        const json = await res.json();
        if (!json.success || !json.history) return;

        if (json.history.length === 0) {
          container.innerHTML = '<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">No push notifications sent yet.</div>';
          return;
        }

        const ICON_MAP = {
          bell: '🔔',
          academic: '🎓',
          house: '🏠',
          alert: '⚡'
        };

        container.innerHTML = json.history.map(function(item) {
          const iconSymbol = ICON_MAP[item.icon] || '🔔';
          const subtitleHtml = item.subtitle ? '<div style="font-size: 11px; font-weight: 700; color: #15803d; margin-bottom: 4px;">' + item.subtitle + '</div>' : '';
          const targetText = item.target === 'emails' ? (item.recipientEmails || []).join(', ') : 'All Users & Guests';

          return '<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; font-size: 12px;">' +
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">' +
              '<span style="font-weight: 800; color: #0f172a; display: flex; align-items: center; gap: 6px;">' +
                '<span>' + iconSymbol + '</span> ' + item.title +
              '</span>' +
              '<span style="font-size: 10px; font-weight: 800; text-transform: uppercase; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px;">' +
                item.target +
              '</span>' +
            '</div>' +
            subtitleHtml +
            '<div style="color: #475569; margin-bottom: 6px; line-height: 1.4;">' + item.body + '</div>' +
            '<div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; color: #94a3b8; font-size: 11px;">' +
              '<span>Target: ' + targetText + '</span>' +
              '<span style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;"><span>' + new Date(item.createdAt).toLocaleString() + '</span><button type="button" onclick="deletePushHistoryItem(&quot;' + item._id + '&quot;)" class="btn" style="background:#fee2e2;color:#dc2626;padding:3px 8px;font-size:10px;font-weight:800;border:1px solid #fca5a5;border-radius:6px;cursor:pointer;">🗑️ Delete</button></span>' +
            '</div>' +
          '</div>';
        }).join('');
      } catch (err) {
        console.error('Failed to load push history:', err);
      }
    }

    async function deleteAllPopupHistory() {
      if (!confirm('Delete all in-app popup history and response records? This cannot be undone.')) return;
      try {
        const res = await fetch('/api/v1/notify/popups', { method: 'DELETE' });
        const json = await res.json();
        if (!json.success) throw new Error(json.error || 'Failed to delete popup history');
        showToast((json.deletedCount || 0) + ' in-app popup record(s) deleted.');
        loadPopupHistory();
      } catch (err) {
        showToast('Error deleting popup history: ' + err.message, true);
      }
    }

    async function deletePushHistoryItem(id) {
      if (!confirm('Delete this notification from the server inbox? It cannot retract a push already shown on a device.')) return;
      try {
        const response = await fetch('/api/v1/admin/push-history/' + encodeURIComponent(id), { method: 'DELETE' });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to delete notification');
        showToast(json.message || 'Notification deleted.');
        loadPushHistory();
      } catch (error) {
        showToast('Failed to delete notification: ' + error.message, true);
      }
    }

    async function deleteAllPushHistory() {
      if (!confirm('Delete all Android push notification history? This cannot retract notifications already shown on devices.')) return;
      try {
        const response = await fetch('/api/v1/admin/push-history', { method: 'DELETE' });
        const json = await response.json();
        if (!json.success) throw new Error(json.error || 'Failed to delete push history');
        showToast((json.deletedCount || 0) + ' push notification record(s) deleted.');
        loadPushHistory();
      } catch (error) {
        showToast('Failed to delete push history: ' + error.message, true);
      }
    }

    async function loadCommunityMessagesAdmin() {
      const tbody = document.getElementById('community-messages-table-body');
      if (!tbody) return;

      try {
        const res = await fetch('/api/v1/dashboard/community-messages');
        const json = await res.json();
        if (!json.success || !json.data) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #dc2626;">Failed to load community messages: ' + (json.error || 'Unknown error') + '</td></tr>';
          return;
        }

        globalCommunityMessages = json.data || [];

        const totalElem = document.getElementById('community-stat-total');
        if (totalElem) totalElem.innerText = json.count || 0;
        const mediaElem = document.getElementById('community-stat-media');
        if (mediaElem) mediaElem.innerText = json.mediaCount || 0;

        const badgeElem = document.getElementById('badge-community-count');
        if (badgeElem) {
          if (json.count > 0) {
            badgeElem.innerText = json.count;
            badgeElem.classList.remove('hidden');
          } else {
            badgeElem.classList.add('hidden');
          }
        }

        renderCommunityMessagesTable(globalCommunityMessages);
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 24px; color: #dc2626;">Error loading community messages: ' + err.message + '</td></tr>';
      }
    }

    function renderCommunityMessagesTable(messages) {
      const tbody = document.getElementById('community-messages-table-body');
      if (!tbody) return;

      if (!messages || messages.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 36px; color: #94a3b8; font-size: 13px;">No community messages found.</td></tr>';
        return;
      }

      tbody.innerHTML = messages.map(function(m) {
        const isSystem = m.type === 'system_notice';
        const senderName = isSystem ? 'System Notice' : (m.senderName || 'Anonymous');
        const senderRole = isSystem ? 'SYSTEM' : (m.senderRole || 'student').toUpperCase();
        
        const senderEmail = m.senderEmail || m.email || '';
        let senderHtml = '<div style="display: flex; align-items: center; gap: 8px;">' +
          '<div style="width: 28px; height: 28px; border-radius: 50%; background: ' + (isSystem ? '#3b82f6' : '#15803d') + '; color: #ffffff; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 800;">' +
            (isSystem ? '⚙️' : senderName[0].toUpperCase()) +
          '</div>' +
          '<div>' +
            '<div style="font-weight: 700; color: #0f172a; font-size: 12px;">' + senderName + '</div>' +
            (senderEmail ? '<div style="font-size: 10px; color: #0284c7; font-weight: 600;">' + senderEmail + '</div>' : '') +
            '<div style="font-size: 10px; font-weight: 800; color: ' + (isSystem ? '#2563eb' : '#64748b') + ';">' + senderRole + '</div>' +
          '</div>' +
        '</div>';

        let contentHtml = '<div style="color: #334155; font-size: 13px; font-weight: 600;">' + (m.message || m.text || '<em style="color:#94a3b8;">No text message</em>') + '</div>';
        if (m.replyTo) {
          contentHtml = '<div style="font-size: 11px; color: #64748b; background: #f1f5f9; padding: 3px 6px; border-radius: 4px; margin-bottom: 4px;">↩️ Replying to: ' + (m.replyTo.senderName || 'user') + (m.replyTo.senderEmail ? ' (' + m.replyTo.senderEmail + ')' : '') + '</div>' + contentHtml;
        }

        let mediaHtml = '<span style="color: #94a3b8; font-size: 11px;">None</span>';
        if (m.fileAttachment && m.fileAttachment.url) {
          const fileType = (m.fileAttachment.fileType || m.fileAttachment.type || 'file').toUpperCase();
          const fileName = m.fileAttachment.fileName || m.fileAttachment.name || 'Attachment';
          const isImg = ['IMAGE', 'JPG', 'PNG', 'WEBP', 'GIF'].includes(fileType);

          mediaHtml = '<div style="display: flex; align-items: center; gap: 8px;">' +
            (isImg ? '<img src="' + m.fileAttachment.url + '" style="width: 36px; height: 36px; border-radius: 6px; object-fit: cover; border: 1px solid #cbd5e1;" />' : '') +
            '<div>' +
              '<a href="' + m.fileAttachment.url + '" target="_blank" download style="font-weight: 700; font-size: 11px; color: #0284c7; text-decoration: none;">' +
                '📎 ' + fileName +
              '</a>' +
              '<div style="font-size: 10px; font-weight: 800; color: #64748b;">' + fileType + ' • ' + formatBytes(m.fileAttachment.fileSize || m.fileAttachment.size || 0) + '</div>' +
            '</div>' +
          '</div>';
        }

        return '<tr>' +
          '<td><input type="checkbox" class="community-msg-cb" data-id="' + m._id + '" /></td>' +
          '<td>' + senderHtml + '</td>' +
          '<td style="max-width: 340px; word-break: break-word;">' + contentHtml + '</td>' +
          '<td>' + mediaHtml + '</td>' +
          '<td style="color: #64748b; font-size: 11px;">' + new Date(m.createdAt).toLocaleString() + '</td>' +
          '<td style="text-align: right;">' +
            '<button data-id="' + m._id + '" onclick="deleteSingleCommunityMessage(this.dataset.id)" class="btn btn-tiny" style="background: #fee2e2; color: #dc2626; border: 1px solid #fecaca;">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
              ' Wipe' +
            '</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function toggleSelectAllCommunity(masterCheckbox) {
      const checkboxes = document.querySelectorAll('.community-msg-cb');
      checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
    }

    function filterCommunityMessages() {
      const q = (document.getElementById('community-search-input')?.value || '').toLowerCase().trim();
      if (!q) {
        renderCommunityMessagesTable(globalCommunityMessages);
        return;
      }

      const filtered = globalCommunityMessages.filter(m =>
        (m.senderName && m.senderName.toLowerCase().includes(q)) ||
        (m.senderEmail && m.senderEmail.toLowerCase().includes(q)) ||
        (m.message && m.message.toLowerCase().includes(q)) ||
        (m.text && m.text.toLowerCase().includes(q)) ||
        (m.fileAttachment?.fileName && m.fileAttachment.fileName.toLowerCase().includes(q)) ||
        (m.fileAttachment?.name && m.fileAttachment.name.toLowerCase().includes(q))
      );
      renderCommunityMessagesTable(filtered);
      renderCommunityMessagesTable(filtered);
    }

    function deleteSingleCommunityMessage(id) {
      executeCommunityDelete([id]);
    }

    function deleteSelectedCommunityMessages() {
      const checked = Array.from(document.querySelectorAll('.community-msg-cb:checked'));
      if (checked.length === 0) {
        showToast('Please select at least one community message to delete.', true);
        return;
      }
      const ids = checked.map(cb => cb.dataset.id);
      executeCommunityDelete(ids);
    }

    async function executeCommunityDelete(ids) {
      if (!ids || ids.length === 0) return;
      if (!confirm('Completely delete and wipe ' + ids.length + ' community message(s) from MongoDB and Cloudinary storage? Zero trace will remain.')) return;

      try {
        const res = await fetch('/api/v1/dashboard/community-messages', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });

        const json = await res.json();
        if (json.success) {
          showToast(json.message);
          loadCommunityMessagesAdmin();
        } else {
          showToast(json.error || 'Failed to delete community messages', true);
        }
      } catch (err) {
        showToast('Delete error: ' + err.message, true);
      }
    }

    // Auto load on page render
    loadDashboardData();
    loadPushHistory();
        loadRegisteredPushDevices();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
};
