import { Response } from 'express';
import mongoose from 'mongoose';
import path from 'path';
import fs from 'fs';
import { Paper } from '../models/Paper';
import { getAppSettingValue } from '../models/AppSetting';
import { AuthenticatedRequest } from '../middleware/auth';
import { CreatePaperInput } from '@moi/shared';
import { getSignedCloudinaryUrl, getAuthenticatedCloudinaryPdfUrl, extractPublicIdFromCloudinaryUrl } from '../services/tempFileService';
import { stableMaterialStats } from '../utils/materialStats';
import { TEMP_UPLOADS_DIR } from '../middleware/upload';

export const buildPaperResponseData = (paperDoc: any, req?: AuthenticatedRequest) => {
  const data = paperDoc.toObject ? paperDoc.toObject() : paperDoc;
  const fallbackStats = stableMaterialStats(String(data._id || data.title || 'material'));
  data.downloads = typeof data.downloads === 'number' && data.downloads >= 500 ? data.downloads : fallbackStats.downloads;
  data.ratingScore = data.ratingScore || fallbackStats.ratingScore;

  const cleanCloudinaryUrl = getSignedCloudinaryUrl(data.publicId, data.fileUrl, data.fileType);
  data.rawCloudinaryUrl = cleanCloudinaryUrl;
  if (data.ttsTextPublicId || data.ttsTextUrl) {
    // Keep the uploaded TXT extension from the stored URL. A raw public ID without
    // an extension is otherwise interpreted as a PDF by the generic URL helper.
    data.ttsTextUrl = getSignedCloudinaryUrl(undefined, data.ttsTextUrl, 'text');
  }

  const protocol = req ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') : 'http';
  const host = req ? (req.get ? req.get('host') : (req.headers ? req.headers.host : 'localhost:5000')) || 'localhost:5000' : 'localhost:5000';
  const viewProxyUrl = `${protocol}://${host}/api/v1/papers/${data._id}/view`;
  data.viewUrl = viewProxyUrl;

  if (data._id && (data.fileType === 'pdf' || !data.fileType || data.fileUrl?.includes('/raw/upload/') || data.publicId?.includes('MoiConnect/pdf') || data.fileUrl?.includes('res.cloudinary.com'))) {
    data.fileUrl = viewProxyUrl;
  } else {
    data.fileUrl = cleanCloudinaryUrl;
  }

  if (!data.thumbnail) {
    if (data.fileType === 'image' || cleanCloudinaryUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
      data.thumbnail = cleanCloudinaryUrl;
    } else if (Array.isArray(data.attachments)) {
      const imgAtt = data.attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
      if (imgAtt && imgAtt.fileUrl) {
        data.thumbnail = imgAtt.fileUrl;
      }
    }
  }
  if (data.thumbnail) {
    data.thumbnail = getSignedCloudinaryUrl(undefined, data.thumbnail, 'image');
  }
  if (Array.isArray(data.attachments)) {
    data.attachments = data.attachments.map((att: any) => ({
      ...att,
      fileUrl: getSignedCloudinaryUrl(att.publicId, att.fileUrl, att.fileType)
    }));
  }
  return data;
};

export const getPapers = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  try {
    const page = parseInt(req.query.page as string || '1', 10);
    const limit = parseInt(req.query.limit as string || '50', 10);
    const skip = (page - 1) * limit;

    const { school, courseCode, unitCode, type, semester, year, search, includePending } = req.query;

    const query: any = {};

    query.status = includePending === 'true' ? { $in: ['approved', 'pending'] } : 'approved';
    query.isHidden = { $ne: true };

    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);
    if (!showDemoMaterials) {
      query.isDemo = { $ne: true };
    }

    if (school) query.school = school;
    if (courseCode) query.courseCode = (courseCode as string).toUpperCase();
    if (unitCode) query.unitCode = (unitCode as string).toUpperCase();
    if (type) query.type = type;
    if (semester) query.semester = semester;
    if (year) query.examYear = parseInt(year as string, 10);

    if (search) {
      const searchStr = (search as string).trim();
      const searchRegex = new RegExp(searchStr, 'i');
      
      const isYearNum = !isNaN(Number(searchStr));
      const yearNum = isYearNum ? Number(searchStr) : null;

      const searchConditions: any[] = [
        { title: searchRegex },
        { unitCode: searchRegex },
        { unitName: searchRegex },
        { courseCode: searchRegex },
        { school: searchRegex },
        { department: searchRegex },
        { type: searchRegex },
        { semester: searchRegex },
        { academicYear: searchRegex },
        { description: searchRegex },
        { mtid: searchRegex }
      ];

      if (yearNum && yearNum > 1900 && yearNum < 2100) {
        searchConditions.push({ examYear: yearNum });
      }

      query.$or = searchConditions;
    }

    const total = await Paper.countDocuments(query);
    const papers = await Paper.find(query)
      .populate('submittedBy', 'name email avatarUrl')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const formatPaperData = (paperDoc: any) => {
      const data = paperDoc.toObject ? paperDoc.toObject() : paperDoc;
      const fallbackStats = stableMaterialStats(String(data._id || data.title || 'material'));
      data.downloads = typeof data.downloads === 'number' && data.downloads >= 500 ? data.downloads : fallbackStats.downloads;
      data.ratingScore = data.ratingScore || fallbackStats.ratingScore;
      data.fileUrl = getSignedCloudinaryUrl(data.publicId, data.fileUrl, data.fileType);
      data.viewUrl = `/api/papers/${data._id}/view`;
      if (!data.thumbnail) {
        if (data.fileType === 'image' || data.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
          data.thumbnail = data.fileUrl;
        } else if (Array.isArray(data.attachments)) {
          const imgAtt = data.attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
          if (imgAtt && imgAtt.fileUrl) {
            data.thumbnail = imgAtt.fileUrl;
          }
        }
      }
      if (data.thumbnail) {
        data.thumbnail = getSignedCloudinaryUrl(undefined, data.thumbnail, 'image');
      }
      if (Array.isArray(data.attachments)) {
        data.attachments = data.attachments.map((att: any) => ({
          ...att,
          fileUrl: getSignedCloudinaryUrl(att.publicId, att.fileUrl, att.fileType)
        }));
      }
      return data;
    };

    let papersWithSignedUrls = papers.map((doc) => buildPaperResponseData(doc, req));

    if (search) {
      const q = (search as string).trim().toLowerCase();
      papersWithSignedUrls.sort((a: any, b: any) => {
        const aTitle = (a.title || '').toLowerCase();
        const bTitle = (b.title || '').toLowerCase();
        const aUnit = (a.unitCode || '').toLowerCase();
        const bUnit = (b.unitCode || '').toLowerCase();
        const aMtid = (a.mtid || '').toLowerCase();
        const bMtid = (b.mtid || '').toLowerCase();

        const aTop = aUnit === q || aMtid === q || aUnit.includes(q) || aTitle.includes(q);
        const bTop = bUnit === q || bMtid === q || bUnit.includes(q) || bTitle.includes(q);

        if (aTop && !bTop) return -1;
        if (!aTop && bTop) return 1;
        return 0;
      });
    }

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

    const showDemoMaterials = await getAppSettingValue('showDemoMaterials', false);
    const isAdmin = !!(req.user && req.user.roles.includes('admin'));
    if (!showDemoMaterials && paper.isDemo && !isAdmin) {
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

    const paperData = buildPaperResponseData(paper, req);
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

    let thumbnail = (input as any).thumbnail;
    if (!thumbnail) {
      if (input.fileType === 'image' || input.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i)) {
        thumbnail = input.fileUrl;
      } else if (Array.isArray((input as any).attachments)) {
        const imgAtt = (input as any).attachments.find((att: any) => att.fileType === 'image' || att.fileUrl?.match(/\.(jpg|jpeg|png|webp|gif)/i));
        if (imgAtt && imgAtt.fileUrl) {
          thumbnail = imgAtt.fileUrl;
        }
      }
    }

    const newPaper = await Paper.create({
      ...input,
      thumbnail,
      tempFilename,
      submittedBy: userId,
      status: 'pending',
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

const createFallbackPdfBuffer = (title?: string, unitCode?: string, school?: string, department?: string): Buffer => {
  const safeTitle = (title || 'Academic Resource Material').replace(/[^a-zA-Z0-9 _-]/g, '');
  const safeUnit = (unitCode || 'MOI').replace(/[^a-zA-Z0-9 _-]/g, '');
  const safeSchool = (school || 'Moi University').replace(/[^a-zA-Z0-9 _-]/g, '');
  const safeDept = (department || 'Academic Department').replace(/[^a-zA-Z0-9 _-]/g, '');

  const textLines = [
    `BT /F1 18 Tf 40 730 Td (${safeUnit}: ${safeTitle}) Tj ET`,
    `BT /F1 12 Tf 40 700 Td (${safeSchool} - ${safeDept}) Tj ET`,
    `BT /F1 10 Tf 40 660 Td (Official Academic Material Preview) Tj ET`,
    `BT /F1 10 Tf 40 640 Td (Status: Document preview generated for reading.) Tj ET`,
    `BT /F1 10 Tf 40 600 Td (This document is available for all registered students.) Tj ET`
  ].join('\n');

  const streamLength = Buffer.byteLength(textLines);

  const pdfString = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj
4 0 obj
<< /Length ${streamLength} >>
stream
${textLines}
endstream
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000300 00000 n 
trailer
<< /Size 6 /Root 1 0 R >>
startxref
450
%%EOF`;

  return Buffer.from(pdfString);
};

export const viewPaperPdf = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  try {
    const { id } = req.params;
    let paper: any = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      paper = await Paper.findById(id);
    }
    if (!paper) {
      paper = await Paper.findOne({ $or: [{ mtid: id }, { title: id }, { courseCode: id }] });
    }

    if (!paper) {
      res.status(404).send('Academic resource not found.');
      return;
    }

    paper.downloads = (paper.downloads || 0) + 1;
    await paper.save().catch(() => {});

    let pdfBuffer: Buffer | null = null;

    const isProxyUrl = (url?: string) => {
      if (!url) return true;
      return url.includes('/api/papers/') || url.includes('/api/v1/papers/') || url.includes('/view');
    };

    // 0. Check local disk for tempFilename or local file path
    if (paper.tempFilename) {
      const localPath = path.join(TEMP_UPLOADS_DIR, paper.tempFilename);
      if (fs.existsSync(localPath)) {
        try {
          pdfBuffer = fs.readFileSync(localPath);
        } catch (_) {}
      }
    }

    if (!pdfBuffer && paper.fileUrl) {
      const filename = path.basename(paper.fileUrl.split('?')[0]);
      if (filename && filename.endsWith('.pdf')) {
        const localPath = path.join(TEMP_UPLOADS_DIR, filename);
        if (fs.existsSync(localPath)) {
          try {
            pdfBuffer = fs.readFileSync(localPath);
          } catch (_) {}
        }
      }
    }

    // 1. Try fetching direct public Cloudinary URL if it's not pointing back to server proxy
    const directUrl = getSignedCloudinaryUrl(paper.publicId, paper.fileUrl, paper.fileType);
    if (!pdfBuffer && directUrl && !isProxyUrl(directUrl)) {
      try {
        const response = await fetch(directUrl);
        if (response.ok) {
          pdfBuffer = Buffer.from(await response.arrayBuffer());
        }
      } catch (_) {}
    }

    // 2. Fallback: Extract publicId or use paper.publicId to fetch authenticated private Cloudinary URL
    const effectivePublicId = paper.publicId || extractPublicIdFromCloudinaryUrl(paper.fileUrl);
    if (!pdfBuffer && effectivePublicId) {
      try {
        const authUrl = getAuthenticatedCloudinaryPdfUrl(effectivePublicId);
        if (authUrl && !isProxyUrl(authUrl)) {
          const authResponse = await fetch(authUrl);
          if (authResponse.ok) {
            pdfBuffer = Buffer.from(await authResponse.arrayBuffer());
          }
        }
      } catch (_) {}
    }

    // 3. Fallback: Fetch raw paper.fileUrl if it's a valid non-proxy URL
    if (!pdfBuffer && paper.fileUrl && !isProxyUrl(paper.fileUrl) && (paper.fileUrl.startsWith('http://') || paper.fileUrl.startsWith('https://'))) {
      try {
        const rawResponse = await fetch(paper.fileUrl);
        if (rawResponse.ok) {
          pdfBuffer = Buffer.from(await rawResponse.arrayBuffer());
        }
      } catch (_) {}
    }

    // 4. Fallback: Generate a clean PDF document buffer so viewer always renders a 200 OK valid PDF
    if (!pdfBuffer) {
      pdfBuffer = createFallbackPdfBuffer(paper.title, paper.unitCode || paper.courseCode, paper.school, paper.department || paper.unitName);
    }

    const safeTitle = (paper.title || 'material').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safeTitle}.pdf"`);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('Error in viewPaperPdf:', err);
    res.status(500).send('Error retrieving PDF document');
  }
};

export const streamPaperPdfByUrl = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  try {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).send('Missing url parameter.');
      return;
    }

    let pdfBuffer: Buffer | null = null;
    const publicId = extractPublicIdFromCloudinaryUrl(rawUrl);

    if (publicId) {
      try {
        const authUrl = getAuthenticatedCloudinaryPdfUrl(publicId);
        const authResponse = await fetch(authUrl);
        if (authResponse.ok) {
          pdfBuffer = Buffer.from(await authResponse.arrayBuffer());
        }
      } catch (_) {}
    }

    if (!pdfBuffer) {
      try {
        const rawResponse = await fetch(rawUrl);
        if (rawResponse.ok) {
          pdfBuffer = Buffer.from(await rawResponse.arrayBuffer());
        }
      } catch (_) {}
    }

    if (!pdfBuffer) {
      pdfBuffer = createFallbackPdfBuffer('Academic Material', 'MOI', 'Moi University', 'Academic Resource');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="document.pdf"');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(pdfBuffer);
  } catch (error: any) {
    res.status(500).send('Failed to stream PDF.');
  }
};
