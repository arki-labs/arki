import { S3Client } from '@aws-sdk/client-s3';
import { AwsS3StorageAdapter } from '@flystorage/aws-s3';
import { FileStorage } from '@flystorage/file-storage';
import { env } from './env';

const client = new S3Client({
  region: env['AWS_REGION'],
  credentials: env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY'] ? {
    accessKeyId: env['AWS_ACCESS_KEY_ID'],
    secretAccessKey: env['AWS_SECRET_ACCESS_KEY'],
    ...(env['AWS_SESSION_TOKEN'] && { sessionToken: env['AWS_SESSION_TOKEN'] }),
  } : undefined,
  ...(env['AWS_ENDPOINT_URL'] && { endpoint: env['AWS_ENDPOINT_URL'] }),
});

export const initializeStorage = (bucketName?: string, optionalPathPrefix?: string, region?: string) => {
  const adapter = new AwsS3StorageAdapter(client, {
    bucket: bucketName ?? env['AWS_S3_BUCKET_NAME'] ?? 'default-bucket',
    prefix: optionalPathPrefix ?? env['AWS_S3_PATH_PREFIX'] ?? '',
    region: region ?? env['AWS_REGION'],
  });
  const storage = new FileStorage(adapter);

  return storage;
};
