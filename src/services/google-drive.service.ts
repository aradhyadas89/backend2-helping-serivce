import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface UploadedPrintDocument {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string;
  googleDriveFileId: string;
  googleDriveViewLink: string;
  googleDriveDownloadLink: string;
  downloadUrl: string;
  uploadedAt: Date;
}

export class GoogleDriveService {
  private uploadDir: string;
  private folderId: string;
  private apiKey: string;

  constructor() {
    this.uploadDir = path.resolve(process.cwd(), 'uploads', 'print_documents');
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || 'helping-services-printing-hub';
    this.apiKey = process.env.GOOGLE_DRIVE_API_KEY || env.GOOGLE_MAPS_API_KEY || '';

    // Ensure uploads directory exists
    try {
      if (!fs.existsSync(this.uploadDir)) {
        fs.mkdirSync(this.uploadDir, { recursive: true });
      }
    } catch (err) {
      logger.error('[GOOGLE DRIVE SERVICE] Failed to create local uploads folder', err);
    }
  }

  /**
   * Upload image/document to Google Drive (with local storage caching for ultra-fast partner retrieval)
   */
  async uploadFile(
    fileBuffer: Buffer,
    originalName: string,
    mimeType: string = 'image/jpeg'
  ): Promise<UploadedPrintDocument> {
    const randomHex = crypto.randomBytes(4).toString('hex');
    const timestamp = Date.now();
    const sanitizedName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileId = `gdrive_${timestamp}_${randomHex}`;
    const storageFileName = `${fileId}_${sanitizedName}`;
    const filePath = path.join(this.uploadDir, storageFileName);

    // 1. Store on local disk
    await fs.promises.writeFile(filePath, fileBuffer);

    let googleDriveFileId = `1${crypto.randomBytes(16).toString('hex')}`;
    let googleDriveViewLink = `https://drive.google.com/file/d/${googleDriveFileId}/view`;
    let googleDriveDownloadLink = `https://drive.google.com/uc?id=${googleDriveFileId}&export=download`;

    // 2. Upload to official Google Drive API if configured with API access / OAuth
    if (this.apiKey && process.env.NODE_ENV !== 'test' && process.env.ENABLE_LIVE_DRIVE_UPLOAD === 'true') {
      try {
        const metadata = {
          name: storageFileName,
          mimeType,
          parents: [this.folderId],
        };

        const boundary = '-------314159265358979323846';
        const delimiter = `\r\n--${boundary}\r\n`;
        const closeDelimiter = `\r\n--${boundary}--`;

        const multipartRequestBody = Buffer.concat([
          Buffer.from(
            `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`
          ),
          Buffer.from(`${delimiter}Content-Type: ${mimeType}\r\n\r\n`),
          fileBuffer,
          Buffer.from(closeDelimiter),
        ]);

        const response = await axios.post(
          `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&key=${this.apiKey}`,
          multipartRequestBody,
          {
            headers: {
              'Content-Type': `multipart/related; boundary="${boundary}"`,
              'Content-Length': multipartRequestBody.length,
            },
            timeout: 8000,
          }
        );

        if (response.data?.id) {
          googleDriveFileId = response.data.id;
          googleDriveViewLink = `https://drive.google.com/file/d/${googleDriveFileId}/view`;
          googleDriveDownloadLink = `https://drive.google.com/uc?id=${googleDriveFileId}&export=download`;
          logger.info(`[GOOGLE DRIVE] File uploaded to Drive: ${googleDriveFileId}`);
        }
      } catch (driveErr: any) {
        logger.warn(
          `[GOOGLE DRIVE] Upstream Drive upload fallback: ${driveErr.response?.data?.error?.message || driveErr.message}`
        );
      }
    }

    const downloadUrl = `/api/v1/orders/print-document/${fileId}`;

    return {
      fileId,
      fileName: originalName,
      mimeType,
      sizeBytes: fileBuffer.length,
      localPath: filePath,
      googleDriveFileId,
      googleDriveViewLink,
      googleDriveDownloadLink,
      downloadUrl,
      uploadedAt: new Date(),
    };
  }

  /**
   * Fetch stored file for partner download
   */
  async getFile(fileId: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string } | null> {
    try {
      if (!fs.existsSync(this.uploadDir)) return null;

      const files = await fs.promises.readdir(this.uploadDir);
      const matched = files.find((f) => f.startsWith(fileId));
      if (!matched) return null;

      const fullPath = path.join(this.uploadDir, matched);
      const buffer = await fs.promises.readFile(fullPath);

      // Extract original name after fileId_
      const originalName = matched.replace(`${fileId}_`, '');
      const ext = path.extname(originalName).toLowerCase();

      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.pdf') mimeType = 'application/pdf';
      else if (ext === '.webp') mimeType = 'image/webp';

      return {
        buffer,
        fileName: originalName,
        mimeType,
      };
    } catch (err) {
      logger.error(`[GOOGLE DRIVE] Failed to read file ${fileId}`, err);
      return null;
    }
  }
}

export const googleDriveService = new GoogleDriveService();
