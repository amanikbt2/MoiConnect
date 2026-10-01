import fs from 'fs';
import path from 'path';
import cloudinary from '../config/cloudinary';
import { Paper } from '../models/Paper';
import { TEMP_UPLOADS_DIR } from '../middleware/upload';

export interface ITempFileInfo {
  filename: string;
  sizeBytes: number;
  sizeFormatted: string;
  createdAt: string;
  modifiedAt: string;
  fileUrl: string;
  associatedPaper?: {
    id: string;
    title: string;
    unitCode: string;
    status: string;
    school: string;
  };
}

export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

export const listTempFiles = async (): Promise<{ files: ITempFileInfo[]; totalFiles: number; totalSizeBytes: number; totalSizeFormatted: string }> => {
  if (!fs.existsSync(TEMP_UPLOADS_DIR)) {
    fs.mkdirSync(TEMP_UPLOADS_DIR, { recursive: true });
    return { files: [], totalFiles: 0, totalSizeBytes: 0, totalSizeFormatted: '0 Bytes' };
  }

  const fileNames = fs.readdirSync(TEMP_UPLOADS_DIR);
  let totalSizeBytes = 0;
  const fileInfos: ITempFileInfo[] = [];

  // Query papers that might link to files in temp
  const pendingPapers = await Paper.find({
    $or: [
      { tempFilename: { $exists: true, $ne: '' } },
      { fileUrl: { $regex: '/uploads/temp/' } }
    ]
  }).select('_id title unitCode status school tempFilename fileUrl');

  const paperMapByFilename = new Map<string, any>();
  for (const p of pendingPapers) {
    if (p.tempFilename) {
      paperMapByFilename.set(p.tempFilename, p);
    }
    if (p.fileUrl) {
      const base = path.basename(p.fileUrl.split('?')[0]);
      if (base) paperMapByFilename.set(base, p);
    }
  }

  for (const name of fileNames) {
    const fullPath = path.join(TEMP_UPLOADS_DIR, name);
    try {
      const stats = fs.statSync(fullPath);
      if (stats.isFile()) {
        totalSizeBytes += stats.size;
        const linkedPaper = paperMapByFilename.get(name);

        fileInfos.push({
          filename: name,
          sizeBytes: stats.size,
          sizeFormatted: formatBytes(stats.size),
          createdAt: stats.birthtime.toISOString(),
          modifiedAt: stats.mtime.toISOString(),
          fileUrl: `/uploads/temp/${name}`,
          associatedPaper: linkedPaper ? {
            id: linkedPaper._id.toString(),
            title: linkedPaper.title,
            unitCode: linkedPaper.unitCode,
            status: linkedPaper.status,
            school: linkedPaper.school
          } : undefined
        });
      }
    } catch (err) {
      console.warn(`Could not stat temp file ${name}:`, err);
    }
  }

  // Sort latest first
  fileInfos.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  return {
    files: fileInfos,
    totalFiles: fileInfos.length,
    totalSizeBytes,
    totalSizeFormatted: formatBytes(totalSizeBytes)
  };
};

export const deleteTempFile = (filenameOrPath: string): boolean => {
  const filename = path.basename(filenameOrPath);
  const targetPath = path.join(TEMP_UPLOADS_DIR, filename);

  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
    return true;
  }
  return false;
};

export const deleteBatchTempFiles = (filenames: string[]): { deletedCount: number; errors: string[] } => {
  let deletedCount = 0;
  const errors: string[] = [];

  for (const fn of filenames) {
    try {
      const success = deleteTempFile(fn);
      if (success) {
        deletedCount++;
      }
    } catch (err: any) {
      errors.push(`Failed to delete ${fn}: ${err?.message || err}`);
    }
  }

  return { deletedCount, errors };
};

export const getSignedCloudinaryUrl = (publicId?: string, fileUrl?: string, fileType?: string): string => {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'mconnect';

  const cleanPublicUrl = (rawPublicId: string, configuredCloudName = cloudName): string => {
    const cleanPid = rawPublicId.replace(/^\/+/, '');
    const publicIdWithExtension = path.extname(cleanPid) ? cleanPid : `${cleanPid}.pdf`;
    return `https://res.cloudinary.com/${configuredCloudName}/raw/upload/${publicIdWithExtension}`;
  };

  // 1. If publicId is provided and it's a raw/PDF asset, return non-expiring res.cloudinary.com CDN link
  if (publicId) {
    const isImage = fileType === 'image' || publicId.match(/\.(jpg|jpeg|png|webp|gif)$/i);
    const isVideo = fileType === 'video' || publicId.match(/\.(mp4|mov|webm)$/i);
    const resourceType = isImage ? 'image' : (isVideo ? 'video' : 'raw');

    if (resourceType === 'raw') {
      return cleanPublicUrl(publicId);
    }

    return cloudinary.url(publicId, {
      resource_type: resourceType,
      type: 'upload',
      secure: true
    });
  }

  if (!fileUrl) return '';

  let sanitized = fileUrl;

  // 2. If fileUrl contains api.cloudinary.com (stale timestamp link), sanitize it to direct res.cloudinary.com CDN link
  if (sanitized.includes('api.cloudinary.com')) {
    try {
      const parsedUrl = new URL(sanitized);
      const pidParam = parsedUrl.searchParams.get('public_id');
      const extractedCloud = parsedUrl.pathname.split('/')[2] || cloudName;

      if (pidParam) {
        return cleanPublicUrl(pidParam, extractedCloud);
      }
    } catch (e) {
      // Fallback if URL parsing fails
    }
  }

  // 3. Strip any signature tokens (/s--...--/) and query strings (?_a=...) from raw upload URLs
  if (sanitized.includes('/raw/upload/')) {
    sanitized = sanitized.replace(/\/raw\/upload\/s--[^/]+--\//, '/raw/upload/');
    sanitized = sanitized.split('?')[0];
  }

  return sanitized;
};

export const extractPublicIdFromCloudinaryUrl = (url: string): string | null => {
  if (!url) return null;
  try {
    const cleanUrl = url.split('#')[0].split('?')[0];
    const match = cleanUrl.match(/\/raw\/upload\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)$/i) ||
                  cleanUrl.match(/\/upload\/(?:s--[^/]+--\/)?(?:v\d+\/)?(.+?)$/i);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  } catch (_) {}
  return null;
};

export const getAuthenticatedCloudinaryPdfUrl = (publicId: string, format = 'pdf'): string => {
  try {
    const cleanPid = publicId.replace(/^\/+/, '');
    return cloudinary.utils.private_download_url(cleanPid, format, {
      resource_type: 'raw',
      type: 'upload'
    });
  } catch (err) {
    console.error('Error generating authenticated Cloudinary PDF URL:', err);
    return getSignedCloudinaryUrl(publicId);
  }
};
export const uploadTempFileToCloudinary = async (
  filenameOrUrl: string,
  folder: string = 'MoiConnect/pdf',
  resourceTypeOverride?: 'image' | 'video' | 'raw'
): Promise<{ secure_url: string; public_id: string }> => {
  const filename = path.basename(filenameOrUrl.split('?')[0]);
  const filePath = path.join(TEMP_UPLOADS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Temporary file "${filename}" not found in server storage (${TEMP_UPLOADS_DIR}).`);
  }

  const stats = fs.statSync(filePath);
  if (stats.size === 0) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (_) {}
    throw new Error(`The uploaded file "${filename}" is empty (0 bytes). Please upload a valid document.`);
  }

  const extension = path.extname(filename).toLowerCase();
  const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg', '.ico', '.tif', '.tiff']);
  const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv', '.3gp']);
  const resourceType = resourceTypeOverride || (imageExtensions.has(extension) ? 'image' : videoExtensions.has(extension) ? 'video' : 'raw');

  const result: any = await cloudinary.uploader.upload(filePath, {
    folder,
    resource_type: resourceType,
    type: 'upload',
    access_mode: 'public',
    access_control: [{ access_type: 'anonymous' }],
    use_filename: true,
    unique_filename: true
  });

  // After successful Cloudinary upload, remove file from local server disk
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (unlinkErr) {
    console.error(`Warning: Could not remove temp file ${filePath} after Cloudinary upload:`, unlinkErr);
  }

  return {
    secure_url: getSignedCloudinaryUrl(result.public_id, result.secure_url, resourceType === 'raw' ? 'pdf' : 'image'),
    public_id: result.public_id
  };
};
