import { randomUUID } from 'crypto';

export type DownloadStatus = 'Queued' | 'Downloading' | 'Extracting' | 'Completed' | 'Failed';

export interface QueueItem {
  nzo_id: string;
  title: string;
  videoUrl: string;
  category: string;
  status: DownloadStatus;
  percentage: number;
  totalBytes: number;
  downloadedBytes: number;
  startTime: Date;
  filePath?: string;
  failMessage?: string;
}

export interface HistoryItem {
  nzo_id: string;
  nzb_name: string;
  category: string;
  bytes: number;
  storage: string;
  status: 'Completed' | 'Failed';
  fail_message: string;
  download_time: number;
  name: string;
  videoUrl?: string;
}

// Global in-memory state
export const downloadQueue: Map<string, QueueItem> = new Map();
export const downloadHistory: HistoryItem[] = [];

/**
 * Create and register a new queue entry.
 */
export function createQueueItem(title: string, videoUrl: string, category: string): QueueItem {
  const item: QueueItem = {
    nzo_id: `joyn-${randomUUID()}`,
    title,
    videoUrl,
    category,
    status: 'Queued',
    percentage: 0,
    totalBytes: 0,
    downloadedBytes: 0,
    startTime: new Date(),
  };
  downloadQueue.set(item.nzo_id, item);
  return item;
}

/**
 * Move a completed queue item to the history list.
 */
export function moveToHistory(item: QueueItem, storagePath: string): void {
  const downloadTimeSec = Math.round((Date.now() - item.startTime.getTime()) / 1000);

  const historyItem: HistoryItem = {
    nzo_id: item.nzo_id,
    nzb_name: item.title,
    category: item.category,
    bytes: item.totalBytes || item.downloadedBytes,
    storage: storagePath,
    status: 'Completed',
    fail_message: '',
    download_time: downloadTimeSec,
    name: item.title,
  };

  downloadHistory.unshift(historyItem); // most recent first
  downloadQueue.delete(item.nzo_id);
}

/**
 * Move a failed queue item to the history list.
 */
export function moveToHistoryFailed(item: QueueItem, errorMessage: string): void {
  const downloadTimeSec = Math.round((Date.now() - item.startTime.getTime()) / 1000);

  const historyItem: HistoryItem = {
    nzo_id: item.nzo_id,
    nzb_name: item.title,
    category: item.category,
    bytes: item.downloadedBytes,
    storage: '',
    status: 'Failed',
    fail_message: errorMessage,
    download_time: downloadTimeSec,
    name: item.title,
    videoUrl: item.videoUrl,
  };

  downloadHistory.unshift(historyItem);
  downloadQueue.delete(item.nzo_id);
}

/**
 * Remove a history item by its nzo_id.
 */
export function deleteHistoryItem(nzo_id: string): void {
  const idx = downloadHistory.findIndex(h => h.nzo_id === nzo_id);
  if (idx !== -1) {
    downloadHistory.splice(idx, 1);
  }
}
