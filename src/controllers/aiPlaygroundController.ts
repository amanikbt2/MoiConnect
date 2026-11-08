import { Request, Response } from 'express';
import { AssistantKind, getAiPlaygroundOptions, testAiPlayground, testAiPlaygroundForumFlow } from '../services/campusBotService';

export const getOptions = (_req: Request, res: Response): void => {
  res.json({ success: true, data: getAiPlaygroundOptions() });
};

export const testRequest = async (req: Request, res: Response): Promise<void> => {
  try {
    const body = req.body || {};
    const message = typeof body.message === 'string' ? body.message : '';
    const model = typeof body.model === 'string' ? body.model : '';
    const customApiKey = typeof body.customApiKey === 'string' ? body.customApiKey : undefined;
    const apiIndex = Number.isInteger(body.apiIndex) ? body.apiIndex : undefined;
    const assistantKind: AssistantKind = body.assistant === 'bot' ? 'bot' : 'ai';
    if (body.mode === 'forum') {
      const data = await testAiPlaygroundForumFlow(message, assistantKind);
      res.json({ success: true, data });
      return;
    }
    const data = await testAiPlayground({ apiIndex, customApiKey, model, message, assistantKind });
    res.json({ success: true, data });
  } catch (error: any) {
    const providerStatus = Number.isInteger(error?.providerStatus) ? error.providerStatus : undefined;
    res.status(providerStatus ? 502 : 400).json({
      success: false,
      error: String(error?.message || 'The API playground request failed.').slice(0, 500),
      data: providerStatus ? { providerStatus } : undefined
    });
  }
};
