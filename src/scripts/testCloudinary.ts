import dotenv from 'dotenv';
import path from 'path';
import { v2 as cloudinary } from 'cloudinary';

// Load env from backend root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

console.log('\n=== Cloudinary Diagnostic Test ===');
console.log('CLOUDINARY_CLOUD_NAME:', cloudName || '❌ NOT SET');
console.log('CLOUDINARY_API_KEY   :', apiKey ? `${apiKey.slice(0, 6)}...` : '❌ NOT SET');
console.log('CLOUDINARY_API_SECRET:', apiSecret ? `${apiSecret.slice(0, 6)}...` : '❌ NOT SET');

if (!cloudName || !apiKey || !apiSecret) {
  console.error('\n❌ Missing Cloudinary credentials. Set them in your .env file.\n');
  process.exit(1);
}

cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });

async function testUpload() {
  try {
    console.log('\n⏳ Uploading a tiny test image to Cloudinary...');

    // Upload a tiny 1x1 red pixel PNG as a base64 data URI
    const result = await cloudinary.uploader.upload(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
      {
        folder: 'MoiConnect/test',
        public_id: 'diagnostic_test_pixel',
        overwrite: true,
      }
    );

    console.log('\n✅ Upload SUCCESSFUL!');
    console.log('   URL    :', result.secure_url);
    console.log('   Public ID:', result.public_id);
    console.log('   Folder :', result.folder);
    console.log('   Bytes  :', result.bytes);
    console.log('\n🎉 Cloudinary credentials are working correctly.\n');
  } catch (err: any) {
    console.error('\n❌ Upload FAILED!');
    console.error('   Message:', err.message);
    if (err.http_code) console.error('   HTTP code:', err.http_code);
    if (err.error) console.error('   Error detail:', JSON.stringify(err.error, null, 2));
    console.error('');
    process.exit(1);
  }
}

testUpload();
