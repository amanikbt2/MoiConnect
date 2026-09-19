import { Response } from 'express';
import { Paper } from '../models/Paper';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreatePaperInput } from '@moi/shared';

export const getPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '20', 10);
    const skip = (page - 1) * limit;

    const { school, courseCode, unitCode, type, semester, year, search } = req.query;

    const query: any = { status: 'approved' };

    if (school) query.school = school;
    if (courseCode) query.courseCode = (courseCode as string).toUpperCase();
    if (unitCode) query.unitCode = (unitCode as string).toUpperCase();
    if (type) query.type = type;
    if (semester) query.semester = semester;
    if (year) query.examYear = parseInt(year as string, 10);

    if (search) {
      query.$text = { $search: search as string };
    }

    const total = await Paper.countDocuments(query);
    const papers = await Paper.find(query)
      .populate('submittedBy', 'name email avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: papers,
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

    // Unapproved papers can only be viewed by submitter or admin
    if (paper.status !== 'approved') {
      const isSubmitter = req.user && paper.submittedBy._id.toString() === req.user._id.toString();
      const isAdmin = req.user && req.user.roles.includes('admin');
      if (!isSubmitter && !isAdmin) {
        res.status(403).json({ success: false, error: 'This academic resource is pending approval.' });
        return;
      }
    }

    res.json({ success: true, data: paper });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Failed to fetch paper' });
  }
};

export const createPaper = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const input: CreatePaperInput = req.body;
    const user = req.user!;

    const newPaper = await Paper.create({
      ...input,
      submittedBy: user._id,
      status: 'pending',
      downloads: 0
    });

    const populated = await newPaper.populate('submittedBy', 'name email avatarUrl');

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

    res.json({
      success: true,
      data: { fileUrl: paper.fileUrl, downloads: paper.downloads }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Download failed' });
  }
};
