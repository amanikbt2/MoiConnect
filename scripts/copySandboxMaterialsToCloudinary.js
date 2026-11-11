const path = require('node:path');
const fs = require('node:fs');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;

dotenv.config({ path: path.resolve(__dirname, '../.env.sandbox') });

const SANDBOX_URI = 'mongodb://127.0.0.1:27017/mconnect_sandbox';
const SANDBOX_FOLDER = 'MConnect-sandbox/materials';

const main = async () => {
  const cloudName = process.env.CLOUDINARY_SANDBOX_CLOUD_NAME?.trim();
  const apiKey = process.env.CLOUDINARY_SANDBOX_API_KEY?.trim();
  const apiSecret = process.env.CLOUDINARY_SANDBOX_API_SECRET?.trim();
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Add the separate sandbox Cloudinary cloud name, API key, and API secret to backend/.env.sandbox.');
  }
  const mainEnvPath = path.resolve(__dirname, '../.env');
  if (fs.existsSync(mainEnvPath)) {
    const mainCloudName = dotenv.parse(fs.readFileSync(mainEnvPath, 'utf8')).CLOUDINARY_CLOUD_NAME?.trim();
    if (mainCloudName && mainCloudName.toLowerCase() === cloudName.toLowerCase()) {
      throw new Error('Sandbox Cloudinary cloud name matches the main MConnect cloud. Create/use a separate Cloudinary cloud.');
    }
  }

  let db;
  try {
    db = await mongoose.createConnection(SANDBOX_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    }).asPromise();
    if (db.host !== '127.0.0.1' || db.name !== 'mconnect_sandbox') {
      throw new Error('Sandbox database validation failed. Only local mconnect_sandbox is allowed.');
    }

    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
    const papers = db.collection('papers');
    const materials = await papers.find({ status: 'approved', isHidden: { $ne: true }, isDemo: { $ne: true } }).toArray();
    if (!materials.length) {
      console.log('No approved sandbox materials were found. Run seed:sandbox-materials first.');
      return;
    }

    let copied = 0;
    let skipped = 0;
    let failed = 0;
    for (const paper of materials) {
      try {
        const sourceUrl = String(paper.fileUrl || '').trim();
        if (!sourceUrl) throw new Error('No file URL is stored for this material.');
        const parsedSourceUrl = new URL(sourceUrl);
        const sourceIsCloudinary = parsedSourceUrl.protocol === 'https:' &&
          (parsedSourceUrl.hostname === 'cloudinary.com' || parsedSourceUrl.hostname.endsWith('.cloudinary.com'));
        if (!sourceIsCloudinary) throw new Error('The source file is not an HTTPS Cloudinary URL.');

        if (sourceUrl.includes(`res.cloudinary.com/${cloudName}/`)) {
          skipped += 1;
          continue;
        }

        const ext = path.extname(parsedSourceUrl.pathname).toLowerCase() || '.pdf';
        const stableId = String(paper.mtid || paper._id).replace(/[^a-zA-Z0-9_-]/g, '_');
        const resourceType = paper.fileType === 'image' || paper.fileType === 'video' ? paper.fileType : 'raw';
        const uploaded = await cloudinary.uploader.upload(sourceUrl, {
          folder: SANDBOX_FOLDER,
          public_id: `${stableId}${resourceType === 'raw' ? ext : ''}`,
          resource_type: resourceType,
          type: 'upload',
          access_mode: 'public',
          access_control: [{ access_type: 'anonymous' }],
          overwrite: true,
          invalidate: true,
          use_filename: false,
          unique_filename: false
        });

        await papers.updateOne({ _id: paper._id }, {
          $set: { fileUrl: uploaded.secure_url, publicId: uploaded.public_id }
        });
        copied += 1;
        console.log(`Copied ${paper.mtid || paper.unitCode || String(paper._id)}.`);
      } catch (error) {
        failed += 1;
        console.error(`Could not copy ${paper.mtid || paper.unitCode || String(paper._id)}: ${error.message || error}`);
      }
    }

    console.log(`Sandbox Cloudinary copy finished: ${copied} copied, ${skipped} already in the sandbox cloud, ${failed} failed.`);
    console.log('Database updates were limited to fileUrl and publicId on local mconnect_sandbox.papers. No main Cloudinary write credentials were used.');
    if (failed) process.exitCode = 1;
  } finally {
    await db?.close();
  }
};

main().catch((error) => {
  console.error(`[Sandbox Cloudinary copy failed]: ${error.message || error}`);
  process.exitCode = 1;
});
