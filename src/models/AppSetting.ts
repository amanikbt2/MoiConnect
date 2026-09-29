import mongoose, { Schema, Document } from 'mongoose';

export interface IAppSettingDocument extends Document {
  key: string;
  value: any;
  description?: string;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const appSettingSchema = new Schema<IAppSettingDocument>(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, trim: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

export const AppSetting = mongoose.model<IAppSettingDocument>('AppSetting', appSettingSchema);

export const getAppSettingValue = async <T = any>(key: string, defaultValue: T): Promise<T> => {
  try {
    const setting = await AppSetting.findOne({ key });
    if (setting && setting.value !== undefined && setting.value !== null) {
      return setting.value as T;
    }
    return defaultValue;
  } catch (error) {
    console.error(`Error reading AppSetting [${key}]:`, error);
    return defaultValue;
  }
};

export const setAppSettingValue = async <T = any>(key: string, value: T, userId?: string): Promise<T> => {
  try {
    const updateData: any = { value };
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      updateData.updatedBy = new mongoose.Types.ObjectId(userId);
    }
    const setting = await AppSetting.findOneAndUpdate(
      { key },
      { $set: updateData },
      { upsert: true, new: true }
    );
    return setting.value as T;
  } catch (error) {
    console.error(`Error writing AppSetting [${key}]:`, error);
    throw error;
  }
};
