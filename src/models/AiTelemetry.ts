import { Schema, model, Document } from 'mongoose';

export interface IAiPoolUsage extends Document {
  apiLabel: string;
  used: number;
  successes: number;
  failures: number;
  lastUsedAt?: Date;
  cooldownUntil?: Date;
  updatedAt: Date;
  createdAt: Date;
}

export interface IAiFailureLog extends Document {
  timestamp: Date;
  level: 'info' | 'warn' | 'error';
  assistant: string;
  apiLabel?: string;
  modelName?: string;
  status?: number;
  message: string;
  createdAt: Date;
}

const aiPoolUsageSchema = new Schema<IAiPoolUsage>({
  apiLabel: { type: String, required: true, unique: true, index: true },
  used: { type: Number, default: 0 },
  successes: { type: Number, default: 0 },
  failures: { type: Number, default: 0 },
  lastUsedAt: { type: Date },
  cooldownUntil: { type: Date }
}, { timestamps: true });

const aiFailureLogSchema = new Schema<IAiFailureLog>({
  timestamp: { type: Date, required: true, default: Date.now, index: true },
  level: { type: String, enum: ['info', 'warn', 'error'], required: true },
  assistant: { type: String, required: true },
  apiLabel: { type: String },
  modelName: { type: String },
  status: { type: Number },
  message: { type: String, required: true }
}, { timestamps: true });

export const AiPoolUsage = model<IAiPoolUsage>('AiPoolUsage', aiPoolUsageSchema);
export const AiFailureLog = model<IAiFailureLog>('AiFailureLog', aiFailureLogSchema);
