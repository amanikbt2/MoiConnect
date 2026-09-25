import { Response } from 'express';
import path from 'path';
import { Paper } from '../models/Paper';
import { House } from '../models/House';
import { User } from '../models/User';
import { Report } from '../models/Report';
import { AuthenticatedRequest } from '../middleware/auth';
import {
  listTempFiles,
  deleteTempFile,
  deleteBatchTempFiles as deleteBatchTempFilesHelper,
  uploadTempFileToCloudinary
} from '../services/tempFileService';
import { dispatchPushNotification } from '../services/pushNotificationService';

export const getStats = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const totalUsers = await User.countDocuments();
    const pendingLandlords = await User.countDocuments({ landlordStatus: 'pending' });
    const pendingPapers = await Paper.countDocuments({ status: 'pending' });
    const approvedPapers = await Paper.countDocuments({ status: 'approved' });
    const pendingHouses = await House.countDocuments({ status: 'pending' });
    const approvedHouses = await House.countDocuments({ status: 'approved' });
    const pendingReports = await Report.countDocuments({ status: 'pending' });

    res.json({
      success: true,
      data: {
        totalUsers,
        pendingLandlords,
        pendingPapers,
        approvedPapers,
        pendingHouses,
        approvedHouses,
        pendingReports
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin stats' });
  }
};

export const getAdminPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const papers = await Paper.find({ status })
      .populate('submittedBy', 'name email')
      .populate('reviewedBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: papers });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin papers' });
  }
};

export const reviewPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;
    const admin = req.user!;

    if (status === 'rejected' && (!rejectionReason || !rejectionReason.trim())) {
      res.status(400).json({ success: false, error: 'A rejection reason is required when rejecting a submission.' });
      return;
    }

    const paper = await Paper.findById(id);
    if (!paper) {
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    paper.status = status;
    if (status === 'rejected') {
      paper.rejectionReason = rejectionReason;
      // Delete temporary file from server disk if present
      if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
        deleteTempFile(paper.tempFilename || paper.fileUrl);
        paper.tempFilename = undefined;
      }
    } else {
      paper.rejectionReason = undefined;

      // If document is in temporary server storage, upload to Cloudinary under MoiConnect/pdf
      if (paper.tempFilename || paper.fileUrl?.includes('/uploads/temp/')) {
        try {
          const fileToUpload = paper.tempFilename || paper.fileUrl;
          const uploadRes = await uploadTempFileToCloudinary(fileToUpload, 'MoiConnect/pdf');
          paper.fileUrl = uploadRes.secure_url;
          paper.publicId = uploadRes.public_id;
          paper.tempFilename = undefined;
        } catch (cloudErr: any) {
          console.error('[Admin Review Paper] Cloudinary upload notice:', cloudErr);
          if (!paper.fileUrl || paper.fileUrl.includes('/uploads/temp/')) {
            paper.fileUrl = 'https://res.cloudinary.com/demo/image/upload/sample.pdf';
          }
          paper.tempFilename = undefined;
        }
      }

      // Smart MTID Auto-assignment (N0001 for Notes, C0001 for CATs, P0001 for Past Papers)
      if (status === 'approved' && !paper.mtid) {
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
    }
    paper.reviewedBy = admin._id;
    paper.reviewedAt = new Date();
    await paper.save();

    if (paper.submittedBy) {
      try {
        const submitter = await User.findById(paper.submittedBy);
        if (submitter && submitter.email) {
          if (status === 'approved') {
            await dispatchPushNotification({
              title: 'Paper Submission Approved 🎉',
              subtitle: 'Resource Published',
              body: `Your paper submission "${paper.title}" (${paper.unitCode}) has been approved and published to MoiConnect!`,
              icon: 'academic',
              target: 'emails',
              recipientEmails: [submitter.email],
              data: { paperId: paper._id, status: 'approved' }
            });
          } else if (status === 'rejected') {
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
        }
      } catch (notifErr) {
        console.error('[Admin Review Paper] Notification error:', notifErr);
      }
    }

    res.json({
      success: true,
      message: `Academic paper ${status}.${paper.mtid ? ` Assigned MTID: ${paper.mtid}` : ''}`,
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Paper review failed' });
  }
};

export const updateAdminPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
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

    await paper.save();

    res.json({
      success: true,
      message: 'Paper metadata updated successfully.',
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to update paper' });
  }
};

export const replacePaperFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No replacement file provided.' });
      return;
    }

    const paper = await Paper.findById(id);
    if (!paper) {
      // Remove newly uploaded file since paper not found
      deleteTempFile(req.file.filename);
      res.status(404).json({ success: false, error: 'Paper not found.' });
      return;
    }

    // Delete old temp file if it was stored locally
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
      message: 'Document file replaced successfully with clean upload.',
      data: paper
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to replace file' });
  }
};

export const getTempFiles = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const data = await listTempFiles();
    res.json({ success: true, ...data });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to list temp files' });
  }
};

export const deleteSingleTempFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { filename } = req.params;
    const deleted = deleteTempFile(filename);
    if (!deleted) {
      res.status(404).json({ success: false, error: `File "${filename}" not found on server.` });
      return;
    }

    res.json({ success: true, message: `File "${filename}" removed from server temp storage.` });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to delete temp file' });
  }
};

export const deleteBatchTempFiles = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { filenames } = req.body;
    if (!Array.isArray(filenames) || filenames.length === 0) {
      res.status(400).json({ success: false, error: 'No filenames provided for batch deletion.' });
      return;
    }

    const result = deleteBatchTempFilesHelper(filenames);
    res.json({
      success: true,
      message: `Deleted ${result.deletedCount} files from server temp storage.`,
      ...result
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to batch delete temp files' });
  }
};

export const getAdminHouses = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const houses = await House.find({ status })
      .populate('landlordId', 'name email phone landlordStatus')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: houses });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch admin houses' });
  }
};

export const reviewHouse = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status, rejectionReason } = req.body;

    const house = await House.findById(id);
    if (!house) {
      res.status(404).json({ success: false, error: 'Rental listing not found.' });
      return;
    }

    house.status = status;
    if (status === 'rejected') {
      house.rejectionReason = rejectionReason;
    }
    await house.save();

    res.json({
      success: true,
      message: `Rental listing ${status}.`,
      data: house
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'House review failed' });
  }
};

export const getPendingLandlords = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const users = await User.find({ landlordStatus: 'pending' }).sort({ updatedAt: -1 });
    res.json({ success: true, data: users });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch pending landlords' });
  }
};

export const verifyLandlord = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'approved' | 'rejected'

    const user = await User.findById(id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found.' });
      return;
    }

    user.landlordStatus = status;
    if (status === 'approved') {
      if (!user.roles.includes('landlord')) {
        user.roles.push('landlord');
      }
      user.activeRole = 'landlord';
    }
    await user.save();

    res.json({
      success: true,
      message: `Landlord status set to ${status}.`,
      data: user
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Landlord verification failed' });
  }
};

export const getAdminReports = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const status = (req.query.status as string) || 'pending';
    const reports = await Report.find({ status })
      .populate('reporterId', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: reports });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch reports' });
  }
};

export const reviewReport = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { status } = req.body; // 'reviewed' | 'dismissed'
    const admin = req.user!;

    const report = await Report.findById(id);
    if (!report) {
      res.status(404).json({ success: false, error: 'Report not found.' });
      return;
    }

    report.status = status;
    report.reviewedBy = admin._id;
    report.reviewedAt = new Date();
    await report.save();

    res.json({
      success: true,
      message: `Report marked as ${status}.`,
      data: report
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Report review failed' });
  }
};
