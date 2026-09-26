import { Response } from 'express';
import path from 'path';
import { Paper } from '../models/Paper';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreatePaperInput } from '@moi/shared';
import { getSignedCloudinaryUrl } from '../services/tempFileService';

export const getPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '50', 10);
    const skip = (page - 1) * limit;

    const { school, courseCode, unitCode, type, semester, year, search, includePending } = req.query;

    const query: any = {};

    query.status = includePending === 'true' ? { $in: ['approved', 'pending'] } : 'approved';
    query.isHidden = { $ne: true };

    if (school) query.school = school;
    if (courseCode) query.courseCode = (courseCode as string).toUpperCase();
    if (unitCode) query.unitCode = (unitCode as string).toUpperCase();
    if (type) query.type = type;
    if (semester) query.semester = semester;
    if (year) query.examYear = parseInt(year as string, 10);

    if (search) {
      const searchRegex = new RegExp(search as string, 'i');
      query.$or = [
        { title: searchRegex },
        { unitCode: searchRegex },
        { unitName: searchRegex },
        { school: searchRegex }
      ];
    }

    const total = await Paper.countDocuments(query);
    const papers = await Paper.find(query)
      .populate('submittedBy', 'name email avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const papersWithSignedUrls = papers.map((paper) => {
      const data = paper.toObject();
      data.fileUrl = getSignedCloudinaryUrl(data.publicId, data.fileUrl, data.fileType);
      return data;
    });

    res.json({
      success: true,
      data: papersWithSignedUrls,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch academic papers' });
  }
};

export const getPaperById = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findById(id).populate('submittedBy', 'name email avatarUrl');

    if (!paper) {
      res.status(404).json({ success: false, error: 'Academic resource not found.' });
      return;
    }

    if (paper.isHidden) {
      const isAdmin = !!(req.user && req.user.roles.includes('admin'));
      const submitterId = paper.submittedBy ? ((paper.submittedBy as any)._id || paper.submittedBy).toString() : null;
      const isSubmitter = !!(req.user && submitterId && submitterId === req.user._id.toString());
      if (!isAdmin && !isSubmitter) {
        res.status(404).json({ success: false, error: 'Academic resource not found.' });
        return;
      }
    }

    // Unapproved papers can only be viewed by submitter or admin
    if (paper.status !== 'approved') {
      const submitterId = paper.submittedBy ? ((paper.submittedBy as any)._id || paper.submittedBy).toString() : null;
      const isSubmitter = !!(req.user && submitterId && submitterId === req.user._id.toString());
      const isAdmin = !!(req.user && req.user.roles.includes('admin'));
      if (!isSubmitter && !isAdmin) {
        res.status(403).json({ success: false, error: 'This academic resource is pending approval.' });
        return;
      }
    }

    const paperData = paper.toObject();
    paperData.fileUrl = getSignedCloudinaryUrl(paperData.publicId, paperData.fileUrl, paperData.fileType);
    res.json({ success: true, data: paperData });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch paper' });
  }
};

export const uploadPaperFile = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, error: 'No file uploaded' });
      return;
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

    res.status(201).json({
      success: true,
      message: 'File temporarily saved to server for admin verification.',
      data: {
        tempFilename: req.file.filename,
        originalName: req.file.originalname,
        fileUrl: fullUrl,
        relativeUrl,
        fileSize: req.file.size,
        fileType: detectedType
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'File upload failed' });
  }
};

export const createPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const input: CreatePaperInput = req.body;
    const userId = req.user ? req.user._id : undefined;

    let tempFilename = (input as any).tempFilename;
    if (!tempFilename && input.fileUrl && input.fileUrl.includes('/uploads/temp/')) {
      tempFilename = input.fileUrl.split('/uploads/temp/')[1]?.split('?')[0];
    }

    const newPaper = await Paper.create({
      ...input,
      tempFilename,
      submittedBy: userId,
      status: 'pending',
      downloads: 0
    });

    const populated = userId ? await newPaper.populate('submittedBy', 'name email avatarUrl') : newPaper;

    res.status(201).json({
      success: true,
      message: 'Academic paper submitted successfully and is pending administrator review.',
      data: populated
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Paper submission failed' });
  }
};

export const getMySubmissions = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const user = req.user!;
    const papers = await Paper.find({ submittedBy: user._id }).sort({ createdAt: -1 });

    res.json({
      success: true,
      data: papers
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch submissions' });
  }
};

export const downloadPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const paper = await Paper.findByIdAndUpdate(id, { $inc: { downloads: 1 } }, { new: true });
    if (!paper) {
      res.status(404).json({ success: false, error: 'Resource not found' });
      return;
    }

    if (paper.isHidden) {
      res.status(404).json({ success: false, error: 'Resource not found' });
      return;
    }

    res.json({
      success: true,
      data: { fileUrl: paper.fileUrl, downloads: paper.downloads }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Download failed' });
  }
};
