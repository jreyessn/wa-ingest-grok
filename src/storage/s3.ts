import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StorageConfig } from "../config.js";

export interface ObjectUpload {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface ObjectStorage {
  upload(input: ObjectUpload): Promise<string>;
}

export class S3Storage implements ObjectStorage {
  private readonly client: S3Client;

  constructor(private readonly config: StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      // R2 and MinIO reject the default flexible checksum headers.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  async upload(input: ObjectUpload): Promise<string> {
    const key = `${this.config.prefix}${input.key}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: this.config.expiresSeconds },
    );
  }
}
