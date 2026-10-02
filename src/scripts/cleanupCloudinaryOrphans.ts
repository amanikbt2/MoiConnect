import mongoose from 'mongoose';
import cloudinary from '../config/cloudinary';
import { config } from '../config';
import { Paper } from '../models/Paper';
import { Popup } from '../models/Popup';
import { CommunityMessage } from '../models/CommunityMessage';
import { User } from '../models/User';

type ResourceType = 'image' | 'raw' | 'video';

const folders = ['MoiConnect', 'moiconnect'];
const resourceTypes: ResourceType[] = ['image', 'raw', 'video'];
const knownExtensions = /\.(pdf|txt|text|jpg|jpeg|png|webp|gif|bmp|svg|ico|tif|tiff|mp4|mov|m4v|webm|avi|mkv|3gp|doc|docx)$/i;

const normalizeId = (value: string): string => {
  let id = String(value || '').split('?')[0].split('#')[0].replace(/^\/+/, '');
  id = id.replace(/^v\d+\//, '');
  return id.replace(knownExtensions, '');
};

const addReference = (references: Set<string>, value?: string | null) => {
  if (!value) return;
  const id = normalizeId(value);
  if (!id || !id.toLowerCase().includes('moiconnect')) return;
  resourceTypes.forEach((resourceType) => references.add(`${resourceType}|${id}`));
};

const addUrlReference = (references: Set<string>, value?: string | null) => {
  if (!value || !value.includes('res.cloudinary.com')) return;
  try {
    const pathname = new URL(value).pathname;
    const marker = pathname.match(/\/(?:image|raw|video)\/upload\/(.+)$/i);
    if (!marker) return;
    let pathPart = marker[1];
    const versionIndex = pathPart.search(/(?:^|\/)v\d+\//);
    if (versionIndex >= 0) pathPart = pathPart.slice(versionIndex).replace(/^v\d+\//, '');
    addReference(references, pathPart);
  } catch (_) {
    return;
  }
};

const collectReferences = async (): Promise<Set<string>> => {
  const references = new Set<string>();
  const papers = await Paper.find().lean();
  for (const paper of papers as any[]) {
    addReference(references, paper.publicId);
    addReference(references, paper.ttsTextPublicId);
    addUrlReference(references, paper.fileUrl);
    addUrlReference(references, paper.ttsTextUrl);
    addUrlReference(references, paper.thumbnail);
    for (const attachment of paper.attachments || []) {
      addReference(references, attachment.publicId);
      addReference(references, attachment.ttsTextPublicId);
      addUrlReference(references, attachment.fileUrl);
      addUrlReference(references, attachment.ttsTextUrl);
    }
  }

  const popups = await Popup.find().lean();
  for (const popup of popups as any[]) addUrlReference(references, popup.imageUrl);

  const messages = await CommunityMessage.find().lean();
  for (const message of messages as any[]) {
    addUrlReference(references, message.senderAvatarUrl);
    addUrlReference(references, message.fileAttachment?.url);
    addUrlReference(references, message.replyTo?.fileAttachment?.url);
  }

  const users = await User.find().lean();
  for (const user of users as any[]) addUrlReference(references, user.avatarUrl);
  return references;
};

const listResources = async (resourceType: ResourceType, prefix: string): Promise<any[]> => {
  const resources: any[] = [];
  let nextCursor: string | undefined;
  do {
    const response: any = await cloudinary.api.resources({
      resource_type: resourceType,
      type: 'upload',
      prefix,
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {})
    });
    resources.push(...(response.resources || []));
    nextCursor = response.next_cursor;
  } while (nextCursor);
  return resources;
};

const main = async () => {
  const shouldDelete = process.argv.includes('--delete');
  if (!config.cloudinary.cloudName || !config.cloudinary.apiKey || !config.cloudinary.apiSecret) {
    throw new Error('Cloudinary credentials are not configured.');
  }

  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  const references = await collectReferences();
  const orphaned: Array<{ resourceType: ResourceType; publicId: string }> = [];

  for (const resourceType of resourceTypes) {
    for (const folder of folders) {
      const resources = await listResources(resourceType, folder);
      for (const resource of resources) {
        const publicId = normalizeId(resource.public_id);
        if (!references.has(`${resourceType}|${publicId}`)) {
          orphaned.push({ resourceType, publicId: resource.public_id });
        }
      }
    }
  }

  console.log(JSON.stringify({ mode: shouldDelete ? 'delete' : 'dry-run', referenced: references.size, orphaned: orphaned.length, assets: orphaned }, null, 2));

  if (shouldDelete) {
    for (let index = 0; index < orphaned.length; index += 100) {
      const batch = orphaned.slice(index, index + 100);
      for (const resourceType of resourceTypes) {
        const ids = batch.filter((asset) => asset.resourceType === resourceType).map((asset) => asset.publicId);
        if (ids.length > 0) {
          await cloudinary.api.delete_resources(ids, { resource_type: resourceType, type: 'upload', invalidate: true });
        }
      }
    }
    console.log(`Deleted ${orphaned.length} confirmed orphaned assets.`);
  }

  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error?.message || error);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
